import type { DatabaseSync } from "node:sqlite";
import type { Router } from "express";
import type { DashboardArchivePage, DashboardArchiveDetail, ArchivedDashboardObject } from "../shared/dashboard-archive.js";
import { isRecord } from "../shared/is-record.js";

const SUMMARY = "id,type,title,status,lifecycle,taskId,taskTitle,interventionBy,createdAt";
function decode(raw: unknown): Record<string, unknown> {
  const value: unknown = JSON.parse(String(raw));
  if (!isRecord(value)) throw new Error("Archived dashboard row is malformed");
  return value;
}
export function createDashboardArchiveStore(db: DatabaseSync) {
  function list(offset = 0, query = "", openOnly = false): DashboardArchivePage {
    const open = "type IN ('decision','alert') AND COALESCE(lifecycle,status) IN ('active','acknowledged','handed_off')";
    const where = `${openOnly ? `(${open}) AND ` : ""}(instr(lower(title),lower(?))>0 OR instr(lower(COALESCE(taskTitle,'')),lower(?))>0)`;
    const rows = db.prepare(`SELECT ${SUMMARY} FROM dashboard_legacy_objects WHERE ${where} ORDER BY createdAt DESC,id LIMIT 30 OFFSET ?`).all(query, query, offset);
    const total = Number(db.prepare(`SELECT COUNT(*) AS n FROM dashboard_legacy_objects WHERE ${where}`).get(query, query)?.n);
    const retired = db.prepare("SELECT completedAt FROM dashboard_retirement WHERE version=1").get();
    return { items: rows as unknown as ArchivedDashboardObject[], total, offset, hasMore: offset + rows.length < total,
      openConcerns: Number(db.prepare(`SELECT COUNT(*) AS n FROM dashboard_legacy_objects WHERE ${open}`).get()?.n),
      ...(retired ? { retiredAt: String(retired.completedAt) } : {}) };
  }
  function get(id: string, recordOffset = 0): DashboardArchiveDetail | undefined {
    const row = db.prepare(`SELECT ${SUMMARY},body FROM dashboard_legacy_objects WHERE id=?`).get(id);
    if (!row) return undefined;
    const predicate = "json_extract(rowJson,'$.id')=? OR json_extract(rowJson,'$.objectId')=? OR json_extract(rowJson,'$.sourceId')=? OR json_extract(rowJson,'$.feedCardId')=?";
    const recordsTotal = Number(db.prepare(`SELECT COUNT(*) AS n FROM dashboard_legacy_rows WHERE ${predicate}`).get(id, id, id, id)?.n);
    const records = db.prepare(`SELECT tableName,rowJson FROM dashboard_legacy_rows WHERE ${predicate}
      ORDER BY tableName,rowKey LIMIT 100 OFFSET ?`).all(id, id, id, id, recordOffset)
      .map(record => ({ table: String(record.tableName), value: decode(record.rowJson) }));
    return { ...row as unknown as ArchivedDashboardObject, body: row.body === null ? null : String(row.body), records, recordsTotal, recordOffset, hasMoreRecords: recordOffset + records.length < recordsTotal };
  }
  function visual(id: string): { artifactId: string } | undefined {
    const row = db.prepare("SELECT rawJson FROM dashboard_legacy_objects WHERE id=?").get(id);
    if (!row) return undefined;
    const original = decode(row.rawJson);
    const value = typeof original.visualJson === "string" ? decode(original.visualJson) : undefined;
    return value && typeof value.artifactId === "string" ? { artifactId: value.artifactId } : undefined;
  }
  function readiness() {
    const row = db.prepare("SELECT completedAt,manifestJson FROM dashboard_retirement WHERE version=1").get();
    return row ? { retiredAt: String(row.completedAt), manifest: decode(row.manifestJson) } : { retiredAt: null, manifest: null };
  }
  return { list, get, visual, readiness };
}
export type DashboardArchiveStore = ReturnType<typeof createDashboardArchiveStore>;
export function registerDashboardArchiveRoutes(router: Router, store: DashboardArchiveStore): void {
  router.get("/home/archive", (req, res) => {
    const offset = req.query.offset ?? "0", query = req.query.q ?? "";
    if (typeof offset !== "string" || !/^\d+$/.test(offset) || Number(offset) > 1000000 || typeof query !== "string" || query.length > 500) {
      res.status(400).json({ error: "Invalid archive page or query" }); return;
    }
    res.json(store.list(Number(offset), query, req.query.open === "true"));
  });
  router.get("/home/archive-readiness", (_req, res) => res.json(store.readiness()));
  router.get("/home/archive/:id", (req, res) => {
    const rawOffset = req.query.recordOffset ?? "0";
    if (typeof rawOffset !== "string" || !/^\d+$/.test(rawOffset) || Number(rawOffset) > 1000000) {
      res.status(400).json({ error: "Invalid historical source-record offset" }); return;
    }
    const record = store.get(req.params.id, Number(rawOffset));
    if (!record) { res.status(404).json({ error: "This historical dashboard record was not retained" }); return; }
    res.json(record);
  });
}
