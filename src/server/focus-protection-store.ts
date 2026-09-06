import type { DatabaseSync } from "./db.js";
import { runImmediateTransaction } from "./db-transaction.js";
import type { GlobalBus } from "./global-bus.js";
import { createFocusAttentionStore } from "./focus-attention-store.js";
import { settleFocusProtectionHolds } from "./focus-protection-settlement.js";
import { FeedCardNotFoundError, FeedCardValidationError } from "./feed-store.js";
import { focusBoolean, focusInteger, focusRecord, focusText, focusTimestamp } from "./focus-details-store.js";
import { safeSetTimeout, type LongTimeout } from "./long-timeout.js";
import {
  MAX_FOCUS_PROTECTION_DURATION_MS,
  type FocusProtectionDisposition,
  type FocusProtectionHold,
  type FocusProtectionImpact,
  type FocusProtectionImpactSummary,
  type FocusProtectionRequest,
  type FocusProtectionWindow,
  type FocusProtectionWork,
  type FocusProtectionWorkKind,
} from "../shared/focus-protection.js";

type WindowRow = Omit<FocusProtectionWindow, "status" | "allowNeedsInput" | "allowAuthorizedDeadlineOverride"> & {
  allowNeedsInput: number;
  allowAuthorizedDeadlineOverride: number;
};
type HoldRow = { id: string; objectId: string; detailsJson: string; createdAt: string };

export class FocusProtectionConflictError extends Error {}

export function initializeFocusProtectionSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS focus_protection_windows (
      id TEXT PRIMARY KEY,
      startsAt TEXT NOT NULL,
      endsAt TEXT NOT NULL CHECK (endsAt > startsAt),
      timezone TEXT NOT NULL,
      reason TEXT NOT NULL,
      allowNeedsInput INTEGER NOT NULL CHECK (allowNeedsInput IN (0, 1)),
      allowAuthorizedDeadlineOverride INTEGER NOT NULL CHECK (allowAuthorizedDeadlineOverride IN (0, 1)),
      cancelledAt TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_focus_protection_time ON focus_protection_windows(startsAt, endsAt)
      WHERE cancelledAt IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_focus_protection_transition ON focus_attention_events(objectId, eventType)
      WHERE eventType IN ('protection_started', 'protection_cleared');
    CREATE INDEX IF NOT EXISTS idx_focus_protection_holds ON focus_attention_events(
      reason, json_extract(detailsJson,'$.workId'), json_extract(detailsJson,'$.scheduledFor'), objectId
    ) WHERE eventType='protection_postponed';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_focus_protection_dispositions
      ON focus_attention_events(json_extract(detailsJson,'$.holdId')) WHERE eventType='protection_disposition';
  `);
}

export function normalizeFocusProtectionRequest(value: unknown, now = Date.now()): FocusProtectionRequest {
  const input = focusRecord(value, [
    "startsAt", "endsAt", "timezone", "reason", "allowNeedsInput", "allowAuthorizedDeadlineOverride",
  ]);
  const startsAt = input.startsAt === undefined ? undefined : focusTimestamp(input.startsAt, "startsAt")!;
  const endsAt = focusTimestamp(input.endsAt, "endsAt")!;
  const start = startsAt === undefined ? now : Date.parse(startsAt);
  if (start < now) throw new FeedCardValidationError("startsAt cannot be in the past; omit it to start at confirmation");
  if (Date.parse(endsAt) <= start) throw new FeedCardValidationError("endsAt must be after startsAt and in the future");
  if (Date.parse(endsAt) - start > MAX_FOCUS_PROTECTION_DURATION_MS) {
    throw new FeedCardValidationError("Protection may last at most 7 days");
  }
  const timezone = focusText(input.timezone, "timezone")!;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    throw new FeedCardValidationError("timezone must be an IANA timezone");
  }
  return {
    ...(startsAt ? { startsAt } : {}), endsAt, timezone, reason: focusText(input.reason, "reason")!,
    allowNeedsInput: input.allowNeedsInput === undefined ? true : focusBoolean(input.allowNeedsInput, "allowNeedsInput"),
    allowAuthorizedDeadlineOverride: input.allowAuthorizedDeadlineOverride === undefined
      ? false : focusBoolean(input.allowAuthorizedDeadlineOverride, "allowAuthorizedDeadlineOverride"),
  };
}

export function protectionRetryAt(window: Pick<FocusProtectionWindow, "endsAt">, key: string): number {
  let hash = 0;
  for (const char of key) hash = (Math.imul(hash, 31) + char.charCodeAt(0)) >>> 0;
  return Date.parse(window.endsAt) + 1 + hash % 3_000;
}

function hydrate(row: WindowRow, now: number): FocusProtectionWindow {
  return {
    ...row, allowNeedsInput: row.allowNeedsInput === 1,
    allowAuthorizedDeadlineOverride: row.allowAuthorizedDeadlineOverride === 1,
    status: row.cancelledAt ? "cancelled" : Date.parse(row.endsAt) <= now ? "completed"
      : Date.parse(row.startsAt) > now ? "scheduled" : "active",
  };
}

export function createFocusProtectionStore(db: DatabaseSync, bus: GlobalBus) {
  const attention = createFocusAttentionStore(db);
  let timer: LongTimeout | undefined;
  let started = false;
  let reconciling = false;

  function clearTimer(): void {
    timer?.cancel();
    timer = undefined;
  }

  function get(id: string, now = Date.now()): FocusProtectionWindow | undefined {
    const row = db.prepare("SELECT * FROM focus_protection_windows WHERE id=?").get(id) as WindowRow | undefined;
    return row ? hydrate(row, now) : undefined;
  }

  // Admission reads have no timer, telemetry, or bus side effects.
  function current(now = Date.now()): FocusProtectionWindow | null {
    const at = new Date(now).toISOString();
    const row = db.prepare(`SELECT * FROM focus_protection_windows
      WHERE cancelledAt IS NULL AND startsAt<=? AND endsAt>? ORDER BY startsAt LIMIT 1`).get(at, at) as WindowRow | undefined;
    return row ? hydrate(row, now) : null;
  }

  function list(options: { limit?: number; offset?: number } = {}, now = Date.now()): FocusProtectionWindow[] {
    return (db.prepare("SELECT * FROM focus_protection_windows ORDER BY startsAt DESC, id DESC LIMIT ? OFFSET ?")
      .all(focusInteger(options.limit ?? 50, "limit", 1, 100), focusInteger(options.offset ?? 0, "offset", 0, 1_000_000)) as WindowRow[])
      .map((row) => hydrate(row, now));
  }

  function upcoming(now = Date.now()): FocusProtectionWindow | null {
    const row = db.prepare(`SELECT * FROM focus_protection_windows WHERE cancelledAt IS NULL AND startsAt>?
      ORDER BY startsAt LIMIT 1`).get(new Date(now).toISOString()) as WindowRow | undefined;
    return row ? hydrate(row, now) : null;
  }

  function latestCompleted(now = Date.now()): FocusProtectionWindow | null {
    const row = db.prepare(`SELECT * FROM focus_protection_windows WHERE cancelledAt IS NULL AND endsAt<=?
      ORDER BY endsAt DESC, id DESC LIMIT 1`).get(new Date(now).toISOString()) as WindowRow | undefined;
    return row ? hydrate(row, now) : null;
  }

  function coveringSlot(scheduledFor: string, now = Date.now(), graceMs = 60 * 60_000): FocusProtectionWindow | null {
    const slot = Date.parse(scheduledFor);
    if (!Number.isFinite(slot)) throw new FeedCardValidationError("Invalid protected scheduled slot");
    const row = db.prepare(`SELECT * FROM focus_protection_windows
      WHERE startsAt<=? AND startsAt<=? AND MIN(endsAt, COALESCE(cancelledAt, endsAt))>?
        AND MIN(endsAt, COALESCE(cancelledAt, endsAt))>startsAt
      ORDER BY startsAt DESC LIMIT 1`).get(
      new Date(now).toISOString(), new Date(slot + graceMs).toISOString(), new Date(slot).toISOString(),
    ) as WindowRow | undefined;
    return row ? hydrate(row, now) : null;
  }

  function arm(): void {
    clearTimer();
    if (!started) return;
    const at = new Date().toISOString();
    const next = db.prepare(`SELECT MIN(at) AS at FROM (
      SELECT startsAt AS at FROM focus_protection_windows WHERE cancelledAt IS NULL AND startsAt>?
      UNION ALL SELECT endsAt AS at FROM focus_protection_windows WHERE cancelledAt IS NULL AND endsAt>?
    )`).get(at, at) as { at: string | null };
    if (!next.at) return;
    timer = safeSetTimeout(tick, Date.parse(next.at) - Date.now());
    timer.unref();
  }

  function tick(): void {
    timer = undefined;
    if (!started) return;
    try { reconcile(); } catch (error) {
      console.error("[focus-protection] Lifecycle transition failed:", error);
      if (started) {
        clearTimer();
        timer = safeSetTimeout(tick, 30_000);
        timer.unref();
      }
    }
  }

  function reconcile(now = Date.now()): void {
    if (reconciling) return;
    reconciling = true;
    try {
      const transitions = runImmediateTransaction(db, () => {
        const at = new Date(now).toISOString();
        const rows = db.prepare(`SELECT w.* FROM focus_protection_windows w WHERE
          ((w.cancelledAt IS NOT NULL OR w.endsAt<=?) AND NOT EXISTS (
            SELECT 1 FROM focus_attention_events e WHERE e.objectId=w.id AND e.eventType='protection_cleared'))
          OR (w.cancelledAt IS NULL AND w.startsAt<=? AND w.endsAt>? AND NOT EXISTS (
            SELECT 1 FROM focus_attention_events e WHERE e.objectId=w.id AND e.eventType='protection_started'))`)
          .all(at, at, at) as WindowRow[];
        return rows.map((row) => {
          const window = hydrate(row, now);
          const cleared = window.status === "completed" || window.status === "cancelled";
          attention.record({
            eventType: cleared ? "protection_cleared" : "protection_started", objectId: row.id,
            reason: window.status, createdAt: at, details: { endsAt: row.endsAt, cancelledAt: row.cancelledAt },
          });
          return { window, cleared };
        });
      });
      for (const { window, cleared } of transitions) {
        bus.emit({
          type: cleared ? "focus:protection-cleared" : "focus:protection-changed",
          protectionWindowId: window.id, reason: window.status,
        });
      }
    } finally {
      reconciling = false;
      arm();
    }
  }

  function create(value: unknown, validate?: (request: FocusProtectionRequest) => void): FocusProtectionWindow {
    const now = Date.now();
    const request = normalizeFocusProtectionRequest(value, now);
    const result = runImmediateTransaction(db, () => {
      validate?.(request);
      const startsAt = request.startsAt ?? new Date(now).toISOString();
      const overlap = db.prepare(`SELECT id FROM focus_protection_windows
        WHERE cancelledAt IS NULL AND startsAt<? AND endsAt>? LIMIT 1`).get(request.endsAt, startsAt);
      if (overlap) throw new FocusProtectionConflictError("Protection overlaps an existing non-cancelled window");
      const at = new Date(now).toISOString();
      const id = crypto.randomUUID();
      db.prepare(`INSERT INTO focus_protection_windows (
        id, startsAt, endsAt, timezone, reason, allowNeedsInput, allowAuthorizedDeadlineOverride, cancelledAt, createdAt, updatedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)`).run(
        id, startsAt, request.endsAt, request.timezone, request.reason,
        Number(request.allowNeedsInput), Number(request.allowAuthorizedDeadlineOverride), at, at,
      );
      attention.record({ eventType: "protection_created", objectId: id, actor: "user", reason: request.reason, details: { ...request } });
      return get(id, now)!;
    });
    bus.emit({ type: "focus:protection-changed", protectionWindowId: result.id, reason: "created" });
    reconcile(now);
    return result;
  }

  function cancel(id: string): FocusProtectionWindow {
    const result = runImmediateTransaction(db, () => {
      const window = get(id);
      if (!window) throw new FeedCardNotFoundError("Protection window not found");
      if (window.status === "cancelled") return window;
      if (window.status === "completed") throw new FocusProtectionConflictError("Protection has already completed");
      const at = new Date().toISOString();
      db.prepare("UPDATE focus_protection_windows SET cancelledAt=?, updatedAt=? WHERE id=?").run(at, at, id);
      attention.record({ eventType: "protection_cancelled", objectId: id, actor: "user", reason: "user-cancelled" });
      return get(id)!;
    });
    reconcile();
    return result;
  }

  function hold(window: FocusProtectionWindow, work: FocusProtectionWork): boolean {
    return runImmediateTransaction(db, () => {
      const existing = db.prepare(`SELECT id FROM focus_attention_events WHERE eventType='protection_postponed'
        AND objectId=? AND json_extract(detailsJson,'$.kind')=? AND json_extract(detailsJson,'$.workId')=?
        AND json_extract(detailsJson,'$.scheduledFor')=?`).get(window.id, work.kind, work.workId, work.scheduledFor);
      if (existing) return false;
      attention.record({
        eventType: "protection_postponed", objectId: window.id, reason: work.kind,
        details: { ...work, endsAt: window.endsAt },
      });
      return true;
    });
  }

  function hydrateHold(row: HoldRow): FocusProtectionHold {
    return { ...JSON.parse(row.detailsJson) as FocusProtectionWork & { endsAt: string },
      id: row.id, windowId: row.objectId, createdAt: row.createdAt };
  }

  function outstanding(kind?: FocusProtectionWorkKind, workId?: string, scheduledFor?: string): FocusProtectionHold[] {
    return (db.prepare(`SELECT e.id, e.objectId, e.detailsJson, e.createdAt FROM focus_attention_events e
      WHERE e.eventType='protection_postponed' ${kind ? "AND e.reason=?" : ""}
      ${workId === undefined ? "" : "AND json_extract(e.detailsJson,'$.workId')=?"}
      ${scheduledFor === undefined ? "" : "AND json_extract(e.detailsJson,'$.scheduledFor')=?"}
      AND NOT EXISTS (SELECT 1 FROM focus_attention_events d WHERE d.eventType='protection_disposition'
        AND json_extract(d.detailsJson,'$.holdId')=e.id) ORDER BY e.createdAt, e.id`)
      .all(...(kind ? [kind] : []), ...(workId === undefined ? [] : [workId]),
        ...(scheduledFor === undefined ? [] : [scheduledFor])) as HoldRow[]).map(hydrateHold);
  }

  function settle(work: Pick<FocusProtectionWork, "kind" | "workId"> & { scheduledFor?: string },
    disposition: FocusProtectionDisposition, details: Record<string, unknown> = {}): void {
    runImmediateTransaction(db, () => {
      settleFocusProtectionHolds(db, work, disposition, details);
    });
  }

  function impacts(windowId?: string): FocusProtectionImpactSummary {
    if (!windowId) return { postponed: 0, pending: 0, dispositions: {}, recent: [] };
    const rows = db.prepare(`SELECT h.id, h.objectId, h.detailsJson, h.createdAt,
      d.reason AS disposition, d.createdAt AS settledAt FROM focus_attention_events h
      LEFT JOIN focus_attention_events d ON d.eventType='protection_disposition' AND json_extract(d.detailsJson,'$.holdId')=h.id
      WHERE h.eventType='protection_postponed' AND h.objectId=? ORDER BY h.createdAt DESC, h.id DESC`)
      .all(windowId) as Array<HoldRow & { disposition: FocusProtectionDisposition | null; settledAt: string | null }>;
    const dispositions: FocusProtectionImpactSummary["dispositions"] = {};
    for (const row of rows) if (row.disposition) dispositions[row.disposition] = (dispositions[row.disposition] ?? 0) + 1;
    const recent: FocusProtectionImpact[] = rows.slice(0, 20).map((row) => ({
      ...hydrateHold(row), disposition: row.disposition, settledAt: row.settledAt,
    }));
    return { postponed: rows.length, pending: rows.filter((row) => !row.disposition).length, dispositions, recent };
  }

  function start(): void { if (!started) { started = true; reconcile(); } }
  function stop(): void { started = false; clearTimer(); }

  return { get, current, upcoming, latestCompleted, list, coveringSlot, create, cancel, hold, outstanding, settle, impacts, reconcile, start, stop };
}

export type FocusProtectionStore = ReturnType<typeof createFocusProtectionStore>;
