import type { DatabaseSync } from "./db.js";
import { runImmediateTransaction } from "./db-transaction.js";
import { focusInteger } from "./focus-details-store.js";
import { createFocusAttentionStore } from "./focus-attention-store.js";
import { settleFocusProtectionHolds } from "./focus-protection-settlement.js";

export const FOCUS_NOTIFICATION_CLAIM_GRACE_MS = 30 * 60_000;
const RECONCILIATION_BATCH_SIZE = 500;
const UNKNOWN_OUTCOME = "outcome-unknown";
const UNSETTLED_DELIVERY_HOLDS = `EXISTS (
  SELECT 1 FROM focus_attention_events h WHERE h.eventType='protection_postponed'
  AND ((d.reason='immediate-alert' AND h.reason='notification'
    AND json_extract(h.detailsJson,'$.workId')=json_array(d.objectId,d.activationId))
    OR (d.reason='protected-needs-input' AND h.reason='needs-input' AND h.objectId=d.objectId))
  AND NOT EXISTS (SELECT 1 FROM focus_attention_events settled WHERE settled.eventType='protection_disposition'
    AND json_extract(settled.detailsJson,'$.holdId')=h.id)
)`;

function claimEpoch(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = /^((?:\d{4}|[+-]\d{6})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const local = `${match[1]}.${(match[2] ?? "").padEnd(3, "0").slice(0, 3)}Z`;
  const localEpoch = Date.parse(local);
  const epoch = Date.parse(value);
  // Date.parse normalizes some impossible calendar dates rather than rejecting them.
  return Number.isFinite(localEpoch) && new Date(localEpoch).toISOString() === local && Number.isFinite(epoch)
    ? epoch : null;
}

export interface FocusNotificationDelivery {
  id: string; objectId: string; activationId: string; transitionId: string | null; reason: string;
  status: "eligible" | "suppressed" | "sent" | "failed"; suppressionReason: string | null;
  resolvedGrantId: string | null; pendingUntil: string | null; claimToken: string | null;
  claimedAt: string | null; sentAt: string | null; error: string | null; outcomeJson: string | null;
  createdAt: string; updatedAt: string;
}
export interface FocusDeliveryIdentity {
  objectId: string; activationId: string; reason: string; transitionId?: string | null;
}
export interface DeliverySettlement {
  includedSessionIds?: string[];
  reason?: string;
}
export function createFocusNotificationDeliveryStore(db: DatabaseSync) {
  const telemetry = createFocusAttentionStore(db);
  // Use the same parser for bounded SQL selection and metadata. SQL's permissive
  // date parser (including "now") must not leave malformed claims immortal.
  db.function("focus_notification_claim_epoch", { deterministic: true }, claimEpoch);

  function settleDelivery(row: FocusNotificationDelivery, context: Record<string, unknown>, at: string): void {
    const disposition = row.status === "sent" ? "delivered" : "failed";
    const settlement = context.protectionSettlement as DeliverySettlement | undefined;
    const details = { deliveryId: row.id, deliveryObjectId: row.objectId,
      ...(settlement?.reason ? { reason: settlement.reason } : {}),
      ...(context.recovery ? { reason: UNKNOWN_OUTCOME, recovery: context.recovery } : {}) };
    if (row.reason === "immediate-alert") {
      settleFocusProtectionHolds(db, { kind: "notification", workId: JSON.stringify([row.objectId, row.activationId]) },
        disposition, details, { createdAt: at });
    } else if (row.reason === "protected-needs-input") {
      settleFocusProtectionHolds(db, { kind: "needs-input", windowId: row.objectId }, disposition, details, {
        createdAt: at, includedSessionIds: settlement?.includedSessionIds ?? context.sessionIds as string[] | undefined,
      });
    }
  }

  function get(identity: FocusDeliveryIdentity): FocusNotificationDelivery | undefined {
    return db.prepare("SELECT * FROM focus_notification_deliveries WHERE objectId = ? AND activationId = ? AND reason = ?")
      .get(identity.objectId, identity.activationId, identity.reason) as FocusNotificationDelivery | undefined;
  }
  function claim(identity: FocusDeliveryIdentity, resolvedGrantId: string | null, now = Date.now(),
    context?: Record<string, unknown>): FocusNotificationDelivery | undefined {
    return runImmediateTransaction(db, () => {
      const existing = get(identity);
      // A claimed delivery is never retried automatically: a crashed sender may
      // already have delivered it. Browser tags mitigate duplicates, not this gap.
      if (existing?.claimToken || existing?.status === "sent" || existing?.status === "failed") return undefined;
      if (existing?.pendingUntil && Date.parse(existing.pendingUntil) > now) return undefined;
      const at = new Date(now).toISOString();
      const token = crypto.randomUUID();
      db.prepare(`INSERT INTO focus_notification_deliveries (
        id, objectId, activationId, transitionId, reason, status, resolvedGrantId, claimToken, claimedAt, outcomeJson, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, 'eligible', ?, ?, ?, ?, ?, ?)
        ON CONFLICT(objectId, activationId, reason) DO UPDATE SET status='eligible',
        resolvedGrantId=excluded.resolvedGrantId, claimToken=excluded.claimToken, claimedAt=excluded.claimedAt,
        outcomeJson=excluded.outcomeJson, suppressionReason=NULL, pendingUntil=NULL, updatedAt=excluded.updatedAt`).run(
        existing?.id ?? crypto.randomUUID(), identity.objectId, identity.activationId, identity.transitionId ?? null,
        identity.reason, resolvedGrantId, token, at, context ? JSON.stringify(context) : null, existing?.createdAt ?? at, at,
      );
      telemetry.record({ ...identity, eventType: "notification_eligibility", details: { ...context, resolvedGrantId } });
      return get(identity);
    });
  }
  function suppress(identity: FocusDeliveryIdentity, reason: string, options: {
    pendingUntil?: string | null; resolvedGrantId?: string | null; terminal?: boolean; context?: Record<string, unknown>;
  } = {}): void {
    runImmediateTransaction(db, () => {
      const existing = get(identity);
      if (existing?.claimToken || existing?.status === "sent" || existing?.status === "failed") return;
      const outcomeJson = options.context ? JSON.stringify({
        ...(existing?.outcomeJson ? JSON.parse(existing.outcomeJson) as Record<string, unknown> : {}), ...options.context,
      }) : existing?.outcomeJson ?? null;
      if (existing?.suppressionReason === reason && existing.pendingUntil === (options.pendingUntil ?? null)
        && existing.resolvedGrantId === (options.resolvedGrantId ?? null) && existing.outcomeJson === outcomeJson
        && !options.terminal) return;
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO focus_notification_deliveries (
        id, objectId, activationId, transitionId, reason, status, suppressionReason, resolvedGrantId, pendingUntil,
        claimToken, claimedAt, outcomeJson, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, 'suppressed', ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(objectId, activationId, reason) DO UPDATE SET status='suppressed',
        suppressionReason=excluded.suppressionReason, resolvedGrantId=excluded.resolvedGrantId,
        pendingUntil=excluded.pendingUntil, claimToken=excluded.claimToken, claimedAt=excluded.claimedAt, outcomeJson=excluded.outcomeJson,
        updatedAt=excluded.updatedAt`).run(
        existing?.id ?? crypto.randomUUID(), identity.objectId, identity.activationId, identity.transitionId ?? null,
        identity.reason, reason, options.resolvedGrantId ?? null, options.terminal ? null : options.pendingUntil ?? null,
        options.terminal ? crypto.randomUUID() : null, options.terminal ? now : null, outcomeJson, existing?.createdAt ?? now, now,
      );
      telemetry.record({ ...identity, eventType: "notification_suppression", reason, details: options });
    });
  }
  function finish(claimed: FocusNotificationDelivery,
    outcome: { sent: number; failed: number; attempted: number; pruned: number }, error?: string,
    settlement?: DeliverySettlement): boolean {
    return runImmediateTransaction(db, () => {
      const now = new Date().toISOString();
      const status = outcome.sent > 0 && outcome.failed === 0 ? "sent" : "failed";
      const current = get(claimed);
      if (!current || current.id !== claimed.id || !claimed.claimToken || current.claimToken !== claimed.claimToken) return false;
      const context = current.outcomeJson ? JSON.parse(current.outcomeJson) as Record<string, unknown> : {};
      if (current.status !== "eligible") {
        if (current.status === "failed" && (context.recovery as { outcome?: string } | undefined)?.outcome === "unknown"
          && !db.prepare(`SELECT 1 FROM focus_attention_events WHERE eventType='notification_delivery'
            AND objectId=? AND activationId=? AND reason='late-result'
            AND json_extract(detailsJson,'$.deliveryId')=? AND json_extract(detailsJson,'$.claimToken')=? LIMIT 1`)
            .get(current.objectId, current.activationId, current.id, current.claimToken)) {
          telemetry.record({
            eventType: "notification_delivery", objectId: current.objectId, activationId: current.activationId,
            transitionId: current.transitionId, reason: "late-result", createdAt: now,
            details: { deliveryId: current.id, claimToken: current.claimToken, outcome, error: error ?? null,
              retainedStatus: current.status, recovery: context.recovery },
          });
        }
        return false;
      }
      const resultContext = { ...context, ...outcome, ...(settlement ? { protectionSettlement: settlement } : {}) };
      const result = db.prepare(`UPDATE focus_notification_deliveries SET status=?, sentAt=?, error=?,
        outcomeJson=?, updatedAt=? WHERE id=? AND claimToken=? AND status='eligible'`).run(
        status, outcome.sent > 0 ? now : null, error ?? (status === "failed" ? "Delivery incomplete or no subscriptions" : null),
        JSON.stringify(resultContext), now, claimed.id, claimed.claimToken,
      );
      if (result.changes) {
        telemetry.record({
          eventType: "notification_delivery", objectId: claimed.objectId, activationId: claimed.activationId,
          transitionId: claimed.transitionId, reason: status, details: { ...resultContext, error: error ?? null },
        });
        settleDelivery({ ...current, status }, resultContext, now);
      }
      return Boolean(result.changes);
    });
  }

  function nextClaimInspectionAt(now = Date.now(), reason?: string): number | null {
    const row = db.prepare(`SELECT MIN(at) AS at FROM (
      SELECT COALESCE(focus_notification_claim_epoch(d.claimedAt) + ?, ?) AS at
      FROM focus_notification_deliveries d WHERE d.status='eligible' AND d.claimToken IS NOT NULL
        ${reason === undefined ? "" : "AND d.reason=?"}
      UNION ALL SELECT ? AS at FROM focus_notification_deliveries d
      WHERE d.status IN ('sent','failed') ${reason === undefined ? "" : "AND d.reason=?"}
        AND ${UNSETTLED_DELIVERY_HOLDS}
    )`).get(FOCUS_NOTIFICATION_CLAIM_GRACE_MS, now, ...(reason === undefined ? [] : [reason]),
      now, ...(reason === undefined ? [] : [reason])) as { at: number | null };
    return row.at;
  }

  function reconcileStaleClaims(now = Date.now(), limit = RECONCILIATION_BATCH_SIZE, reason?: string): number {
    const at = new Date(now).toISOString();
    return runImmediateTransaction(db, () => {
      const rows = db.prepare(`SELECT d.* FROM focus_notification_deliveries d
        WHERE ${reason === undefined ? "" : "d.reason=? AND"} (
          (d.status='eligible' AND d.claimToken IS NOT NULL AND
            (focus_notification_claim_epoch(d.claimedAt) IS NULL OR focus_notification_claim_epoch(d.claimedAt)<=?))
          OR (d.status IN ('sent','failed') AND ${UNSETTLED_DELIVERY_HOLDS}))
        ORDER BY d.createdAt, d.id LIMIT ?`)
        .all(...(reason === undefined ? [] : [reason]), now - FOCUS_NOTIFICATION_CLAIM_GRACE_MS,
          focusInteger(limit, "limit", 1, RECONCILIATION_BATCH_SIZE)) as unknown as FocusNotificationDelivery[];
      for (const row of rows) {
        const context = row.outcomeJson ? JSON.parse(row.outcomeJson) as Record<string, unknown> : {};
        if (row.status === "eligible") {
          const invalidClaimTime = claimEpoch(row.claimedAt) === null;
          // An invalid timestamp supplies no trustworthy grace boundary. Fail
          // closed as unknown immediately, explicitly preserving its raw value.
          const recovery = { outcome: "unknown", reason: invalidClaimTime ? "invalid-claimed-at" : "stale-claim",
            inspectedAt: at, claimedAt: row.claimedAt, graceMs: FOCUS_NOTIFICATION_CLAIM_GRACE_MS, automaticRetry: false };
          const error = `Delivery outcome unknown: ${invalidClaimTime ? "invalid claim timestamp" : "claim exceeded the 30-minute grace period"}; automatic retry disabled`;
          context.recovery = recovery;
          const updated = db.prepare(`UPDATE focus_notification_deliveries SET status='failed', sentAt=NULL, error=?,
            outcomeJson=?, pendingUntil=NULL, updatedAt=? WHERE id=? AND claimToken=? AND status='eligible'`)
            .run(error, JSON.stringify(context), at, row.id, row.claimToken);
          if (!updated.changes) throw new Error(`Notification claim ${row.id} changed during reconciliation`);
          telemetry.record({ eventType: "notification_delivery", objectId: row.objectId, activationId: row.activationId,
            transitionId: row.transitionId, reason: UNKNOWN_OUTCOME, createdAt: at,
            details: { ...context, deliveryId: row.id, claimToken: row.claimToken, error } });
        }
        // Also repairs pre-existing result/hold crash gaps without session state
        // or a pending delivery row. The append-once ledger is the recovery marker.
        settleDelivery(row.status === "eligible" ? { ...row, status: "failed" } : row, context, at);
      }
      return rows.length;
    });
  }
  function pending(limit = 100, reason?: string): FocusNotificationDelivery[] {
    return db.prepare(`SELECT * FROM focus_notification_deliveries WHERE status='suppressed'
      AND pendingUntil IS NOT NULL AND claimToken IS NULL ${reason === undefined ? "" : "AND reason=?"}
      ORDER BY pendingUntil, id LIMIT ?`)
      .all(...(reason === undefined ? [] : [reason]), focusInteger(limit, "limit", 1, 500)) as unknown as FocusNotificationDelivery[];
  }
  function reconcileSessionCoverage(reason: string, waitingSessionIds: string[], options: { claimedOnly?: boolean } = {}): string[] {
    return runImmediateTransaction(db, () => {
      const waiting = new Set(waitingSessionIds);
      const covered = new Set<string>();
      const rows = db.prepare(`SELECT id, outcomeJson, claimToken FROM focus_notification_deliveries
        WHERE reason=? AND (claimToken IS NOT NULL AND (status IN ('eligible','sent')
          OR status='failed' AND json_extract(outcomeJson,'$.recovery.outcome')='unknown')
          OR status='suppressed' AND pendingUntil IS NOT NULL AND claimToken IS NULL)
        AND json_array_length(outcomeJson, '$.pendingSessionIds')>0`)
        .all(reason) as Array<{ id: string; outcomeJson: string; claimToken: string | null }>;
      for (const row of rows) {
        const context = JSON.parse(row.outcomeJson) as { pendingSessionIds: string[] } & Record<string, unknown>;
        const pendingSessionIds = context.pendingSessionIds.filter((id) => waiting.has(id));
        if (!options.claimedOnly || row.claimToken !== null) for (const id of pendingSessionIds) covered.add(id);
        // Keep the historical recipients, but stop treating an answered input
        // as covered. Finishing an in-flight send preserves this current state.
        if (pendingSessionIds.length !== context.pendingSessionIds.length) {
          db.prepare("UPDATE focus_notification_deliveries SET outcomeJson=? WHERE id=?")
            .run(JSON.stringify({ ...context, pendingSessionIds }), row.id);
        }
      }
      return [...covered];
    });
  }
  function list(limit = 100): FocusNotificationDelivery[] {
    const count = focusInteger(limit, "limit", 1, 500);
    reconcileStaleClaims();
    return db.prepare("SELECT * FROM focus_notification_deliveries ORDER BY createdAt DESC, id DESC LIMIT ?")
      .all(count) as unknown as FocusNotificationDelivery[];
  }
  return { get, claim, suppress, finish, pending, reconcileStaleClaims, nextClaimInspectionAt, reconcileSessionCoverage, list };
}

export type FocusNotificationDeliveryStore = ReturnType<typeof createFocusNotificationDeliveryStore>;
