// Database module — single SQLite database for all app data
// Uses Node.js built-in node:sqlite (DatabaseSync)

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_FILENAME = "bridge.db";
const UNKNOWN_SCHEDULE_RUN_AT = "0001-01-01T00:00:00.000Z";
const LEGACY_JSON_STATE_FILES = [
  "tasks.json",
  "task-groups.json",
  "sessions-meta.json",
  "settings.json",
  "session-titles.json",
  "schedules.json",
  "read-state.json",
] as const;
const SQLITE_STATE_TABLES = [
  "tasks",
  "task_sessions",
  "task_work_items",
  "task_pull_requests",
  "task_groups",
  "session_meta",
  "session_workspace",
  "settings",
  "session_titles",
  "schedules",
  "schedule_runs",
  "schedule_run_claims",
  "schedule_session_claims",
  "read_state",
  "checklist_items",
  "voice_jobs",
  "tags",
  "entity_tags",
  "tag_mcp_servers",
  "deferred_prompts",
] as const;
type SqliteStateTable = typeof SQLITE_STATE_TABLES[number];

function legacyJsonFileHasState(dataDir: string, file: typeof LEGACY_JSON_STATE_FILES[number]): boolean {
  const content = readFileSync(join(dataDir, file), "utf-8").trim();
  if (content === "") return false;

  let value: unknown;
  try {
    value = JSON.parse(content) as unknown;
  } catch {
    return true;
  }
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function getLegacyJsonFilesWithState(dataDir: string): string[] {
  return LEGACY_JSON_STATE_FILES.filter((file) =>
    existsSync(join(dataDir, file)) && legacyJsonFileHasState(dataDir, file)
  );
}

function formatLegacyJsonStateError(action: string, legacyStateFiles: string[]): Error {
  return new Error(
    `Refusing to ${action} because legacy JSON state files contain data without migrated SQLite state: ${legacyStateFiles.join(", ")}. Restore a current ${DB_FILENAME} or remove the legacy JSON files before starting.`,
  );
}

function tableExists(db: DatabaseSync, table: SqliteStateTable): boolean {
  const row = db.prepare(
    "SELECT 1 as found FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(table) as { found?: number } | undefined;
  return row?.found === 1;
}

function tableHasRows(db: DatabaseSync, table: SqliteStateTable): boolean {
  const row = db.prepare(`SELECT COUNT(*) as count FROM ${table}`).get() as { count: number };
  return row.count > 0;
}

function hasPersistedSqliteState(db: DatabaseSync): boolean {
  return SQLITE_STATE_TABLES.some((table) => tableExists(db, table) && tableHasRows(db, table));
}

/** Open (or create) the bridge database and initialize schema */
export function openDatabase(dataDir: string): DatabaseSync {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  const dbPath = join(dataDir, DB_FILENAME);
  const dbExists = existsSync(dbPath);
  const legacyStateFiles = getLegacyJsonFilesWithState(dataDir);
  if (!dbExists && legacyStateFiles.length > 0) {
    throw formatLegacyJsonStateError(`create an empty ${DB_FILENAME}`, legacyStateFiles);
  }

  const db = new DatabaseSync(dbPath);
  if (dbExists && legacyStateFiles.length > 0 && !hasPersistedSqliteState(db)) {
    db.close();
    throw formatLegacyJsonStateError(`use ${DB_FILENAME}`, legacyStateFiles);
  }

  // Enable WAL mode for better concurrency and performance
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");

  initSchema(db);
  return db;
}

/** Open an in-memory database (for tests) */
export function openMemoryDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA foreign_keys = ON");
  initSchema(db);
  return db;
}

function rebuildTasksWithoutLegacyTaskColumn(db: DatabaseSync): void {
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
        updatedAt TEXT NOT NULL
      );

      INSERT INTO tasks_new (
        id, title, kind, status, groupId, cwd, notes, doneWhen, nextAction, waitingOn, nextTouchAt,
        priority, "order", createdAt, updatedAt
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
        priority, "order", createdAt, updatedAt
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

function initSchema(db: DatabaseSync): void {
  db.exec(`
    -- Tasks
    CREATE TABLE IF NOT EXISTS tasks (
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
      updatedAt TEXT NOT NULL
    );

    -- Task ↔ Session links
    CREATE TABLE IF NOT EXISTS task_sessions (
      taskId TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      sessionId TEXT NOT NULL,
      linkedAt TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (taskId, sessionId)
    );

    -- Task ↔ Work Item links
    CREATE TABLE IF NOT EXISTS task_work_items (
      taskId TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      itemId TEXT NOT NULL,
      provider TEXT NOT NULL DEFAULT 'ado',
      PRIMARY KEY (taskId, itemId, provider)
    );

    -- Task ↔ Pull Request links
    CREATE TABLE IF NOT EXISTS task_pull_requests (
      taskId TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      repoId TEXT NOT NULL,
      repoName TEXT,
      prId INTEGER NOT NULL,
      provider TEXT NOT NULL DEFAULT 'ado',
      PRIMARY KEY (taskId, repoId, prId, provider)
    );

    -- Task groups
    CREATE TABLE IF NOT EXISTS task_groups (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT NOT NULL DEFAULT 'blue',
      notes TEXT NOT NULL DEFAULT '',
      "order" INTEGER NOT NULL DEFAULT 0,
      collapsed INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    -- Session metadata
    CREATE TABLE IF NOT EXISTS session_meta (
      sessionId TEXT PRIMARY KEY,
      archived INTEGER NOT NULL DEFAULT 0,
      archivedAt TEXT,
      triggeredBy TEXT,
      scheduleId TEXT,
      scheduleName TEXT,
      lastVisibleActivityAt TEXT
    );

    -- Persisted session workspaces
    CREATE TABLE IF NOT EXISTS session_workspace (
      sessionId TEXT PRIMARY KEY,
      cwd TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    -- Per-run schedule history
    CREATE TABLE IF NOT EXISTS schedule_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      scheduleId TEXT NOT NULL,
      sessionId TEXT NOT NULL,
      recordedAt TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS schedule_run_claims (
      scheduleId TEXT NOT NULL,
      runKey TEXT NOT NULL,
      source TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'claimed',
      claimedAt TEXT NOT NULL,
      leaseExpiresAt TEXT NOT NULL,
      finishedAt TEXT,
      sessionId TEXT,
      PRIMARY KEY (scheduleId, runKey)
    );
    CREATE TABLE IF NOT EXISTS schedule_session_claims (
      sessionId TEXT PRIMARY KEY,
      scheduleId TEXT NOT NULL,
      claimedAt TEXT NOT NULL,
      leaseExpiresAt TEXT NOT NULL
    );

    -- Settings (key-value, main entry is key='app')
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    -- Session titles
    CREATE TABLE IF NOT EXISTS session_titles (
      sessionId TEXT PRIMARY KEY,
      title TEXT NOT NULL
    );

    -- Schedules
    CREATE TABLE IF NOT EXISTS schedules (
      id TEXT PRIMARY KEY,
      taskId TEXT NOT NULL,
      name TEXT NOT NULL,
      prompt TEXT NOT NULL,
      type TEXT NOT NULL,
      cron TEXT,
      runAt TEXT,
      timezone TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      sessionMode TEXT NOT NULL DEFAULT 'new',
      targetSessionId TEXT,
      lastSessionId TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      lastRunAt TEXT,
      nextRunAt TEXT,
      runCount INTEGER NOT NULL DEFAULT 0,
      maxRuns INTEGER,
      expiresAt TEXT,
      reuseLastRequiresExistingSession INTEGER NOT NULL DEFAULT 0
    );

    -- Read state
    CREATE TABLE IF NOT EXISTS read_state (
      sessionId TEXT PRIMARY KEY,
      lastReadAt TEXT NOT NULL
    );

    -- Checklist items (per-task checklists or global/unparented)
    CREATE TABLE IF NOT EXISTS checklist_items (
      id TEXT PRIMARY KEY,
      taskId TEXT REFERENCES tasks(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      "order" INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL,
      completedAt TEXT,
      deadline TEXT
    );

    -- Indexes for common queries
    CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    CREATE INDEX IF NOT EXISTS idx_task_sessions_session ON task_sessions(sessionId);
    CREATE INDEX IF NOT EXISTS idx_schedules_taskId ON schedules(taskId);
    CREATE INDEX IF NOT EXISTS idx_schedules_enabled ON schedules(enabled);
    CREATE INDEX IF NOT EXISTS idx_schedule_runs_schedule ON schedule_runs(scheduleId, recordedAt DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_schedule_run_claims_status ON schedule_run_claims(status, leaseExpiresAt);
    CREATE INDEX IF NOT EXISTS idx_checklist_items_taskId ON checklist_items(taskId);

    -- Voice jobs
    CREATE TABLE IF NOT EXISTS voice_jobs (
      id TEXT PRIMARY KEY,
      composerKey TEXT NOT NULL,
      taskId TEXT,
      targetSessionId TEXT,
      status TEXT NOT NULL,
      audioPath TEXT NOT NULL,
      transcript TEXT,
      error TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_voice_jobs_composer ON voice_jobs(composerKey);
    CREATE INDEX IF NOT EXISTS idx_voice_jobs_target_session ON voice_jobs(targetSessionId);
    CREATE INDEX IF NOT EXISTS idx_voice_jobs_status ON voice_jobs(status);
    CREATE INDEX IF NOT EXISTS idx_voice_jobs_updated ON voice_jobs(updatedAt);

    -- Docs knowledge base — structured metadata table
    CREATE TABLE IF NOT EXISTS docs_pages (
      rowid INTEGER PRIMARY KEY,
      path TEXT UNIQUE NOT NULL,
      title TEXT,
      tags TEXT,
      body TEXT,
      frontmatter_json TEXT,
      folder TEXT,
      created TEXT,
      modified TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_docs_pages_folder ON docs_pages(folder);

    -- Telemetry spans (performance profiling)
    CREATE TABLE IF NOT EXISTS telemetry_spans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      sessionId TEXT,
      duration REAL NOT NULL,
      metadata TEXT,
      source TEXT NOT NULL,
      createdAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_telemetry_name ON telemetry_spans(name);
    CREATE INDEX IF NOT EXISTS idx_telemetry_session ON telemetry_spans(sessionId);
    CREATE INDEX IF NOT EXISTS idx_telemetry_created ON telemetry_spans(createdAt);
    CREATE TABLE IF NOT EXISTS telemetry_ingest_keys (
      id TEXT PRIMARY KEY,
      createdAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_telemetry_ingest_keys_created ON telemetry_ingest_keys(createdAt);

    -- Tags
    CREATE TABLE IF NOT EXISTS tags (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      color TEXT NOT NULL DEFAULT 'slate',
      instructions TEXT NOT NULL DEFAULT '',
      "order" INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );

    -- Tag ↔ Entity junction
    CREATE TABLE IF NOT EXISTS entity_tags (
      entityType TEXT NOT NULL,
      entityId TEXT NOT NULL,
      tagId TEXT NOT NULL,
      PRIMARY KEY (entityType, entityId, tagId),
      FOREIGN KEY (tagId) REFERENCES tags(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_entity_tags_tag ON entity_tags(tagId);

    -- Tag ↔ MCP server configs
    CREATE TABLE IF NOT EXISTS tag_mcp_servers (
      tagId TEXT NOT NULL,
      serverName TEXT NOT NULL,
      config TEXT NOT NULL,
      PRIMARY KEY (tagId, serverName),
      FOREIGN KEY (tagId) REFERENCES tags(id) ON DELETE CASCADE
    );

    -- Deferred prompts (same-session deferred execution)
    CREATE TABLE IF NOT EXISTS deferred_prompts (
      id TEXT PRIMARY KEY,
      sessionId TEXT NOT NULL,
      prompt TEXT NOT NULL,
      runAt TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      claimToken TEXT,
      leaseExpiresAt TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      lastError TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_deferred_prompts_status_runAt
      ON deferred_prompts(status, runAt);
    CREATE INDEX IF NOT EXISTS idx_deferred_prompts_sessionId_status_runAt
      ON deferred_prompts(sessionId, status, runAt);
  `);

  // ── Migrations ──────────────────────────────────────────────────
  // Add linkedAt column to task_sessions if missing (existing rows get a fixed fallback)
  const cols = db.prepare("PRAGMA table_info(task_sessions)").all() as any[];
  if (!cols.some((c: any) => c.name === "linkedAt")) {
    db.exec("ALTER TABLE task_sessions ADD COLUMN linkedAt TEXT NOT NULL DEFAULT '2000-01-01T00:00:00Z'");
  }

  const sessionMetaCols = db.prepare("PRAGMA table_info(session_meta)").all() as any[];
  if (!sessionMetaCols.some((c: any) => c.name === "lastVisibleActivityAt")) {
    db.exec("ALTER TABLE session_meta ADD COLUMN lastVisibleActivityAt TEXT");
  }
  db.exec("CREATE INDEX IF NOT EXISTS idx_session_meta_lastVisibleActivityAt ON session_meta(lastVisibleActivityAt)");

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

  // Migrate reuse-target → reuse-last using the former target as the last session.
  // New writes can no longer create explicit target schedules, but this preserves
  // existing same-session schedule behavior without keeping the removed mode.
  db.exec(`
    UPDATE schedules
    SET sessionMode = 'reuse-last',
        lastSessionId = targetSessionId,
        reuseLastRequiresExistingSession = 1,
        targetSessionId = NULL
    WHERE sessionMode = 'reuse-target';

    DELETE FROM schedule_session_claims
    WHERE scheduleId NOT IN (
      SELECT id FROM schedules WHERE sessionMode = 'reuse-last'
    );
  `);

  // Backfill schedule run history from prior metadata and latest schedule state
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

  const tableExists = (tableName: string): boolean =>
    !!db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName);
  const getTableInfo = (tableName: string): any[] =>
    tableExists(tableName) ? (db.prepare(`PRAGMA table_info(${tableName})`).all() as any[]) : [];

  // Migrate legacy Bridge todos -> checklist_items, then normalize checklist_items schema.
  db.exec("BEGIN");
  try {
    if (tableExists("todos")) {
      const legacyTodoCols = getTableInfo("todos");
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

    const checklistItemCols = getTableInfo("checklist_items");
    if (!checklistItemCols.some((c: any) => c.name === "deadline")) {
      db.exec("ALTER TABLE checklist_items ADD COLUMN deadline TEXT");
    }

    const normalizedChecklistItemCols = getTableInfo("checklist_items");
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

  // Add notes column to task_groups
  const groupCols = db.prepare("PRAGMA table_info(task_groups)").all() as any[];
  if (!groupCols.some((c: any) => c.name === "notes")) {
    db.exec("ALTER TABLE task_groups ADD COLUMN notes TEXT NOT NULL DEFAULT ''");
  }

  // Add task kind and optional momentum columns to tasks
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
  db.exec("UPDATE tasks SET status = 'active' WHERE status = 'paused'");
  db.exec(`
    UPDATE tasks
    SET nextAction = NULL, waitingOn = NULL, nextTouchAt = NULL
    WHERE status != 'active'
      AND (nextAction IS NOT NULL OR waitingOn IS NOT NULL OR nextTouchAt IS NOT NULL)
  `);
  taskCols = db.prepare("PRAGMA table_info(tasks)").all() as any[];
  if (taskCols.some((c: any) => c.name === "pinned")) rebuildTasksWithoutLegacyTaskColumn(db);
  db.exec(`
    UPDATE tasks
    SET
      status = CASE WHEN status = 'done' THEN 'active' ELSE status END,
      doneWhen = NULL
    WHERE kind = 'ongoing'
      AND (status = 'done' OR doneWhen IS NOT NULL);
  `);
  db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status)");
  db.exec("CREATE INDEX IF NOT EXISTS idx_tasks_nextTouchAt ON tasks(nextTouchAt)");

  // Migrate task_work_items.itemId from INTEGER to TEXT for string-based identifiers (e.g. Linear "ENG-123")
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

  // Docs FTS5 virtual table (separate from main schema — FTS5 needs special handling)
  try {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
        path, title, tags, body,
        content='docs_pages', content_rowid='rowid'
      );
    `);
  } catch {
    // FTS5 table already exists or other issue — safe to ignore
  }
}

export type { DatabaseSync };
