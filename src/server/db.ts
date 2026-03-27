// Database module — single SQLite database for all app data
// Uses Node.js built-in node:sqlite (DatabaseSync)

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_FILENAME = "bridge.db";

/** Open (or create) the bridge database and initialize schema */
export function openDatabase(dataDir: string): DatabaseSync {
  if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });

  const dbPath = join(dataDir, DB_FILENAME);
  const db = new DatabaseSync(dbPath);

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

function initSchema(db: DatabaseSync): void {
  db.exec(`
    -- Tasks
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      groupId TEXT,
      cwd TEXT,
      notes TEXT NOT NULL DEFAULT '',
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
      itemId INTEGER NOT NULL,
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
      scheduleName TEXT
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
      reuseSession INTEGER NOT NULL DEFAULT 0,
      lastSessionId TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      lastRunAt TEXT,
      nextRunAt TEXT,
      runCount INTEGER NOT NULL DEFAULT 0,
      maxRuns INTEGER,
      expiresAt TEXT
    );

    -- Read state
    CREATE TABLE IF NOT EXISTS read_state (
      sessionId TEXT PRIMARY KEY,
      lastReadAt TEXT NOT NULL
    );

    -- Todos (per-task checklists or global/unparented)
    CREATE TABLE IF NOT EXISTS todos (
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
    CREATE INDEX IF NOT EXISTS idx_todos_taskId ON todos(taskId);

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
  `);

  // ── Migrations ──────────────────────────────────────────────────
  // Add linkedAt column to task_sessions if missing (existing rows get a fixed fallback)
  const cols = db.prepare("PRAGMA table_info(task_sessions)").all() as any[];
  if (!cols.some((c: any) => c.name === "linkedAt")) {
    db.exec("ALTER TABLE task_sessions ADD COLUMN linkedAt TEXT NOT NULL DEFAULT '2000-01-01T00:00:00Z'");
  }

  // Add deadline column to todos
  const todoCols = db.prepare("PRAGMA table_info(todos)").all() as any[];
  if (!todoCols.some((c: any) => c.name === "deadline")) {
    db.exec('ALTER TABLE todos ADD COLUMN deadline TEXT');
  }

  // Make taskId nullable for global (unparented) todos
  const todoInfo = db.prepare("PRAGMA table_info(todos)").all() as any[];
  const taskIdCol = todoInfo.find((c: any) => c.name === "taskId");
  if (taskIdCol && taskIdCol.notnull === 1) {
    db.exec(`
      CREATE TABLE todos_new (
        id TEXT PRIMARY KEY,
        taskId TEXT REFERENCES tasks(id) ON DELETE CASCADE,
        text TEXT NOT NULL,
        done INTEGER NOT NULL DEFAULT 0,
        "order" INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL,
        completedAt TEXT,
        deadline TEXT
      );
      INSERT INTO todos_new (id, taskId, text, done, "order", createdAt, completedAt, deadline)
        SELECT id, taskId, text, done, "order", createdAt, completedAt, deadline FROM todos;
      DROP TABLE todos;
      ALTER TABLE todos_new RENAME TO todos;
      CREATE INDEX IF NOT EXISTS idx_todos_taskId ON todos(taskId);
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
