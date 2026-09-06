import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppContext } from "../app-context.js";
import { initializeSchedulerAndDeferredRunners } from "../app-context-factory.js";
import { createChecklistStore } from "../checklist-store.js";
import { createFocusDataLayer } from "../focus-data-layer.js";
import {
  createFocusSessionLaunchService, type FocusLaunchServiceOptions, type FocusSessionLaunchService,
} from "../focus-session-launch-service.js";
import { FOCUS_LAUNCH_STARTUP_RECOVERY_LIMIT } from "../focus-session-launch-store.js";
import * as restartController from "../restart-controller.js";
import { createDefaultRestartState } from "../restart-state.js";
import { createTaskGroupStore } from "../task-group-store.js";
import { createTaskStore } from "../task-store.js";
import { decisionDetails } from "./focus-test-fixtures.js";
import { createMockSessionManager, createTestBus, registerTestAppCleanup, setupTestDb } from "./helpers.js";

const CURRENT_OWNER = { pid: 100, startMarker: "current-launch-process" };
const OLD_OWNER = { pid: 101, startMarker: "previous-launch-process" };

beforeEach(() => {
  vi.spyOn(restartController, "refreshRestartState").mockResolvedValue(createDefaultRestartState());
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function setup() {
  const db = setupTestDb();
  const bus = createTestBus();
  const checklistStore = createChecklistStore(db, bus);
  const layer = createFocusDataLayer(db, bus, checklistStore);
  const store = layer.sessionLaunchStore;
  const ctx = {
    sessionManager: createMockSessionManager(),
    taskStore: createTaskStore(db, bus),
    taskGroupStore: createTaskGroupStore(db, bus),
    focusMutationCoordinator: layer.mutations,
    focusAttentionStore: layer.attentionStore,
  };
  const getOwner = vi.fn<NonNullable<FocusLaunchServiceOptions["getOwner"]>>().mockResolvedValue(CURRENT_OWNER);
  const getOwnerStatus = vi.fn<NonNullable<FocusLaunchServiceOptions["getOwnerStatus"]>>().mockResolvedValue("exited");
  const services: FocusSessionLaunchService[] = [];
  function createService(options: FocusLaunchServiceOptions = {}) {
    const service = createFocusSessionLaunchService(ctx, store, { getOwner, getOwnerStatus, ...options });
    services.push(service);
    return service;
  }
  const service = createService();
  registerTestAppCleanup(async () => {
    for (const owned of services) owned.stop();
    try { await Promise.all(services.map((owned) => owned.drain())); }
    finally { db.close(); }
  });
  function prepared(taskId?: string) {
    const object = layer.mutations.saveDecision({
      ...decisionDetails, title: "Review the rollout", taskId, action: { prompt: "Discuss the rollout alternatives." },
    }).decision;
    const { receipt } = service.prepare({
      objectId: object.id, activationId: object.activationId, source: "launch_prompt",
    });
    return { object, receipt };
  }
  function created(taskId?: string) {
    const { object, receipt } = prepared(taskId);
    const claimed = store.claim(receipt, OLD_OWNER)!;
    store.markDispatched(receipt.id, claimed.ownerToken!);
    return { object, receipt: store.markCreated(receipt.id, claimed.ownerToken!, receipt.expectedSessionId) };
  }
  const create = vi.spyOn(ctx.sessionManager, "createSession");
  const createTask = vi.spyOn(ctx.sessionManager, "createTaskSession");
  const probe = vi.spyOn(ctx.sessionManager, "getSessionCreationState");
  const warm = vi.spyOn(ctx.sessionManager, "warmSession");
  const send = vi.spyOn(ctx.sessionManager, "startWorkAndWaitForDelivery");
  return {
    db, ctx, layer, store, checklistStore, service, createService, getOwner, getOwnerStatus,
    prepared, created, create, createTask, probe, warm, send,
  };
}

describe("bounded Focus launch startup recovery", () => {
  it.each([false, true])("repairs a confirmed created receipt and sends once, already linked=%s", async (linked) => {
    const f = setup();
    const task = f.ctx.taskStore.createTask("Rollout task");
    const { object, receipt } = f.created(task.id);
    if (linked) {
      f.ctx.taskStore.linkSession(task.id, receipt.expectedSessionId);
      f.layer.mutations.linkLaunchedSession(object.id, receipt.expectedSessionId, object.activationId);
      f.store.markLinked(receipt.id, receipt.ownerToken!);
    }
    const linkTask = vi.spyOn(f.ctx.taskStore, "linkSession");
    const first = f.service.reconcileStartup();
    expect(f.service.reconcileStartup()).toBe(first);
    expect(await first).toMatchObject({
      selected: 1, recovered: 1, unrecovered: 0, skippedPrepared: 0, skippedInspectOnly: 0,
      deferred: 0, stopped: 0, error: null,
    });
    expect(f.store.requireReceipt(receipt.id)).toMatchObject({
      status: "ready", sessionId: receipt.expectedSessionId, expectedSessionId: receipt.expectedSessionId,
      promptStatus: "sent", linkedAt: expect.any(String), ownerToken: null,
    });
    expect(f.layer.decisionStore.get(object.id)).toMatchObject({
      activationId: object.activationId, sessionId: receipt.expectedSessionId, lifecycle: "acknowledged",
      details: { handedOffAt: null },
    });
    expect(f.ctx.taskStore.getTask(task.id)?.sessionIds).toContain(receipt.expectedSessionId);
    expect(linkTask).toHaveBeenCalledTimes(1);
    expect(f.warm).toHaveBeenCalledExactlyOnceWith(receipt.expectedSessionId);
    expect(f.send).toHaveBeenCalledExactlyOnceWith(receipt.expectedSessionId, receipt.prompt, undefined, {
      clientMessageId: `focus-launch:${receipt.id}`,
    });
    expect(() => f.store.markLinked(receipt.id, receipt.ownerToken!)).toThrow("claim changed");
    expect(f.service.reconcileStartup()).toBe(first);
    expect(await f.createService().reconcileStartup()).toMatchObject({ selected: 0, recovered: 0 });
    expect(f.create).not.toHaveBeenCalled();
    expect(f.createTask).not.toHaveBeenCalled();
    expect(f.probe).not.toHaveBeenCalled();
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it("preserves a handoff already created by accepted Action work", async () => {
    const f = setup();
    const { object, receipt } = f.created();
    const promotion = f.layer.mutations.promoteToAction(object.id, f.checklistStore, { taskId: null });
    const handedOffAt = f.layer.decisionStore.get(object.id)?.details.handedOffAt;
    expect(await f.service.reconcileStartup()).toMatchObject({ recovered: 1 });
    expect(f.layer.decisionStore.get(object.id)).toMatchObject({
      lifecycle: "handed_off", sessionId: receipt.expectedSessionId, details: { handedOffAt },
    });
    expect(f.checklistStore.getChecklistItem(promotion.action.id)).toEqual(promotion.action);
  });

  it("leaves an unconfirmed dialog preparation untouched without creating a session", async () => {
    const f = setup();
    const { object, receipt } = f.prepared();
    expect(await f.service.reconcileStartup()).toMatchObject({
      selected: 0, recovered: 0, skippedPrepared: 1, skippedInspectOnly: 0,
    });
    expect(f.store.requireReceipt(receipt.id)).toEqual(receipt);
    expect(f.layer.decisionStore.get(object.id)).toEqual(object);
    expect(f.getOwner).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
    expect(f.createTask).not.toHaveBeenCalled();
    expect(f.probe).not.toHaveBeenCalled();
    expect(f.warm).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });

  it.each([
    "creating-before-dispatch", "creating-after-dispatch", "unknown-creation",
    "sending-prompt", "unknown-prompt", "failed-link", "pending-with-dispatch-marker",
    "created-without-session", "created-with-empty-session", "created-with-mismatched-session",
  ] as const)("keeps %s receipts inspect-only and unchanged", async (state) => {
    const f = setup();
    const { receipt } = f.prepared();
    const claimed = f.store.claim(receipt, OLD_OWNER)!;
    const token = claimed.ownerToken!;
    if (state !== "creating-before-dispatch") f.store.markDispatched(receipt.id, token);
    if (state === "unknown-creation") f.store.fail(receipt.id, token, "unknown", "creation", "Creation response lost");
    else if (!state.startsWith("creating-")) {
      f.store.markCreated(receipt.id, token, receipt.expectedSessionId);
      if (state === "sending-prompt" || state === "unknown-prompt") f.store.claimPrompt(receipt.id, token);
      if (state === "unknown-prompt") f.store.fail(receipt.id, token, "unknown", "prompt", "Prompt response lost");
      if (state === "failed-link") f.store.fail(receipt.id, token, "failed", "link", "Link failed");
      if (state === "pending-with-dispatch-marker") {
        f.db.prepare("UPDATE focus_session_launches SET promptDispatchedAt=? WHERE id=?")
          .run(new Date().toISOString(), receipt.id);
      }
      if (state === "created-without-session") {
        f.db.prepare("UPDATE focus_session_launches SET sessionId=NULL WHERE id=?").run(receipt.id);
      }
      if (state === "created-with-empty-session") {
        f.db.prepare("UPDATE focus_session_launches SET sessionId='', expectedSessionId='' WHERE id=?").run(receipt.id);
      }
      if (state === "created-with-mismatched-session") {
        f.db.prepare("UPDATE focus_session_launches SET sessionId='different-session' WHERE id=?").run(receipt.id);
      }
    }
    const before = f.store.requireReceipt(receipt.id);
    expect(await f.service.reconcileStartup()).toMatchObject({
      selected: 0, recovered: 0, skippedPrepared: 0, skippedInspectOnly: 1,
    });
    expect(f.store.requireReceipt(receipt.id)).toEqual(before);
    expect(f.getOwner).not.toHaveBeenCalled();
    expect(f.create).not.toHaveBeenCalled();
    expect(f.createTask).not.toHaveBeenCalled();
    expect(f.probe).not.toHaveBeenCalled();
    expect(f.warm).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });

  it.each(["new-episode", "resolved", "dismissed", "accepted_risk"] as const)(
    "does not reactivate or deliver an old prompt for a %s source", async (state) => {
      const f = setup();
      const { object, receipt } = f.created();
      f.layer.mutations.updateDecision(object.id, state === "new-episode"
        ? { lifecycle: "active", newEpisode: true, episodeReason: "A different concern" }
        : { lifecycle: state, lifecycleReason: "Explicit user disposition" });
      const before = f.layer.decisionStore.get(object.id);
      expect(await f.service.reconcileStartup()).toMatchObject({ recovered: 0, unrecovered: 1 });
      expect(f.store.requireReceipt(receipt.id)).toMatchObject({ status: "superseded", promptStatus: "pending" });
      expect(f.layer.decisionStore.get(object.id)).toEqual(before);
      expect(f.create).not.toHaveBeenCalled();
      expect(f.warm).not.toHaveBeenCalled();
      expect(f.send).not.toHaveBeenCalled();
    },
  );

  it.each(["archived", "muted", "deleted"] as const)("revalidates a now-%s destination", async (state) => {
    const f = setup();
    const task = f.ctx.taskStore.createTask("Destination");
    const { object, receipt } = f.created(task.id);
    if (state === "deleted") f.ctx.taskStore.deleteTask(task.id);
    else f.ctx.taskStore.updateTask(task.id, state === "archived" ? { status: "archived" } : { muted: true });
    const before = f.layer.decisionStore.get(object.id);
    const linkTask = vi.spyOn(f.ctx.taskStore, "linkSession");
    expect(await f.service.reconcileStartup()).toMatchObject({ recovered: 0, unrecovered: 1 });
    expect(f.store.requireReceipt(receipt.id)).toMatchObject({
      status: "failed", sessionId: receipt.expectedSessionId, promptStatus: "pending",
    });
    expect(f.layer.decisionStore.get(object.id)).toEqual(before);
    expect(linkTask).not.toHaveBeenCalled();
    expect(f.createTask).not.toHaveBeenCalled();
    expect(f.warm).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });

  it.each(["alive", "unknown"] as const)("does not steal %s process ownership", async (status) => {
    const f = setup();
    const { receipt } = f.created();
    f.getOwnerStatus.mockResolvedValue(status);
    expect(await f.service.reconcileStartup()).toMatchObject({ selected: 1, recovered: 0, unrecovered: 1 });
    expect(f.getOwnerStatus).toHaveBeenCalledExactlyOnceWith(OLD_OWNER);
    expect(f.store.requireReceipt(receipt.id)).toEqual(receipt);
    expect(f.warm).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });

  it("honors active claims held by another service in this process", async () => {
    const f = setup();
    const { receipt } = f.prepared();
    const entered = gate();
    const release = gate();
    f.warm.mockImplementation(async () => { entered.resolve(); await release.promise; });
    const manualLaunch = f.service.start(receipt.id);
    try {
      await entered.promise;
      const before = f.store.requireReceipt(receipt.id);
      expect(before).toMatchObject({ status: "created", promptStatus: "pending", ownerPid: CURRENT_OWNER.pid });
      expect(await f.createService().reconcileStartup()).toMatchObject({ selected: 1, recovered: 0, unrecovered: 1 });
      expect(f.store.requireReceipt(receipt.id)).toEqual(before);
      expect(f.getOwnerStatus).not.toHaveBeenCalled();
      expect(f.warm).toHaveBeenCalledTimes(1);
      expect(f.send).not.toHaveBeenCalled();
    } finally { release.resolve(); await manualLaunch; }
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it("fences a candidate changed by another owner during the ownership check", async () => {
    const f = setup();
    const { receipt } = f.created();
    const entered = gate();
    const release = gate();
    f.getOwnerStatus.mockImplementation(async () => { entered.resolve(); await release.promise; return "exited"; });
    const recovery = f.service.reconcileStartup();
    try {
      await entered.promise;
      const newer = f.store.claim(receipt, { pid: 102, startMarker: "newer-owner" })!;
      const sending = f.store.claimPrompt(receipt.id, newer.ownerToken!);
      release.resolve();
      expect(await recovery).toMatchObject({ recovered: 0, unrecovered: 1 });
      expect(f.store.requireReceipt(receipt.id)).toEqual(sending);
      expect(f.warm).not.toHaveBeenCalled();
      expect(f.send).not.toHaveBeenCalled();
    } finally { release.resolve(); await recovery; }
  });

  it("rechecks queued eligibility without changing a newly ambiguous prompt", async () => {
    const f = setup();
    f.created();
    f.created();
    const [first, second] = f.store.getStartupRecoveryBatch().receipts;
    const entered = gate();
    const release = gate();
    f.warm.mockImplementation(async () => { entered.resolve(); await release.promise; });
    const recovery = f.service.reconcileStartup();
    try {
      await entered.promise;
      const sending = f.store.claimPrompt(second!.id, second!.ownerToken!);
      release.resolve();
      expect(await recovery).toMatchObject({ selected: 2, recovered: 1, unrecovered: 1 });
      expect(f.store.requireReceipt(second!.id)).toEqual(sending);
      expect(f.send).toHaveBeenCalledExactlyOnceWith(first!.sessionId, first!.prompt, undefined, {
        clientMessageId: `focus-launch:${first!.id}`,
      });
    } finally { release.resolve(); await recovery; }
  });

  it("stops remaining candidates and drains the current prompt delivery", async () => {
    const f = setup();
    f.created();
    f.created();
    f.created();
    const [, ...queued] = f.store.getStartupRecoveryBatch().receipts;
    const entered = gate();
    const release = gate();
    f.send.mockImplementation(async () => { entered.resolve(); await release.promise; });
    const recovery = f.service.reconcileStartup();
    try {
      await entered.promise;
      f.service.stop();
      let drained = false;
      const draining = f.service.drain().then(() => { drained = true; });
      await Promise.resolve();
      expect(drained).toBe(false);
      release.resolve();
      await draining;
      expect(await recovery).toMatchObject({ selected: 3, recovered: 1, stopped: 2 });
      expect(f.send).toHaveBeenCalledTimes(1);
      for (const receipt of queued) expect(f.store.requireReceipt(receipt.id)).toEqual(receipt);
      await expect(f.service.start(queued[0]!.id)).rejects.toThrow("shutting down");
    } finally { release.resolve(); await recovery; }
  });

  it("owns restart-readiness work in drain even before a launch is in flight", async () => {
    const f = setup();
    const { receipt } = f.created();
    const entered = gate();
    const release = gate();
    vi.mocked(restartController.refreshRestartState).mockImplementation(async () => {
      entered.resolve();
      await release.promise;
      return createDefaultRestartState();
    });
    const recovery = f.service.reconcileStartup();
    try {
      await entered.promise;
      f.service.stop();
      let drained = false;
      const draining = f.service.drain().then(() => { drained = true; });
      await Promise.resolve();
      expect(drained).toBe(false);
      expect(f.getOwner).not.toHaveBeenCalled();
      release.resolve();
      await draining;
      expect(await recovery).toMatchObject({ selected: 1, recovered: 0, stopped: 1 });
      expect(f.store.requireReceipt(receipt.id)).toEqual(receipt);
      expect(f.send).not.toHaveBeenCalled();
    } finally { release.resolve(); await recovery; }
  });

  it("does not start a scan after the service has stopped", async () => {
    const f = setup();
    const { receipt } = f.created();
    const scan = vi.spyOn(f.store, "getStartupRecoveryBatch");
    f.service.stop();
    expect(await f.service.reconcileStartup()).toMatchObject({ selected: 0, recovered: 0 });
    await f.service.drain();
    expect(scan).not.toHaveBeenCalled();
    expect(f.store.requireReceipt(receipt.id)).toEqual(receipt);
  });

  it("only processes the first bounded batch without retrying overflow", async () => {
    const f = setup();
    const receipts = Array.from({ length: FOCUS_LAUNCH_STARTUP_RECOVERY_LIMIT + 1 }, () => f.created().receipt);
    const selected = new Set(f.store.getStartupRecoveryBatch().receipts.map((receipt) => receipt.id));
    const overflow = receipts.find((receipt) => !selected.has(receipt.id))!;
    const recovery = f.service.reconcileStartup();
    expect(await recovery).toMatchObject({
      selected: FOCUS_LAUNCH_STARTUP_RECOVERY_LIMIT, recovered: FOCUS_LAUNCH_STARTUP_RECOVERY_LIMIT, deferred: 1,
    });
    expect(f.service.reconcileStartup()).toBe(recovery);
    expect(f.send).toHaveBeenCalledTimes(FOCUS_LAUNCH_STARTUP_RECOVERY_LIMIT);
    expect(f.store.requireReceipt(overflow.id)).toEqual(overflow);
    expect(f.create).not.toHaveBeenCalled();
    expect(f.createTask).not.toHaveBeenCalled();
  });

  it.each([0, 1])("defers the remaining batch when restart cutover begins after %s deliveries", async (delivered) => {
    const f = setup();
    f.created();
    f.created();
    const before = f.store.getStartupRecoveryBatch().receipts;
    const refresh = vi.mocked(restartController.refreshRestartState)
      .mockResolvedValue({ ...createDefaultRestartState(), phase: "restarting" });
    if (delivered) refresh.mockResolvedValueOnce(createDefaultRestartState());
    expect(await f.service.reconcileStartup()).toMatchObject({ selected: 2, recovered: delivered, deferred: 2 - delivered });
    for (const receipt of before.slice(delivered)) expect(f.store.requireReceipt(receipt.id)).toEqual(receipt);
    expect(f.send).toHaveBeenCalledTimes(delivered);
  });

  it("continues past one failed ownership probe without mutating its receipt", async () => {
    const f = setup();
    f.created();
    f.created();
    const [first] = f.store.getStartupRecoveryBatch().receipts;
    f.getOwner.mockRejectedValueOnce(new Error("Identity unavailable"));
    expect(await f.service.reconcileStartup()).toMatchObject({ selected: 2, recovered: 1, unrecovered: 1 });
    expect(f.store.requireReceipt(first!.id)).toEqual(first);
    expect(f.send).toHaveBeenCalledTimes(1);
  });

  it("never retries prompt delivery after an automatic recovery becomes ambiguous", async () => {
    const f = setup();
    const { receipt } = f.created();
    f.send.mockRejectedValue(new Error("Prompt delivery response lost"));
    expect(await f.service.reconcileStartup()).toMatchObject({ selected: 1, recovered: 0, unrecovered: 1 });
    const ambiguous = f.store.requireReceipt(receipt.id);
    expect(ambiguous).toMatchObject({ status: "unknown", promptStatus: "unknown", errorStage: "prompt" });
    expect(await f.createService().reconcileStartup()).toMatchObject({
      selected: 0, recovered: 0, skippedInspectOnly: 1,
    });
    expect(f.store.requireReceipt(receipt.id)).toEqual(ambiguous);
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.create).not.toHaveBeenCalled();
  });

  it("leaves candidates untouched when restart readiness cannot be established", async () => {
    const f = setup();
    const { receipt } = f.created();
    vi.mocked(restartController.refreshRestartState).mockRejectedValue(new Error("Restart state unavailable"));
    expect(await f.service.reconcileStartup()).toMatchObject({
      selected: 1, recovered: 0, deferred: 1, error: "Restart state unavailable",
    });
    expect(f.store.requireReceipt(receipt.id)).toEqual(receipt);
    expect(f.getOwner).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
    await f.service.drain();
  });

  it("reports a failed scan once without an unhandled or endlessly retried worker", async () => {
    const f = setup();
    const scan = vi.spyOn(f.store, "getStartupRecoveryBatch").mockImplementation(() => { throw new Error("Store unavailable"); });
    const recovery = f.service.reconcileStartup();
    expect(await recovery).toMatchObject({ selected: 0, recovered: 0, error: "Store unavailable" });
    expect(f.service.reconcileStartup()).toBe(recovery);
    await f.service.drain();
    expect(scan).toHaveBeenCalledTimes(1);
    expect(f.getOwner).not.toHaveBeenCalled();
  });

  it("uses the shared SDK-ready hook without blocking startup on prompt delivery", async () => {
    const f = setup();
    f.created();
    const entered = gate();
    const release = gate();
    f.send.mockImplementation(async () => { entered.resolve(); await release.promise; });
    const scan = vi.spyOn(f.store, "getStartupRecoveryBatch");
    const context = {
      ...f.ctx,
      focusSessionLaunchService: f.service,
      focusProtectionStore: { start: vi.fn() },
      scheduler: { initialize: vi.fn() },
      deferredPromptRunner: { start: vi.fn() },
      deferLoopRunner: { start: vi.fn() },
    } as unknown as AppContext;
    expect(scan).not.toHaveBeenCalled();
    expect(initializeSchedulerAndDeferredRunners(context)).toBeUndefined();
    try {
      await entered.promise;
      expect(initializeSchedulerAndDeferredRunners(context)).toBeUndefined();
      expect(scan).toHaveBeenCalledTimes(1);
      expect(f.send).toHaveBeenCalledTimes(1);
      expect(context.scheduler?.initialize).toHaveBeenCalledTimes(2);
    } finally { release.resolve(); await f.service.drain(); }
  });
});
