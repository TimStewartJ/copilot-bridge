import type { DatabaseSync } from "node:sqlite";
import {
  isMcpServerConfig,
  mcpServerConfigsEqual,
  type McpServerConfig,
} from "./mcp-config.js";

// This registry is for idempotent database/schema compatibility only. Runtime
// compatibility remains next to its call site, e.g. API aliases, workspace.yaml
// fallback, staging preview context fallbacks, and attachment blob handling.
const UNKNOWN_SCHEDULE_RUN_AT = "0001-01-01T00:00:00.000Z";
const BRIDGE_SESSION_STATE_LEGACY_BACKFILL = "bridge_session_state_legacy_backfill_v1";
const SCHEDULE_RUNS_LEGACY_BACKFILL = "schedule_runs_legacy_backfill_v1";

type DatabaseMigrationCategory =
  | "schema-upgrade"
  | "legacy-data"
  | "compat-backfill"
  | "data-repair";
type DatabaseMigrationRunMode = "every-open" | "once";

interface DatabaseMigration {
  id: string;
  category: DatabaseMigrationCategory;
  runMode: DatabaseMigrationRunMode;
  description: string;
  apply(db: DatabaseSync): void;
}

export interface DatabaseMigrationInfo {
  id: string;
  category: DatabaseMigrationCategory;
  runMode: DatabaseMigrationRunMode;
  description: string;
}

function rebuildTasksWithoutLegacyTaskColumn(db: DatabaseSync, hasCompletedAt: boolean): void {
  const foreignKeysRow = db.prepare("PRAGMA foreign_keys").get() as { foreign_keys?: number } | undefined;
  const restoreForeignKeys = foreignKeysRow?.foreign_keys !== 0;
  let inTransaction = false;

  db.exec("PRAGMA foreign_keys = OFF");
  try {
    db.exec("BEGIN");
    inTransaction = true;
    db.exec(`
      CREATE TABLE tasks_new (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'task',
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

      INSERT INTO tasks_new (
        id, title, kind, status, groupId, cwd, notes, doneWhen, nextAction, waitingOn, nextTouchAt,
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
        status, groupId, cwd, notes, doneWhen, nextAction, waitingOn, nextTouchAt,
        priority, "order", createdAt, ${hasCompletedAt ? "completedAt" : "NULL"}, updatedAt
      FROM tasks;

      DROP TABLE tasks;
      ALTER TABLE tasks_new RENAME TO tasks;
    `);
    db.exec("COMMIT");
    inTransaction = false;
  } catch (error) {
    if (inTransaction) db.exec("ROLLBACK");
    throw error;
  } finally {
    if (restoreForeignKeys) db.exec("PRAGMA foreign_keys = ON");
  }

  const violations = db.prepare("PRAGMA foreign_key_check").all() as any[];
  if (violations.length > 0) {
    throw new Error(`Task legacy-column migration left ${violations.length} foreign key violation(s)`);
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
  db.exec("BEGIN");
  try {
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

    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
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

function ensureLegacyScheduleReuseColumns(db: DatabaseSync): void {
  const scheduleCols = db.prepare("PRAGMA table_info(schedules)").all() as any[];
  if (!scheduleCols.some((c: any) => c.name === "sessionMode")) {
    db.exec("ALTER TABLE schedules ADD COLUMN sessionMode TEXT NOT NULL DEFAULT 'new'");
    if (scheduleCols.some((c: any) => c.name === "reuseSession")) {
      db.exec("UPDATE schedules SET sessionMode = CASE WHEN reuseSession = 1 THEN 'reuse-last' ELSE 'new' END");
    }
  }
  if (!scheduleCols.some((c: any) => c.name === "targetSessionId")) {
    db.exec("ALTER TABLE schedules ADD COLUMN targetSessionId TEXT");
  }
  if (!scheduleCols.some((c: any) => c.name === "reuseLastRequiresExistingSession")) {
    db.exec("ALTER TABLE schedules ADD COLUMN reuseLastRequiresExistingSession INTEGER NOT NULL DEFAULT 0");
  }
  if (!scheduleCols.some((c: any) => c.name === "autoArchiveKeep")) {
    db.exec("ALTER TABLE schedules ADD COLUMN autoArchiveKeep INTEGER");
  }
}

function finalizeLegacyScheduleReuseState(db: DatabaseSync): void {
  db.exec(`
    UPDATE schedules
    SET sessionMode = 'reuse-last',
        lastSessionId = targetSessionId,
        reuseLastRequiresExistingSession = 1,
        targetSessionId = NULL
    WHERE sessionMode = 'reuse-target';
  `);

  db.exec(`
    UPDATE schedules
    SET sessionMode = 'new',
        targetSessionId = NULL,
        reuseLastRequiresExistingSession = 0
    WHERE sessionMode != 'new'
       OR targetSessionId IS NOT NULL
       OR reuseLastRequiresExistingSession != 0;

    DELETE FROM schedule_session_claims;
  `);
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
  db.exec("BEGIN");
  try {
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
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function addTaskGroupNotes(db: DatabaseSync): void {
  const groupCols = db.prepare("PRAGMA table_info(task_groups)").all() as any[];
  if (!groupCols.some((c: any) => c.name === "notes")) {
    db.exec("ALTER TABLE task_groups ADD COLUMN notes TEXT NOT NULL DEFAULT ''");
  }
}

function normalizeTaskSchemaAndStatuses(db: DatabaseSync): void {
  let taskCols = db.prepare("PRAGMA table_info(tasks)").all() as any[];
  if (!taskCols.some((c: any) => c.name === "kind")) {
    db.exec("ALTER TABLE tasks ADD COLUMN kind TEXT NOT NULL DEFAULT 'task'");
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
  if (taskCols.some((c: any) => c.name === "pinned")) rebuildTasksWithoutLegacyTaskColumn(db, hasCompletedAt);
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
      INSERT INTO task_work_items_new (taskId, itemId, provider)
        SELECT taskId, CAST(itemId AS TEXT), provider FROM task_work_items;
      DROP TABLE task_work_items;
      ALTER TABLE task_work_items_new RENAME TO task_work_items;
    `);
  }
}

const DATABASE_MIGRATIONS: readonly DatabaseMigration[] = [
  {
    id: "mcp-registry-from-legacy-settings-and-tag-configs",
    category: "legacy-data",
    runMode: "every-open",
    description: "Promote legacy settings.mcpServers and tag_mcp_servers rows into the canonical MCP server registry.",
    apply: migrateMcpRegistry,
  },
  {
    id: "task-sessions-linked-at-column",
    category: "schema-upgrade",
    runMode: "every-open",
    description: "Add linkedAt to task_sessions for existing databases.",
    apply: addTaskSessionLinkedAt,
  },
  {
    id: "session-meta-last-visible-activity-column",
    category: "schema-upgrade",
    runMode: "every-open",
    description: "Add lastVisibleActivityAt to legacy session_meta rows.",
    apply: addSessionMetaLastVisibleActivity,
  },
  {
    id: BRIDGE_SESSION_STATE_LEGACY_BACKFILL,
    category: "compat-backfill",
    runMode: "once",
    description: "One-time import of session_meta, session_titles, and session_workspace values into bridge_session_state.",
    apply: backfillBridgeSessionState,
  },
  {
    id: "schedule-reuse-fields-normalization",
    category: "schema-upgrade",
    runMode: "every-open",
    description: "Add former schedule reuse columns when needed so legacy databases remain readable.",
    apply: ensureLegacyScheduleReuseColumns,
  },
  {
    id: "schedule-reuse-final-new-session-normalization-v1",
    category: "data-repair",
    runMode: "once",
    description: "One-time normalization of removed schedule reuse modes to fresh-session schedules.",
    apply: finalizeLegacyScheduleReuseState,
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
    description: "Move legacy todos rows into checklist_items and normalize checklist schema for global items and deadlines.",
    apply: migrateLegacyTodosAndNormalizeChecklist,
  },
  {
    id: "task-groups-notes-column",
    category: "schema-upgrade",
    runMode: "every-open",
    description: "Add notes to task_groups for existing databases.",
    apply: addTaskGroupNotes,
  },
  {
    id: "tasks-kind-momentum-and-status-repair",
    category: "data-repair",
    runMode: "every-open",
    description: "Upgrade task schema, remove legacy pinned/paused/done shapes, and repair invalid ongoing task rows.",
    apply: normalizeTaskSchemaAndStatuses,
  },
  {
    id: "task-work-items-text-item-id",
    category: "schema-upgrade",
    runMode: "every-open",
    description: "Rebuild task_work_items when itemId was stored as INTEGER so string identifiers are preserved.",
    apply: migrateTaskWorkItemIdsToText,
  },
];

export function listDatabaseMigrations(): readonly DatabaseMigrationInfo[] {
  return DATABASE_MIGRATIONS.map(({ id, category, runMode, description }) => ({ id, category, runMode, description }));
}

export function runDatabaseMigrations(db: DatabaseSync): void {
  for (const migration of DATABASE_MIGRATIONS) {
    try {
      if (migration.runMode === "once") {
        if (hasSchemaMigration(db, migration.id)) continue;
        db.exec("BEGIN");
        try {
          migration.apply(db);
          markSchemaMigration(db, migration.id);
          db.exec("COMMIT");
        } catch (error) {
          db.exec("ROLLBACK");
          throw error;
        }
      } else {
        migration.apply(db);
      }
    } catch (error) {
      throw new Error(`Database migration "${migration.id}" failed: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
  }
}
