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
  "management_jobs",
  "session_context_summary",
  "session_context_turns",
  "session_context_events",
  "session_context_backfills",
] as const;
type SqliteStateTable = typeof SQLITE_STATE_TABLES[number];

export type DocsFtsFailureDetectedBy =
  | "create_virtual_table"
  | "schema_probe"
  | "smoke_query"
  | "repair";

export interface DocsFtsFailure {
  code: "docs_fts_init_failed";
  message: string;
  cause: string;
  detectedBy: DocsFtsFailureDetectedBy;
  checkedAt: string;
}

export type DocsFtsHealth =
  | {
      ok: true;
      status: "available";
      checkedAt: string;
      /**
       * Process-local signal that this connection repaired docs_fts while opening
       * or rechecking the database. The source of truth remains docs_pages/files.
       */
      repaired?: boolean;
      previousFailure?: DocsFtsFailure;
      repairMessage?: string;
      quarantinedTable?: string;
    }
  | (DocsFtsFailure & {
      ok: false;
      status: "unavailable";
      previousFailure?: DocsFtsFailure;
    });

const docsFtsHealthByDb = new WeakMap<DatabaseSync, DocsFtsHealth>();
const docsFtsWarningLoggedByDb = new WeakSet<DatabaseSync>();
const docsFtsRepairLoggedByDb = new WeakSet<DatabaseSync>();
const DOCS_FTS_SHADOW_TABLES = [
  "docs_fts_config",
  "docs_fts_content",
  "docs_fts_data",
  "docs_fts_docsize",
  "docs_fts_idx",
] as const;

interface DocsFtsInitializeOptions {
  warnOnFailure?: boolean;
  warnOnRepair?: boolean;
  repair?: boolean;
  rebuild?: boolean;
}

interface DocsFtsRepairResult {
  health: Extract<DocsFtsHealth, { ok: true }>;
  actions: string[];
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function quoteSqlIdentifier(identifier: string): string {
  return `"${identifier.replace(/"/g, "\"\"")}"`;
}

function unavailableDocsFtsFailure(
  detectedBy: DocsFtsFailureDetectedBy,
  cause: string,
): DocsFtsFailure {
  return {
    code: "docs_fts_init_failed",
    message: "Docs full-text search initialization failed. Docs search and reindex operations are unavailable until the docs_fts schema is repaired.",
    cause,
    detectedBy,
    checkedAt: new Date().toISOString(),
  };
}

function unavailableDocsFtsHealth(detectedBy: DocsFtsFailureDetectedBy, cause: string): Extract<DocsFtsHealth, { ok: false }> {
  return {
    ok: false,
    status: "unavailable",
    ...unavailableDocsFtsFailure(detectedBy, cause),
  };
}

function availableDocsFtsHealth(options: Partial<Extract<DocsFtsHealth, { ok: true }>> = {}): Extract<DocsFtsHealth, { ok: true }> {
  return {
    ok: true,
    status: "available",
    checkedAt: new Date().toISOString(),
    ...options,
  };
}

function recordDocsFtsHealth(db: DatabaseSync, health: DocsFtsHealth, options: DocsFtsInitializeOptions = {}): DocsFtsHealth {
  docsFtsHealthByDb.set(db, health);
  if (!health.ok && options.warnOnFailure !== false && !docsFtsWarningLoggedByDb.has(db)) {
    docsFtsWarningLoggedByDb.add(db);
    console.warn(`[docs-fts] ${health.message} Detected by ${health.detectedBy}. Cause: ${health.cause}`);
  }
  if (health.ok && health.repaired && options.warnOnRepair !== false && !docsFtsRepairLoggedByDb.has(db)) {
    docsFtsRepairLoggedByDb.add(db);
    const previous = health.previousFailure;
    const quarantine = health.quarantinedTable ? ` Quarantined conflicting table as ${health.quarantinedTable}.` : "";
    console.warn(`[docs-fts] Repaired docs full-text search index.${quarantine}${previous ? ` Previous failure detected by ${previous.detectedBy}: ${previous.cause}` : ""}`);
  }
  return health;
}

function getDocsFtsSchemaRow(db: DatabaseSync): { type?: string; sql?: string } | undefined {
  return db.prepare("SELECT type, sql FROM sqlite_master WHERE name = 'docs_fts'").get() as { type?: string; sql?: string } | undefined;
}

function isFts5VirtualTableSql(sql: string | undefined): boolean {
  const normalizedSql = (sql ?? "").toLowerCase().replace(/\s+/g, " ");
  return normalizedSql.includes("create virtual table") && normalizedSql.includes("using fts5");
}

function validateDocsFtsSchema(db: DatabaseSync): DocsFtsFailure | null {
  const row = getDocsFtsSchemaRow(db);
  const sql = row?.sql;
  if (!sql) {
    return unavailableDocsFtsFailure("schema_probe", "docs_fts was not found in sqlite_master after setup");
  }

  const normalizedSql = sql.toLowerCase().replace(/\s+/g, " ");
  const hasExpectedShape = isFts5VirtualTableSql(sql)
    && /\bpath\b/.test(normalizedSql)
    && /\btitle\b/.test(normalizedSql)
    && /\btags\b/.test(normalizedSql)
    && /\bbody\b/.test(normalizedSql)
    && normalizedSql.includes("content='docs_pages'")
    && normalizedSql.includes("content_rowid='rowid'");

  if (!hasExpectedShape) {
    return unavailableDocsFtsFailure("schema_probe", `docs_fts exists but is not the expected external-content FTS5 table: ${sql}`);
  }

  return null;
}

function createDocsFtsTable(db: DatabaseSync): void {
  db.exec(`
    CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
      path, title, tags, body,
      content='docs_pages', content_rowid='rowid'
    );
  `);
}

function probeDocsFts(db: DatabaseSync): DocsFtsFailure | null {
  const schemaFailure = validateDocsFtsSchema(db);
  if (schemaFailure) return schemaFailure;

  try {
    db.prepare(`
      SELECT snippet(docs_fts, 3, '', '', '', 1) as snippet
      FROM docs_fts
      WHERE docs_fts MATCH ?
      LIMIT 0
    `).all("\"__bridge_docs_fts_probe__\"");
  } catch (error) {
    return unavailableDocsFtsFailure("smoke_query", getErrorMessage(error));
  }

  return null;
}

function attemptInitializeDocsFts(db: DatabaseSync): DocsFtsHealth {
  try {
    createDocsFtsTable(db);
  } catch (error) {
    return {
      ok: false,
      status: "unavailable",
      ...unavailableDocsFtsFailure("create_virtual_table", getErrorMessage(error)),
    };
  }

  const probeFailure = probeDocsFts(db);
  if (probeFailure) return { ok: false, status: "unavailable", ...probeFailure };
  return availableDocsFtsHealth();
}

function listDocsFtsShadowTables(db: DatabaseSync): string[] {
  return DOCS_FTS_SHADOW_TABLES.filter((name) =>
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
  );
}

function createQuarantineTableName(db: DatabaseSync): string {
  let suffix = Date.now().toString(36);
  let candidate = `quarantined_docs_fts_${suffix}`;
  let index = 0;
  while (db.prepare("SELECT 1 FROM sqlite_master WHERE name = ?").get(candidate)) {
    index += 1;
    suffix = `${Date.now().toString(36)}_${index}`;
    candidate = `quarantined_docs_fts_${suffix}`;
  }
  return candidate;
}

function runInImmediateTransaction<T>(db: DatabaseSync, operation: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Preserve the original repair failure.
    }
    throw error;
  }
}

function repairDocsFtsCache(db: DatabaseSync, previousFailure: DocsFtsFailure, options: DocsFtsInitializeOptions): DocsFtsRepairResult {
  return runInImmediateTransaction(db, () => {
    const actions: string[] = [];
    let quarantinedTable: string | undefined;
    const existing = getDocsFtsSchemaRow(db);

    if (existing?.sql) {
      if (isFts5VirtualTableSql(existing.sql)) {
        db.exec("DROP TABLE IF EXISTS docs_fts");
        actions.push("dropped existing docs_fts virtual table");
      } else if (existing.type === "table") {
        quarantinedTable = createQuarantineTableName(db);
        db.exec(`ALTER TABLE docs_fts RENAME TO ${quoteSqlIdentifier(quarantinedTable)}`);
        actions.push(`quarantined conflicting docs_fts table as ${quarantinedTable}`);
      } else {
        throw new Error(`Cannot repair docs_fts because an unsupported ${existing.type ?? "object"} named docs_fts exists`);
      }
    }

    for (const shadowTable of listDocsFtsShadowTables(db)) {
      db.exec(`DROP TABLE IF EXISTS ${quoteSqlIdentifier(shadowTable)}`);
      actions.push(`dropped leftover docs FTS shadow table ${shadowTable}`);
    }

    createDocsFtsTable(db);
    actions.push("created docs_fts virtual table");

    if (options.rebuild !== false) {
      db.exec("INSERT INTO docs_fts(docs_fts) VALUES('rebuild')");
      actions.push("rebuilt docs_fts from docs_pages");
    }

    const probeFailure = probeDocsFts(db);
    if (probeFailure) {
      throw new Error(`docs_fts still failed validation after repair: ${probeFailure.cause}`);
    }

    return {
      actions,
      health: availableDocsFtsHealth({
        repaired: true,
        previousFailure,
        repairMessage: actions.join("; "),
        ...(quarantinedTable ? { quarantinedTable } : {}),
      }),
    };
  });
}

export function initializeDocsFts(db: DatabaseSync, options: DocsFtsInitializeOptions = {}): DocsFtsHealth {
  const health = attemptInitializeDocsFts(db);
  if (health.ok || options.repair === false) return recordDocsFtsHealth(db, health, options);

  try {
    const repaired = repairDocsFtsCache(db, health, options);
    return recordDocsFtsHealth(db, repaired.health, options);
  } catch (repairError) {
    const failedRepair = unavailableDocsFtsHealth(
      "repair",
      `Initial failure detected by ${health.detectedBy}: ${health.cause}. Repair failed: ${getErrorMessage(repairError)}`,
    );
    failedRepair.previousFailure = health;
    return recordDocsFtsHealth(db, failedRepair, options);
  }
}

export function getDocsFtsHealth(db: DatabaseSync): DocsFtsHealth {
  return docsFtsHealthByDb.get(db)
    ?? unavailableDocsFtsHealth("schema_probe", "docs FTS health was not recorded for this database connection");
}

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
  db.exec("PRAGMA busy_timeout = 5000");
  db.exec("PRAGMA foreign_keys = ON");

  initSchema(db);
  return db;
}

/** Open an in-memory database (for tests) */
export function openMemoryDatabase(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec("PRAGMA busy_timeout = 5000");
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
      terminalOverlayJson TEXT,
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
    CREATE INDEX IF NOT EXISTS idx_schedules_enabled_nextRunAt ON schedules(enabled, nextRunAt);
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
    CREATE INDEX IF NOT EXISTS idx_feed_cards_updatedAt ON feed_cards(updatedAt, kind);

    -- Voice jobs
    CREATE TABLE IF NOT EXISTS voice_jobs (
      id TEXT PRIMARY KEY,
      composerKey TEXT NOT NULL,
      taskId TEXT REFERENCES tasks(id) ON DELETE SET NULL,
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
    CREATE INDEX IF NOT EXISTS idx_voice_jobs_taskId ON voice_jobs(taskId);

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

    -- Provider-neutral per-session context telemetry
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
      nameKey TEXT NOT NULL,
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

    -- Durable management jobs (self update / staging preview / staging deploy)
    CREATE TABLE IF NOT EXISTS management_jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      input TEXT NOT NULL DEFAULT '{}',
      result TEXT,
      error TEXT,
      logPath TEXT,
      runnerPid INTEGER,
      heartbeatAt TEXT,
      cancelRequestedAt TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      startedAt TEXT,
      completedAt TEXT,
      CHECK (type IN ('self_update', 'staging_preview', 'staging_deploy')),
      CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'cancelled'))
    );
    CREATE INDEX IF NOT EXISTS idx_management_jobs_status_created
      ON management_jobs(status, createdAt);
    CREATE INDEX IF NOT EXISTS idx_management_jobs_active_update_deploy
      ON management_jobs(type, status, createdAt);
    CREATE INDEX IF NOT EXISTS idx_management_jobs_heartbeat
      ON management_jobs(status, heartbeatAt);
  `);

  // Ordered, idempotent compatibility migrations live in db-migrations.ts so
  // legacy state handling is tracked in one place instead of being scattered here.
  runDatabaseMigrations(db);

  // Docs FTS5 virtual table (separate from main schema — FTS5 needs special handling)
  initializeDocsFts(db);
}

export type { DatabaseSync };
