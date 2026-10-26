import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../db.js";
import { prepareDashboardRetirement } from "../dashboard-retirement.js";
import { createTaskStore } from "../task-store.js";
import { createChecklistStore } from "../checklist-store.js";
import { createGlobalBus } from "../global-bus.js";
import { makeTestDir } from "./helpers.js";

const oldSchema = readFileSync(new URL("./fixtures/dashboard-retirement.sql", import.meta.url), "utf8");
// What version 1 of the retirement left behind: an immutable archive and a manifest naming old records and a backup.
const versionOneArchive = `
  CREATE TABLE dashboard_legacy_rows (tableName TEXT NOT NULL, rowKey TEXT NOT NULL, rowJson TEXT NOT NULL, PRIMARY KEY(tableName,rowKey));
  CREATE TABLE dashboard_legacy_objects (id TEXT PRIMARY KEY, type TEXT NOT NULL, title TEXT NOT NULL, rawJson TEXT NOT NULL);
  CREATE TRIGGER dashboard_archive_rows_no_delete BEFORE DELETE ON dashboard_legacy_rows BEGIN SELECT RAISE(ABORT,'Dashboard archive is immutable'); END;
  CREATE TRIGGER dashboard_archive_objects_no_delete BEFORE DELETE ON dashboard_legacy_objects BEGIN SELECT RAISE(ABORT,'Dashboard archive is immutable'); END;
  INSERT INTO dashboard_legacy_rows VALUES('alerts','["a"]','{"id":"a"}');
  INSERT INTO dashboard_legacy_objects VALUES('a','alert','Old alert','{}');
  INSERT INTO dashboard_retirement VALUES(1,'2026-01-01T00:00:00Z','{"producerReferences":[{"title":"Old schedule"}]}','/backups/before-v1.db');
`;
const leftovers = (db: DatabaseSync) => db.prepare(`SELECT name FROM sqlite_master WHERE (type='table' AND (name LIKE 'focus\\_%' ESCAPE '\\'
  OR name IN ('decisions','alerts','feed_cards','feed_card_checklist_promotions','dashboard_legacy_rows','dashboard_legacy_objects')))
  OR (type='trigger' AND (name LIKE 'focus\\_%' ESCAPE '\\' OR name LIKE 'dashboard\\_archive\\_%' ESCAPE '\\'))`).all().map(row => row.name);

describe("off-thread dashboard removal", () => {
  let db: DatabaseSync | undefined;
  afterEach(() => { db?.close(); db = undefined; });

  it("drops every old dashboard table and keeps tasks, schedules and checklist retry keys", async () => {
    const directory = makeTestDir("dashboard-removal");
    db = openDatabase(directory);
    const bus = createGlobalBus(), tasks = createTaskStore(db, bus), checklist = createChecklistStore(db, bus);
    const task = tasks.createTask("Keep this task", undefined, "ongoing");
    tasks.updateTask(task.id, { notes: "Original notes", nextAction: "Original next action", waitingOn: "Original wait" });
    const withoutDetails = checklist.createChecklistItem(task.id, "Accepted before details existed", "2030-01-01");
    const withDetails = checklist.createChecklistItem(task.id, "Accepted with an empty details row");
    const keyOwner = checklist.createChecklistItem(task.id, "Accepted later under the same key", undefined, { key: "key-taken" });
    const collides = checklist.createChecklistItem(task.id, "Legacy key now owned by another item");
    db.prepare("DELETE FROM checklist_item_details WHERE itemId=?").run(withoutDetails.id);
    db.exec(oldSchema);
    const id = "ba5e1000-0000-4000-8000-000000000001", at = "2026-01-01T00:00:00Z";
    db.prepare("INSERT INTO focus_object_identities(id,objectType,dedupeKey) VALUES(?,?,?)").run(id, "alert", "historical-alert");
    db.prepare("INSERT INTO alerts(id,title,taskId,status,activationId,createdAt,updatedAt,statusChangedAt) VALUES(?,?,?,?,?,?,?,?)").run(id, "Old alert", task.id, "active", "episode", at, at, at);
    db.prepare("INSERT INTO focus_action_details(actionId,stableKey,sourceUrl) VALUES(?,?,?)").run(withoutDetails.id, "key-one", "https://example.com/one");
    db.prepare("INSERT INTO focus_action_details(actionId,stableKey,sourceUrl) VALUES(?,?,?)").run(withDetails.id, "key-two", "https://example.com/two");
    db.prepare("INSERT INTO focus_action_details(actionId,stableKey,sourceUrl) VALUES(?,?,?)").run(collides.id, "key-taken", "https://example.com/taken");
    const backups = join(directory, "backups", "dashboard-retirement");
    mkdirSync(backups, { recursive: true });
    writeFileSync(join(backups, "before-v1.db"), "old records");
    db.prepare("INSERT INTO schedules(id,taskId,name,prompt,type,cron,enabled,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?)")
      .run("monitor", task.id, "Real monitor", "Do the research then call event_save.", "cron", "0 8 * * *", 1, at, at);
    const before = tasks.getTask(task.id);
    db.close(); db = undefined;

    await prepareDashboardRetirement(directory);

    db = openDatabase(directory);
    const newTasks = createTaskStore(db, bus), newChecklist = createChecklistStore(db, bus);
    expect(leftovers(db)).toEqual([]);
    expect(newTasks.getTask(task.id)).toEqual(before);
    expect(newChecklist.getChecklistItem(withoutDetails.id)).toMatchObject({ deadline: "2030-01-01", stableKey: "key-one", sourceUrl: "https://example.com/one", originalTaskId: task.id });
    expect(newChecklist.getChecklistItem(withDetails.id)).toMatchObject({ stableKey: "key-two", sourceUrl: "https://example.com/two" });
    expect(newChecklist.createChecklistItem(task.id, "Retry must not add another item", undefined, { key: "key-one" }).id).toBe(withoutDetails.id);
    expect(newChecklist.getChecklistItem(keyOwner.id)).toMatchObject({ stableKey: "key-taken" });
    expect(newChecklist.getChecklistItem(collides.id)).toMatchObject({ sourceUrl: "https://example.com/taken" });
    expect(newChecklist.getChecklistItem(collides.id)?.stableKey).toBeUndefined();
    expect(existsSync(backups)).toBe(false);
    expect(db.prepare("SELECT enabled,prompt FROM schedules WHERE id='monitor'").get()).toMatchObject({ enabled: 1, prompt: "Do the research then call event_save." });
    expect(JSON.parse(String(db.prepare("SELECT manifestJson FROM dashboard_retirement WHERE version=2").get()?.manifestJson)))
      .toMatchObject({ droppedTables: { alerts: 1, focus_action_details: 3, focus_object_identities: 1 }, skippedKeys: 1 });
  });

  it("removes the version 1 archive, clears its manifest, and removes tables an older release recreates", async () => {
    const directory = makeTestDir("dashboard-removal-v1");
    db = openDatabase(directory);
    db.exec(versionOneArchive);
    db.close(); db = undefined;

    await prepareDashboardRetirement(directory);
    db = openDatabase(directory);
    expect(leftovers(db)).toEqual([]);
    expect(db.prepare("SELECT manifestJson,backupPath FROM dashboard_retirement WHERE version=1").get())
      .toMatchObject({ manifestJson: expect.not.stringContaining("Old schedule"), backupPath: null });
    const removedAt = db.prepare("SELECT completedAt FROM dashboard_retirement WHERE version=2").get()?.completedAt;
    db.close(); db = undefined;

    await prepareDashboardRetirement(directory);
    db = openDatabase(directory);
    expect(db.prepare("SELECT COUNT(*) AS n FROM dashboard_retirement").get()?.n).toBe(2);

    // A rollback to a release that still creates the archive, then this release again.
    db.exec(versionOneArchive.replace(/INSERT INTO dashboard_retirement[^;]*;/, ""));
    db.close(); db = undefined;
    await prepareDashboardRetirement(directory);
    db = openDatabase(directory);
    expect(leftovers(db)).toEqual([]);
    expect(db.prepare("SELECT completedAt FROM dashboard_retirement WHERE version=2").get()?.completedAt).toBe(removedAt);
  });
});
