import { DatabaseSync } from "node:sqlite";
import { existsSync, readdirSync, rmdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { initializeDashboardRetirementSchema } from "./dashboard-retirement-schema.js";

// Runs only as an off-main-thread preboot command. No request handler imports this module.
// Removes every table of the retired dashboard (and the version 1 archive of it). Runs on each start so
// tables recreated by an older release after a rollback are removed again.
const dataDir = process.argv[2];
if (!dataDir) throw new Error("A data directory is required for dashboard retirement");
const databasePath = join(dataDir, "bridge.db");
if (existsSync(databasePath)) {
  const db = new DatabaseSync(databasePath);
  const hasTable = (name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;
  try {
    db.exec("PRAGMA busy_timeout=30000; PRAGMA foreign_keys=ON");
    const legacyTables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'focus\\_%' ESCAPE '\\'
      OR name IN ('decisions','alerts','feed_cards','feed_card_checklist_promotions','dashboard_legacy_rows','dashboard_legacy_objects')) ORDER BY name`)
      .all().map(row => String(row.name));
    const legacyTriggers = db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND (name LIKE 'focus\\_%' ESCAPE '\\'
      OR name LIKE 'dashboard\\_archive\\_%' ESCAPE '\\')`).all().map(row => String(row.name));
    const recorded = hasTable("dashboard_retirement") && !!db.prepare("SELECT 1 FROM dashboard_retirement WHERE version=2").get();
    if (recorded && !legacyTables.length && !legacyTriggers.length) {
      console.log(JSON.stringify({ removed: false, alreadyRemoved: true }));
    } else if (hasTable("checklist_items") && hasTable("tasks")) {
      db.exec("BEGIN IMMEDIATE");
      try {
        initializeDashboardRetirementSchema(db);
        // Retry keys and provenance of accepted checklist items are live data: keep them before the old table goes.
        // A key another item already owns is skipped (and reported) rather than failing startup on the UNIQUE constraint.
        let skippedKeys = 0;
        if (hasTable("focus_action_details")) {
          const claimed = `EXISTS(SELECT 1 FROM checklist_item_details k WHERE k.stableKey=d.stableKey AND k.itemId!=c.id)`;
          skippedKeys = Number(db.prepare(`SELECT COUNT(*) AS n FROM checklist_items c JOIN focus_action_details d ON d.actionId=c.id
            WHERE d.stableKey IS NOT NULL AND ${claimed}`).get()?.n);
          db.exec(`INSERT INTO checklist_item_details(itemId,stableKey,sourceUrl,originalTaskId,originalTaskTitle,orphanedAt)
            SELECT c.id,CASE WHEN ${claimed} THEN NULL ELSE d.stableKey END,d.sourceUrl,COALESCE(d.originalTaskId,c.taskId),COALESCE(d.originalTaskTitle,t.title),d.orphanedAt
            FROM checklist_items c LEFT JOIN tasks t ON t.id=c.taskId LEFT JOIN focus_action_details d ON d.actionId=c.id
            WHERE true
            ON CONFLICT(itemId) DO UPDATE SET
              stableKey=COALESCE(checklist_item_details.stableKey,excluded.stableKey),
              sourceUrl=COALESCE(checklist_item_details.sourceUrl,excluded.sourceUrl),
              originalTaskId=COALESCE(checklist_item_details.originalTaskId,excluded.originalTaskId),
              originalTaskTitle=COALESCE(checklist_item_details.originalTaskTitle,excluded.originalTaskTitle),
              orphanedAt=COALESCE(checklist_item_details.orphanedAt,excluded.orphanedAt)`);
        }
        for (const trigger of legacyTriggers) db.exec(`DROP TRIGGER IF EXISTS ${quoted(trigger)}`);
        const droppedTables: Record<string, number> = {};
        for (const table of legacyTables) {
          droppedTables[table] = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${quoted(table)}`).get()?.n);
          db.exec(`DROP TABLE ${quoted(table)}`);
        }
        db.exec("UPDATE checklist_item_details SET archivedSourcesJson='[]' WHERE archivedSourcesJson!='[]'");
        db.exec(`UPDATE dashboard_retirement SET manifestJson='{"notice":"Historical dashboard records were removed by version 2."}',backupPath=NULL WHERE version=1`);
        if (!recorded) {
          db.prepare("INSERT INTO dashboard_retirement VALUES(2,?,?,NULL)").run(new Date().toISOString(),
            JSON.stringify({ droppedTables, skippedKeys, notice: "Historical dashboard records were removed. Checklist retry keys and provenance were kept." }));
        }
        const violations = db.prepare("PRAGMA foreign_key_check").all();
        if (violations.length) throw new Error(`Dashboard removal left ${violations.length} foreign key violations`);
        db.exec("COMMIT");
        console.log(JSON.stringify({ removed: true, droppedTables, skippedKeys }));
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    }
  } finally { db.close(); }
  // The pre-retirement backup made by version 1 holds the removed records; delete it once they are gone.
  const versionOneBackups = join(dataDir, "backups", "dashboard-retirement");
  for (const name of ["before-v1.db", "before-v1.pending.db"]) {
    const backup = join(versionOneBackups, name);
    if (existsSync(backup)) { unlinkSync(backup); console.log(JSON.stringify({ deletedBackup: backup })); }
  }
  if (existsSync(versionOneBackups) && readdirSync(versionOneBackups).length === 0) rmdirSync(versionOneBackups);
}
