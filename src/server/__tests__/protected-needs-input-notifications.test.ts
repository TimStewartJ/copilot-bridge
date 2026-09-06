import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_FOCUS_NOTIFICATION_POLICY } from "../../shared/focus-notification-policy.js";
import type { FocusProtectionRequest, FocusProtectionSession } from "../../shared/focus-protection.js";
import type { DatabaseSync } from "../db.js";
import { createFocusAttentionStore } from "../focus-attention-store.js";
import {
  createFocusNotificationDeliveryStore, FOCUS_NOTIFICATION_CLAIM_GRACE_MS, type FocusNotificationDeliveryStore,
} from "../focus-notification-delivery-store.js";
import { createFocusProtectionStore, initializeFocusProtectionSchema, type FocusProtectionStore } from "../focus-protection-store.js";
import { createGlobalBus, type GlobalBus } from "../global-bus.js";
import {
  initPushEventNotifications, type BridgePushPayload, type PushEventNotificationDisposer,
  type PushEventNotificationOptions, type PushSendSummary,
} from "../push-notification-service.js";
import { createSettingsStore, type SettingsStore } from "../settings-store.js";
import { createTaskStore } from "../task-store.js";
import { setupTestDb } from "./helpers.js";

vi.mock("../public-url.js", () => ({ buildPublicUrl: (path: string) => path }));

const NOON = Date.parse("2026-06-01T12:00:00.000Z");
const SENT: PushSendSummary = { attempted: 1, sent: 1, failed: 0, pruned: 0 };
const SUMMARY_REASON = "protected-needs-input";

function session(sessionId: string, overrides: Partial<FocusProtectionSession> = {}): FocusProtectionSession {
  return { sessionId, title: `Session ${sessionId}`, taskId: null, muted: false, busy: false,
    pendingUserInputCount: 1, ...overrides };
}

function identity(windowId: string) {
  return { objectId: windowId, activationId: windowId, reason: SUMMARY_REASON };
}

describe("protected needs-input notifications", () => {
  let db: DatabaseSync;
  let bus: GlobalBus;
  let protectionStore: FocusProtectionStore;
  let deliveryStore: FocusNotificationDeliveryStore;
  let settingsStore: SettingsStore;
  let sessions: FocusProtectionSession[];
  let ctx: Parameters<typeof initPushEventNotifications>[0];
  let sendToAll: ReturnType<typeof vi.fn<(payload: BridgePushPayload) => Promise<PushSendSummary>>>;
  let disposers: PushEventNotificationDisposer[];

  function protect(updates: Partial<FocusProtectionRequest> = {}) {
    return protectionStore.create({
      endsAt: new Date(Date.now() + 5 * 60_000).toISOString(), timezone: "UTC", reason: "Deep work",
      allowNeedsInput: false, allowAuthorizedDeadlineOverride: false, ...updates,
    });
  }

  function start(overrides: PushEventNotificationOptions = {}): PushEventNotificationDisposer {
    const stop = initPushEventNotifications(ctx, { sendToAll, sendToEndpoint: async () => SENT }, {
      protectionStore, deliveryStore, settingsStore,
      getSessions: () => sessions.map((entry) => ({ ...entry })), ...overrides,
    });
    disposers.push(stop);
    return stop;
  }

  function emit(sessionId: string, count = 1): void {
    const existing = sessions.find((entry) => entry.sessionId === sessionId);
    if (existing) existing.pendingUserInputCount = count;
    else sessions.push(session(sessionId, { pendingUserInputCount: count }));
    bus.emit({ type: "session:user-input", sessionId, pendingUserInputCount: count, needsUserInput: count > 0 });
  }

  function abandonedClaim(window: ReturnType<typeof protect>, sessionIds: string[], now = Date.now()) {
    protectionStore.hold(window, {
      kind: "needs-input", workId: window.id, scheduledFor: window.startsAt, title: "Coalesced needs-input summary",
    });
    return deliveryStore.claim(identity(window.id), null, now, {
      protectionWindowId: window.id, sessionIds, pendingSessionIds: sessionIds,
    })!;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOON);
    db = setupTestDb();
    initializeFocusProtectionSchema(db);
    bus = createGlobalBus();
    protectionStore = createFocusProtectionStore(db, bus);
    deliveryStore = createFocusNotificationDeliveryStore(db);
    settingsStore = createSettingsStore(db);
    settingsStore.updateSettings({ focusNotifications: { ...DEFAULT_FOCUS_NOTIFICATION_POLICY, quietHours: null } });
    ctx = { globalBus: bus, taskStore: createTaskStore(db, bus), cliSessionCatalog: undefined,
      apiBasePath: "/staging/test/api", focusAttentionStore: createFocusAttentionStore(db) };
    sessions = [];
    sendToAll = vi.fn<(payload: BridgePushPayload) => Promise<PushSendSummary>>().mockResolvedValue(SENT);
    disposers = [];
  });

  afterEach(async () => {
    await Promise.all(disposers.map((stop) => stop()));
    protectionStore.stop();
    vi.restoreAllMocks();
    vi.useRealTimers();
    db.close();
  });

  it("preserves normal needs-input delivery when allowed, including its independent standing policy", async () => {
    settingsStore.updateSettings({
      focusNotifications: { ...DEFAULT_FOCUS_NOTIFICATION_POLICY, quietHours: { start: "12:00", end: "13:00" } },
    });
    const window = protect({ allowNeedsInput: true });
    const stop = start();
    emit("waiting");
    emit("waiting", 2);
    await stop.flush();
    expect(sendToAll).toHaveBeenCalledTimes(1);
    expect(sendToAll).toHaveBeenCalledWith(expect.objectContaining({
      tag: "bridge-session-waiting", data: { eventType: "session:user-input", sessionId: "waiting" },
    }));
    expect(protectionStore.impacts(window.id).postponed).toBe(0);
    expect(deliveryStore.get(identity(window.id))).toBeUndefined();
    emit("waiting", 0);
    emit("waiting", 1);
    await stop.flush();
    expect(sendToAll).toHaveBeenCalledTimes(2);
  });

  it.each([false, true])("includes already-waiting sessions, service initialized first=%s", async (serviceFirst) => {
    sessions = [session("waiting"), session("answered"), session("task-muted"), session("already-muted", { muted: true })];
    const task = ctx.taskStore.createTask("Source");
    ctx.taskStore.linkSession(task.id, "task-muted");
    const stop = serviceFirst ? start() : undefined;
    if (stop) await stop.flush();
    const window = protect();
    const controller = stop ?? start();
    await controller.flush();
    emit("waiting");
    emit("waiting", 2);
    await controller.flush();
    expect(protectionStore.impacts(window.id)).toMatchObject({ postponed: 1, pending: 1 });
    expect(deliveryStore.pending(500, SUMMARY_REASON)).toHaveLength(1);
    expect(ctx.focusAttentionStore!.list({ objectId: window.id }).filter((event) =>
      event.eventType === "notification_suppression" && event.reason === "protected-focus")).toHaveLength(1);
    sessions.find((entry) => entry.sessionId === "answered")!.pendingUserInputCount = 0;
    ctx.taskStore.updateTask(task.id, { muted: true });
    sessions.push(session("new-current"));
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(sendToAll).toHaveBeenCalledTimes(1);
    expect(sendToAll.mock.calls[0][0]).toMatchObject({
      title: "2 sessions need input", tag: `bridge-needs-input-${window.id}`,
      url: "/staging/test/dashboard/focus",
      data: { sessionIds: ["waiting", "new-current"], protectionWindowId: window.id, sessionCount: 2 },
    });
    expect(sendToAll.mock.calls[0][0].body).not.toContain("answered");
    expect(sendToAll.mock.calls[0][0].body).not.toContain("muted");
    expect(protectionStore.impacts(window.id)).toMatchObject({
      pending: 0, dispositions: { delivered: 1 },
    });
    expect(JSON.parse(deliveryStore.get(identity(window.id))!.outcomeJson!).sessionIds).toEqual(["waiting", "new-current"]);
  });

  it.each(["expiry", "cancellation", "offline-expiry", "offline-cancellation"] as const)(
    "releases one current summary on %s and never replays it",
    async (release) => {
      const window = protect();
      sessions = [session("one"), session("two")];
      const first = start();
      await first.flush();
      if (release.startsWith("offline")) await first();
      if (release.endsWith("cancellation")) protectionStore.cancel(window.id);
      else vi.setSystemTime(NOON + 5 * 60_000);
      const controller = release.startsWith("offline") ? start() : first;
      await controller.flush();
      expect(sendToAll).toHaveBeenCalledTimes(1);
      expect(deliveryStore.get(identity(window.id))).toMatchObject({ status: "sent", resolvedGrantId: null });
      bus.emit({ type: "focus:protection-cleared", protectionWindowId: window.id });
      emit("one");
      emit("two");
      await controller.flush();
      await controller();
      const restarted = start();
      await restarted.flush();
      emit("one");
      emit("two");
      await restarted.flush();
      expect(sendToAll).toHaveBeenCalledTimes(1);
      expect(protectionStore.impacts(window.id)).toMatchObject({ pending: 0, dispositions: { delivered: 1 } });
    },
  );

  it("drops answered sessions without replaying an event or misreporting a successful delivery", async () => {
    const window = protect();
    sessions = [session("answered")];
    const stop = start();
    await stop.flush();
    sessions[0].pendingUserInputCount = 0;
    protectionStore.cancel(window.id);
    await stop.flush();
    expect(sendToAll).not.toHaveBeenCalled();
    expect(deliveryStore.get(identity(window.id))).toMatchObject({
      status: "suppressed", suppressionReason: "no-longer-needed", pendingUntil: null, sentAt: null,
      claimToken: expect.any(String),
    });
    expect(protectionStore.impacts(window.id)).toMatchObject({ pending: 0, dispositions: { "no-longer-needed": 1 } });
    bus.emit({ type: "session:user-input", sessionId: "answered", needsUserInput: true });
    bus.emit({ type: "focus:protection-cleared", protectionWindowId: window.id });
    await stop.flush();
    expect(sendToAll).not.toHaveBeenCalled();
    emit("new-input");
    await stop.flush();
    expect(sendToAll).toHaveBeenCalledTimes(1);
    expect(sendToAll.mock.calls[0][0].tag).toBe("bridge-session-new-input");
  });

  it("applies both current session and independently resolved task mute rules", async () => {
    const window = protect();
    sessions = [session("session-muted"), session("task-muted"), session("mixed")];
    const muted = ctx.taskStore.createTask("Muted");
    const unmuted = ctx.taskStore.createTask("Unmuted");
    ctx.taskStore.linkSession(muted.id, "task-muted");
    ctx.taskStore.linkSession(muted.id, "mixed");
    ctx.taskStore.linkSession(unmuted.id, "mixed");
    const stop = start();
    await stop.flush();
    sessions[0].muted = true;
    ctx.taskStore.updateTask(muted.id, { muted: true });
    protectionStore.cancel(window.id);
    await stop.flush();
    expect(sendToAll).toHaveBeenCalledTimes(1);
    expect(sendToAll.mock.calls[0][0].data?.sessionIds).toEqual(["mixed"]);
  });

  it("preserves standing quiet hours after cancellation instead of granting an override", async () => {
    const window = protect();
    sessions = [session("waiting")];
    const stop = start();
    await stop.flush();
    settingsStore.updateSettings({
      focusNotifications: { ...DEFAULT_FOCUS_NOTIFICATION_POLICY, quietHours: { start: "12:00", end: "12:02" },
        allowGrantQuietHoursOverride: true },
    });
    protectionStore.cancel(window.id);
    await stop.flush();
    expect(sendToAll).not.toHaveBeenCalled();
    expect(deliveryStore.get(identity(window.id))).toMatchObject({
      suppressionReason: "quiet-hours", pendingUntil: "2026-06-01T12:02:00.000Z",
    });
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    expect(sendToAll).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])("does not extend protection to fresh input after release, next window allows input=%s", async (nextWindow) => {
    const window = protect();
    sessions = [session("held")];
    const stop = start();
    await stop.flush();
    settingsStore.updateSettings({
      focusNotifications: { ...DEFAULT_FOCUS_NOTIFICATION_POLICY, quietHours: { start: "12:00", end: "13:00" } },
    });
    protectionStore.cancel(window.id);
    if (nextWindow) protect({ allowNeedsInput: true });
    await stop.flush();
    expect(sendToAll).not.toHaveBeenCalled();
    emit("fresh");
    await stop.flush();
    expect(sendToAll).toHaveBeenCalledTimes(1);
    expect(sendToAll.mock.calls[0][0].tag).toBe("bridge-session-fresh");
    emit("held");
    await stop.flush();
    expect(sendToAll).toHaveBeenCalledTimes(1);
    emit("held", 0);
    emit("held", 1);
    await stop.flush();
    expect(sendToAll).toHaveBeenCalledTimes(2);
    expect(sendToAll.mock.calls[1][0].tag).toBe("bridge-session-held");
  });

  it("recovers a durable hold when a crash prevented its pending delivery row", async () => {
    const window = protect();
    sessions = [session("waiting")];
    protectionStore.hold(window, {
      kind: "needs-input", workId: JSON.stringify([window.id, "waiting"]), scheduledFor: window.startsAt,
      sessionId: "waiting", title: "Waiting",
    });
    vi.setSystemTime(NOON + 5 * 60_000);
    const stop = start();
    await stop.flush();
    expect(sendToAll).toHaveBeenCalledTimes(1);
    expect(protectionStore.impacts(window.id)).toMatchObject({ postponed: 1, pending: 0, dispositions: { delivered: 1 } });
  });

  it("does not replay an ambiguous claim after restart but allows a genuinely new input episode", async () => {
    const window = protect();
    sessions = [session("waiting")];
    const first = start();
    await first.flush();
    await first();
    vi.setSystemTime(NOON + 5 * 60_000);
    deliveryStore.suppress(identity(window.id), "summary-ready");
    deliveryStore.claim(identity(window.id), null, Date.now(), {
      protectionWindowId: window.id, sessionIds: ["waiting"], pendingSessionIds: ["waiting"],
    });
    const second = start();
    await second.flush();
    emit("waiting");
    await second.flush();
    expect(sendToAll).not.toHaveBeenCalled();
    expect(deliveryStore.get(identity(window.id))?.status).toBe("eligible");
    emit("waiting", 0);
    emit("waiting", 1);
    await second.flush();
    expect(sendToAll).toHaveBeenCalledTimes(1);
    expect(sendToAll.mock.calls[0][0].tag).toBe("bridge-session-waiting");
  });

  it("inspects only-claimed startup rows at grace expiry even while session hydration is unavailable", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const window = protect();
    sessions = [session("waiting")];
    const claimed = abandonedClaim(window, ["waiting"]);
    vi.setSystemTime(NOON + 5 * 60_000);
    let unavailable = true;
    const stop = start({ getSessions: () => {
      if (unavailable) throw new Error("Session state unavailable");
      return sessions;
    } });
    await stop.flush();
    expect(deliveryStore.pending()).toEqual([]);
    expect(protectionStore.impacts(window.id)).toMatchObject({ pending: 1, dispositions: {} });
    await vi.advanceTimersByTimeAsync(FOCUS_NOTIFICATION_CLAIM_GRACE_MS - 5 * 60_000 - 1);
    expect(deliveryStore.get(identity(window.id))?.status).toBe("eligible");
    await vi.advanceTimersByTimeAsync(1);
    expect(deliveryStore.get(identity(window.id))).toMatchObject({
      status: "failed", claimToken: claimed.claimToken, claimedAt: claimed.claimedAt,
      error: expect.stringContaining("outcome unknown"), sentAt: null,
    });
    expect(protectionStore.impacts(window.id)).toMatchObject({ pending: 0, dispositions: { failed: 1 } });
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("Session state unavailable"));
    expect(sendToAll).not.toHaveBeenCalled();
    unavailable = false;
    emit("waiting");
    await stop.flush();
    await stop();
    const restarted = start();
    emit("waiting");
    await restarted.flush();
    expect(sendToAll).not.toHaveBeenCalled();
    expect(JSON.parse(deliveryStore.get(identity(window.id))!.outcomeJson!)).toMatchObject({
      sessionIds: ["waiting"], pendingSessionIds: ["waiting"],
    });
    emit("waiting", 0);
    emit("waiting", 1);
    await restarted.flush();
    expect(sendToAll).toHaveBeenCalledTimes(1);
    expect(sendToAll.mock.calls[0][0].tag).toBe("bridge-session-waiting");
  });

  it.each(["sent", "failed"] as const)(
    "repairs a legacy %s result/hold crash gap before reading unavailable session state",
    async (status) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const window = protect();
      const claimed = abandonedClaim(window, ["waiting"]);
      const context = JSON.parse(claimed.outcomeJson!) as Record<string, unknown>;
      db.prepare("UPDATE focus_notification_deliveries SET status=?, outcomeJson=? WHERE id=?").run(status,
        JSON.stringify({ ...context, ...(status === "sent" ? SENT : { recovery: { outcome: "unknown", reason: "stale-claim" } }) }),
        claimed.id);
      const before = deliveryStore.get(identity(window.id));
      const stop = start({ getSessions: () => { throw new Error("Session state unavailable"); } });
      await stop.flush();
      expect(deliveryStore.pending()).toEqual([]);
      expect(deliveryStore.get(identity(window.id))).toEqual(before);
      expect(protectionStore.impacts(window.id)).toMatchObject({
        pending: 0, dispositions: { [status === "sent" ? "delivered" : "failed"]: 1 },
      });
      expect(sendToAll).not.toHaveBeenCalled();
    },
  );

  it("uses another bounded clock pass for more than 500 claimed summaries without pending rows", async () => {
    for (let index = 0; index < 501; index++) {
      deliveryStore.claim(identity(`crashed-window-${index}`), null, NOON - FOCUS_NOTIFICATION_CLAIM_GRACE_MS);
    }
    const reconcile = vi.spyOn(deliveryStore, "reconcileStaleClaims");
    start();
    await vi.advanceTimersByTimeAsync(0);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveLastReturnedWith(500);
    expect(deliveryStore.pending()).toEqual([]);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(reconcile).toHaveLastReturnedWith(1);
    expect(db.prepare("SELECT COUNT(*) AS count FROM focus_notification_deliveries WHERE status='failed'").get())
      .toMatchObject({ count: 501 });
    expect(vi.getTimerCount()).toBe(0);
    expect(sendToAll).not.toHaveBeenCalled();
  });

  it("logs and retries a failed atomic inspection without masking a hold-ledger database failure", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const window = protect();
    sessions = [session("waiting")];
    const claimed = abandonedClaim(window, ["waiting"]);
    vi.setSystemTime(NOON + FOCUS_NOTIFICATION_CLAIM_GRACE_MS);
    db.exec(`CREATE TRIGGER reject_recovery_disposition BEFORE INSERT ON focus_attention_events
      WHEN NEW.eventType='protection_disposition' BEGIN SELECT RAISE(ABORT, 'hold-ledger-unavailable'); END`);
    start();
    await vi.advanceTimersByTimeAsync(0);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("hold-ledger-unavailable"));
    expect(deliveryStore.get(identity(window.id))).toEqual(claimed);
    expect(protectionStore.impacts(window.id)).toMatchObject({ pending: 1, dispositions: {} });
    expect(sendToAll).not.toHaveBeenCalled();
    db.exec("DROP TRIGGER reject_recovery_disposition");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(deliveryStore.get(identity(window.id))?.status).toBe("failed");
    expect(protectionStore.impacts(window.id)).toMatchObject({ pending: 0, dispositions: { failed: 1 } });
    expect(sendToAll).not.toHaveBeenCalled();
  });

  it("never includes an ambiguously notified current input in a later protection summary", async () => {
    const firstWindow = protect();
    abandonedClaim(firstWindow, ["already-covered"]);
    vi.setSystemTime(NOON + FOCUS_NOTIFICATION_CLAIM_GRACE_MS);
    sessions = [session("already-covered"), session("fresh")];
    const nextWindow = protect();
    const stop = start();
    await stop.flush();
    expect(deliveryStore.get(identity(firstWindow.id))?.status).toBe("failed");
    emit("already-covered");
    await stop.flush();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(sendToAll).toHaveBeenCalledTimes(1);
    expect(sendToAll.mock.calls[0][0]).toMatchObject({
      tag: `bridge-needs-input-${nextWindow.id}`, data: { sessionIds: ["fresh"], sessionCount: 1 },
    });
    emit("already-covered");
    emit("fresh");
    await stop.flush();
    expect(sendToAll).toHaveBeenCalledTimes(1);
    expect(protectionStore.impacts(firstWindow.id)).toMatchObject({ pending: 0, dispositions: { failed: 1 } });
    expect(protectionStore.impacts(nextWindow.id)).toMatchObject({ pending: 0, dispositions: { delivered: 1 } });
  });

  it.each(["sent", "rejected"] as const)(
    "recovers a hung summary independently of its queue and session reads before a late %s result",
    async (late) => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      let entered!: () => void;
      let complete!: (summary: PushSendSummary) => void;
      let reject!: (error: Error) => void;
      const started = new Promise<void>((resolve) => { entered = resolve; });
      const sending = new Promise<PushSendSummary>((resolve, rejectPromise) => { complete = resolve; reject = rejectPromise; });
      sendToAll.mockImplementationOnce(() => { entered(); return sending; });
      const window = protect();
      sessions = [session("answered"), session("waiting")];
      let unavailable = false;
      const stop = start({ getSessions: () => {
        if (unavailable) throw new Error("Session state unavailable");
        return sessions;
      } });
      await stop.flush();
      const settle = vi.spyOn(protectionStore, "settle");
      vi.setSystemTime(NOON + 5 * 60_000);
      const releasing = stop.flush();
      await started;
      try {
        const claimed = deliveryStore.get(identity(window.id))!;
        expect(vi.getTimerCount()).toBe(1);
        emit("answered", 0);
        unavailable = true;
        await vi.advanceTimersByTimeAsync(FOCUS_NOTIFICATION_CLAIM_GRACE_MS - 1);
        expect(deliveryStore.get(identity(window.id))?.status).toBe("eligible");
        await vi.advanceTimersByTimeAsync(1);
        const recovered = deliveryStore.get(identity(window.id));
        expect(recovered).toMatchObject({ status: "failed", claimToken: claimed.claimToken, sentAt: null });
        expect(protectionStore.impacts(window.id)).toMatchObject({ pending: 0, dispositions: { failed: 1 } });
        expect(JSON.parse(recovered!.outcomeJson!)).toMatchObject({
          sessionIds: ["answered", "waiting"], pendingSessionIds: ["waiting"],
        });
        unavailable = false;
        if (late === "sent") complete(SENT);
        else reject(new Error("Late transport failure"));
        await releasing;
        emit("waiting");
        await stop.flush();
        expect(deliveryStore.get(identity(window.id))).toEqual(recovered);
        expect(settle.mock.calls.some(([, disposition]) => disposition === "delivered")).toBe(false);
        expect(ctx.focusAttentionStore!.list({ objectId: window.id }).filter((event) => event.reason === "late-result"))
          .toEqual([expect.objectContaining({
            details: expect.objectContaining({ retainedStatus: "failed",
              ...(late === "sent" ? { outcome: SENT } : { error: "Late transport failure" }) }),
          })]);
        expect(sendToAll).toHaveBeenCalledTimes(1);
        expect(vi.getTimerCount()).toBe(0);
        emit("answered");
        await stop.flush();
        expect(sendToAll).toHaveBeenCalledTimes(2);
        expect(sendToAll.mock.calls[1][0].tag).toBe("bridge-session-answered");
      } finally {
        unavailable = false;
        complete(SENT);
        await releasing;
      }
    },
  );

  it("stops the only-claimed inspection clock on shutdown and reconciles the claim after restart", async () => {
    const window = protect();
    sessions = [session("waiting")];
    abandonedClaim(window, ["waiting"]);
    const first = start();
    await first.flush();
    expect(vi.getTimerCount()).toBe(1);
    await first();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(FOCUS_NOTIFICATION_CLAIM_GRACE_MS);
    expect(deliveryStore.get(identity(window.id))?.status).toBe("eligible");
    expect(protectionStore.impacts(window.id).pending).toBe(1);
    const second = start();
    await second.flush();
    expect(deliveryStore.get(identity(window.id))?.status).toBe("failed");
    expect(protectionStore.impacts(window.id)).toMatchObject({ pending: 0, dispositions: { failed: 1 } });
    emit("waiting");
    await second.flush();
    expect(sendToAll).not.toHaveBeenCalled();
  });

  it("recovers the ready-before-claim crash gap without sending both an event and its summary", async () => {
    const window = protect();
    sessions = [session("waiting")];
    const first = start();
    await first.flush();
    await first();
    vi.setSystemTime(NOON + 5 * 60_000);
    deliveryStore.suppress(identity(window.id), "summary-ready");
    expect(deliveryStore.pending(500, SUMMARY_REASON)).toEqual([]);
    const second = start();
    emit("waiting");
    await second.flush();
    expect(sendToAll).toHaveBeenCalledTimes(1);
    expect(sendToAll.mock.calls[0][0].tag).toBe(`bridge-needs-input-${window.id}`);
    expect(deliveryStore.get(identity(window.id))?.status).toBe("sent");
  });

  it("arbitrates summary claims across controllers without mislabelling an in-flight send", async () => {
    let entered!: () => void;
    let complete!: (summary: PushSendSummary) => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const sending = new Promise<PushSendSummary>((resolve) => { complete = resolve; });
    sendToAll.mockImplementation(() => { entered(); return sending; });
    const window = protect();
    sessions = [session("waiting")];
    const first = start();
    const second = start();
    await Promise.all([first.flush(), second.flush()]);
    vi.setSystemTime(NOON + 5 * 60_000);
    const firstFlush = first.flush();
    await started;
    await second.flush();
    expect(sendToAll).toHaveBeenCalledTimes(1);
    expect(protectionStore.impacts(window.id)).toMatchObject({ pending: 1, dispositions: {} });
    complete(SENT);
    await firstFlush;
    expect(protectionStore.impacts(window.id)).toMatchObject({ pending: 0, dispositions: { delivered: 1 } });
  });

  it("supersedes a previous quiet-hour backlog when another protection window starts", async () => {
    settingsStore.updateSettings({
      focusNotifications: { ...DEFAULT_FOCUS_NOTIFICATION_POLICY, quietHours: { start: "12:00", end: "12:20" } },
    });
    const firstWindow = protect();
    sessions = [session("waiting")];
    const stop = start();
    await stop.flush();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    const secondWindow = protect();
    await stop.flush();
    expect(protectionStore.impacts(firstWindow.id).dispositions).toEqual({ superseded: 1 });
    expect(deliveryStore.get(identity(firstWindow.id))).toMatchObject({ suppressionReason: "superseded", pendingUntil: null });
    await vi.advanceTimersByTimeAsync(15 * 60_000);
    expect(sendToAll).toHaveBeenCalledTimes(1);
    expect(sendToAll.mock.calls[0][0].data?.protectionWindowId).toBe(secondWindow.id);
  });

  it("coalesces several windows that elapsed offline instead of replaying each backlog", async () => {
    const firstWindow = protect();
    sessions = [session("waiting")];
    const first = start();
    await first.flush();
    await first();
    vi.setSystemTime(NOON + 5 * 60_000);
    const secondWindow = protect();
    protectionStore.hold(secondWindow, {
      kind: "needs-input", workId: JSON.stringify([secondWindow.id, "waiting"]),
      scheduledFor: secondWindow.startsAt, sessionId: "waiting",
    });
    vi.setSystemTime(NOON + 10 * 60_000);
    const second = start();
    await second.flush();
    expect(sendToAll).toHaveBeenCalledTimes(1);
    expect(sendToAll.mock.calls[0][0].data?.protectionWindowId).toBe(secondWindow.id);
    expect(protectionStore.impacts(firstWindow.id).dispositions).toEqual({ superseded: 1 });
  });

  it.each(["throw", "partial", "empty"] as const)("keeps a %s summary failure terminal but allows a successful direct retry after restart", async (failure) => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const window = protect();
    sessions = [session("waiting")];
    const first = start();
    await first.flush();
    if (failure === "throw") sendToAll.mockRejectedValue(new Error("Transport unavailable"));
    else sendToAll.mockResolvedValue(failure === "partial"
      ? { attempted: 2, sent: 1, failed: 1, pruned: 0 }
      : { attempted: 0, sent: 0, failed: 0, pruned: 0 });
    protectionStore.cancel(window.id);
    await first.flush();
    expect(deliveryStore.get(identity(window.id))?.status).toBe("failed");
    expect(protectionStore.impacts(window.id).dispositions).toEqual({ failed: 1 });
    expect(warning).toHaveBeenCalled();
    await first.flush();
    expect(sendToAll).toHaveBeenCalledTimes(1);
    await first();
    const restarted = start();
    await restarted.flush();
    expect(sendToAll).toHaveBeenCalledTimes(1);
    sendToAll.mockResolvedValue(SENT);
    emit("waiting");
    emit("waiting", 2);
    await restarted.flush();
    expect(sendToAll).toHaveBeenCalledTimes(2);
    expect(sendToAll.mock.calls[1][0].tag).toBe("bridge-session-waiting");
    emit("waiting", 3);
    await restarted.flush();
    expect(sendToAll).toHaveBeenCalledTimes(2);
    expect(deliveryStore.get(identity(window.id))?.status).toBe("failed");
  });

  it("fails closed on a current-state read error and retries the queued summary", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const window = protect();
    sessions = [session("waiting")];
    let broken = false;
    const stop = start({ getSessions: () => {
      if (broken) throw new Error("Session state unavailable");
      return sessions;
    } });
    await stop.flush();
    broken = true;
    protectionStore.cancel(window.id);
    await stop.flush();
    expect(sendToAll).not.toHaveBeenCalled();
    expect(deliveryStore.get(identity(window.id))?.claimToken).toBeNull();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("Session state unavailable"));
    broken = false;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(sendToAll).toHaveBeenCalledTimes(1);
  });

  it("rechecks independently muted tasks immediately after claiming and before sending", async () => {
    const window = protect();
    sessions = [session("waiting")];
    const task = ctx.taskStore.createTask("Source");
    ctx.taskStore.linkSession(task.id, "waiting");
    const claim = deliveryStore.claim;
    const stop = start({ deliveryStore: { ...deliveryStore, claim: (...args) => {
      const row = claim(...args);
      ctx.taskStore.updateTask(task.id, { muted: true });
      return row;
    } } });
    await stop.flush();
    protectionStore.cancel(window.id);
    await stop.flush();
    expect(sendToAll).not.toHaveBeenCalled();
    expect(deliveryStore.get(identity(window.id))).toMatchObject({ status: "failed" });
  });

  it("awaits an in-flight summary on dispose and does not process later events", async () => {
    let entered!: () => void;
    let complete!: (summary: PushSendSummary) => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const sending = new Promise<PushSendSummary>((resolve) => { complete = resolve; });
    sendToAll.mockImplementation(() => { entered(); return sending; });
    const window = protect();
    sessions = [session("waiting")];
    const stop = start();
    await stop.flush();
    vi.setSystemTime(NOON + 5 * 60_000);
    const releasing = stop.flush();
    await started;
    let stopped = false;
    const stopping = stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    emit("another");
    complete(SENT);
    await Promise.all([releasing, stopping]);
    expect(stopped).toBe(true);
    expect(sendToAll).toHaveBeenCalledTimes(1);
    expect(deliveryStore.get(identity(window.id))?.status).toBe("sent");
  });

  it("disposes a protection timer while retaining its durable queue for restart", async () => {
    const window = protect();
    sessions = [session("waiting")];
    const first = start();
    await first.flush();
    await first();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(sendToAll).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    const second = start();
    await second.flush();
    expect(sendToAll).toHaveBeenCalledTimes(1);
    expect(deliveryStore.get(identity(window.id))?.status).toBe("sent");
  });

  it("coalesces an unbounded current session set into a bounded push payload", async () => {
    const window = protect();
    sessions = Array.from({ length: 510 }, (_, index) => session(`session-${index}`));
    const stop = start();
    await stop.flush();
    expect(protectionStore.impacts(window.id).postponed).toBe(1);
    vi.setSystemTime(NOON + 5 * 60_000);
    await stop.flush();
    expect(sendToAll).toHaveBeenCalledTimes(1);
    const payload = sendToAll.mock.calls[0][0];
    expect(payload.title).toBe("510 sessions need input");
    expect(payload.data?.sessionCount).toBe(510);
    expect(JSON.stringify(payload).length).toBeLessThan(3_000);
    expect(JSON.parse(deliveryStore.get(identity(window.id))!.outcomeJson!).sessionIds).toHaveLength(510);
    expect(protectionStore.impacts(window.id)).toMatchObject({ pending: 0, dispositions: { delivered: 1 } });
  });

  it("reports standalone push failures rather than manufacturing a successful delivery", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    sendToAll.mockRejectedValue(new Error("Offline"));
    const stop = initPushEventNotifications(ctx, { sendToAll, sendToEndpoint: async () => SENT });
    disposers.push(stop);
    emit("standalone");
    emit("standalone");
    await stop();
    expect(sendToAll).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("Offline"));
    expect(ctx.focusAttentionStore!.list()).toEqual(expect.arrayContaining([
      expect.objectContaining({ eventType: "notification_delivery", details: expect.objectContaining({ sent: 0, error: "Offline" }) }),
    ]));
  });

  it("can defer initial reconciliation until the session catalog is ready", async () => {
    protect();
    sessions = [session("waiting")];
    const getSessions = vi.fn(() => sessions.map((entry) => ({ ...entry })));

    const stop = start({ getSessions, startImmediately: false });
    await Promise.resolve();
    expect(getSessions).not.toHaveBeenCalled();

    await stop.flush();
    expect(getSessions).toHaveBeenCalled();
    expect(deliveryStore.pending(10, SUMMARY_REASON)).toHaveLength(1);
  });

  it("rejects incomplete protection wiring rather than silently bypassing it", () => {
    expect(() => initPushEventNotifications(ctx, { sendToAll, sendToEndpoint: async () => SENT }, { protectionStore }))
      .toThrow("deliveryStore and getSessions");
  });
});
