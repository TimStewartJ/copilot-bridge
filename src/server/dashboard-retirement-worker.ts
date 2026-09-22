import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, renameSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { initializeDashboardRetirementSchema } from "./dashboard-retirement-schema.js";

// Runs only as an off-main-thread preboot command. No request handler imports this module.
const dataDir = process.argv[2];
if (!dataDir) throw new Error("A data directory is required for dashboard retirement");
const databasePath = join(dataDir, "bridge.db");
if (existsSync(databasePath)) {
  const db = new DatabaseSync(databasePath);
  const hasTable = (name: string) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  const quoted = (name: string) => `"${name.replaceAll('"', '""')}"`;
  try {
    db.exec("PRAGMA busy_timeout=30000; PRAGMA foreign_keys=ON");
    if (hasTable("dashboard_retirement") && db.prepare("SELECT 1 FROM dashboard_retirement WHERE version=1").get()) {
      console.log(JSON.stringify({ migrated: false, alreadyRetired: true }));
    } else if (hasTable("checklist_items") && hasTable("tasks")) {
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'focus\\_%' ESCAPE '\\' OR name IN ('decisions','alerts','feed_cards','feed_card_checklist_promotions')) ORDER BY name")
        .all().map(row => String(row.name));
      let backupPath: string | undefined;
      if (tables.length) {
        const backupDir = join(dataDir, "backups", "dashboard-retirement");
        mkdirSync(backupDir, { recursive: true });
        backupPath = join(backupDir, "before-v1.db");
        const pendingBackup = join(backupDir, "before-v1.pending.db");
        if (existsSync(pendingBackup)) unlinkSync(pendingBackup);
        db.exec(`VACUUM INTO '${pendingBackup.replaceAll("'", "''")}'`);
        renameSync(pendingBackup, backupPath);
      }
      db.exec("BEGIN IMMEDIATE");
      try {
        for (const row of db.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'focus\\_%' ESCAPE '\\'").all()) {
          db.exec(`DROP TRIGGER ${quoted(String(row.name))}`);
        }
        initializeDashboardRetirementSchema(db);
        const counts: Record<string, number> = {};
        for (const table of tables) {
          const columns = db.prepare(`PRAGMA table_info(${quoted(table)})`).all();
          const pk = columns.filter(column => Number(column.pk) > 0).sort((a, b) => Number(a.pk) - Number(b.pk));
          const key = `json_array(${pk.length ? pk.map(column => quoted(String(column.name))).join(",") : "rowid"})`;
          const json = `json_object(${columns.flatMap(column => [`'${String(column.name).replaceAll("'", "''")}'`, quoted(String(column.name))]).join(",")})`;
          db.prepare(`INSERT INTO dashboard_legacy_rows(tableName,rowKey,rowJson) SELECT ?,${key},${json} FROM ${quoted(table)}`).run(table);
          counts[table] = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${quoted(table)}`).get()?.n);
          const copied = Number(db.prepare("SELECT COUNT(*) AS n FROM dashboard_legacy_rows WHERE tableName=?").get(table)?.n);
          if (copied !== counts[table]) throw new Error(`Dashboard archive count mismatch for ${table}`);
        }
        const hasDetails = hasTable("focus_action_details");
        const hasLinks = hasTable("focus_action_links") && hasTable("focus_object_details") && hasTable("decisions") && hasTable("alerts") && hasTable("focus_events");
        const sources = hasLinks ? `(SELECT COALESCE(json_group_array(json_object('sourceId',links.sourceId,'sourceType',links.sourceType,'activationId',links.activationId,
          'title',COALESCE(d.title,a.title,e.title),'lifecycle',details.lifecycle)),'[]')
          FROM focus_action_links links LEFT JOIN focus_object_details details ON details.objectId=links.sourceId
          LEFT JOIN decisions d ON d.id=links.sourceId LEFT JOIN alerts a ON a.id=links.sourceId LEFT JOIN focus_events e ON e.id=links.sourceId WHERE links.actionId=c.id)` : "'[]'";
        db.exec(`INSERT INTO checklist_item_details(itemId,stableKey,sourceUrl,originalTaskId,originalTaskTitle,orphanedAt,archivedSourcesJson)
          SELECT c.id,${hasDetails ? "d.stableKey,d.sourceUrl,COALESCE(d.originalTaskId,c.taskId),COALESCE(d.originalTaskTitle,t.title),d.orphanedAt" : "NULL,NULL,c.taskId,t.title,NULL"},${sources}
          FROM checklist_items c LEFT JOIN tasks t ON t.id=c.taskId ${hasDetails ? "LEFT JOIN focus_action_details d ON d.actionId=c.id" : ""}
          WHERE NOT EXISTS(SELECT 1 FROM checklist_item_details current WHERE current.itemId=c.id)`);
        const objectTables = [["decisions", "decision"], ["alerts", "alert"], ["focus_events", "event"], ["feed_cards", "feed"]] as const;
        let expectedObjects = 0;
        for (const [table, type] of objectTables) {
          if (!hasTable(table)) continue;
          const details = hasTable("focus_object_details");
          const unprojected = type === "feed" ? " WHERE NOT EXISTS(SELECT 1 FROM dashboard_legacy_objects archived WHERE archived.id=o.id)" : "";
          expectedObjects += Number(db.prepare(`SELECT COUNT(*) AS n FROM ${table} o${unprojected}`).get()?.n);
          db.exec(`INSERT INTO dashboard_legacy_objects(id,type,title,status,lifecycle,taskId,taskTitle,interventionBy,createdAt,body,rawJson)
            SELECT o.id,'${type}',o.title,o.status,${details ? "d.lifecycle" : "NULL"},
              ${details ? "COALESCE(o.taskId,d.originalTaskId)" : "o.taskId"},${details ? "COALESCE(t.title,d.originalTaskTitle)" : "t.title"},
              ${details ? "d.interventionBy" : "NULL"},o.createdAt,o.body,r.rowJson
            FROM ${table} o JOIN dashboard_legacy_rows r ON r.tableName='${table}' AND json_extract(r.rowJson,'$.id')=o.id
            LEFT JOIN tasks t ON t.id=o.taskId ${details ? "LEFT JOIN focus_object_details d ON d.objectId=o.id" : ""}${unprojected}`);
        }
        if (Number(db.prepare("SELECT COUNT(*) AS n FROM dashboard_legacy_objects").get()?.n) !== expectedObjects) throw new Error("Readable dashboard archive count mismatch");
        const retiredTools = /\b(?:alert_(?:save|list|promote)|decision_(?:save|list|promote)|event_(?:save|list|promote)|feed_(?:save|list)|focus_[a-z_]+)\b/g;
        const references: Array<{ type: string; id: string; title: string; tools: string[]; enabled?: boolean }> = [];
        for (const [table, field, title] of [["schedules", "prompt", "name"], ["tasks", "notes", "title"], ["tags", "instructions", "name"]] as const) {
          if (!hasTable(table)) continue;
          const columns = db.prepare(`PRAGMA table_info(${table})`).all().map(column => column.name);
          if (!columns.includes(field)) continue;
          for (const row of db.prepare(`SELECT * FROM ${table}`).all()) {
            const tools = [...new Set(String(row[field] ?? "").match(retiredTools) ?? [])];
            if (tools.length) references.push({ type: table, id: String(row.id), title: String(row[title]), tools,
              ...(table === "schedules" ? { enabled: row.enabled === 1 } : {}) });
          }
        }
        const pendingLaunches = db.prepare(`SELECT rowJson FROM dashboard_legacy_rows WHERE tableName='focus_session_launches'
          AND json_extract(rowJson,'$.status') IN ('creating','created','unknown')
          AND json_extract(rowJson,'$.promptStatus')!='sent'`).all().map(row => {
          const value = JSON.parse(String(row.rowJson)) as Record<string, unknown>;
          return { id: value.id, objectId: value.objectId, taskId: value.taskId, sessionId: value.sessionId,
            status: value.status, promptStatus: value.promptStatus, promptDispatchedAt: value.promptDispatchedAt };
        });
        const manifests = { tables: counts, readableObjects: expectedObjects, pendingLaunches,
          pendingLaunchNotice: "Retired launch receipts are not automatically replayed or declared complete. Inspect any listed session before starting replacement work.",
          taskContext: "Only titles referenced by archived objects/checklist provenance are denormalized; task notes are not copied into immutable history.",
          rowKeyEncoding: "JSON array of ordered primary-key columns; rowid when absent",
          producerReferences: references, notice: "Historical records only. Retirement did not resolve concerns or transfer notification authority. Schedules and instructions were not altered." };
        db.prepare("INSERT INTO dashboard_retirement VALUES(1,?,?,?)").run(new Date().toISOString(), JSON.stringify(manifests), backupPath ?? null);
        db.exec("COMMIT");
        console.log(JSON.stringify({ migrated: true, counts, producerReferences: references.length, backupPath }));
      } catch (error) { db.exec("ROLLBACK"); throw error; }
    }
  } finally { db.close(); }
}
