import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_FOCUS_NOTIFICATION_POLICY } from "../../shared/focus-notification-policy.js";
import type { FocusProtectionSession } from "../../shared/focus-protection.js";
import type { DatabaseSync } from "../db.js";
import { createFocusAttentionStore } from "../focus-attention-store.js";
import { createFocusNotificationDeliveryStore, type FocusNotificationDeliveryStore } from "../focus-notification-delivery-store.js";
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

const NOW = Date.parse("2026-06-01T12:00:00.000Z");
const SENT: PushSendSummary = { attempted: 1, sent: 1, failed: 0, pruned: 0 };
const EMPTY: PushSendSummary = { attempted: 0, sent: 0, failed: 0, pruned: 0 };
const PARTIAL: PushSendSummary = { attempted: 2, sent: 1, failed: 1, pruned: 0 };
const SUMMARY_REASON = "protected-needs-input";

describe("needs-input delivery retries and episode fencing", () => {
  let db: DatabaseSync;
  let bus: GlobalBus;
  let protectionStore: FocusProtectionStore;
  let deliveryStore: FocusNotificationDeliveryStore;
  let settingsStore: SettingsStore;
  let sessions: FocusProtectionSession[];
  let ctx: Parameters<typeof initPushEventNotifications>[0];
  let sendToAll: ReturnType<typeof vi.fn<(payload: BridgePushPayload) => Promise<PushSendSummary>>>;
  let disposers: PushEventNotificationDisposer[];
  let completions: Array<(summary: PushSendSummary) => void>;

  function currentSessions(): FocusProtectionSession[] {
    return sessions.map((entry) => ({ ...entry }));
  }

  function start(options: PushEventNotificationOptions = { getSessions: currentSessions }) {
    const stop = initPushEventNotifications(ctx, { sendToAll, sendToEndpoint: async () => SENT }, options);
    disposers.push(stop);
    return stop;
  }

  function startProtected() {
    return start({ protectionStore, deliveryStore, settingsStore, getSessions: currentSessions });
  }

  function protect() {
    return protectionStore.create({
      endsAt: new Date(Date.now() + 5 * 60_000).toISOString(), timezone: "UTC", reason: "Deep work",
      allowNeedsInput: false, allowAuthorizedDeadlineOverride: false,
    });
  }

  function emit(count: number): void {
    const existing = sessions.find((entry) => entry.sessionId === "waiting");
    if (existing) existing.pendingUserInputCount = count;
    else sessions.push({
      sessionId: "waiting", title: "Waiting", taskId: null, muted: false, busy: false, pendingUserInputCount: count,
    });
    bus.emit({ type: "session:user-input", sessionId: "waiting", pendingUserInputCount: count, needsUserInput: count > 0 });
  }

  function deferredSend() {
    let entered!: () => void;
    let complete!: (summary: PushSendSummary) => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const sending = new Promise<PushSendSummary>((resolve) => { complete = resolve; });
    sendToAll.mockImplementationOnce(() => { entered(); return sending; });
    completions.push(complete);
    return { started, complete };
  }

  function failNextSend(failure: "throw" | "empty" | "partial"): PushSendSummary {
    if (failure === "throw") sendToAll.mockRejectedValueOnce(new Error("Transport unavailable"));
    else sendToAll.mockResolvedValueOnce(failure === "partial" ? PARTIAL : EMPTY);
    return failure === "partial" ? PARTIAL : EMPTY;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    db = setupTestDb();
    initializeFocusProtectionSchema(db);
    bus = createGlobalBus();
    protectionStore = createFocusProtectionStore(db, bus);
    deliveryStore = createFocusNotificationDeliveryStore(db);
    settingsStore = createSettingsStore(db);
    settingsStore.updateSettings({ focusNotifications: { ...DEFAULT_FOCUS_NOTIFICATION_POLICY, quietHours: null } });
    ctx = {
      globalBus: bus, taskStore: createTaskStore(db, bus), cliSessionCatalog: undefined,
      apiBasePath: "/api", focusAttentionStore: createFocusAttentionStore(db),
    };
    sessions = [];
    sendToAll = vi.fn<(payload: BridgePushPayload) => Promise<PushSendSummary>>().mockResolvedValue(SENT);
    disposers = [];
    completions = [];
  });

  afterEach(async () => {
    for (const complete of completions) complete(SENT);
    await Promise.all(disposers.map((stop) => stop()));
    protectionStore.stop();
    vi.restoreAllMocks();
    vi.useRealTimers();
    db.close();
  });

  it.each(["throw", "empty", "partial"] as const)(
    "retries a direct %s failure on a later pending-count event and stops after successful delivery",
    async (failure) => {
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      const outcome = failNextSend(failure);
      const stop = start();
      emit(1);
      emit(2);
      await stop.flush();
      expect(sendToAll).toHaveBeenCalledTimes(1);
      expect(warning).toHaveBeenCalled();
      expect(ctx.focusAttentionStore!.list()).toEqual(expect.arrayContaining([
        expect.objectContaining({
          eventType: "notification_delivery", reason: "needs-input",
          details: expect.objectContaining({
            sessionId: "waiting", ...outcome, ...(failure === "throw" ? { error: "Transport unavailable" } : {}),
          }),
        }),
      ]));

      emit(3);
      await stop.flush();
      expect(sendToAll).toHaveBeenCalledTimes(2);
      emit(4);
      emit(5);
      await stop.flush();
      expect(sendToAll).toHaveBeenCalledTimes(2);
    },
  );

  it("coalesces same-episode input events while a direct delivery is still in flight", async () => {
    const sending = deferredSend();
    const stop = start();
    emit(1);
    await sending.started;
    emit(2);
    await stop.flush();
    emit(3);
    expect(sendToAll).toHaveBeenCalledTimes(1);
    sending.complete(SENT);
    await stop.flush();
    emit(4);
    await stop.flush();
    expect(sendToAll).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    "does not let clear → old completion suppress the next input episode, snapshots=%s",
    async (withSnapshots) => {
      const sending = deferredSend();
      const stop = start(withSnapshots ? { getSessions: currentSessions } : {});
      emit(1);
      await sending.started;
      emit(0);
      sending.complete(SENT);
      await stop.flush();
      expect(sendToAll).toHaveBeenCalledTimes(1);
      emit(1);
      await stop.flush();
      expect(sendToAll).toHaveBeenCalledTimes(2);
      emit(2);
      await stop.flush();
      expect(sendToAll).toHaveBeenCalledTimes(2);
    },
  );

  it("does not let an older episode's success or cleanup cover a newer in-flight failure", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const oldSend = deferredSend();
    const newSend = deferredSend();
    const stop = start();
    emit(1);
    await oldSend.started;
    emit(0);
    emit(1);
    await newSend.started;
    expect(sendToAll).toHaveBeenCalledTimes(2);
    oldSend.complete(SENT);
    await stop.flush();
    emit(2);
    expect(sendToAll).toHaveBeenCalledTimes(2);
    newSend.complete(PARTIAL);
    await stop.flush();
    emit(3);
    await stop.flush();
    expect(sendToAll).toHaveBeenCalledTimes(3);
    emit(4);
    await stop.flush();
    expect(sendToAll).toHaveBeenCalledTimes(3);
  });

  it.each(["throw", "empty", "partial"] as const)(
    "does not let a failed %s summary block a same-episode direct retry",
    async (failure) => {
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      const window = protect();
      emit(1);
      const stop = startProtected();
      await stop.flush();
      failNextSend(failure);
      protectionStore.cancel(window.id);
      await stop.flush();
      expect(sendToAll).toHaveBeenCalledTimes(1);
      const identity = { objectId: window.id, activationId: window.id, reason: SUMMARY_REASON };
      expect(deliveryStore.get(identity)?.status).toBe("failed");
      expect(protectionStore.impacts(window.id).dispositions).toEqual({ failed: 1 });
      expect(warning).toHaveBeenCalled();
      await stop.flush();
      expect(sendToAll).toHaveBeenCalledTimes(1);

      emit(2);
      emit(3);
      await stop.flush();
      expect(sendToAll).toHaveBeenCalledTimes(2);
      expect(sendToAll.mock.calls[1][0].tag).toBe("bridge-session-waiting");
      emit(4);
      await stop.flush();
      expect(sendToAll).toHaveBeenCalledTimes(2);
      expect(deliveryStore.get(identity)?.status).toBe("failed");
    },
  );

  it("protects an in-flight summary but does not re-cover answered input after its late success", async () => {
    const window = protect();
    emit(1);
    const stop = startProtected();
    await stop.flush();
    const sending = deferredSend();
    protectionStore.cancel(window.id);
    const releasing = stop.flush();
    await sending.started;
    emit(2);
    expect(sendToAll).toHaveBeenCalledTimes(1);
    emit(0);
    sending.complete(SENT);
    await releasing;
    const identity = { objectId: window.id, activationId: window.id, reason: SUMMARY_REASON };
    expect(deliveryStore.get(identity)?.status).toBe("sent");
    expect(JSON.parse(deliveryStore.get(identity)!.outcomeJson!)).toMatchObject({
      sessionIds: ["waiting"], pendingSessionIds: [],
    });
    emit(1);
    await stop.flush();
    expect(sendToAll).toHaveBeenCalledTimes(2);
    expect(sendToAll.mock.calls[1][0].tag).toBe("bridge-session-waiting");
    emit(2);
    await stop.flush();
    expect(sendToAll).toHaveBeenCalledTimes(2);
  });

  it("does not let an old summary success cover a new episode whose direct delivery fails", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const window = protect();
    emit(1);
    const stop = startProtected();
    await stop.flush();
    const oldSend = deferredSend();
    const newSend = deferredSend();
    protectionStore.cancel(window.id);
    const releasing = stop.flush();
    await oldSend.started;
    emit(0);
    emit(1);
    await newSend.started;
    oldSend.complete(SENT);
    await releasing;
    emit(2);
    expect(sendToAll).toHaveBeenCalledTimes(2);
    newSend.complete(PARTIAL);
    await stop.flush();
    emit(3);
    await stop.flush();
    expect(sendToAll).toHaveBeenCalledTimes(3);
    emit(4);
    await stop.flush();
    expect(sendToAll).toHaveBeenCalledTimes(3);
  });
});
