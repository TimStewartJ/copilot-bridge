import type { DatabaseSync } from "node:sqlite";
import {
  isMcpServerConfig,
  mcpServerConfigsEqual,
  type McpServerConfig,
} from "./mcp-config.js";
import { normalizeTagNameKey } from "./tag-name.js";

// This registry is for idempotent database/schema compatibility only. Runtime
// compatibility remains next to its call site, e.g. API aliases, workspace.yaml
// fallback, staging preview context fallbacks, and attachment blob handling.
const UNKNOWN_SCHEDULE_RUN_AT = "0001-01-01T00:00:00.000Z";
const BRIDGE_SESSION_STATE_LEGACY_BACKFILL = "bridge_session_state_legacy_backfill_v1";
const SCHEDULE_REUSE_COLUMNS_DROP = "schedule-reuse-columns-drop-v1";
const SCHEDULE_RUNS_LEGACY_BACKFILL = "schedule_runs_legacy_backfill_v1";

type DatabaseMigrationCategory =
  | "schema-upgrade"
  | "legacy-data"
  | "compat-backfill"
  | "data-repair";
type DatabaseMigrationRunMode = "every-open" | "once";
type DatabaseMigrationTransactionMode = "auto" | "self";

interface DatabaseMigrationBase {
  id: string;
  category: DatabaseMigrationCategory;
  description: string;
  apply(db: DatabaseSync): void;
}

interface EveryOpenDatabaseMigration extends DatabaseMigrationBase {
  runMode: "every-open";
  // "auto" migrations are wrapped by the runner and must not issue transaction
  // control statements. "self" migrations own their transaction so the runner
  // will not wrap them, which avoids nested BEGIN errors when they use
  // runMigrationInTransaction directly or need PRAGMA work outside the transaction.
  transaction: DatabaseMigrationTransactionMode;
}

interface OneTimeDatabaseMigration extends DatabaseMigrationBase {
  runMode: "once";
  transaction?: never;
}

type DatabaseMigration = EveryOpenDatabaseMigration | OneTimeDatabaseMigration;

export interface DatabaseMigrationInfo {
  id: string;
  category: DatabaseMigrationCategory;
  runMode: DatabaseMigrationRunMode;
  transaction: DatabaseMigrationTransactionMode;
  description: string;
}

function rebuildTasksWithoutLegacyTaskColumn(db: DatabaseSync, hasCompletedAt: boolean, hasMuted: boolean): void {
  db.exec(`
    CREATE TABLE tasks_new (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'task',
      muted INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      groupId TEXT,
      cwd TEXT,
      notes TEXT NOT NULL DEFAULT '',
      doneWhen TEXT,
      nextAction TEXT,
      waitingOn TEXT,
      nextTouchAt TEXT,
      priority INTEGER NOT NULL DEFAULT 0,
      "order" INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL,
      completedAt TEXT,
      updatedAt TEXT NOT NULL
    );
  `);
  db.exec(`
    INSERT INTO tasks_new (
      id, title, kind, muted, status, groupId, cwd, notes, doneWhen, nextAction, waitingOn, nextTouchAt,
      priority, "order", createdAt, completedAt, updatedAt
    )
    SELECT
      id,
      title,
      CASE
        WHEN pinned != 0 THEN 'ongoing'
        WHEN kind IN ('task', 'ongoing') THEN kind
        ELSE 'task'
      END,
      ${hasMuted ? "COALESCE(muted, 0)" : "0"},
      status, groupId, cwd, notes, doneWhen, nextAction, waitingOn, nextTouchAt,
      priority, "order", createdAt, ${hasCompletedAt ? "completedAt" : "NULL"}, updatedAt
    FROM tasks;
  `);
  db.exec("DROP TABLE tasks");
  db.exec("ALTER TABLE tasks_new RENAME TO tasks");
}

function assertNoForeignKeyViolations(db: DatabaseSync, migrationName: string): void {
  const violations = db.prepare("PRAGMA foreign_key_check").all() as any[];
  if (violations.length > 0) {
    throw new Error(`${migrationName} left ${violations.length} foreign key violation(s)`);
  }
}

function runMigrationInTransaction(db: DatabaseSync, apply: () => void): void {
  let shouldRollback = false;
  try {
    db.exec("BEGIN");
    shouldRollback = true;
    apply();
    db.exec("COMMIT");
    shouldRollback = false;
  } catch (error) {
    if (shouldRollback) db.exec("ROLLBACK");
    throw error;
  }
}

function withForeignKeysDisabled(db: DatabaseSync, apply: () => void): void {
  const foreignKeysRow = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys?: number } | undefined;
  const restoreForeignKeys = foreignKeysRow?.foreign_keys !== 0;
  db.exec("PRAGMA foreign_keys = OFF");
  try {
    apply();
  } finally {
    if (restoreForeignKeys) db.exec("PRAGMA foreign_keys = ON");
  }
}

function parseJsonObject(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}

function parseMcpServerConfig(value: string): McpServerConfig | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return isMcpServerConfig(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function normalizeMcpServerName(name: string): string {
  const trimmed = name.trim();
  return trimmed || "mcp-server";
}

function hydrateMcpServerConfig(row: { config: string }): McpServerConfig | undefined {
  return parseMcpServerConfig(row.config);
}

function findMcpServerByName(db: DatabaseSync, name: string): any | undefined {
  return db.prepare("SELECT * FROM mcp_servers WHERE name = ? COLLATE NOCASE").get(name) as any;
}

function insertMcpServer(
  db: DatabaseSync,
  name: string,
  config: McpServerConfig,
  enabledByDefault: boolean,
): string {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO mcp_servers (id, name, config, enabledByDefault, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, name, JSON.stringify(config), enabledByDefault ? 1 : 0, now, now);
  return id;
}

function makeUniqueMcpServerName(db: DatabaseSync, preferredName: string): string {
  const base = normalizeMcpServerName(preferredName);
  const existingNames = new Set(
    (db.prepare("SELECT name FROM mcp_servers").all() as Array<{ name: string }>)
      .map((row) => row.name.toLocaleLowerCase()),
  );
  if (!existingNames.has(base.toLocaleLowerCase())) return base;

  const first = `${base} (tag override)`;
  if (!existingNames.has(first.toLocaleLowerCase())) return first;
  for (let i = 2; ; i++) {
    const candidate = `${base} (tag override ${i})`;
    if (!existingNames.has(candidate.toLocaleLowerCase())) return candidate;
  }
}

function upsertDefaultMcpServer(db: DatabaseSync, name: string, config: McpServerConfig): string {
  const normalizedName = normalizeMcpServerName(name);
  const existing = findMcpServerByName(db, normalizedName);
  if (!existing) return insertMcpServer(db, normalizedName, config, true);

  const existingConfig = hydrateMcpServerConfig(existing);
  if (!existingConfig || !mcpServerConfigsEqual(existingConfig, config) || existing.enabledByDefault !== 1) {
    db.prepare(`
      UPDATE mcp_servers
      SET config = ?, enabledByDefault = 1, updatedAt = ?
      WHERE id = ?
    `).run(JSON.stringify(config), new Date().toISOString(), existing.id);
  }
  return existing.id;
}

function findReusableMcpServerForTagConfig(
  db: DatabaseSync,
  tagId: string,
  name: string,
  config: McpServerConfig,
): any | undefined {
  const normalizedName = normalizeMcpServerName(name);
  const lowerName = normalizedName.toLocaleLowerCase();
  const existingRefs = db.prepare(`
    SELECT ms.*
    FROM tag_mcp_server_refs refs
    JOIN mcp_servers ms ON ms.id = refs.serverId
    WHERE refs.tagId = ?
  `).all(tagId) as any[];
  const existingRef = existingRefs.find((row) => {
    const existingConfig = hydrateMcpServerConfig(row);
    return existingConfig ? mcpServerConfigsEqual(existingConfig, config) : false;
  });
  if (existingRef) return existingRef;

  const sameName = findMcpServerByName(db, normalizedName);
  const sameNameConfig = sameName ? hydrateMcpServerConfig(sameName) : undefined;
  if (sameName && sameNameConfig && mcpServerConfigsEqual(sameNameConfig, config)) return sameName;

  const generatedRows = db.prepare("SELECT * FROM mcp_servers").all() as any[];
  return generatedRows.find((row) => {
    const lowerRowName = String(row.name).toLocaleLowerCase();
    if (!lowerRowName.startsWith(`${lowerName} (`)) return false;
    const existingConfig = hydrateMcpServerConfig(row);
    return existingConfig ? mcpServerConfigsEqual(existingConfig, config) : false;
  });
}

function ensureTagMcpServerInRegistry(
  db: DatabaseSync,
  tagId: string,
  name: string,
  config: McpServerConfig,
): string {
  const reusable = findReusableMcpServerForTagConfig(db, tagId, name, config);
  if (reusable) return reusable.id;
  return insertMcpServer(db, makeUniqueMcpServerName(db, name), config, false);
}

function migrateMcpRegistry(db: DatabaseSync): void {
  runMigrationInTransaction(db, () => {
    const appSettingsRow = db.prepare("SELECT value FROM settings WHERE key = 'app'").get() as { value: string } | undefined;
    const appSettings = appSettingsRow ? parseJsonObject(appSettingsRow.value) : undefined;
    const legacyMcpServers = appSettings?.mcpServers;
    if (legacyMcpServers && typeof legacyMcpServers === "object" && !Array.isArray(legacyMcpServers)) {
      for (const [name, config] of Object.entries(legacyMcpServers)) {
        if (typeof name === "string" && isMcpServerConfig(config)) {
          upsertDefaultMcpServer(db, name, config);
        }
      }
      delete appSettings.mcpServers;
      db.prepare("UPDATE settings SET value = ? WHERE key = 'app'").run(JSON.stringify(appSettings));
    }

    const legacyTagServers = db.prepare("SELECT tagId, serverName, config FROM tag_mcp_servers").all() as Array<{
      tagId: string;
      serverName: string;
      config: string;
    }>;
    for (const row of legacyTagServers) {
      const config = parseMcpServerConfig(row.config);
      if (!config) continue;
      const serverId = ensureTagMcpServerInRegistry(db, row.tagId, row.serverName, config);
      db.prepare(`
        INSERT OR IGNORE INTO tag_mcp_server_refs (tagId, serverId)
        VALUES (?, ?)
      `).run(row.tagId, serverId);
    }
    db.prepare("DELETE FROM tag_mcp_servers").run();
  });
}

function hasSchemaMigration(db: DatabaseSync, id: string): boolean {
  const row = db.prepare("SELECT 1 AS found FROM schema_migrations WHERE id = ?").get(id) as { found?: number } | undefined;
  return row?.found === 1;
}

function markSchemaMigration(db: DatabaseSync, id: string): void {
  db.prepare(`
    INSERT INTO schema_migrations (id, appliedAt)
    VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT(id) DO NOTHING
  `).run(id);
}

function sqliteTableExists(db: DatabaseSync, tableName: string): boolean {
  return !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName);
}

function getTableInfo(db: DatabaseSync, tableName: string): any[] {
  return sqliteTableExists(db, tableName) ? (db.prepare(`PRAGMA table_info(${tableName})`).all() as any[]) : [];
}

function addTaskSessionLinkedAt(db: DatabaseSync): void {
  const cols = db.prepare("PRAGMA table_info(task_sessions)").all() as any[];
  if (!cols.some((c: any) => c.name === "linkedAt")) {
    db.exec("ALTER TABLE task_sessions ADD COLUMN linkedAt TEXT NOT NULL DEFAULT '2000-01-01T00:00:00Z'");
  }
}

function addSessionMetaLastVisibleActivity(db: DatabaseSync): void {
  if (!sqliteTableExists(db, "session_meta")) return;

  const sessionMetaCols = db.prepare("PRAGMA table_info(session_meta)").all() as any[];
  if (!sessionMetaCols.some((c: any) => c.name === "lastVisibleActivityAt")) {
    db.exec("ALTER TABLE session_meta ADD COLUMN lastVisibleActivityAt TEXT");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_session_meta_lastVisibleActivityAt ON session_meta(lastVisibleActivityAt)");
}

function addBridgeSessionStateLastAttention(db: DatabaseSync): void {
  const bridgeSessionStateCols = db.prepare("PRAGMA table_info(bridge_session_state)").all() as any[];
  if (!bridgeSessionStateCols.some((c: any) => c.name === "lastAttentionAt")) {
    db.exec("ALTER TABLE bridge_session_state ADD COLUMN lastAttentionAt TEXT");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_bridge_session_state_lastAttentionAt ON bridge_session_state(lastAttentionAt)");
}

function backfillBridgeSessionState(db: DatabaseSync): void {
  if (sqliteTableExists(db, "session_meta")) {
    db.exec(`
      INSERT OR IGNORE INTO bridge_session_state (
        sessionId,
        archived,
        archivedAt,
        triggeredBy,
        scheduleId,
        scheduleName,
        lastVisibleActivityAt,
        createdAt,
        updatedAt
      )
      SELECT
        sessionId,
        archived,
        NULLIF(archivedAt, ''),
        triggeredBy,
        scheduleId,
        scheduleName,
        lastVisibleActivityAt,
        COALESCE(NULLIF(archivedAt, ''), lastVisibleActivityAt, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        COALESCE(lastVisibleActivityAt, NULLIF(archivedAt, ''), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      FROM session_meta;

      UPDATE bridge_session_state
      SET
        archived = COALESCE((SELECT archived FROM session_meta WHERE session_meta.sessionId = bridge_session_state.sessionId), archived),
        archivedAt = COALESCE((SELECT NULLIF(archivedAt, '') FROM session_meta WHERE session_meta.sessionId = bridge_session_state.sessionId), archivedAt),
        triggeredBy = COALESCE((SELECT triggeredBy FROM session_meta WHERE session_meta.sessionId = bridge_session_state.sessionId), triggeredBy),
        scheduleId = COALESCE((SELECT scheduleId FROM session_meta WHERE session_meta.sessionId = bridge_session_state.sessionId), scheduleId),
        scheduleName = COALESCE((SELECT scheduleName FROM session_meta WHERE session_meta.sessionId = bridge_session_state.sessionId), scheduleName),
        lastVisibleActivityAt = COALESCE((SELECT lastVisibleActivityAt FROM session_meta WHERE session_meta.sessionId = bridge_session_state.sessionId), lastVisibleActivityAt)
      WHERE EXISTS (SELECT 1 FROM session_meta WHERE session_meta.sessionId = bridge_session_state.sessionId);
    `);
  }

  if (sqliteTableExists(db, "session_titles")) {
    db.exec(`
      INSERT OR IGNORE INTO bridge_session_state (
        sessionId,
        titleOverride,
        titleOverrideUpdatedAt,
        createdAt,
        updatedAt
      )
      SELECT
        sessionId,
        title,
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      FROM session_titles;

      UPDATE bridge_session_state
      SET
        titleOverride = COALESCE((SELECT title FROM session_titles WHERE session_titles.sessionId = bridge_session_state.sessionId), titleOverride),
        titleOverrideUpdatedAt = COALESCE(titleOverrideUpdatedAt, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      WHERE EXISTS (SELECT 1 FROM session_titles WHERE session_titles.sessionId = bridge_session_state.sessionId);
    `);
  }

  if (sqliteTableExists(db, "session_workspace")) {
    db.exec(`
      INSERT OR IGNORE INTO bridge_session_state (
        sessionId,
        pinnedCwd,
        pinnedCwdUpdatedAt,
        createdAt,
        updatedAt
      )
      SELECT sessionId, cwd, updatedAt, updatedAt, updatedAt
      FROM session_workspace;

      UPDATE bridge_session_state
      SET
        pinnedCwd = COALESCE((SELECT cwd FROM session_workspace WHERE session_workspace.sessionId = bridge_session_state.sessionId), pinnedCwd),
        pinnedCwdUpdatedAt = COALESCE((SELECT updatedAt FROM session_workspace WHERE session_workspace.sessionId = bridge_session_state.sessionId), pinnedCwdUpdatedAt)
      WHERE EXISTS (SELECT 1 FROM session_workspace WHERE session_workspace.sessionId = bridge_session_state.sessionId);
    `);
  }
}

function ensureScheduleAutoArchiveKeepColumn(db: DatabaseSync): void {
  const scheduleCols = getTableInfo(db, "schedules");
  if (!scheduleCols.some((c: any) => c.name === "autoArchiveKeep")) {
    db.exec("ALTER TABLE schedules ADD COLUMN autoArchiveKeep INTEGER");
  }
}

function ensureFeedCardsVisualJsonColumn(db: DatabaseSync): void {
  if (!sqliteTableExists(db, "feed_cards")) return;
  const feedCols = getTableInfo(db, "feed_cards");
  if (!feedCols.some((c: any) => c.name === "visualJson")) {
    db.exec("ALTER TABLE feed_cards ADD COLUMN visualJson TEXT");
  }
}

function ensureFeedCardsActionJsonColumn(db: DatabaseSync): void {
  if (!sqliteTableExists(db, "feed_cards")) return;
  const feedCols = getTableInfo(db, "feed_cards");
  if (!feedCols.some((c: any) => c.name === "actionJson")) {
    db.exec("ALTER TABLE feed_cards ADD COLUMN actionJson TEXT");
  }
}

function scheduleColumnExpr(cols: any[], name: string, fallback: string): string {
  return cols.some((c: any) => c.name === name) ? name : fallback;
}

function backfillScheduleRunsFromScheduleColumn(db: DatabaseSync, columnName: string): void {
  db.exec(`
    INSERT INTO schedule_runs (scheduleId, sessionId, recordedAt)
    SELECT s.id, s.${columnName}, COALESCE(NULLIF(s.lastRunAt, ''), NULLIF(s.updatedAt, ''), NULLIF(s.createdAt, ''), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    FROM schedules s
    WHERE s.${columnName} IS NOT NULL
      AND s.${columnName} != ''
      AND NOT EXISTS (
        SELECT 1
        FROM schedule_runs sr
        WHERE sr.scheduleId = s.id AND sr.sessionId = s.${columnName}
      );
  `);
}

function dropScheduleReuseState(db: DatabaseSync): void {
  if (!sqliteTableExists(db, "schedules")) return;

  const scheduleCols = getTableInfo(db, "schedules");
  const hasColumn = (name: string) => scheduleCols.some((c: any) => c.name === name);
  const hasReuseColumns = ["sessionMode", "targetSessionId", "reuseLastRequiresExistingSession", "reuseSession"]
    .some(hasColumn);

  if (hasColumn("targetSessionId")) {
    backfillScheduleRunsFromScheduleColumn(db, "targetSessionId");
  }
  if (hasColumn("lastSessionId")) {
    backfillScheduleRunsFromScheduleColumn(db, "lastSessionId");
  }

  if (hasReuseColumns) {
    const lastSessionExpr = hasColumn("lastSessionId") && hasColumn("targetSessionId")
      ? "COALESCE(lastSessionId, targetSessionId)"
      : scheduleColumnExpr(scheduleCols, "lastSessionId", scheduleColumnExpr(scheduleCols, "targetSessionId", "NULL"));

    db.exec(`
      CREATE TABLE schedules_new (
        id TEXT PRIMARY KEY,
        taskId TEXT NOT NULL,
        name TEXT NOT NULL,
        prompt TEXT NOT NULL,
        type TEXT NOT NULL,
        cron TEXT,
        runAt TEXT,
        timezone TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        lastSessionId TEXT,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        lastRunAt TEXT,
        nextRunAt TEXT,
        runCount INTEGER NOT NULL DEFAULT 0,
        maxRuns INTEGER,
        expiresAt TEXT,
        autoArchiveKeep INTEGER
      );

      INSERT INTO schedules_new (
        id, taskId, name, prompt, type, cron, runAt, timezone, enabled, lastSessionId,
        createdAt, updatedAt, lastRunAt, nextRunAt, runCount, maxRuns, expiresAt, autoArchiveKeep
      )
      SELECT
        id,
        taskId,
        name,
        prompt,
        type,
        ${scheduleColumnExpr(scheduleCols, "cron", "NULL")},
        ${scheduleColumnExpr(scheduleCols, "runAt", "NULL")},
        ${scheduleColumnExpr(scheduleCols, "timezone", "NULL")},
        ${scheduleColumnExpr(scheduleCols, "enabled", "1")},
        ${lastSessionExpr},
        ${scheduleColumnExpr(scheduleCols, "createdAt", "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')")},
        ${scheduleColumnExpr(scheduleCols, "updatedAt", "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')")},
        ${scheduleColumnExpr(scheduleCols, "lastRunAt", "NULL")},
        ${scheduleColumnExpr(scheduleCols, "nextRunAt", "NULL")},
        ${scheduleColumnExpr(scheduleCols, "runCount", "0")},
        ${scheduleColumnExpr(scheduleCols, "maxRuns", "NULL")},
        ${scheduleColumnExpr(scheduleCols, "expiresAt", "NULL")},
        ${scheduleColumnExpr(scheduleCols, "autoArchiveKeep", "NULL")}
      FROM schedules;

      DROP TABLE schedules;
      ALTER TABLE schedules_new RENAME TO schedules;
      CREATE INDEX IF NOT EXISTS idx_schedules_taskId ON schedules(taskId);
      CREATE INDEX IF NOT EXISTS idx_schedules_enabled ON schedules(enabled);
      CREATE INDEX IF NOT EXISTS idx_schedules_enabled_nextRunAt ON schedules(enabled, nextRunAt);
    `);
  }

  db.exec("DROP TABLE IF EXISTS schedule_session_claims");
}

function backfillScheduleRuns(db: DatabaseSync): void {
  db.exec(`
    INSERT INTO schedule_runs (scheduleId, sessionId, recordedAt)
    SELECT s.id, s.lastSessionId, COALESCE(s.lastRunAt, s.updatedAt, s.createdAt, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    FROM schedules s
    WHERE s.lastSessionId IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM schedule_runs sr
        WHERE sr.scheduleId = s.id AND sr.sessionId = s.lastSessionId
      );
  `);

  if (sqliteTableExists(db, "session_meta")) {
    db.exec(`
    INSERT INTO schedule_runs (scheduleId, sessionId, recordedAt)
    SELECT sm.scheduleId, sm.sessionId, COALESCE(NULLIF(sm.archivedAt, ''), '${UNKNOWN_SCHEDULE_RUN_AT}')
    FROM session_meta sm
    WHERE sm.scheduleId IS NOT NULL
      AND NOT EXISTS (
        SELECT 1
        FROM schedule_runs sr
        WHERE sr.scheduleId = sm.scheduleId AND sr.sessionId = sm.sessionId
      );
    `);
  }
}

function migrateLegacyTodosAndNormalizeChecklist(db: DatabaseSync): void {
  runMigrationInTransaction(db, () => {
    if (sqliteTableExists(db, "todos")) {
      const legacyTodoCols = getTableInfo(db, "todos");
      const deadlineExpr = legacyTodoCols.some((c: any) => c.name === "deadline") ? "deadline" : "NULL";
      db.exec(`
        INSERT OR IGNORE INTO checklist_items (id, taskId, text, done, "order", createdAt, completedAt, deadline)
        SELECT id, taskId, text, done, "order", createdAt, completedAt, ${deadlineExpr}
        FROM todos;
      `);

      const missingLegacyRows = (db.prepare(`
        SELECT COUNT(*) AS count
        FROM todos legacy
        WHERE NOT EXISTS (
          SELECT 1 FROM checklist_items current WHERE current.id = legacy.id
        )
      `).get() as any).count ?? 0;
      if (missingLegacyRows > 0) {
        throw new Error(`Checklist migration incomplete: ${missingLegacyRows} legacy row(s) missing`);
      }

      db.exec("DROP TABLE todos");
    }

    const checklistItemCols = getTableInfo(db, "checklist_items");
    if (!checklistItemCols.some((c: any) => c.name === "deadline")) {
      db.exec("ALTER TABLE checklist_items ADD COLUMN deadline TEXT");
    }

    const normalizedChecklistItemCols = getTableInfo(db, "checklist_items");
    const taskIdCol = normalizedChecklistItemCols.find((c: any) => c.name === "taskId");
    if (taskIdCol && taskIdCol.notnull === 1) {
      db.exec(`
        CREATE TABLE checklist_items_new (
          id TEXT PRIMARY KEY,
          taskId TEXT REFERENCES tasks(id) ON DELETE CASCADE,
          text TEXT NOT NULL,
          done INTEGER NOT NULL DEFAULT 0,
          "order" INTEGER NOT NULL DEFAULT 0,
          createdAt TEXT NOT NULL,
          completedAt TEXT,
          deadline TEXT
        );
        INSERT INTO checklist_items_new (id, taskId, text, done, "order", createdAt, completedAt, deadline)
          SELECT id, taskId, text, done, "order", createdAt, completedAt, deadline FROM checklist_items;
        DROP TABLE checklist_items;
        ALTER TABLE checklist_items_new RENAME TO checklist_items;
      `);
    }

    db.exec("CREATE INDEX IF NOT EXISTS idx_checklist_items_taskId ON checklist_items(taskId)");
  });
}

function addTaskGroupNotes(db: DatabaseSync): void {
  const groupCols = db.prepare("PRAGMA table_info(task_groups)").all() as any[];
  if (!groupCols.some((c: any) => c.name === "notes")) {
    db.exec("ALTER TABLE task_groups ADD COLUMN notes TEXT NOT NULL DEFAULT ''");
  }
}

function normalizeTaskSchemaAndStatuses(db: DatabaseSync): void {
  withForeignKeysDisabled(db, () => {
    runMigrationInTransaction(db, () => {
      let taskCols = db.prepare("PRAGMA table_info(tasks)").all() as any[];
      if (!taskCols.some((c: any) => c.name === "kind")) {
        db.exec("ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'task'");
      }
      if (!taskCols.some((c: any) => c.name === "muted")) {
        db.exec("ALTER TABLE tasks ADD COLUMN muted INTEGER NOT NULL DEFAULT 0");
      }
      if (!taskCols.some((c: any) => c.name === "doneWhen")) {
        db.exec("ALTER TABLE tasks ADD COLUMN doneWhen TEXT");
      }
      if (!taskCols.some((c: any) => c.name === "nextAction")) {
        db.exec("ALTER TABLE tasks ADD COLUMN nextAction TEXT");
      }
      if (!taskCols.some((c: any) => c.name === "waitingOn")) {
        db.exec("ALTER TABLE tasks ADD COLUMN waitingOn TEXT");
      }
      if (!taskCols.some((c: any) => c.name === "nextTouchAt")) {
        db.exec("ALTER TABLE tasks ADD COLUMN nextTouchAt TEXT");
      }
      if (!taskCols.some((c: any) => c.name === "completedAt")) {
        db.exec("ALTER TABLE tasks ADD COLUMN completedAt TEXT");
      }
      db.exec("UPDATE tasks SET status = 'active' WHERE status = 'paused'");
      db.exec(`
        UPDATE tasks
        SET nextAction = NULL, waitingOn = NULL, nextTouchAt = NULL
        WHERE status != 'active'
          AND (nextAction IS NOT NULL OR waitingOn IS NOT NULL OR nextTouchAt IS NOT NULL)
      `);
      taskCols = db.prepare("PRAGMA table_info(tasks)").all() as any[];
      const hasCompletedAt = taskCols.some((c: any) => c.name === "completedAt");
      const hasMuted = taskCols.some((c: any) => c.name === "muted");
      const rebuiltLegacyTaskTable = taskCols.some((c: any) => c.name === "pinned");
      if (rebuiltLegacyTaskTable) rebuildTasksWithoutLegacyTaskColumn(db, hasCompletedAt, hasMuted);
      db.exec(`
        UPDATE tasks
        SET
          status = 'archived',
          completedAt = COALESCE(NULLIF(completedAt, ''), updatedAt, createdAt)
        WHERE kind != 'ongoing'
          AND status = 'done';
      `);
      db.exec(`
        UPDATE tasks
        SET
          status = CASE WHEN status = 'done' THEN 'active' ELSE status END,
          doneWhen = NULL,
          completedAt = NULL
        WHERE kind = 'ongoing'
          AND (status = 'done' OR doneWhen IS NOT NULL OR completedAt IS NOT NULL);
      `);
      db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)");
      db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_nextTouchAt ON tasks(nextTouchAt)");
      if (rebuiltLegacyTaskTable) assertNoForeignKeyViolations(db, "Task legacy-column migration");
    });
  });
}

function migrateTaskWorkItemIdsToText(db: DatabaseSync): void {
  const wiCols = db.prepare("PRAGMA table_info(task_work_items)").all() as any[];
  const itemIdCol = wiCols.find((c: any) => c.name === "itemId");
  if (itemIdCol && itemIdCol.type === "INTEGER") {
    db.exec(`
      CREATE TABLE task_work_items_new (
        taskId TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
        itemId TEXT NOT NULL,
        provider TEXT NOT NULL DEFAULT 'ado',
        PRIMARY KEY (taskId, itemId, provider)
      );
    `);
    db.exec(`
      INSERT INTO task_work_items_new (taskId, itemId, provider)
        SELECT taskId, CAST(itemId AS TEXT), provider FROM task_work_items;
    `);
    db.exec("DROP TABLE task_work_items");
    db.exec("ALTER TABLE task_work_items_new RENAME TO task_work_items");
  }
}

function ensureCopilotModelPricesTable(db: DatabaseSync): void {
  // Last-known-good cache of SDK-provided model token prices. Populated via
  // write-through whenever live model metadata is fetched; never hand-maintained.
  db.exec(`
    CREATE TABLE IF NOT EXISTS copilot_model_prices (
      id TEXT PRIMARY KEY,
      name TEXT,
      metadataJson TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
  `);
}

function ensureSessionContextTelemetryTables(db: DatabaseSync): void {
  // Keep this DDL as a historical compatibility snapshot. Do not import the
  // current baseline from db.ts: future baseline columns must be added below
  // with ALTER TABLE so existing databases upgrade safely.
  db.exec(`
    CREATE TABLE IF NOT EXISTS session_context_summary (
      sessionId TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      providerSessionId TEXT,
      updatedAt TEXT NOT NULL,
      currentModel TEXT,
      latestBridgeTurnId TEXT,
      latestSnapshotAt TEXT,
      contextWindow INTEGER,
      tokensUsed INTEGER,
      tokensRemaining INTEGER,
      usageRatio REAL,
      modelUsageJson TEXT,
      provenanceJson TEXT,
      contextWindowCapability TEXT NOT NULL DEFAULT 'unavailable',
      modelUsageCapability TEXT NOT NULL DEFAULT 'unavailable',
      snapshotCount INTEGER NOT NULL DEFAULT 0,
      compactionCount INTEGER NOT NULL DEFAULT 0,
      truncationCount INTEGER NOT NULL DEFAULT 0,
      shutdownCount INTEGER NOT NULL DEFAULT 0,
      lastSnapshotHash TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_session_context_summary_provider
      ON session_context_summary(provider, providerSessionId);
    CREATE TABLE IF NOT EXISTS session_context_turns (
      sessionId TEXT NOT NULL,
      bridgeTurnId TEXT NOT NULL,
      provider TEXT NOT NULL,
      providerSessionId TEXT,
      providerTurnId TEXT,
      attribution TEXT NOT NULL,
      startedAt TEXT,
      endedAt TEXT,
      latestEventAt TEXT,
      model TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      PRIMARY KEY (sessionId, bridgeTurnId)
    );
    CREATE INDEX IF NOT EXISTS idx_session_context_turns_provider
      ON session_context_turns(provider, providerSessionId, providerTurnId);
    CREATE TABLE IF NOT EXISTS session_context_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sessionId TEXT NOT NULL,
      provider TEXT NOT NULL,
      providerSessionId TEXT,
      providerEventId TEXT,
      providerTurnId TEXT,
      bridgeTurnId TEXT,
      attribution TEXT NOT NULL,
      type TEXT NOT NULL,
      occurredAt TEXT NOT NULL,
      model TEXT,
      contextWindow INTEGER,
      tokensUsed INTEGER,
      tokensRemaining INTEGER,
      usageRatio REAL,
      modelUsageJson TEXT,
      provenanceJson TEXT,
      metadataJson TEXT,
      dedupeKey TEXT NOT NULL,
      snapshotHash TEXT,
      contextWindowCapability TEXT NOT NULL DEFAULT 'unavailable',
      modelUsageCapability TEXT NOT NULL DEFAULT 'unavailable',
      createdAt TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_session_context_events_dedupe
      ON session_context_events(sessionId, dedupeKey);
    CREATE INDEX IF NOT EXISTS idx_session_context_events_session_recent
      ON session_context_events(sessionId, occurredAt DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_session_context_events_provider
      ON session_context_events(provider, providerSessionId, providerEventId);
    CREATE TABLE IF NOT EXISTS session_context_backfills (
      sessionId TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      providerSessionId TEXT,
      eventsPath TEXT NOT NULL,
      fileSize INTEGER NOT NULL,
      mtimeMs REAL NOT NULL,
      backfilledAt TEXT NOT NULL
    );
  `);
  const summaryCols = db.prepare("PRAGMA table_info(session_context_summary)").all() as any[];
  if (!summaryCols.some((column) => column.name === "provenanceJson")) {
    db.exec("ALTER TABLE session_context_summary ADD COLUMN provenanceJson TEXT");
  }
  const eventCols = db.prepare("PRAGMA table_info(session_context_events)").all() as any[];
  if (!eventCols.some((column) => column.name === "provenanceJson")) {
    db.exec("ALTER TABLE session_context_events ADD COLUMN provenanceJson TEXT");
  }
}

interface TagNameKeyMigrationRow {
  id: string;
  name: string;
  instructions: string;
  order: number;
  createdAt: string;
  updatedAt: string;
  nameKey: string | null;
}

function ensureTagNameKeyColumn(db: DatabaseSync): boolean {
  if (!sqliteTableExists(db, "tags")) return false;
  const tagCols = getTableInfo(db, "tags");
  if (!tagCols.some((c: any) => c.name === "nameKey")) {
    db.exec("ALTER TABLE tags ADD COLUMN nameKey TEXT");
  }
  return true;
}

function selectTagNameKeyMigrationRows(db: DatabaseSync): TagNameKeyMigrationRow[] {
  const rows = db.prepare(`
    SELECT id, name, instructions, "order" AS "order", createdAt, updatedAt, nameKey
    FROM tags
    ORDER BY "order", createdAt, id
  `).all() as any[];
  return rows.map((row) => ({
    id: String(row.id),
    name: String(row.name),
    instructions: String(row.instructions ?? ""),
    order: Number(row.order ?? 0),
    createdAt: String(row.createdAt ?? ""),
    updatedAt: String(row.updatedAt ?? ""),
    nameKey: typeof row.nameKey === "string" ? row.nameKey : null,
  }));
}

function mergeTagInstructions(rows: TagNameKeyMigrationRow[]): string {
  const parts: string[] = [];
  for (const row of rows) {
    if (!row.instructions.trim() || parts.includes(row.instructions)) continue;
    parts.push(row.instructions);
  }
  return parts.join("\n\n");
}

function latestTagUpdatedAt(rows: TagNameKeyMigrationRow[]): string {
  return rows.reduce(
    (latest, row) => row.updatedAt > latest ? row.updatedAt : latest,
    rows[0]?.updatedAt ?? new Date().toISOString(),
  );
}

function redirectTagReferences(db: DatabaseSync, fromTagId: string, toTagId: string): void {
  if (sqliteTableExists(db, "entity_tags")) {
    db.prepare(`
      INSERT OR IGNORE INTO entity_tags (entityType, entityId, tagId)
      SELECT entityType, entityId, ? FROM entity_tags WHERE tagId = ?
    `).run(toTagId, fromTagId);
    db.prepare("DELETE FROM entity_tags WHERE tagId = ?").run(fromTagId);
  }

  if (sqliteTableExists(db, "tag_mcp_server_refs")) {
    db.prepare(`
      INSERT OR IGNORE INTO tag_mcp_server_refs (tagId, serverId)
      SELECT ?, serverId FROM tag_mcp_server_refs WHERE tagId = ?
    `).run(toTagId, fromTagId);
    db.prepare("DELETE FROM tag_mcp_server_refs WHERE tagId = ?").run(fromTagId);
  }

  if (sqliteTableExists(db, "tag_mcp_servers")) {
    db.prepare(`
      INSERT OR IGNORE INTO tag_mcp_servers (tagId, serverName, config)
      SELECT ?, serverName, config FROM tag_mcp_servers WHERE tagId = ?
    `).run(toTagId, fromTagId);
    db.prepare("DELETE FROM tag_mcp_servers WHERE tagId = ?").run(fromTagId);
  }
}

function mergeTagNameKeyGroup(db: DatabaseSync, key: string, rows: TagNameKeyMigrationRow[]): void {
  const [survivor, ...duplicates] = rows;
  if (!survivor) return;

  for (const duplicate of duplicates) {
    redirectTagReferences(db, duplicate.id, survivor.id);
    db.prepare("DELETE FROM tags WHERE id = ?").run(duplicate.id);
  }

  db.prepare(`
    UPDATE tags
    SET nameKey = ?, instructions = ?, updatedAt = ?
    WHERE id = ?
  `).run(key, mergeTagInstructions(rows), latestTagUpdatedAt(rows), survivor.id);
}

function compactTagOrders(db: DatabaseSync): void {
  const rows = db.prepare('SELECT id FROM tags ORDER BY "order", createdAt, id').all() as Array<{ id: string }>;
  const update = db.prepare('UPDATE tags SET "order" = ? WHERE id = ?');
  rows.forEach((row, index) => update.run(index, row.id));
}

function normalizeTagNameKeys(db: DatabaseSync): void {
  if (!ensureTagNameKeyColumn(db)) return;

  db.exec("DROP INDEX IF EXISTS idx_tags_name_key");
  const rows = selectTagNameKeyMigrationRows(db);
  const rowsByKey = new Map<string, TagNameKeyMigrationRow[]>();
  for (const row of rows) {
    const key = normalizeTagNameKey(row.name);
    const keyRows = rowsByKey.get(key);
    if (keyRows) {
      keyRows.push(row);
    } else {
      rowsByKey.set(key, [row]);
    }
  }

  let mergedDuplicates = false;
  for (const [key, keyRows] of rowsByKey) {
    if (keyRows.length === 1) {
      db.prepare("UPDATE tags SET nameKey = ? WHERE id = ?").run(key, keyRows[0].id);
    } else {
      mergeTagNameKeyGroup(db, key, keyRows);
      mergedDuplicates = true;
    }
  }

  if (mergedDuplicates) compactTagOrders(db);

  const missingKeyRows = (db.prepare("SELECT COUNT(*) AS count FROM tags WHERE nameKey IS NULL").get() as any).count ?? 0;
  if (missingKeyRows > 0) {
    throw new Error(`Tag name-key migration left ${missingKeyRows} row(s) without a canonical key`);
  }
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_tags_name_key ON tags(nameKey)");
}

const DATABASE_MIGRATIONS: readonly DatabaseMigration[] = [
  {
    id: "mcp-registry-from-legacy-settings-and-tag-configs",
    category: "legacy-data",
    runMode: "every-open",
    transaction: "self",
    description: "Promote legacy settings.mcpServers and tag_mcp_servers rows into the canonical MCP server registry.",
    apply: migrateMcpRegistry,
  },
  {
    id: "tag-name-key-normalization",
    category: "data-repair",
    runMode: "every-open",
    transaction: "auto",
    description: "Backfill canonical tag name keys and merge Unicode-equivalent duplicate tags.",
    apply: normalizeTagNameKeys,
  },
  {
    id: "task-sessions-linked-at-column",
    category: "schema-upgrade",
    runMode: "every-open",
    transaction: "auto",
    description: "Add linkedAt to task_sessions for existing databases.",
    apply: addTaskSessionLinkedAt,
  },
  {
    id: "session-meta-last-visible-activity-column",
    category: "schema-upgrade",
    runMode: "every-open",
    transaction: "auto",
    description: "Add lastVisibleActivityAt to legacy session_meta rows.",
    apply: addSessionMetaLastVisibleActivity,
  },
  {
    id: "bridge-session-state-last-attention-column",
    category: "schema-upgrade",
    runMode: "every-open",
    transaction: "auto",
    description: "Add lastAttentionAt to bridge_session_state rows.",
    apply: addBridgeSessionStateLastAttention,
  },
  {
    id: BRIDGE_SESSION_STATE_LEGACY_BACKFILL,
    category: "compat-backfill",
    runMode: "once",
    description: "One-time import of session_meta, session_titles, and session_workspace values into bridge_session_state.",
    apply: backfillBridgeSessionState,
  },
  {
    id: "schedule-auto-archive-keep-column",
    category: "schema-upgrade",
    runMode: "every-open",
    transaction: "auto",
    description: "Add schedule autoArchiveKeep to legacy schedules tables.",
    apply: ensureScheduleAutoArchiveKeepColumn,
  },
  {
    id: "feed-cards-visual-json-column",
    category: "schema-upgrade",
    runMode: "every-open",
    transaction: "auto",
    description: "Add visualJson to feed_cards for dashboard visual artifacts.",
    apply: ensureFeedCardsVisualJsonColumn,
  },
  {
    id: "feed-cards-action-json-column",
    category: "schema-upgrade",
    runMode: "every-open",
    transaction: "auto",
    description: "Add actionJson to feed_cards for prompt-based session launch actions.",
    apply: ensureFeedCardsActionJsonColumn,
  },
  {
    id: SCHEDULE_REUSE_COLUMNS_DROP,
    category: "schema-upgrade",
    runMode: "once",
    description: "Remove schedule reuse columns and claim table after preserving legacy run references.",
    apply: dropScheduleReuseState,
  },
  {
    id: SCHEDULE_RUNS_LEGACY_BACKFILL,
    category: "compat-backfill",
    runMode: "once",
    description: "One-time backfill of schedule_runs from legacy lastSessionId and session_meta schedule metadata.",
    apply: backfillScheduleRuns,
  },
  {
    id: "checklist-items-from-legacy-todos",
    category: "legacy-data",
    runMode: "every-open",
    transaction: "self",
    description: "Move legacy todos rows into checklist_items and normalize checklist schema for global items and deadlines.",
    apply: migrateLegacyTodosAndNormalizeChecklist,
  },
  {
    id: "task-groups-notes-column",
    category: "schema-upgrade",
    runMode: "every-open",
    transaction: "auto",
    description: "Add notes to task_groups for existing databases.",
    apply: addTaskGroupNotes,
  },
  {
    id: "tasks-kind-momentum-and-status-repair",
    category: "data-repair",
    runMode: "every-open",
    transaction: "self",
    description: "Upgrade task schema, remove legacy pinned/paused/done shapes, and repair invalid ongoing task rows.",
    apply: normalizeTaskSchemaAndStatuses,
  },
  {
    id: "task-work-items-text-item-id",
    category: "schema-upgrade",
    runMode: "every-open",
    transaction: "auto",
    description: "Rebuild task_work_items when itemId was stored as INTEGER so string identifiers are preserved.",
    apply: migrateTaskWorkItemIdsToText,
  },
  {
    id: "session-context-telemetry-tables",
    category: "schema-upgrade",
    runMode: "every-open",
    transaction: "auto",
    description: "Create provider-neutral session context telemetry tables.",
    apply: ensureSessionContextTelemetryTables,
  },
  {
    id: "copilot-model-prices-table",
    category: "schema-upgrade",
    runMode: "every-open",
    transaction: "auto",
    description: "Create copilot_model_prices cache for last-known-good SDK token prices.",
    apply: ensureCopilotModelPricesTable,
  },
];

export function listDatabaseMigrations(): readonly DatabaseMigrationInfo[] {
  return DATABASE_MIGRATIONS.map((migration) => ({
    id: migration.id,
    category: migration.category,
    runMode: migration.runMode,
    transaction: migration.runMode === "every-open" ? migration.transaction : "auto",
    description: migration.description,
  }));
}

export function runDatabaseMigrations(db: DatabaseSync): void {
  for (const migration of DATABASE_MIGRATIONS) {
    try {
      if (migration.runMode === "once") {
        if (hasSchemaMigration(db, migration.id)) continue;
        runMigrationInTransaction(db, () => {
          migration.apply(db);
          markSchemaMigration(db, migration.id);
        });
      } else if (migration.transaction === "self") {
        migration.apply(db);
      } else {
        runMigrationInTransaction(db, () => migration.apply(db));
      }
    } catch (error) {
      throw new Error(`Database migration "${migration.id}" failed: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
  }
}
