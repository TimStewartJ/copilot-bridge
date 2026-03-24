// One-time migration: JSON files → SQLite
// Runs automatically on first startup if JSON files exist and SQLite tables are empty.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatabaseSync } from "./db.js";

export function migrateJsonToSqlite(db: DatabaseSync, dataDir: string): void {
  // Check if migration is needed: if tasks table already has rows, skip
  const count = (db.prepare("SELECT COUNT(*) as cnt FROM tasks").get() as any).cnt;
  if (count > 0) return;

  const tasksFile = join(dataDir, "tasks.json");
  if (!existsSync(tasksFile)) return; // no JSON data to migrate

  console.log("[migrate] Migrating JSON data to SQLite...");

  // Wrap everything in a transaction for atomicity
  db.exec("BEGIN");
  try {
    migrateTasks(db, dataDir);
    migrateTaskGroups(db, dataDir);
    migrateSessionMeta(db, dataDir);
    migrateSettings(db, dataDir);
    migrateSessionTitles(db, dataDir);
    migrateSchedules(db, dataDir);
    migrateReadState(db, dataDir);
    db.exec("COMMIT");
    console.log("[migrate] ✅ Migration complete. JSON files kept as backup.");
  } catch (err) {
    db.exec("ROLLBACK");
    console.error("[migrate] ❌ Migration failed, rolled back:", err);
    throw err;
  }
}

function loadJson(dataDir: string, filename: string): any {
  const path = join(dataDir, filename);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

function migrateTasks(db: DatabaseSync, dataDir: string): void {
  const tasks = loadJson(dataDir, "tasks.json");
  if (!Array.isArray(tasks)) return;

  const insertTask = db.prepare(`
    INSERT INTO tasks (id, title, status, groupId, cwd, notes, priority, "order", createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertSession = db.prepare(
    "INSERT OR IGNORE INTO task_sessions (taskId, sessionId) VALUES (?, ?)",
  );
  const insertWorkItem = db.prepare(
    "INSERT OR IGNORE INTO task_work_items (taskId, itemId, provider) VALUES (?, ?, ?)",
  );
  const insertPR = db.prepare(
    "INSERT OR IGNORE INTO task_pull_requests (taskId, repoId, repoName, prId, provider) VALUES (?, ?, ?, ?, ?)",
  );

  for (const t of tasks) {
    // Handle legacy workItemIds migration
    const workItems = Array.isArray(t.workItems)
      ? t.workItems
      : Array.isArray(t.workItemIds)
        ? t.workItemIds.map((id: number) => ({ id, provider: "ado" }))
        : [];

    insertTask.run(
      t.id, t.title, t.status ?? "active", t.groupId ?? null, t.cwd ?? null,
      t.notes ?? "", t.priority ?? 0, t.order ?? 0,
      t.createdAt ?? new Date().toISOString(), t.updatedAt ?? new Date().toISOString(),
    );

    for (const sid of t.sessionIds ?? []) {
      insertSession.run(t.id, sid);
    }
    for (const wi of workItems) {
      insertWorkItem.run(t.id, wi.id, wi.provider ?? "ado");
    }
    for (const pr of t.pullRequests ?? []) {
      insertPR.run(t.id, pr.repoId, pr.repoName ?? null, pr.prId, pr.provider ?? "ado");
    }
  }

  console.log(`[migrate]   tasks: ${tasks.length} rows`);
}

function migrateTaskGroups(db: DatabaseSync, dataDir: string): void {
  const groups = loadJson(dataDir, "task-groups.json");
  if (!Array.isArray(groups)) return;

  const insert = db.prepare(`
    INSERT INTO task_groups (id, name, color, "order", collapsed, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  for (const g of groups) {
    insert.run(
      g.id, g.name, g.color ?? "blue", g.order ?? 0, g.collapsed ? 1 : 0,
      g.createdAt ?? new Date().toISOString(), g.updatedAt ?? new Date().toISOString(),
    );
  }

  console.log(`[migrate]   task_groups: ${groups.length} rows`);
}

function migrateSessionMeta(db: DatabaseSync, dataDir: string): void {
  const meta = loadJson(dataDir, "sessions-meta.json");
  if (!meta || typeof meta !== "object") return;

  const insert = db.prepare(`
    INSERT INTO session_meta (sessionId, archived, archivedAt, triggeredBy, scheduleId, scheduleName)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  let count = 0;
  for (const [sessionId, m] of Object.entries(meta) as [string, any][]) {
    insert.run(
      sessionId, m.archived ? 1 : 0, m.archivedAt ?? null,
      m.triggeredBy ?? null, m.scheduleId ?? null, m.scheduleName ?? null,
    );
    count++;
  }

  console.log(`[migrate]   session_meta: ${count} rows`);
}

function migrateSettings(db: DatabaseSync, dataDir: string): void {
  const settings = loadJson(dataDir, "settings.json");
  if (!settings) return;

  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(
    "app", JSON.stringify(settings),
  );

  console.log("[migrate]   settings: 1 row");
}

function migrateSessionTitles(db: DatabaseSync, dataDir: string): void {
  const titles = loadJson(dataDir, "session-titles.json");
  if (!titles || typeof titles !== "object") return;

  const insert = db.prepare(
    "INSERT OR IGNORE INTO session_titles (sessionId, title) VALUES (?, ?)",
  );

  let count = 0;
  for (const [sessionId, title] of Object.entries(titles)) {
    // Skip leaked prompt-text titles (cleanup during migration)
    if (typeof title === "string" && /generate a concise|3-6 word title/i.test(title)) continue;
    insert.run(sessionId, title as string);
    count++;
  }

  console.log(`[migrate]   session_titles: ${count} rows`);
}

function migrateSchedules(db: DatabaseSync, dataDir: string): void {
  const schedules = loadJson(dataDir, "schedules.json");
  if (!Array.isArray(schedules)) return;

  const insert = db.prepare(`
    INSERT INTO schedules (id, taskId, name, prompt, type, cron, runAt, timezone,
      enabled, reuseSession, lastSessionId, createdAt, updatedAt,
      lastRunAt, nextRunAt, runCount, maxRuns, expiresAt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const s of schedules) {
    insert.run(
      s.id, s.taskId, s.name, s.prompt, s.type, s.cron ?? null, s.runAt ?? null,
      s.timezone ?? null, s.enabled ? 1 : 0, s.reuseSession ? 1 : 0,
      s.lastSessionId ?? null, s.createdAt, s.updatedAt,
      s.lastRunAt ?? null, s.nextRunAt ?? null, s.runCount ?? 0,
      s.maxRuns ?? null, s.expiresAt ?? null,
    );
  }

  console.log(`[migrate]   schedules: ${schedules.length} rows`);
}

function migrateReadState(db: DatabaseSync, dataDir: string): void {
  const state = loadJson(dataDir, "read-state.json");
  if (!state || typeof state !== "object") return;

  const insert = db.prepare(
    "INSERT OR IGNORE INTO read_state (sessionId, lastReadAt) VALUES (?, ?)",
  );

  let count = 0;
  for (const [sessionId, lastReadAt] of Object.entries(state)) {
    insert.run(sessionId, lastReadAt as string);
    count++;
  }

  console.log(`[migrate]   read_state: ${count} rows`);
}
