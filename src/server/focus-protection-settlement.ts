import type { DatabaseSync } from "./db.js";
import { createFocusAttentionStore } from "./focus-attention-store.js";
import type {
  FocusProtectionDisposition, FocusProtectionWork, FocusProtectionWorkKind,
} from "../shared/focus-protection.js";

// Joins the caller's transaction so a delivery result and its hold dispositions
// commit together. It deliberately has no lifecycle, timer, or bus side effects.
export function settleFocusProtectionHolds(
  db: DatabaseSync,
  work: { kind: FocusProtectionWorkKind; workId?: string; scheduledFor?: string; windowId?: string },
  disposition: FocusProtectionDisposition,
  details: Record<string, unknown> = {},
  options: { includedSessionIds?: readonly string[]; createdAt?: string } = {},
): number {
  const rows = db.prepare(`SELECT h.id, h.objectId, h.detailsJson FROM focus_attention_events h
    WHERE h.eventType='protection_postponed' AND h.reason=?
    ${work.workId === undefined ? "" : "AND json_extract(h.detailsJson,'$.workId')=?"}
    ${work.scheduledFor === undefined ? "" : "AND json_extract(h.detailsJson,'$.scheduledFor')=?"}
    ${work.windowId === undefined ? "" : "AND h.objectId=?"}
    AND NOT EXISTS (SELECT 1 FROM focus_attention_events d WHERE d.eventType='protection_disposition'
      AND json_extract(d.detailsJson,'$.holdId')=h.id) ORDER BY h.createdAt, h.id`)
    .all(work.kind, ...(work.workId === undefined ? [] : [work.workId]),
      ...(work.scheduledFor === undefined ? [] : [work.scheduledFor]),
      ...(work.windowId === undefined ? [] : [work.windowId])) as Array<{ id: string; objectId: string; detailsJson: string }>;
  const attention = createFocusAttentionStore(db);
  const included = options.includedSessionIds && new Set(options.includedSessionIds);
  for (const row of rows) {
    const held = JSON.parse(row.detailsJson) as FocusProtectionWork;
    const result = included && held.sessionId && !included.has(held.sessionId) ? "no-longer-needed" : disposition;
    attention.record({
      eventType: "protection_disposition", objectId: row.objectId, reason: result, createdAt: options.createdAt,
      details: { ...details, kind: held.kind, workId: held.workId, scheduledFor: held.scheduledFor,
        holdId: row.id, disposition: result },
    });
  }
  return rows.length;
}
