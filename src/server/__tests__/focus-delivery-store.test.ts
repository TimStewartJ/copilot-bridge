import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type DatabaseSync } from "../db.js";
import { createFocusAttentionStore } from "../focus-attention-store.js";
import {
  createFocusNotificationDeliveryStore, FOCUS_NOTIFICATION_CLAIM_GRACE_MS, type FocusNotificationDeliveryStore,
} from "../focus-notification-delivery-store.js";
import { createFocusProtectionStore, type FocusProtectionStore } from "../focus-protection-store.js";
import { createGlobalBus } from "../global-bus.js";
import { makeTestDir, setupTestDb } from "./helpers.js";

const connections: DatabaseSync[] = [];
afterEach(() => {
  for (const connection of connections.splice(0)) connection.close();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("stale notification claim recovery", () => {
  const now = Date.parse("2026-06-01T12:00:00.000Z");
  const sent = { attempted: 1, sent: 1, failed: 0, pruned: 0 };
  const identity = { objectId: "object", activationId: "episode", reason: "immediate-alert", transitionId: "transition" };
  let db: DatabaseSync;
  let store: FocusNotificationDeliveryStore;
  let protection: FocusProtectionStore;

  function window() {
    return protection.create({
      endsAt: new Date(now + 60_000).toISOString(), timezone: "UTC", reason: "Focus",
      allowNeedsInput: false, allowAuthorizedDeadlineOverride: false,
    });
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    db = setupTestDb();
    connections.push(db);
    store = createFocusNotificationDeliveryStore(db);
    protection = createFocusProtectionStore(db, createGlobalBus());
  });

  it("fails only stale claims, retains the send fence and context, and reconciles idempotently across connections", () => {
    const directory = makeTestDir("focus-stale-claims");
    const firstDb = connection(directory);
    store = createFocusNotificationDeliveryStore(firstDb);
    const second = createFocusNotificationDeliveryStore(connection(directory));
    const context = { sessionIds: ["waiting"], pendingSessionIds: ["waiting"], protectionWindowId: "window" };
    const claimed = store.claim(identity, "grant", now - FOCUS_NOTIFICATION_CLAIM_GRACE_MS, context)!;
    const freshIdentity = { ...identity, objectId: "fresh" };
    const fresh = store.claim(freshIdentity, "grant", now - FOCUS_NOTIFICATION_CLAIM_GRACE_MS + 1)!;
    const future = store.claim({ ...identity, objectId: "future" }, "grant", now + 60_000)!;
    const sentinelIdentity = { ...identity, objectId: "sentinel" };
    store.suppress(sentinelIdentity, "no-longer-needed", { terminal: true });
    firstDb.prepare("UPDATE focus_notification_deliveries SET claimedAt='invalid' WHERE objectId='sentinel'").run();
    const sentinel = store.get(sentinelIdentity);
    const knownSent = store.claim({ ...identity, objectId: "sent" }, "grant", now - FOCUS_NOTIFICATION_CLAIM_GRACE_MS)!;
    store.finish(knownSent, sent);

    expect(store.nextClaimInspectionAt(now)).toBe(now);
    expect(store.reconcileStaleClaims(now)).toBe(1);
    expect(store.get(identity)).toMatchObject({
      status: "failed", error: expect.stringContaining("outcome unknown"), claimToken: claimed.claimToken,
      claimedAt: claimed.claimedAt, resolvedGrantId: "grant", transitionId: "transition", sentAt: null,
    });
    expect(JSON.parse(store.get(identity)!.outcomeJson!)).toEqual({
      ...context, recovery: { outcome: "unknown", reason: "stale-claim", claimedAt: claimed.claimedAt,
        inspectedAt: new Date(now).toISOString(), graceMs: FOCUS_NOTIFICATION_CLAIM_GRACE_MS, automaticRetry: false },
    });
    expect(store.get(freshIdentity)).toEqual(fresh);
    expect(store.get(future)).toEqual(future);
    expect(store.get(sentinelIdentity)).toEqual(sentinel);
    expect(store.get(knownSent)?.status).toBe("sent");
    expect(second.reconcileStaleClaims(now)).toBe(0);
    expect(second.claim(identity, "grant", now + FOCUS_NOTIFICATION_CLAIM_GRACE_MS)).toBeUndefined();
    second.suppress(identity, "retry", { pendingUntil: new Date(now).toISOString() });
    expect(second.pending()).toEqual([]);
    expect(second.nextClaimInspectionAt(now)).toBe(now + 1);
    expect(createFocusAttentionStore(firstDb).list({ objectId: identity.objectId })
      .filter((event) => event.reason === "outcome-unknown")).toHaveLength(1);
  });

  it.each([
    ["2026-06-01T11:30:00.000Z", now, true],
    ["2026-06-01T11:30:00Z", now, true],
    ["2026-06-01T04:30:00-07:00", now, true],
    ["2026-06-01T18:30:00+07:00", now, true],
    ["2026-06-01T11:30:00.001Z", now + 1, false],
    ["2026-06-01T11:30:00.123456Z", now + 123, false],
    ["2026-06-01T12:01:00Z", now + 31 * 60_000, false],
    ["0000-01-01T00:00:00.000Z", Date.parse("0000-01-01T00:00:00.000Z") + FOCUS_NOTIFICATION_CLAIM_GRACE_MS, true],
    ["-000001-01-01T00:00:00.000Z", Date.parse("-000001-01-01T00:00:00.000Z") + FOCUS_NOTIFICATION_CLAIM_GRACE_MS, true],
    ["+010000-01-01T00:00:00.000Z", Date.parse("+010000-01-01T00:00:00.000Z") + FOCUS_NOTIFICATION_CLAIM_GRACE_MS, false],
  ])("honors the exact grace boundary for %s independently of other row dates", (claimedAt, inspectionAt, stale) => {
    const claimed = store.claim(identity, null, now)!;
    db.prepare("UPDATE focus_notification_deliveries SET claimedAt=?, createdAt='invalid', updatedAt='invalid' WHERE id=?")
      .run(claimedAt, claimed.id);
    expect(store.nextClaimInspectionAt(now)).toBe(inspectionAt);
    expect(store.reconcileStaleClaims(now)).toBe(stale ? 1 : 0);
    expect(store.get(identity)).toMatchObject({ status: stale ? "failed" : "eligible", claimedAt, claimToken: claimed.claimToken });
  });

  it.each([
    null, "", "invalid", "now", "1780315200000", "2026-06-01", "2026-06-01T12:00:00",
    "2026-02-30T12:00:00.000Z", "2026-13-01T12:00:00Z", "2026-06-01T24:00:00Z", "2026-06-01T12:00:00+99:00",
  ])("explicitly fails closed on malformed claim time %s without substituting other timestamps", (claimedAt) => {
    const claimed = store.claim(identity, null, now)!;
    db.prepare("UPDATE focus_notification_deliveries SET claimedAt=?, createdAt='invalid', updatedAt='invalid' WHERE id=?")
      .run(claimedAt, claimed.id);
    expect(store.nextClaimInspectionAt(now)).toBe(now);
    expect(store.reconcileStaleClaims(now)).toBe(1);
    expect(store.get(identity)).toMatchObject({
      status: "failed", claimedAt, claimToken: claimed.claimToken,
      error: "Delivery outcome unknown: invalid claim timestamp; automatic retry disabled",
    });
    expect(JSON.parse(store.get(identity)!.outcomeJson!).recovery).toMatchObject({
      outcome: "unknown", reason: "invalid-claimed-at", claimedAt, automaticRetry: false,
    });
    expect(store.reconcileStaleClaims(now)).toBe(0);
    expect(store.nextClaimInspectionAt(now)).toBeNull();
    expect(store.claim(identity, null)).toBeUndefined();
  });

  it("bounds each stale batch at 500, filters kinds first, and leaves the next inspection due", () => {
    for (let index = 0; index < 501; index++) {
      store.claim({ ...identity, objectId: `alert-${index}` }, null, now - FOCUS_NOTIFICATION_CLAIM_GRACE_MS);
    }
    const summary = { objectId: "window", activationId: "window", reason: "protected-needs-input" };
    store.claim(summary, null, now - FOCUS_NOTIFICATION_CLAIM_GRACE_MS - 1);
    expect(() => store.reconcileStaleClaims(now, 501)).toThrow();
    expect(store.reconcileStaleClaims(now, 500, "immediate-alert")).toBe(500);
    expect(store.get(summary)?.status).toBe("eligible");
    expect(store.nextClaimInspectionAt(now, "immediate-alert")).toBe(now);
    expect(store.reconcileStaleClaims(now, 500, "immediate-alert")).toBe(1);
    expect(store.nextClaimInspectionAt(now, "immediate-alert")).toBeNull();
    expect(store.reconcileStaleClaims(now, 500, "protected-needs-input")).toBe(1);
    expect(store.reconcileStaleClaims(now)).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS count FROM focus_notification_deliveries WHERE status='failed'").get())
      .toMatchObject({ count: 502 });
  });

  it.each(["reconcile", "finish"] as const)("rolls back the %s result if any related hold disposition cannot commit", (operation) => {
    const heldWindow = window();
    const summary = { objectId: heldWindow.id, activationId: heldWindow.id, reason: "protected-needs-input" };
    protection.hold(heldWindow, { kind: "needs-input", workId: heldWindow.id, scheduledFor: heldWindow.startsAt });
    protection.hold(heldWindow, { kind: "needs-input", workId: "excluded", scheduledFor: heldWindow.startsAt, sessionId: "excluded" });
    const claimed = store.claim(summary, null, now - FOCUS_NOTIFICATION_CLAIM_GRACE_MS,
      { sessionIds: ["waiting"], pendingSessionIds: ["waiting"] })!;
    db.exec(`CREATE TRIGGER reject_disposition BEFORE INSERT ON focus_attention_events
      WHEN NEW.eventType='protection_disposition' BEGIN SELECT RAISE(ABORT, 'hold-write-failed'); END`);
    const complete = () => operation === "reconcile" ? store.reconcileStaleClaims(now) : store.finish(claimed, sent);
    expect(complete).toThrow("hold-write-failed");
    expect(store.get(summary)).toEqual(claimed);
    expect(protection.impacts(heldWindow.id)).toMatchObject({ pending: 2, dispositions: {} });
    expect(createFocusAttentionStore(db).list().filter((event) => event.eventType === "notification_delivery")).toEqual([]);
    db.exec("DROP TRIGGER reject_disposition");
    expect(complete()).toBe(operation === "reconcile" ? 1 : true);
    expect(store.get(summary)?.status).toBe(operation === "reconcile" ? "failed" : "sent");
    expect(protection.impacts(heldWindow.id)).toMatchObject({
      pending: 0, dispositions: { [operation === "reconcile" ? "failed" : "delivered"]: 1, "no-longer-needed": 1 },
    });
  });

  it.each(["sent", "failed"] as const)("recovers a legacy %s result/hold crash gap without altering the result", (status) => {
    const heldWindow = window();
    protection.hold(heldWindow, {
      kind: "notification", workId: JSON.stringify([identity.objectId, identity.activationId]), scheduledFor: heldWindow.startsAt,
    });
    const claimed = store.claim(identity, null, now)!;
    db.prepare("UPDATE focus_notification_deliveries SET status=?, outcomeJson=? WHERE id=?")
      .run(status, JSON.stringify(status === "sent" ? sent : { recovery: { outcome: "unknown", reason: "stale-claim" } }), claimed.id);
    const before = store.get(identity);
    expect(store.pending()).toEqual([]);
    expect(store.nextClaimInspectionAt(now)).toBe(now);
    expect(store.reconcileStaleClaims(now)).toBe(1);
    expect(store.get(identity)).toEqual(before);
    expect(protection.impacts(heldWindow.id)).toMatchObject({
      pending: 0, dispositions: { [status === "sent" ? "delivered" : "failed"]: 1 },
    });
    expect(store.reconcileStaleClaims(now)).toBe(0);
    expect(store.nextClaimInspectionAt(now)).toBeNull();
  });

  it.each([sent, { attempted: 1, sent: 0, failed: 1, pruned: 0 }])(
    "records a late result once without changing unknown bookkeeping or current recipient coverage: %j",
    (outcome) => {
      const heldWindow = window();
      const summary = { objectId: heldWindow.id, activationId: heldWindow.id, reason: "protected-needs-input" };
      protection.hold(heldWindow, { kind: "needs-input", workId: heldWindow.id, scheduledFor: heldWindow.startsAt });
      const claimed = store.claim(summary, null, now - FOCUS_NOTIFICATION_CLAIM_GRACE_MS, {
        sessionIds: ["answered", "waiting"], pendingSessionIds: ["answered", "waiting"],
      })!;
      store.reconcileSessionCoverage(summary.reason, ["waiting"]);
      store.reconcileStaleClaims(now);
      const before = store.get(summary);
      expect(store.finish(claimed, outcome)).toBe(false);
      expect(store.finish(claimed, outcome)).toBe(false);
      expect(store.finish({ ...claimed, claimToken: "different-token" }, outcome)).toBe(false);
      expect(store.get(summary)).toEqual(before);
      expect(protection.impacts(heldWindow.id)).toMatchObject({ pending: 0, dispositions: { failed: 1 } });
      expect(createFocusAttentionStore(db).list({ objectId: heldWindow.id }).filter((event) => event.reason === "late-result"))
        .toEqual([expect.objectContaining({ details: expect.objectContaining({ outcome, retainedStatus: "failed" }) })]);
      expect(store.reconcileSessionCoverage(summary.reason, ["answered", "waiting"])).toEqual(["waiting"]);
      expect(JSON.parse(store.get(summary)!.outcomeJson!)).toMatchObject({
        sessionIds: ["answered", "waiting"], pendingSessionIds: ["waiting"],
      });
      expect(store.reconcileSessionCoverage(summary.reason, [])).toEqual([]);
      expect(store.reconcileSessionCoverage(summary.reason, ["waiting"])).toEqual([]);
    },
  );

  it("reconciles a bounded batch when delivery history is inspected", () => {
    store.claim(identity, null, now - FOCUS_NOTIFICATION_CLAIM_GRACE_MS);
    expect(store.list()).toEqual([expect.objectContaining({ status: "failed", error: expect.stringContaining("outcome unknown") })]);
    expect(store.nextClaimInspectionAt(now)).toBeNull();
  });
});
function connection(directory: string) {
  const db = openDatabase(directory);
  connections.push(db);
  return db;
}

describe("durable notification delivery arbitration", () => {
  it("allows only one send claim across independent database connections and restarts", () => {
    const directory = makeTestDir("focus-delivery-claim");
    const first = createFocusNotificationDeliveryStore(connection(directory));
    const second = createFocusNotificationDeliveryStore(connection(directory));
    const identity = { objectId: "object", activationId: "episode", reason: "immediate-alert", transitionId: "transition" };
    const claimed = first.claim(identity, "grant");
    expect(claimed?.claimToken).toBeTruthy();
    expect(second.claim(identity, "grant")).toBeUndefined();
    first.finish(claimed!, { attempted: 1, sent: 1, failed: 0, pruned: 0 });
    expect(second.get(identity)?.status).toBe("sent");
    const reopened = createFocusNotificationDeliveryStore(connection(directory));
    expect(reopened.claim(identity, "grant")).toBeUndefined();
    expect(reopened.claim({ ...identity, activationId: "new-episode" }, "grant")).toBeDefined();
  });

  it("keeps quiet-hour suppressions pending until due without double-claiming them", () => {
    const directory = makeTestDir("focus-delivery-quiet");
    const first = createFocusNotificationDeliveryStore(connection(directory));
    const second = createFocusNotificationDeliveryStore(connection(directory));
    const identity = { objectId: "quiet", activationId: "episode", reason: "immediate-alert" };
    const now = Date.now();
    first.suppress(identity, "quiet-hours", { pendingUntil: new Date(now + 60_000).toISOString(), resolvedGrantId: "grant" });
    expect(first.pending()).toHaveLength(1);
    expect(second.claim(identity, "grant", now)).toBeUndefined();
    const claimed = second.claim(identity, "grant", now + 60_000);
    expect(claimed).toMatchObject({ status: "eligible", pendingUntil: null, suppressionReason: null, resolvedGrantId: "grant" });
    expect(first.claim(identity, "grant", now + 60_000)).toBeUndefined();
    first.finish(claimed!, { attempted: 1, sent: 0, failed: 1, pruned: 0 }, "Transport failed");
    expect(first.get(identity)?.status).toBe("failed");
    expect(second.claim(identity, "grant", now + 120_000)).toBeUndefined();
  });

  it("filters delivery kinds before applying the pending-page bound", () => {
    const db = setupTestDb();
    connections.push(db);
    const store = createFocusNotificationDeliveryStore(db);
    for (let index = 0; index < 501; index++) {
      store.suppress({ objectId: `summary-${index}`, activationId: "window", reason: "protected-needs-input" },
        "protected-focus", { pendingUntil: "2026-06-01T12:00:00.000Z" });
    }
    store.suppress({ objectId: "alert", activationId: "episode", reason: "immediate-alert" },
      "protected-focus", { pendingUntil: "2026-06-01T12:05:00.000Z" });
    expect(store.pending(500)).toHaveLength(500);
    expect(store.pending(500, "immediate-alert").map((row) => row.objectId)).toEqual(["alert"]);
  });

  it("fences a no-longer-needed summary without claiming a successful delivery", () => {
    const db = setupTestDb();
    connections.push(db);
    const store = createFocusNotificationDeliveryStore(db);
    const identity = { objectId: "window", activationId: "window", reason: "protected-needs-input" };
    store.suppress(identity, "no-longer-needed", { terminal: true });
    store.suppress(identity, "protected-focus", { pendingUntil: new Date().toISOString() });
    expect(store.claim(identity, null)).toBeUndefined();
    expect(store.get(identity)).toMatchObject({
      status: "suppressed", suppressionReason: "no-longer-needed", pendingUntil: null,
      claimToken: expect.any(String), sentAt: null,
    });
    expect(store.pending()).toEqual([]);
  });

  it("persists recipient coverage at claim and preserves observed answers when finishing later", () => {
    const directory = makeTestDir("focus-summary-coverage");
    const first = createFocusNotificationDeliveryStore(connection(directory));
    const second = createFocusNotificationDeliveryStore(connection(directory));
    const identity = { objectId: "window", activationId: "window", reason: "protected-needs-input" };
    const claimed = first.claim(identity, null, Date.now(), {
      sessionIds: ["answered", "waiting"], pendingSessionIds: ["answered", "waiting"],
    })!;
    expect(second.reconcileSessionCoverage(identity.reason, ["waiting"])).toEqual(["waiting"]);
    first.finish(claimed, { attempted: 1, sent: 1, failed: 0, pruned: 0 });
    expect(JSON.parse(second.get(identity)!.outcomeJson!)).toMatchObject({
      sessionIds: ["answered", "waiting"], pendingSessionIds: ["waiting"], sent: 1,
    });
    const reopened = createFocusNotificationDeliveryStore(connection(directory));
    expect(reopened.reconcileSessionCoverage(identity.reason, ["answered", "waiting"])).toEqual(["waiting"]);
    expect(reopened.reconcileSessionCoverage(identity.reason, [])).toEqual([]);
    expect(reopened.reconcileSessionCoverage(identity.reason, ["waiting"])).toEqual([]);
    expect(reopened.claim(identity, null)).toBeUndefined();
  });
});
