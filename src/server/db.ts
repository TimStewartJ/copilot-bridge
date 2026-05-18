// Database module — single SQLite database for all app data
// Uses Node.js built-in node:sqlite (DatabaseSync)

import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { runDatabaseMigrations } from "./db-migrations.js";
const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_FILENAME = "bridge.db";
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
  "bridge_session_state",
  "session_workspace",
  "settings",
  "session_titles",
  "schedules",
  "schedule_runs",
  "schedule_run_claims",
  "read_state",
  "checklist_items",
  "feed_cards",
  "voice_jobs",
  "tags",
  "entity_tags",
  "tag_mcp_servers",
  "mcp_servers",
  "tag_mcp_server_refs",
  "deferred_prompts",
  "defer_loops",
  "push_subscriptions",
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

function initSchema(db: DatabaseSync): void {
  db.exec(`
    -- Tasks
    CREATE TABLE IF NOT EXISTS tasks (
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

    -- Bridge-owned session UX state overlay
    CREATE TABLE IF NOT EXISTS bridge_session_state (
      sessionId TEXT PRIMARY KEY,
      archived INTEGER NOT NULL DEFAULT 0,
      archivedAt TEXT,
      titleOverride TEXT,
      titleOverrideUpdatedAt TEXT,
      pinnedCwd TEXT,
      pinnedCwdUpdatedAt TEXT,
      triggeredBy TEXT,
      scheduleId TEXT,
      scheduleName TEXT,
      lastVisibleActivityAt TEXT,
      lastAttentionAt TEXT,
      hiddenReason TEXT,
      hiddenAt TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bridge_session_state_archived
      ON bridge_session_state(archived);
    CREATE INDEX IF NOT EXISTS idx_bridge_session_state_lastVisibleActivityAt
      ON bridge_session_state(lastVisibleActivityAt);

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
    -- Settings (key-value, main entry is key='app')
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      appliedAt TEXT NOT NULL
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

    -- Agent-published dashboard feed cards
    CREATE TABLE IF NOT EXISTS feed_cards (
      id TEXT PRIMARY KEY,
      dedupeKey TEXT,
      title TEXT NOT NULL,
      body TEXT,
      kind TEXT NOT NULL DEFAULT 'note',
      priority TEXT NOT NULL DEFAULT 'normal',
      status TEXT NOT NULL DEFAULT 'active',
      taskId TEXT REFERENCES tasks(id) ON DELETE SET NULL,
      sessionId TEXT,
      url TEXT,
      linksJson TEXT NOT NULL DEFAULT '[]',
      metadataJson TEXT,
      visualJson TEXT,
      actionJson TEXT,
      pinned INTEGER NOT NULL DEFAULT 0,
      statusChangedAt TEXT NOT NULL,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_feed_cards_dedupeKey
      ON feed_cards(dedupeKey) WHERE dedupeKey IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_feed_cards_status_updated
      ON feed_cards(status, pinned DESC, updatedAt DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_feed_cards_status_created
      ON feed_cards(status, pinned DESC, createdAt DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_feed_cards_status_changed
      ON feed_cards(status, statusChangedAt DESC, id DESC);
    CREATE INDEX IF NOT EXISTS idx_feed_cards_taskId ON feed_cards(taskId);
    CREATE INDEX IF NOT EXISTS idx_feed_cards_sessionId ON feed_cards(sessionId);
    CREATE INDEX IF NOT EXISTS idx_feed_cards_kind ON feed_cards(kind);

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

    -- Canonical MCP server registry
    CREATE TABLE IF NOT EXISTS mcp_servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL UNIQUE COLLATE NOCASE,
      config TEXT NOT NULL,
      enabledByDefault INTEGER NOT NULL DEFAULT 0,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_mcp_servers_enabledByDefault ON mcp_servers(enabledByDefault);

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

    -- Tag ↔ canonical MCP server references
    CREATE TABLE IF NOT EXISTS tag_mcp_server_refs (
      tagId TEXT NOT NULL,
      serverId TEXT NOT NULL,
      PRIMARY KEY (tagId, serverId),
      FOREIGN KEY (tagId) REFERENCES tags(id) ON DELETE CASCADE,
      FOREIGN KEY (serverId) REFERENCES mcp_servers(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_tag_mcp_server_refs_server ON tag_mcp_server_refs(serverId);

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

    -- Recurring same-session deferred execution loops
    CREATE TABLE IF NOT EXISTS defer_loops (
      id TEXT PRIMARY KEY,
      sessionId TEXT NOT NULL,
      name TEXT,
      prompt TEXT NOT NULL,
      intervalSeconds INTEGER NOT NULL,
      nextRunAt TEXT NOT NULL,
      status TEXT NOT NULL,
      runCount INTEGER NOT NULL DEFAULT 0,
      maxRuns INTEGER,
      expiresAt TEXT,
      attempts INTEGER NOT NULL DEFAULT 0,
      claimToken TEXT,
      leaseExpiresAt TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      lastError TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_defer_loops_status_nextRunAt
      ON defer_loops(status, nextRunAt);
    CREATE INDEX IF NOT EXISTS idx_defer_loops_sessionId_status_nextRunAt
      ON defer_loops(sessionId, status, nextRunAt);

    -- Browser Web Push subscriptions
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id TEXT PRIMARY KEY,
      endpoint TEXT NOT NULL UNIQUE,
      expirationTime INTEGER,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      userAgent TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      lastSeenAt TEXT NOT NULL
    );
  `);

  // Ordered, idempotent compatibility migrations live in db-migrations.ts so
  // legacy state handling is tracked in one place instead of being scattered here.
  runDatabaseMigrations(db);

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
