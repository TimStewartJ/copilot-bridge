import type { DatabaseSync } from "node:sqlite";

export const MINIMUM_SUPPORTED_DATABASE_BASELINE = "0e363e6 (2026-08-07)";
// This historical id is now a permanent baseline sentinel and must never be reused.
export const MINIMUM_SUPPORTED_DATABASE_MIGRATION = "task-work-items-canonicalize-item-id";

interface DatabaseMigration {
  id: string;
  description: string;
  apply(db: DatabaseSync): void;
}

export interface DatabaseMigrationInfo {
  id: string;
  runMode: "once";
  transaction: "auto";
  description: string;
}

const REQUIRED_BASELINE_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  tasks: ["kind", "muted", "status", "doneWhen", "nextAction", "waitingOn", "nextTouchAt", "completedAt"],
  task_sessions: ["linkedAt"],
  task_work_items: ["itemId", "provider"],
  task_groups: ["notes"],
  checklist_items: ["taskId", "deadline"],
  bridge_session_state: ["lastAttentionAt", "terminalOverlayJson"],
  schedules: ["autoArchiveKeep", "model"],
  feed_cards: ["visualJson", "actionJson"],
  voice_jobs: ["taskId"],
  tags: ["nameKey"],
  mcp_servers: ["config", "enabledByDefault"],
  tag_mcp_server_refs: ["tagId", "serverId"],
  session_context_summary: ["provenanceJson"],
  session_context_turns: ["bridgeTurnId"],
  session_context_events: ["provenanceJson"],
  session_context_backfills: ["eventsPath"],
  copilot_model_prices: ["metadataJson"],
  copilot_usage_sessions: ["parserVersion"],
  copilot_usage_scan_state: ["completedAt"],
};

const RETIRED_TABLES = [
  "todos",
  "session_meta",
  "session_titles",
  "session_workspace",
  "schedule_session_claims",
] as const;

const RETIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
  tasks: ["pinned"],
  schedules: ["sessionMode", "targetSessionId", "reuseLastRequiresExistingSession", "reuseSession"],
};

function sqliteTableExists(db: DatabaseSync, tableName: string): boolean {
  return !!db.prepare("SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName);
}

function getTableInfo(db: DatabaseSync, tableName: string): Array<{ name: string; type: string; notnull: number }> {
  return db.prepare(`PRAGMA table_info(${tableName})`).all() as Array<{
    name: string;
    type: string;
    notnull: number;
  }>;
}

function hasSchemaMigration(db: DatabaseSync, id: string): boolean {
  if (!sqliteTableExists(db, "schema_migrations")) return false;
  const row = db.prepare("SELECT 1 AS found FROM schema_migrations WHERE id = ?").get(id) as
    | { found?: number }
    | undefined;
  return row?.found === 1;
}

function markSchemaMigration(db: DatabaseSync, id: string): void {
  db.prepare(`
    INSERT INTO schema_migrations (id, appliedAt)
    VALUES (?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT(id) DO NOTHING
  `).run(id);
}

function unsupportedBaselineError(issues: readonly string[]): Error {
  return new Error(
    `Unsupported Bridge database: this release requires baseline ${MINIMUM_SUPPORTED_DATABASE_BASELINE}. `
      + `Restore or run an older Bridge release to finish migration first. Problems: ${issues.join("; ")}`,
  );
}

export function assertDatabaseMeetsMinimumBaseline(db: DatabaseSync): void {
  const issues: string[] = [];
  if (!hasSchemaMigration(db, MINIMUM_SUPPORTED_DATABASE_MIGRATION)) {
    issues.push(`missing migration marker ${MINIMUM_SUPPORTED_DATABASE_MIGRATION}`);
  }

  for (const [tableName, requiredColumns] of Object.entries(REQUIRED_BASELINE_COLUMNS)) {
    if (!sqliteTableExists(db, tableName)) {
      issues.push(`missing table ${tableName}`);
      continue;
    }
    const columns = getTableInfo(db, tableName);
    const columnNames = new Set(columns.map((column) => column.name));
    for (const columnName of requiredColumns) {
      if (!columnNames.has(columnName)) issues.push(`missing column ${tableName}.${columnName}`);
    }
  }

  for (const tableName of RETIRED_TABLES) {
    if (sqliteTableExists(db, tableName)) issues.push(`retired table ${tableName} still exists`);
  }
  for (const [tableName, retiredColumns] of Object.entries(RETIRED_COLUMNS)) {
    if (!sqliteTableExists(db, tableName)) continue;
    const columnNames = new Set(getTableInfo(db, tableName).map((column) => column.name));
    for (const columnName of retiredColumns) {
      if (columnNames.has(columnName)) issues.push(`retired column ${tableName}.${columnName} still exists`);
    }
  }

  if (sqliteTableExists(db, "task_work_items")) {
    const itemId = getTableInfo(db, "task_work_items").find((column) => column.name === "itemId");
    if (itemId && itemId.type.toUpperCase() !== "TEXT") {
      issues.push(`task_work_items.itemId has type ${itemId.type || "(none)"} instead of TEXT`);
    }
  }
  if (sqliteTableExists(db, "checklist_items")) {
    const taskId = getTableInfo(db, "checklist_items").find((column) => column.name === "taskId");
    if (taskId?.notnull === 1) issues.push("checklist_items.taskId does not allow global items");
  }
  if (sqliteTableExists(db, "voice_jobs")) {
    const foreignKeys = db.prepare("PRAGMA foreign_key_list(voice_jobs)").all() as Array<{
      table?: string;
      from?: string;
      on_delete?: string;
    }>;
    const hasTaskSetNull = foreignKeys.some(
      (foreignKey) =>
        foreignKey.table === "tasks"
        && foreignKey.from === "taskId"
        && String(foreignKey.on_delete ?? "").toUpperCase() === "SET NULL",
    );
    if (!hasTaskSetNull) issues.push("voice_jobs.taskId is missing its ON DELETE SET NULL foreign key");
  }

  if (issues.length > 0) throw unsupportedBaselineError(issues);
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

function dropRetiredTagMcpServersTable(db: DatabaseSync): void {
  if (!sqliteTableExists(db, "tag_mcp_servers")) return;
  const rowCount = (db.prepare("SELECT COUNT(*) AS count FROM tag_mcp_servers").get() as { count: number }).count;
  if (rowCount > 0) {
    throw new Error(
      `Refusing to drop tag_mcp_servers because ${rowCount} legacy row(s) remain. `
        + "Run an older Bridge release to migrate or repair them first.",
    );
  }
  db.exec("DROP TABLE tag_mcp_servers");
}

function addScheduleLaunchOptionColumns(db: DatabaseSync): void {
  const columns = getTableInfo(db, "schedules");
  if (!columns.some((column) => column.name === "reasoningEffort")) {
    db.exec("ALTER TABLE schedules ADD COLUMN reasoningEffort TEXT");
  }
  if (!columns.some((column) => column.name === "contextTier")) {
    db.exec("ALTER TABLE schedules ADD COLUMN contextTier TEXT");
  }
}

function addForkAutoNameColumns(db: DatabaseSync): void {
  const columns = getTableInfo(db, "bridge_session_state");
  if (!columns.some((column) => column.name === "pendingAutoName")) {
    db.exec("ALTER TABLE bridge_session_state ADD COLUMN pendingAutoName INTEGER NOT NULL DEFAULT 0");
  }
  if (!columns.some((column) => column.name === "pendingAutoNameReplaceTitle")) {
    db.exec("ALTER TABLE bridge_session_state ADD COLUMN pendingAutoNameReplaceTitle TEXT");
  }
}

const DATABASE_MIGRATIONS: readonly DatabaseMigration[] = [
  {
    id: "legacy-tag-mcp-servers-drop-v1",
    description: "Drop the retired per-tag MCP configuration table after verifying that no rows remain.",
    apply: dropRetiredTagMcpServersTable,
  },
  {
    id: "schedule-launch-option-columns-v1",
    description: "Add optional reasoning effort and context tier overrides to supported baseline databases.",
    apply: addScheduleLaunchOptionColumns,
  },
  {
    id: "fork-auto-name-columns-v1",
    description: "Track fork sessions that should be auto-named from their next user message.",
    apply: addForkAutoNameColumns,
  },
];

export function listDatabaseMigrations(): readonly DatabaseMigrationInfo[] {
  return DATABASE_MIGRATIONS.map((migration) => ({
    id: migration.id,
    runMode: "once",
    transaction: "auto",
    description: migration.description,
  }));
}

export function recordFreshDatabaseMigrations(db: DatabaseSync): void {
  markSchemaMigration(db, MINIMUM_SUPPORTED_DATABASE_MIGRATION);
  for (const migration of DATABASE_MIGRATIONS) markSchemaMigration(db, migration.id);
}

export function runDatabaseMigrations(db: DatabaseSync): void {
  for (const migration of DATABASE_MIGRATIONS) {
    if (hasSchemaMigration(db, migration.id)) continue;
    try {
      runMigrationInTransaction(db, () => {
        migration.apply(db);
        markSchemaMigration(db, migration.id);
      });
    } catch (error) {
      throw new Error(`Database migration "${migration.id}" failed: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    }
  }
}
