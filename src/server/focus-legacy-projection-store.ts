import type { SQLOutputValue } from "node:sqlite";
import type { DatabaseSync } from "./db.js";
import { runInOwnOrOuterTransaction } from "./db-transaction.js";
import { focusFingerprint } from "./focus-details-store.js";

const WATERMARK_VERSION = 1;
const TABLE = "focus_legacy_projection_state";

interface InvalidationTrigger { name: string; table: string; sql: string }
function invalidationTriggers(): InvalidationTrigger[] {
  const triggers: InvalidationTrigger[] = [];
  function add(table: string, event: "INSERT" | "UPDATE" | "DELETE", predicate: string) {
    const name = `focus_projection_dirty_${table}_${event.toLowerCase()}`;
    triggers.push({
      name, table,
      sql: `CREATE TRIGGER ${name} AFTER ${event} ON ${table}
        BEGIN DELETE FROM ${TABLE} WHERE ${predicate}; END`,
    });
  }
  add("feed_cards", "INSERT", "feedRowId=NEW.rowid");
  add("feed_cards", "UPDATE", "feedRowId IN (OLD.rowid, NEW.rowid)");
  add("feed_cards", "DELETE", "feedRowId=OLD.rowid");
  for (const table of ["focus_object_identities", "decisions", "alerts", "focus_events"]) {
    add(table, "INSERT", "feedCardId=NEW.id");
    add(table, "UPDATE", "feedCardId IN (OLD.id, NEW.id)");
    add(table, "DELETE", "feedCardId=OLD.id");
  }
  add("focus_object_details", "DELETE", "feedCardId=OLD.objectId");
  return triggers;
}
function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, " ").trim().replace(/;$/, "");
}

export function initializeFocusLegacyProjectionSchema(db: DatabaseSync): void {
  runInOwnOrOuterTransaction(db, () => {
    db.exec(`CREATE TABLE IF NOT EXISTS ${TABLE} (
      feedRowId INTEGER PRIMARY KEY,
      feedCardId TEXT,
      fingerprint TEXT NOT NULL,
      disposition TEXT NOT NULL CHECK (disposition IN ('imported','quarantined')),
      version INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_focus_projection_feed_id ON ${TABLE}(feedCardId);`);
    const installed = new Map(
      (db.prepare("SELECT name, tbl_name, sql FROM sqlite_master WHERE type='trigger' AND name LIKE 'focus_projection_dirty_%'")
        .all() as Array<{ name: string; tbl_name: string; sql: string }>)
        .map((row) => [row.name, row]),
    );
    const changed = invalidationTriggers().filter((trigger) => {
      const existing = installed.get(trigger.name);
      return !existing || existing.tbl_name !== trigger.table || normalizeSql(existing.sql) !== normalizeSql(trigger.sql);
    });
    if (!changed.length) return;
    // A rollback-era table rebuild can drop/rebind triggers. Cached trust is
    // invalid until every native invalidation trigger has the expected body.
    db.prepare(`DELETE FROM ${TABLE}`).run();
    for (const trigger of changed) {
      db.exec(`DROP TRIGGER IF EXISTS ${trigger.name}; ${trigger.sql}`);
    }
  });
}

export type LegacyProjectionRow = Record<string, SQLOutputValue> & { feedRowId: number };
export function createFocusLegacyProjectionStore(db: DatabaseSync) {
  function remember(row: LegacyProjectionRow, disposition: "imported" | "quarantined"): void {
    db.prepare(`INSERT INTO ${TABLE} (feedRowId, feedCardId, fingerprint, disposition, version)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(feedRowId) DO UPDATE SET feedCardId=excluded.feedCardId, fingerprint=excluded.fingerprint,
        disposition=excluded.disposition, version=excluded.version
      WHERE feedCardId IS NOT excluded.feedCardId OR fingerprint!=excluded.fingerprint
        OR disposition!=excluded.disposition OR version!=excluded.version`).run(
      row.feedRowId, typeof row.id === "string" && row.id ? row.id : null,
      focusFingerprint(row), disposition, WATERMARK_VERSION,
    );
  }
  function rememberCurrent(feedRowId: number): void {
    const row = db.prepare("SELECT rowid AS feedRowId, * FROM feed_cards WHERE rowid=?").get(feedRowId) as LegacyProjectionRow | undefined;
    if (!row) throw new Error(`Cannot watermark missing feed projection row ${feedRowId}`);
    remember(row, "imported");
  }
  function listDirty(): LegacyProjectionRow[] {
    return db.prepare(`SELECT f.rowid AS feedRowId, f.* FROM feed_cards f
      LEFT JOIN ${TABLE} saved ON saved.feedRowId=f.rowid
      LEFT JOIN focus_object_identities i ON i.id=f.id
      LEFT JOIN focus_object_details details ON details.objectId=i.id
      LEFT JOIN decisions d ON d.id=i.id AND i.objectType='decision'
      LEFT JOIN alerts a ON a.id=i.id AND i.objectType='alert'
      LEFT JOIN focus_events e ON e.id=i.id AND i.objectType='event'
      LEFT JOIN focus_legacy_reconciliation_issues q ON q.feedRowId=f.rowid
      WHERE saved.feedRowId IS NULL OR saved.version!=? OR saved.feedCardId IS NOT
        (CASE WHEN typeof(f.id)='text' AND length(f.id)>0 THEN f.id ELSE NULL END)
        OR (saved.disposition='imported' AND (i.id IS NULL OR details.objectId IS NULL
          OR COALESCE(d.id,a.id,e.id) IS NULL OR q.id IS NOT NULL))
        OR (saved.disposition='quarantined' AND q.id IS NULL)
      ORDER BY f.rowid`).all(WATERMARK_VERSION) as LegacyProjectionRow[];
  }
  function pruneMissing(): void {
    db.prepare(`DELETE FROM ${TABLE} WHERE feedRowId NOT IN (SELECT rowid FROM feed_cards)`).run();
  }
  return { remember, rememberCurrent, listDirty, pruneMissing };
}
