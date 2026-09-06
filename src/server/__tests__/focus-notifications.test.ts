import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_FOCUS_NOTIFICATION_POLICY,
  getFocusNotificationClock,
  type FocusNotificationPolicyUpdate,
} from "../../shared/focus-notification-policy.js";
import type { FocusProtectionRequest, FocusProtectionWindow } from "../../shared/focus-protection.js";
import { createChecklistStore } from "../checklist-store.js";
import type { DatabaseSync } from "../db.js";
import { createFocusDataLayer, type FocusDataLayer } from "../focus-data-layer.js";
import type { FocusMutationInput, FocusObjectDetails } from "../focus-details-store.js";
import type { FocusAlert } from "../focus-domain-store.js";
import type { FocusAuthorityGrant } from "../focus-governance-store.js";
import { FOCUS_NOTIFICATION_CLAIM_GRACE_MS } from "../focus-notification-delivery-store.js";
import {
  initFocusNotificationService,
  type FocusNotificationController,
  type FocusNotificationServiceDependencies,
} from "../focus-notification-service.js";
import { createFocusProtectionStore, initializeFocusProtectionSchema, type FocusProtectionStore } from "../focus-protection-store.js";
import { createGlobalBus, type GlobalBus, type StatusEvent } from "../global-bus.js";
import type { BridgePushPayload, PushSendSummary } from "../push-notification-service.js";
import { createSettingsStore, SettingsReadError, SettingsValidationError, type SettingsStore } from "../settings-store.js";
import { createTaskStore } from "../task-store.js";
import { setupTestDb } from "./helpers.js";

vi.mock("../public-url.js", () => ({ buildPublicUrl: (path: string) => path }));

const SENT: PushSendSummary = { attempted: 1, sent: 1, failed: 0, pruned: 0 };
const NOON = Date.parse("2026-06-01T12:00:00.000Z");

describe("Focus notification IANA clock", () => {
  it("composes protection without changing standing review or quiet boundaries", () => {
    const now = Date.parse("2026-06-01T23:00:00Z");
    const protection: FocusProtectionWindow = {
      id: "window", startsAt: new Date(now).toISOString(), endsAt: new Date(now + 30_000).toISOString(),
      timezone: "America/Los_Angeles", reason: "Protect work", allowNeedsInput: false,
      allowAuthorizedDeadlineOverride: false, cancelledAt: null, status: "active",
      createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString(),
    };
    const standing = getFocusNotificationClock(DEFAULT_FOCUS_NOTIFICATION_POLICY, now);
    expect(getFocusNotificationClock(DEFAULT_FOCUS_NOTIFICATION_POLICY, now, protection))
      .toEqual({ ...standing, protection });
    expect(getFocusNotificationClock(DEFAULT_FOCUS_NOTIFICATION_POLICY, now + 30_000, protection).protection).toBeNull();
    expect(getFocusNotificationClock(DEFAULT_FOCUS_NOTIFICATION_POLICY, now, { ...protection, cancelledAt: protection.startsAt }))
      .toEqual(standing);
    expect(getFocusNotificationClock(DEFAULT_FOCUS_NOTIFICATION_POLICY, now - 1, protection).protection).toBeNull();
  });

  it.each([
    {
      name: "crosses midnight",
      now: "2026-06-01T23:15:00Z",
      timezone: "UTC",
      quietHours: { start: "22:00", end: "08:00" },
      reviewTimes: ["09:00", "17:00"],
      nextReview: "2026-06-02T09:00:00Z",
      quietEnd: "2026-06-02T08:00:00Z",
    },
    {
      name: "uses midnight as zero, not hour 24",
      now: "2026-06-01T23:59:30Z",
      timezone: "UTC",
      quietHours: { start: "21:00", end: "00:00" },
      reviewTimes: ["00:00"],
      nextReview: "2026-06-02T00:00:00Z",
      quietEnd: "2026-06-02T00:00:00Z",
    },
    {
      name: "ends quiet hours exclusively",
      now: "2026-06-02T08:00:00Z",
      timezone: "UTC",
      quietHours: { start: "22:00", end: "08:00" },
      reviewTimes: ["09:00"],
      nextReview: "2026-06-02T09:00:00Z",
      quietEnd: null,
    },
    {
      name: "supports same-day quiet hours",
      now: "2026-06-01T12:05:00Z",
      timezone: "UTC",
      quietHours: { start: "12:00", end: "13:00" },
      reviewTimes: ["17:00"],
      nextReview: "2026-06-01T17:00:00Z",
      quietEnd: "2026-06-01T13:00:00Z",
    },
    {
      name: "advances skipped spring-DST reviews and quiet ends to the gap end",
      now: "2026-03-08T06:55:00Z",
      timezone: "America/New_York",
      quietHours: { start: "22:00", end: "02:30" },
      reviewTimes: ["02:30"],
      nextReview: "2026-03-08T07:00:00Z",
      quietEnd: "2026-03-08T07:00:00Z",
    },
    {
      name: "uses the next repeated fall-DST review without ending quiet hours early",
      now: "2026-11-01T05:45:00Z",
      timezone: "America/New_York",
      quietHours: { start: "22:00", end: "02:30" },
      reviewTimes: ["01:30"],
      nextReview: "2026-11-01T06:30:00Z",
      quietEnd: "2026-11-01T07:30:00Z",
    },
    {
      name: "handles half-hour DST changes",
      now: "2026-10-03T15:20:00Z",
      timezone: "Australia/Lord_Howe",
      quietHours: { start: "22:00", end: "02:15" },
      reviewTimes: ["02:15"],
      nextReview: "2026-10-03T15:30:00Z",
      quietEnd: "2026-10-03T15:30:00Z",
    },
  ])("$name", ({ now, timezone, quietHours, reviewTimes, nextReview, quietEnd }) => {
    expect(getFocusNotificationClock({
      ...DEFAULT_FOCUS_NOTIFICATION_POLICY, timezone, quietHours, reviewTimes,
    }, Date.parse(now))).toEqual({
      nextReviewAt: Date.parse(nextReview),
      quietHours: quietEnd !== null,
      quietHoursEnd: quietEnd === null ? null : Date.parse(quietEnd),
      protection: null,
    });
  });
});

describe("Focus notification settings and delivery", () => {
  let db: DatabaseSync;
  let bus: GlobalBus;
  let layer: FocusDataLayer;
  let settingsStore: SettingsStore;
  let grant: FocusAuthorityGrant;
  let sendToAll: ReturnType<typeof vi.fn<(payload: BridgePushPayload) => Promise<PushSendSummary>>>;
  let controllers: FocusNotificationController[];

  function configure(updates: FocusNotificationPolicyUpdate = {}): void {
    settingsStore.updateSettings({
      focusNotifications: {
        ...DEFAULT_FOCUS_NOTIFICATION_POLICY,
        quietHours: null,
        reviewTimes: ["17:00"],
        coalesceMinutes: 0,
        enableAuthorizedImmediate: true,
        ...updates,
      },
    });
  }

  function createAlert(updates: FocusMutationInput = {}): FocusAlert {
    return layer.mutations.saveAlert({
      key: `test:${crypto.randomUUID()}`,
      title: "Verified outage",
      sourceFamily: "monitoring",
      producer: "watchdog",
      observedAt: new Date(Date.now() - 60_000).toISOString(),
      validUntil: new Date(Date.now() + 6 * 60 * 60_000).toISOString(),
      interventionBy: new Date(Date.now() + 15 * 60_000).toISOString(),
      evidence: [{ summary: "The endpoint failed its check" }],
      impact: "Production requests are failing.",
      notificationMode: "immediate",
      authorizationGrantId: grant.id,
      ...updates,
    }).alert;
  }

  function start(overrides: Partial<FocusNotificationServiceDependencies> = {}): FocusNotificationController {
    const controller = initFocusNotificationService({
      globalBus: bus,
      alertStore: layer.alertStore,
      authorityStore: layer.authorityStore,
      deliveryStore: layer.notificationDeliveryStore,
      settingsStore,
      pushService: { sendToAll },
      ...overrides,
    });
    controllers.push(controller);
    return controller;
  }

  function emit(alert: FocusAlert, overrides: Partial<StatusEvent> = {}): void {
    bus.emit({
      type: "focus:changed",
      focusObjectId: alert.id,
      focusObjectType: "alert",
      lifecycle: alert.lifecycle,
      activationId: alert.activationId,
      meaningful: true,
      transitionId: crypto.randomUUID(),
      ...overrides,
    });
  }

  function identity(alert: FocusAlert) {
    return { objectId: alert.id, activationId: alert.activationId, reason: "immediate-alert" };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOON);
    db = setupTestDb();
    bus = createGlobalBus();
    layer = createFocusDataLayer(db, bus, createChecklistStore(db, bus));
    settingsStore = createSettingsStore(db);
    configure();
    grant = layer.authorityStore.save({
      title: "Monitor may interrupt for outages",
      sourceFamily: "monitoring",
      producer: "watchdog",
      scope: "Production endpoint",
      validFrom: "2026-01-01T00:00:00Z",
      validUntil: "2027-01-01T00:00:00Z",
      allowImmediate: true,
      grantedBy: "user",
    });
    sendToAll = vi.fn<(payload: BridgePushPayload) => Promise<PushSendSummary>>().mockResolvedValue(SENT);
    controllers = [];
  });

  afterEach(async () => {
    await Promise.all(controllers.map((controller) => controller.dispose()));
    vi.restoreAllMocks();
    vi.useRealTimers();
    db.close();
  });

  describe("strict settings normalization", () => {
    it("persists a canonical typed policy and resets nullable fields safely", () => {
      configure({ timezone: "US/Pacific", reviewTimes: ["17:00", "09:00"] });
      expect(settingsStore.getSettings().focusNotifications).toMatchObject({
        timezone: "America/Los_Angeles",
        reviewTimes: ["09:00", "17:00"],
        enableAuthorizedImmediate: true,
      });
      settingsStore.updateSettings({
        focusNotifications: {
          timezone: null,
          reviewTimes: null,
          coalesceMinutes: null,
          enableAuthorizedImmediate: null,
          allowGrantQuietHoursOverride: null,
        },
      });
      expect(settingsStore.getSettings().focusNotifications).toEqual(DEFAULT_FOCUS_NOTIFICATION_POLICY);
      settingsStore.updateSettings({ focusNotifications: null });
      expect(settingsStore.getSettings().focusNotifications).toBeUndefined();
      expect(DEFAULT_FOCUS_NOTIFICATION_POLICY.enableAuthorizedImmediate).toBe(false);
    });

    it("replaces partial policies from safe defaults rather than retaining authorization", () => {
      settingsStore.updateSettings({ focusNotifications: { coalesceMinutes: 3 } });
      expect(settingsStore.getSettings().focusNotifications).toEqual({
        ...DEFAULT_FOCUS_NOTIFICATION_POLICY, coalesceMinutes: 3,
      });
    });

    it.each([
      ["scalar", true],
      ["array", []],
      ["unknown key", { allowImmediate: true }],
      ["unknown undefined key", { extra: undefined }],
      ["unknown timezone", { timezone: "Not/A_Zone" }],
      ["offset instead of IANA timezone", { timezone: "+01:00" }],
      ["numeric timezone", { timezone: 1 }],
      ["padded timezone", { timezone: " UTC " }],
      ["oversized timezone", { timezone: "A".repeat(101) }],
      ["non-object quiet hours", { quietHours: "22:00-08:00" }],
      ["unknown quiet-hours key", { quietHours: { start: "22:00", end: "08:00", enabled: true } }],
      ["incomplete quiet hours", { quietHours: { start: "22:00" } }],
      ["hour 24", { quietHours: { start: "24:00", end: "08:00" } }],
      ["unbounded all-day quiet hours", { quietHours: { start: "08:00", end: "08:00" } }],
      ["empty reviews", { reviewTimes: [] }],
      ["duplicate reviews", { reviewTimes: ["09:00", "09:00"] }],
      ["oversized reviews", { reviewTimes: Array.from({ length: 25 }, (_, i) => `00:${String(i).padStart(2, "0")}`) }],
      ["short clock", { reviewTimes: ["9:00"] }],
      ["invalid minute", { reviewTimes: ["09:60"] }],
      ["clock seconds", { reviewTimes: ["09:00:00"] }],
      ["non-clock entry", { reviewTimes: [null] }],
      ["sparse reviews", { reviewTimes: new Array<string>(1) }],
      ["negative coalescing", { coalesceMinutes: -1 }],
      ["fractional coalescing", { coalesceMinutes: 0.5 }],
      ["oversized coalescing", { coalesceMinutes: 61 }],
      ["string coalescing", { coalesceMinutes: "5" }],
      ["non-finite coalescing", { coalesceMinutes: Number.POSITIVE_INFINITY }],
      ["non-boolean immediate setting", { enableAuthorizedImmediate: "true" }],
      ["non-boolean override setting", { allowGrantQuietHoursOverride: 1 }],
    ])("rejects %s without changing persisted settings", (_name, value) => {
      const before = settingsStore.getSettings();
      expect(() => settingsStore.updateSettings({
        focusNotifications: value as FocusNotificationPolicyUpdate,
      })).toThrow(SettingsValidationError);
      expect(settingsStore.getSettings()).toEqual(before);
    });

    it("rejects invalid persisted policy rather than falling back to authorized defaults", () => {
      const raw = JSON.stringify({ focusNotifications: { timezone: "invalid", enableAuthorizedImmediate: true } });
      db.prepare("UPDATE settings SET value = ? WHERE key = 'app'").run(raw);
      expect(() => settingsStore.getSettings()).toThrow(SettingsReadError);
      expect(db.prepare("SELECT value FROM settings WHERE key = 'app'").get()?.value).toBe(raw);
    });

    it("validates notification settings before changing the MCP registry", () => {
      expect(() => settingsStore.updateSettings({
        mcpServers: { example: { command: "example", args: [] } },
        focusNotifications: { coalesceMinutes: -1 },
      })).toThrow(SettingsValidationError);
      expect(settingsStore.getMcpServers()).toEqual({});
    });
  });

  it("defaults to no immediate pushes and does not handle needs-input or completion events", async () => {
    settingsStore.updateSettings({ focusNotifications: null });
    const controller = start();
    const alert = createAlert();
    bus.emit({ type: "session:user-input", needsUserInput: true, sessionId: "session" });
    bus.emit({ type: "session:idle", sessionId: "session" });
    await controller.flush();
    expect(sendToAll).not.toHaveBeenCalled();
    expect(layer.notificationDeliveryStore.get(identity(alert))?.suppressionReason).toBe("policy-disabled");
  });

  it("sends only once per episode and records the resolved grant and delivery summary", async () => {
    const controller = start({ apiBasePath: "/staging/test/api" });
    const alert = createAlert();
    emit(alert);
    emit(alert);
    await controller.flush();
    layer.mutations.updateAlert(alert.id, { body: "More details, same concern" });
    await controller.flush();
    expect(sendToAll).toHaveBeenCalledTimes(1);
    expect(sendToAll).toHaveBeenCalledWith(expect.objectContaining({
      title: alert.title,
      body: alert.details.impact,
      url: `/staging/test/dashboard/focus?focus=${encodeURIComponent(alert.id)}&episode=${encodeURIComponent(alert.activationId)}`,
      tag: `bridge-focus-${alert.id}-${alert.activationId}`,
      data: expect.objectContaining({ focusObjectId: alert.id, activationId: alert.activationId }),
    }));
    expect(layer.notificationDeliveryStore.get(identity(alert))).toMatchObject({
      status: "sent", resolvedGrantId: grant.id, outcomeJson: JSON.stringify(SENT),
    });
  });

  it("routes distinct alerts for one session to canonical episodes with separate tags and preserved context", async () => {
    const taskStore = createTaskStore(db, bus);
    const task = taskStore.createTask("Monitored service");
    layer.authorityStore.save({ id: grant.id, taskId: task.id });
    const first = createAlert({ taskId: task.id, sessionId: "session-linked" });
    const second = createAlert({ taskId: task.id, sessionId: "session-linked", title: "Another outage" });
    const controller = start({ apiBasePath: "/staging/test/api/" });
    emit(first, { transitionId: "first-transition" });
    emit(second, { transitionId: "second-transition" });
    await controller.flush();
    expect(sendToAll).toHaveBeenCalledTimes(2);
    for (const [index, alert] of [first, second].entries()) {
      expect(sendToAll.mock.calls[index][0]).toMatchObject({
        tag: `bridge-focus-${alert.id}-${alert.activationId}`,
        url: `/staging/test/dashboard/focus?focus=${encodeURIComponent(alert.id)}&episode=${encodeURIComponent(alert.activationId)}`,
        data: {
          focusObjectType: "alert", focusObjectId: alert.id, activationId: alert.activationId,
          taskId: task.id, originalTaskId: task.id, sessionId: "session-linked",
          transitionId: index === 0 ? "first-transition" : "second-transition",
        },
      });
    }
    expect(new Set(sendToAll.mock.calls.map(([payload]) => payload.tag)).size).toBe(2);
  });

  it("encodes both canonical query parameters rather than treating episode identity as a route", async () => {
    const original = createAlert();
    const alert = { ...original, id: "alert / one&two", activationId: "episode?one/#two" };
    const controller = start({ alertStore: { get: () => alert } });
    emit(alert);
    await controller.flush();
    expect(sendToAll).toHaveBeenCalledWith(expect.objectContaining({
      url: "/dashboard/focus?focus=alert%20%2F%20one%26two&episode=episode%3Fone%2F%23two",
      tag: `bridge-focus-${alert.id}-${alert.activationId}`,
      data: expect.objectContaining({ focusObjectId: alert.id, activationId: alert.activationId }),
    }));
  });

  describe.each(["muted", "archived", "orphaned"] as const)("%s source task", (taskState) => {
    it.each([false, true])("suppresses immediate alerts at delivery, already queued=%s", async (queued) => {
      const taskStore = createTaskStore(db, bus);
      const task = taskStore.createTask("Monitored service");
      layer.authorityStore.save({ id: grant.id, taskId: task.id });
      configure({ coalesceMinutes: queued ? 1 : 0 });
      const alert = createAlert({ taskId: task.id });
      const controller = start();
      if (queued) {
        emit(alert);
        await controller.flush();
        expect(layer.notificationDeliveryStore.get(identity(alert))).toMatchObject({
          suppressionReason: "coalescing", pendingUntil: "2026-06-01T12:01:00.000Z",
        });
      }

      if (taskState === "orphaned") taskStore.deleteTask(task.id);
      else if (taskState === "archived") taskStore.updateTask(task.id, { status: "archived" });
      else taskStore.updateTask(task.id, { muted: true });

      if (queued) await vi.advanceTimersByTimeAsync(60_000);
      else {
        emit(alert);
        await controller.flush();
      }

      const reason = taskState === "muted" ? "muted-source" : "inactive-source";
      expect(layer.alertStore.get(alert.id)).toMatchObject({ taskState, lifecycle: "active", status: "active" });
      expect(sendToAll).not.toHaveBeenCalled();
      expect(layer.notificationDeliveryStore.get(identity(alert))).toMatchObject({
        status: "suppressed", suppressionReason: reason, pendingUntil: null, claimToken: null,
      });
      expect(layer.attentionStore.list({ objectId: alert.id })).toEqual(expect.arrayContaining([
        expect.objectContaining({ eventType: "notification_suppression", reason }),
      ]));
      expect(layer.notificationDeliveryStore.pending()).toEqual([]);
      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it("requires meaningful, current activation and lifecycle payloads", async () => {
    const alert = createAlert();
    const controller = start();
    for (const overrides of [
      { meaningful: false },
      { meaningful: undefined },
      { activationId: undefined },
      { activationId: "old-activation" },
      { lifecycle: undefined },
      { lifecycle: "resolved" as const },
      { focusObjectType: "event" as const },
    ]) emit(alert, overrides);
    await controller.flush();
    expect(sendToAll).not.toHaveBeenCalled();
  });

  it("does not push Events, even with a forged alert payload", async () => {
    const event = layer.feedStore.saveCard({ key: "routine:done", kind: "status", title: "Routine work completed" }).card;
    const controller = start();
    const object = layer.eventStore.get(event.id)!;
    bus.emit({
      type: "focus:changed", focusObjectType: "alert", focusObjectId: event.id,
      activationId: object.activationId, lifecycle: "active", meaningful: true,
    });
    await controller.flush();
    expect(sendToAll).not.toHaveBeenCalled();
  });

  it.each(["acknowledged", "handed_off", "resolved", "accepted_risk", "dismissed"] as const)(
    "does not deliver queued or replayed pushes after lifecycle becomes %s",
    async (lifecycle) => {
      configure({ coalesceMinutes: 1 });
      const controller = start();
      const alert = createAlert();
      await controller.flush();
      layer.mutations.updateAlert(alert.id, { lifecycle, lifecycleReason: "Handled by user" });
      emit(alert);
      await controller.flush();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(sendToAll).not.toHaveBeenCalled();
      expect(layer.notificationDeliveryStore.get(identity(alert))).toMatchObject({
        suppressionReason: "inactive-alert", pendingUntil: null,
      });
    },
  );

  it.each([
    ["missing evidence", { evidence: [] }, "unverified-alert"],
    ["future evidence", { evidence: [{ summary: "Check", observedAt: "2026-06-01T12:01:00Z" }] }, "unverified-alert"],
    ["missing impact", { impact: null }, "unverified-alert"],
    ["missing producer", { producer: null }, "unverified-alert"],
    ["missing family", { sourceFamily: null }, "unverified-alert"],
    ["future observation", { observedAt: "2026-06-01T12:01:00Z" }, "stale-observation"],
    ["expired observation", { validUntil: "2026-06-01T12:00:00Z" }, "stale-observation"],
    ["missing observation", { observedAt: null }, "stale-observation"],
    ["expired intervention", { interventionBy: "2026-06-01T12:00:00Z" }, "intervention-expired"],
    ["missing intervention", { interventionBy: null }, "intervention-expired"],
    ["Focus-only mode", { notificationMode: "focus" }, "not-immediate"],
    ["summary mode", { notificationMode: "summary" }, "not-immediate"],
    ["mismatched producer", { producer: "another-producer" }, "not-authorized"],
    ["mismatched source family", { sourceFamily: "another-family" }, "not-authorized"],
  ])("rechecks %s on the current object at delivery", async (_name, updates, reason) => {
    const alert = createAlert();
    layer.detailsStore.save({ ...alert.details, ...updates } as FocusObjectDetails);
    const controller = start();
    emit(alert);
    await controller.flush();
    expect(sendToAll).not.toHaveBeenCalled();
    expect(layer.notificationDeliveryStore.get(identity(alert))?.suppressionReason).toBe(reason);
  });

  it.each(["2026-06-01T17:00:00Z", "2026-06-01T17:01:00Z"])(
    "does not interrupt for an intervention at or after the next review (%s)",
    async (interventionBy) => {
      const controller = start();
      const alert = createAlert({ interventionBy });
      await controller.flush();
      expect(sendToAll).not.toHaveBeenCalled();
      expect(layer.notificationDeliveryStore.get(identity(alert))?.suppressionReason).toBe("can-wait-for-review");
    },
  );

  it("rechecks authority revoked after first-class admission but before delivery", async () => {
    const controller = start();
    const alert = createAlert();
    layer.authorityStore.revoke(grant.id, "No longer authorized");
    await controller.flush();
    expect(sendToAll).not.toHaveBeenCalled();
    expect(layer.notificationDeliveryStore.get(identity(alert))?.suppressionReason).toBe("not-authorized");
  });

  it("resolves the current grant again immediately after claim and before send", async () => {
    const originalClaim = layer.notificationDeliveryStore.claim;
    const claim = vi.fn((...args: Parameters<typeof originalClaim>) => {
      const claimed = originalClaim(...args);
      layer.authorityStore.revoke(grant.id, "Revoked during delivery preparation");
      return claimed;
    });
    const controller = start({ deliveryStore: { ...layer.notificationDeliveryStore, claim } });
    const alert = createAlert();
    await controller.flush();
    expect(claim).toHaveBeenCalledTimes(1);
    expect(sendToAll).not.toHaveBeenCalled();
    expect(layer.notificationDeliveryStore.get(identity(alert))).toMatchObject({
      status: "failed",
      error: "Delivery cancelled: not-authorized",
      outcomeJson: JSON.stringify({ attempted: 0, sent: 0, failed: 0, pruned: 0 }),
    });
  });

  it.each([
    [false, false, false],
    [false, true, false],
    [true, false, false],
    [true, true, true],
  ])("quiet-hour override requires both policy=%s and grant=%s", async (policyOverride, grantOverride, sends) => {
    vi.setSystemTime(new Date("2026-06-01T07:50:00Z"));
    configure({
      quietHours: { start: "22:00", end: "08:00" },
      reviewTimes: ["09:00"],
      allowGrantQuietHoursOverride: policyOverride,
    });
    layer.authorityStore.save({ id: grant.id, allowQuietHoursOverride: grantOverride });
    const controller = start();
    const alert = createAlert();
    await controller.flush();
    expect(sendToAll).toHaveBeenCalledTimes(sends ? 1 : 0);
    if (!sends) expect(layer.notificationDeliveryStore.get(identity(alert))).toMatchObject({
      suppressionReason: "quiet-hours", pendingUntil: "2026-06-01T08:00:00.000Z",
    });
  });

  it("automatically flushes pending alerts at quiet end without an extra coalescing delay", async () => {
    vi.setSystemTime(new Date("2026-06-01T07:50:00Z"));
    configure({ quietHours: { start: "22:00", end: "08:00" }, reviewTimes: ["09:00"], coalesceMinutes: 5 });
    const controller = start();
    const alert = createAlert();
    await controller.flush();
    expect(layer.notificationDeliveryStore.get(identity(alert))?.pendingUntil).toBe("2026-06-01T08:00:00.000Z");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(sendToAll).toHaveBeenCalledTimes(1);
    expect(layer.notificationDeliveryStore.pending()).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("resumes due quiet-hour deliveries at initialization after restart", async () => {
    vi.setSystemTime(new Date("2026-06-01T07:59:00Z"));
    configure({ quietHours: { start: "22:00", end: "08:00" }, reviewTimes: ["09:00"] });
    const first = start();
    createAlert();
    await first.flush();
    await first.dispose();
    await vi.advanceTimersByTimeAsync(60_000);
    const second = start();
    await second.flush();
    expect(sendToAll).toHaveBeenCalledTimes(1);
  });

  it("rechecks revoked grants and disabled policy when pending delivery becomes due", async () => {
    configure({ coalesceMinutes: 1 });
    const controller = start();
    const alert = createAlert();
    await controller.flush();
    layer.authorityStore.revoke(grant.id, "Stop monitoring");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sendToAll).not.toHaveBeenCalled();
    expect(layer.notificationDeliveryStore.get(identity(alert))).toMatchObject({
      suppressionReason: "not-authorized", pendingUntil: null,
    });
    layer.authorityStore.save({ id: grant.id, status: "active" });
    const another = createAlert();
    await controller.flush();
    settingsStore.updateSettings({ focusNotifications: null });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sendToAll).not.toHaveBeenCalled();
    expect(layer.notificationDeliveryStore.get(identity(another))?.suppressionReason).toBe("policy-disabled");
  });

  it("drops expired interventions rather than sending stale alerts after quiet hours", async () => {
    vi.setSystemTime(new Date("2026-06-01T07:50:00Z"));
    configure({ quietHours: { start: "22:00", end: "08:00" }, reviewTimes: ["09:00"] });
    const controller = start();
    const alert = createAlert({ interventionBy: "2026-06-01T07:55:00Z" });
    await controller.flush();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(sendToAll).not.toHaveBeenCalled();
    expect(layer.notificationDeliveryStore.get(identity(alert))).toMatchObject({
      suppressionReason: "intervention-expired", pendingUntil: null,
    });
  });

  it("does not extend coalescing for repeated meaningful updates", async () => {
    configure({ coalesceMinutes: 5 });
    const controller = start();
    const alert = createAlert();
    await controller.flush();
    await vi.advanceTimersByTimeAsync(2 * 60_000);
    layer.mutations.updateAlert(alert.id, { body: "Updated evidence summary" });
    await controller.flush();
    expect(layer.notificationDeliveryStore.get(identity(alert))?.pendingUntil).toBe("2026-06-01T12:05:00.000Z");
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(sendToAll).toHaveBeenCalledTimes(1);
  });

  it("bounds coalescing before the intervention deadline", async () => {
    configure({ coalesceMinutes: 60 });
    const controller = start();
    const alert = createAlert({ interventionBy: "2026-06-01T12:02:00Z" });
    await controller.flush();
    expect(layer.notificationDeliveryStore.get(identity(alert))?.pendingUntil).toBe("2026-06-01T12:01:59.000Z");
    await vi.advanceTimersByTimeAsync(119_000);
    expect(sendToAll).toHaveBeenCalledTimes(1);
    expect(Date.now()).toBeLessThan(Date.parse(alert.details.interventionBy!));
  });

  it("does not extend an already coalesced window after a policy change or restart", async () => {
    configure({ coalesceMinutes: 2 });
    const first = start();
    createAlert();
    await first.flush();
    await first.dispose();
    await vi.advanceTimersByTimeAsync(60_000);
    configure({ coalesceMinutes: 10 });
    const second = start();
    await second.flush();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sendToAll).toHaveBeenCalledTimes(1);
  });

  it("invalidates an older pending activation but permits one delivery for a genuinely new episode", async () => {
    configure({ coalesceMinutes: 5 });
    const controller = start();
    const alert = createAlert();
    await controller.flush();
    await vi.advanceTimersByTimeAsync(60_000);
    const next = layer.mutations.updateAlert(alert.id, { newEpisode: true, episodeReason: "A second verified outage" });
    await controller.flush();
    expect(next.activationId).not.toBe(alert.activationId);
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(sendToAll).not.toHaveBeenCalled();
    expect(layer.notificationDeliveryStore.get(identity(alert))?.suppressionReason).toBe("stale-activation");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sendToAll).toHaveBeenCalledTimes(1);
    expect(sendToAll.mock.calls[0][0].tag).toBe(`bridge-focus-${next.id}-${next.activationId}`);
  });

  it("deduplicates claims across controllers while a send is still in flight", async () => {
    let complete!: (value: PushSendSummary) => void;
    let entered!: () => void;
    const sending = new Promise<PushSendSummary>((resolve) => { complete = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    sendToAll.mockImplementation(() => { entered(); return sending; });
    const first = start();
    const second = start();
    const alert = createAlert();
    await started;
    await second.flush();
    expect(sendToAll).toHaveBeenCalledTimes(1);
    expect(layer.notificationDeliveryStore.get(identity(alert))?.claimToken).toBeTruthy();
    complete(SENT);
    await first.flush();
    emit(alert);
    await Promise.all([first.flush(), second.flush()]);
    expect(sendToAll).toHaveBeenCalledTimes(1);
  });

  it("inspects an only-claimed restart at grace expiry without retrying the ambiguous send", async () => {
    const alert = createAlert();
    const claimed = layer.notificationDeliveryStore.claim(identity(alert), grant.id)!;
    const controller = start();
    emit(alert);
    await controller.flush();
    expect(sendToAll).not.toHaveBeenCalled();
    expect(layer.notificationDeliveryStore.get(identity(alert))?.status).toBe("eligible");
    expect(layer.notificationDeliveryStore.pending()).toEqual([]);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(FOCUS_NOTIFICATION_CLAIM_GRACE_MS - 1);
    expect(layer.notificationDeliveryStore.get(identity(alert))?.status).toBe("eligible");
    await vi.advanceTimersByTimeAsync(1);
    expect(layer.notificationDeliveryStore.get(identity(alert))).toMatchObject({
      status: "failed", claimToken: claimed.claimToken, claimedAt: claimed.claimedAt,
      error: expect.stringContaining("outcome unknown"),
    });
    emit(alert);
    await controller.flush();
    await controller.dispose();
    const restarted = start();
    emit(alert);
    await restarted.flush();
    expect(sendToAll).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drains more than 500 stale claims through bounded clock passes without a pending queue", async () => {
    for (let index = 0; index < 501; index++) {
      layer.notificationDeliveryStore.claim({ objectId: `crashed-${index}`, activationId: "episode", reason: "immediate-alert" },
        grant.id, NOON - FOCUS_NOTIFICATION_CLAIM_GRACE_MS);
    }
    const reconcile = vi.spyOn(layer.notificationDeliveryStore, "reconcileStaleClaims");
    start();
    await vi.advanceTimersByTimeAsync(0);
    expect(reconcile).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveLastReturnedWith(500);
    expect(layer.notificationDeliveryStore.pending()).toEqual([]);
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(reconcile).toHaveLastReturnedWith(1);
    expect(db.prepare("SELECT COUNT(*) AS count FROM focus_notification_deliveries WHERE status='failed'").get())
      .toMatchObject({ count: 501 });
    expect(vi.getTimerCount()).toBe(0);
    expect(sendToAll).not.toHaveBeenCalled();
  });

  it("logs failed inspections and retries them independently without fabricating a delivery result", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const alert = createAlert();
    const claimed = layer.notificationDeliveryStore.claim(identity(alert), grant.id)!;
    const reconcile = vi.spyOn(layer.notificationDeliveryStore, "reconcileStaleClaims")
      .mockImplementationOnce(() => { throw new Error("Recovery database unavailable"); });
    start();
    await vi.advanceTimersByTimeAsync(0);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("Recovery database unavailable"));
    expect(layer.notificationDeliveryStore.get(identity(alert))).toEqual(claimed);
    expect(reconcile).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(layer.notificationDeliveryStore.get(identity(alert))).toEqual(claimed);
    expect(sendToAll).not.toHaveBeenCalled();
  });

  it("cancels the only-claimed inspection timer on shutdown and resumes inspection on restart", async () => {
    const alert = createAlert();
    layer.notificationDeliveryStore.claim(identity(alert), grant.id);
    const first = start();
    await first.flush();
    expect(vi.getTimerCount()).toBe(1);
    await first.dispose();
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(FOCUS_NOTIFICATION_CLAIM_GRACE_MS);
    expect(layer.notificationDeliveryStore.get(identity(alert))?.status).toBe("eligible");
    const second = start();
    await second.flush();
    expect(layer.notificationDeliveryStore.get(identity(alert))?.status).toBe("failed");
    expect(sendToAll).not.toHaveBeenCalled();
  });

  it("logs push failures and records a terminal failure without repeated nagging", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    sendToAll.mockRejectedValue(new Error("Transport unavailable"));
    const controller = start();
    const alert = createAlert();
    await controller.flush();
    emit(alert);
    await controller.flush();
    expect(sendToAll).toHaveBeenCalledTimes(1);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("Transport unavailable"));
    expect(layer.notificationDeliveryStore.get(identity(alert))).toMatchObject({
      status: "failed", error: "Transport unavailable",
    });
  });

  it("persists incomplete delivery summaries instead of marking them sent", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const outcome = { attempted: 2, sent: 1, failed: 1, pruned: 0 };
    sendToAll.mockResolvedValue(outcome);
    const controller = start();
    const alert = createAlert();
    await controller.flush();
    expect(layer.notificationDeliveryStore.get(identity(alert))).toMatchObject({
      status: "failed", outcomeJson: JSON.stringify(outcome),
    });
  });

  it("contains and visibly logs callback errors, then continues processing later events", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const get = vi.fn(layer.alertStore.get).mockImplementationOnce(() => { throw new Error("Read failed"); });
    const controller = start({ alertStore: { get } });
    const alert = createAlert();
    await controller.flush();
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("Read failed"));
    emit(alert);
    await controller.flush();
    expect(sendToAll).toHaveBeenCalledTimes(1);
  });

  it("does not spin timers when a suppressed row remains due", async () => {
    const alert = createAlert();
    layer.notificationDeliveryStore.suppress(identity(alert), "quiet-hours", {
      pendingUntil: "2026-06-01T11:59:00.000Z",
    });
    settingsStore.updateSettings({ focusNotifications: null });
    const suppress = vi.fn();
    const pending = vi.fn(layer.notificationDeliveryStore.pending);
    const controller = start({ deliveryStore: { ...layer.notificationDeliveryStore, suppress, pending } });
    await controller.flush();
    const before = suppress.mock.calls.length;
    expect(pending).toHaveBeenCalledWith(500, "immediate-alert");
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(suppress).toHaveBeenCalledTimes(before);
    await vi.advanceTimersByTimeAsync(1);
    expect(suppress).toHaveBeenCalledTimes(before + 1);
    expect(vi.getTimerCount()).toBe(1);
  });

  it("unsubscribes, clears timers and awaits an in-flight send during disposal", async () => {
    let complete!: (value: PushSendSummary) => void;
    let entered!: () => void;
    const sending = new Promise<PushSendSummary>((resolve) => { complete = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    sendToAll.mockImplementation(() => { entered(); return sending; });
    const controller = start();
    const alert = createAlert();
    await started;
    expect(vi.getTimerCount()).toBe(1);
    let finished = false;
    const disposing = controller.dispose().then(() => { finished = true; });
    await Promise.resolve();
    expect(finished).toBe(false);
    emit(alert);
    complete(SENT);
    await disposing;
    expect(finished).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    emit(alert);
    await controller.flush();
    expect(sendToAll).toHaveBeenCalledTimes(1);
    expect(layer.notificationDeliveryStore.get(identity(alert))?.status).toBe("sent");
  });

  describe("protected delivery", () => {
    let protectionStore: FocusProtectionStore;

    function protect(updates: Partial<FocusProtectionRequest> = {}) {
      return protectionStore.create({
        endsAt: new Date(Date.now() + 5 * 60_000).toISOString(), timezone: "UTC", reason: "Protected work",
        allowNeedsInput: false, allowAuthorizedDeadlineOverride: false, ...updates,
      });
    }

    beforeEach(() => {
      initializeFocusProtectionSchema(db);
      protectionStore = createFocusProtectionStore(db, bus);
    });

    it("postpones an eligible episode once and delivers at protection expiry", async () => {
      const window = protect();
      const controller = start({ protectionStore });
      const alert = createAlert();
      await controller.flush();
      emit(alert);
      layer.mutations.updateAlert(alert.id, { body: "Still investigating" });
      await controller.flush();
      expect(sendToAll).not.toHaveBeenCalled();
      expect(layer.notificationDeliveryStore.get(identity(alert))).toMatchObject({
        suppressionReason: "protected-focus", pendingUntil: window.endsAt, resolvedGrantId: grant.id,
      });
      expect(protectionStore.impacts(window.id)).toMatchObject({ postponed: 1, pending: 1 });
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(sendToAll).toHaveBeenCalledTimes(1);
      expect(protectionStore.impacts(window.id)).toMatchObject({ postponed: 1, pending: 0, dispositions: { delivered: 1 } });
      emit(alert);
      await controller.flush();
      expect(sendToAll).toHaveBeenCalledTimes(1);
    });

    it.each(["expiry", "cancellation", "offline-expiry", "offline-cancellation"] as const)(
      "re-evaluates held deliveries on %s without requiring a new alert event",
      async (release) => {
        const window = protect();
        const first = start({ protectionStore });
        createAlert();
        await first.flush();
        if (release.startsWith("offline")) await first.dispose();
        if (release.endsWith("cancellation")) protectionStore.cancel(window.id);
        else vi.setSystemTime(NOON + 5 * 60_000);
        const controller = release.startsWith("offline") ? start({ protectionStore }) : first;
        await controller.flush();
        expect(sendToAll).toHaveBeenCalledTimes(1);
        expect(protectionStore.impacts(window.id).dispositions).toEqual({ delivered: 1 });
      },
    );

    it.each([
      [false, 4, false], [true, 4, true], [true, 5, false], [true, 6, false],
    ])("requires protection override=%s and a strictly earlier deadline (%sm)", async (override, minutes, sends) => {
      const window = protect({ allowAuthorizedDeadlineOverride: override });
      const controller = start({ protectionStore });
      const alert = createAlert({ interventionBy: new Date(NOON + minutes * 60_000).toISOString() });
      await controller.flush();
      expect(sendToAll).toHaveBeenCalledTimes(sends ? 1 : 0);
      expect(protectionStore.impacts(window.id).postponed).toBe(sends ? 0 : 1);
      if (!sends) expect(layer.notificationDeliveryStore.get(identity(alert))?.pendingUntil).toBe(window.endsAt);
    });

    it.each([
      ["disabled policy", "policy-disabled"], ["revoked grant", "not-authorized"],
      ["quiet policy", "quiet-hours"], ["quiet grant", "quiet-hours"],
      ["muted task", "muted-source"], ["expired evidence", "stale-observation"],
      ["review first", "can-wait-for-review"], ["missing evidence", "unverified-alert"],
      ["different producer", "not-authorized"], ["inactive", "inactive-alert"],
    ])("never lets deadline override bypass %s", async (requirement, reason) => {
      configure({
        quietHours: { start: "12:00", end: "13:00" }, allowGrantQuietHoursOverride: true,
      });
      const taskStore = createTaskStore(db, bus);
      const task = taskStore.createTask("Monitored task");
      layer.authorityStore.save({ id: grant.id, taskId: task.id, allowQuietHoursOverride: true });
      const window = protect({
        endsAt: new Date(NOON + 60 * 60_000).toISOString(), allowAuthorizedDeadlineOverride: true,
      });
      const alert = createAlert({ taskId: task.id });
      if (requirement === "disabled policy") configure({ enableAuthorizedImmediate: false });
      if (requirement === "revoked grant") layer.authorityStore.revoke(grant.id, "Stop");
      if (requirement === "quiet policy") configure({ quietHours: { start: "12:00", end: "13:00" } });
      if (requirement === "quiet grant") layer.authorityStore.save({ id: grant.id, allowQuietHoursOverride: false });
      if (requirement === "muted task") taskStore.updateTask(task.id, { muted: true });
      if (requirement === "expired evidence") layer.detailsStore.save({ ...alert.details, validUntil: new Date(NOON).toISOString() });
      if (requirement === "review first") configure({ reviewTimes: ["12:10"] });
      if (requirement === "missing evidence") layer.detailsStore.save({ ...alert.details, evidence: [] });
      if (requirement === "different producer") layer.detailsStore.save({ ...alert.details, producer: "other" });
      if (requirement === "inactive") layer.mutations.updateAlert(alert.id, { lifecycle: "resolved", lifecycleReason: "Handled" });
      const controller = start({ protectionStore });
      emit(alert);
      await controller.flush();
      expect(sendToAll).not.toHaveBeenCalled();
      expect(layer.notificationDeliveryStore.get(identity(alert))?.suppressionReason).toBe(reason);
      expect(protectionStore.impacts(window.id).postponed).toBe(0);
    });

    it("allows a deadline bypass only when both independent quiet overrides also pass", async () => {
      configure({ quietHours: { start: "12:00", end: "13:00" }, allowGrantQuietHoursOverride: true });
      layer.authorityStore.save({ id: grant.id, allowQuietHoursOverride: true });
      protect({ endsAt: new Date(NOON + 60 * 60_000).toISOString(), allowAuthorizedDeadlineOverride: true });
      const controller = start({ protectionStore });
      createAlert();
      await controller.flush();
      expect(sendToAll).toHaveBeenCalledTimes(1);
    });

    it.each([2, 10])("intersects protection with standing quiet hours ending after %s minutes", async (minutes) => {
      configure({ quietHours: { start: "12:00", end: minutes === 2 ? "12:02" : "12:10" } });
      protect();
      const controller = start({ protectionStore });
      const alert = createAlert();
      await controller.flush();
      expect(sendToAll).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(sendToAll).toHaveBeenCalledTimes(minutes < 5 ? 1 : 0);
      if (minutes > 5) {
        expect(layer.notificationDeliveryStore.get(identity(alert))?.pendingUntil).toBe("2026-06-01T12:10:00.000Z");
        await vi.advanceTimersByTimeAsync(5 * 60_000);
        expect(sendToAll).toHaveBeenCalledTimes(1);
      }
    });

    it("does not leave cached protection after a sub-minute expiry or early cancellation", async () => {
      protect({ endsAt: new Date(NOON + 5_000).toISOString() });
      const controller = start({ protectionStore });
      createAlert();
      await controller.flush();
      await vi.advanceTimersByTimeAsync(5_000);
      expect(sendToAll).toHaveBeenCalledTimes(1);
      const second = protect({ endsAt: new Date(NOON + 20_000).toISOString() });
      createAlert();
      await controller.flush();
      expect(sendToAll).toHaveBeenCalledTimes(1);
      protectionStore.cancel(second.id);
      await controller.flush();
      expect(sendToAll).toHaveBeenCalledTimes(2);
    });

    it.each(["muted", "revoked", "expired", "quiet", "resolved"] as const)(
      "rechecks %s state when cancellation releases a held alert",
      async (change) => {
        const taskStore = createTaskStore(db, bus);
        const task = taskStore.createTask("Source");
        layer.authorityStore.save({ id: grant.id, taskId: task.id });
        const window = protect();
        const controller = start({ protectionStore });
        const alert = createAlert({ taskId: task.id });
        await controller.flush();
        if (change === "muted") taskStore.updateTask(task.id, { muted: true });
        if (change === "revoked") layer.authorityStore.revoke(grant.id, "Stop");
        if (change === "expired") layer.detailsStore.save({ ...alert.details, interventionBy: new Date(NOON).toISOString() });
        if (change === "quiet") configure({ quietHours: { start: "12:00", end: "12:10" } });
        if (change === "resolved") layer.mutations.updateAlert(alert.id, { lifecycle: "resolved", lifecycleReason: "Handled" });
        protectionStore.cancel(window.id);
        await controller.flush();
        expect(sendToAll).not.toHaveBeenCalled();
        const pending = layer.notificationDeliveryStore.get(identity(alert));
        expect(pending?.claimToken).toBeNull();
        expect(pending?.pendingUntil).toBe(change === "quiet" ? "2026-06-01T12:10:00.000Z" : null);
        expect(protectionStore.impacts(window.id).pending).toBe(change === "quiet" ? 1 : 0);
      },
    );

    it("recovers a hold that committed before its queue row and does not duplicate the hold", async () => {
      const window = protect();
      const alert = createAlert();
      protectionStore.hold(window, {
        kind: "notification", workId: JSON.stringify([alert.id, alert.activationId]), scheduledFor: alert.createdAt,
      });
      const controller = start({ protectionStore });
      await controller.flush();
      expect(protectionStore.impacts(window.id).postponed).toBe(1);
      expect(layer.notificationDeliveryStore.get(identity(alert))?.pendingUntil).toBe(window.endsAt);
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(sendToAll).toHaveBeenCalledTimes(1);
    });

    it("retries a persisted hold when creating its delivery row temporarily fails", async () => {
      const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
      const window = protect();
      let broken = true;
      const controller = start({ protectionStore, deliveryStore: {
        ...layer.notificationDeliveryStore,
        suppress: (...args) => {
          if (broken) throw new Error("Queue unavailable");
          layer.notificationDeliveryStore.suppress(...args);
        },
      } });
      const alert = createAlert();
      await controller.flush();
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("Queue unavailable"));
      expect(layer.notificationDeliveryStore.get(identity(alert))).toBeUndefined();
      expect(protectionStore.impacts(window.id).postponed).toBe(1);
      broken = false;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(layer.notificationDeliveryStore.get(identity(alert))?.pendingUntil).toBe(window.endsAt);
      await vi.advanceTimersByTimeAsync(270_000);
      expect(sendToAll).toHaveBeenCalledTimes(1);
    });

    it("supersedes the old episode, retains a new episode, and never adds dashboard-only producers", async () => {
      const window = protect();
      const controller = start({ protectionStore });
      const first = createAlert();
      createAlert({ notificationMode: "focus" });
      createAlert({ notificationMode: "summary" });
      await controller.flush();
      layer.mutations.updateAlert(first.id, { newEpisode: true, episodeReason: "Another outage" });
      await controller.flush();
      expect(protectionStore.impacts(window.id)).toMatchObject({
        postponed: 2, pending: 1, dispositions: { superseded: 1 },
      });
      await vi.advanceTimersByTimeAsync(5 * 60_000);
      expect(sendToAll).toHaveBeenCalledTimes(1);
    });

    it("settles failed protected sends once and cancels its timer on dispose", async () => {
      vi.spyOn(console, "warn").mockImplementation(() => {});
      const window = protect();
      const first = start({ protectionStore });
      const alert = createAlert();
      await first.flush();
      await first.dispose();
      expect(vi.getTimerCount()).toBe(0);
      vi.setSystemTime(NOON + 5 * 60_000);
      sendToAll.mockRejectedValue(new Error("Offline"));
      const second = start({ protectionStore });
      await second.flush();
      emit(alert);
      await second.flush();
      expect(sendToAll).toHaveBeenCalledTimes(1);
      expect(protectionStore.impacts(window.id)).toMatchObject({ pending: 0, dispositions: { failed: 1 } });
    });

    it("settles stale claimed holds at grace expiry even when current alert state is unavailable", async () => {
      const window = protect();
      const alert = createAlert();
      protectionStore.hold(window, {
        kind: "notification", workId: JSON.stringify([alert.id, alert.activationId]), scheduledFor: alert.createdAt,
      });
      const claimed = layer.notificationDeliveryStore.claim(identity(alert), grant.id)!;
      const get = vi.fn(() => { throw new Error("Alert state unavailable"); });
      const controller = start({ protectionStore, alertStore: { get } });
      await controller.flush();
      expect(layer.notificationDeliveryStore.pending()).toEqual([]);
      expect(protectionStore.impacts(window.id).pending).toBe(1);
      await vi.advanceTimersByTimeAsync(FOCUS_NOTIFICATION_CLAIM_GRACE_MS);
      expect(layer.notificationDeliveryStore.get(identity(alert))).toMatchObject({
        status: "failed", claimToken: claimed.claimToken, error: expect.stringContaining("outcome unknown"),
      });
      expect(protectionStore.impacts(window.id)).toMatchObject({ pending: 0, dispositions: { failed: 1 } });
      expect(get).not.toHaveBeenCalled();
      emit(alert);
      await controller.flush();
      expect(sendToAll).not.toHaveBeenCalled();
    });

    it.each(["sent", "rejected"] as const)(
      "recovers a hung protected send before its late %s result without contradicting hold disposition",
      async (late) => {
        vi.spyOn(console, "warn").mockImplementation(() => {});
        let entered!: () => void;
        let complete!: (summary: PushSendSummary) => void;
        let reject!: (error: Error) => void;
        const started = new Promise<void>((resolve) => { entered = resolve; });
        const sending = new Promise<PushSendSummary>((resolve, rejectPromise) => { complete = resolve; reject = rejectPromise; });
        sendToAll.mockImplementationOnce(() => { entered(); return sending; });
        const window = protect();
        const controller = start({ protectionStore });
        const alert = createAlert();
        await controller.flush();
        const settle = vi.spyOn(protectionStore, "settle");
        vi.setSystemTime(NOON + 5 * 60_000);
        const releasing = controller.flush();
        await started;
        try {
          const claimed = layer.notificationDeliveryStore.get(identity(alert))!;
          expect(vi.getTimerCount()).toBe(1);
          await vi.advanceTimersByTimeAsync(FOCUS_NOTIFICATION_CLAIM_GRACE_MS - 1);
          expect(layer.notificationDeliveryStore.get(identity(alert))?.status).toBe("eligible");
          expect(protectionStore.impacts(window.id).pending).toBe(1);
          await vi.advanceTimersByTimeAsync(1);
          const recovered = layer.notificationDeliveryStore.get(identity(alert));
          expect(recovered).toMatchObject({ status: "failed", claimToken: claimed.claimToken, sentAt: null });
          expect(protectionStore.impacts(window.id)).toMatchObject({ pending: 0, dispositions: { failed: 1 } });
          emit(alert);
          if (late === "sent") complete(SENT);
          else reject(new Error("Late transport failure"));
          await releasing;
          await controller.flush();
          expect(layer.notificationDeliveryStore.get(identity(alert))).toEqual(recovered);
          expect(settle.mock.calls.some(([, disposition]) => disposition === "delivered")).toBe(false);
          expect(layer.attentionStore.list({ objectId: alert.id }).filter((event) => event.reason === "late-result"))
            .toEqual([expect.objectContaining({
              details: expect.objectContaining({ retainedStatus: "failed",
                ...(late === "sent" ? { outcome: SENT } : { error: "Late transport failure" }) }),
            })]);
          expect(sendToAll).toHaveBeenCalledTimes(1);
          expect(vi.getTimerCount()).toBe(0);
        } finally {
          complete(SENT);
          await releasing;
        }
      },
    );
  });
});
