import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setupTestDb } from "../../__tests__/helpers.js";
import { LEASE_MS } from "../../chat-work-runner.js";
import type { DatabaseSync } from "../../db.js";
import { createGlobalBus, type StatusEvent } from "../../global-bus.js";
import { SessionCapacityError } from "../../session-manager.js";
import { createTaskGroupStore } from "../../task-group-store.js";
import { createTaskHistoryStore } from "../../task-history-store.js";
import { createTaskStore } from "../../task-store.js";
import { createTriggerStore } from "../store.js";
import { createTriggerTaskRunner, TRIGGER_TASK_WAIT_RETRY_MS } from "../task-runner.js";
import type { TriggerCreate } from "../types.js";

let db: DatabaseSync;

beforeEach(() => {
  db = setupTestDb();
  vi.useFakeTimers({ now: new Date("2026-11-16T15:30:00.000Z") });
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function setup(input: Partial<TriggerCreate> = {}) {
  const bus = createGlobalBus();
  const events: StatusEvent[] = [];
  bus.subscribe((event) => events.push(event));
  const taskStore = createTaskStore(db, bus);
  const group = createTaskGroupStore(db, bus).createGroup("Ops");
  const owner = taskStore.createTask("Release train", group.id);
  const store = createTriggerStore(db);
  const trigger = store.create({
    name: "Daily review",
    prompt: "Review yesterday's builds.",
    taskId: owner.id,
    when: { kind: "cron", cron: "0 * * * *", timezone: "UTC" },
    action: { kind: "new_chat" },
    nextRunAt: new Date(Date.now() - 60_000).toISOString(),
    ...input,
  });
  let created = 0;
  const sm = {
    createTaskSession: vi.fn(async () => ({ sessionId: `chat-${++created}` })),
    startWorkAndWaitForDelivery: vi.fn(async () => {}),
    deleteSession: vi.fn(async () => {}),
    abortSession: vi.fn(async () => true),
    isSessionBusy: vi.fn(() => false),
    readSessionsFromDisk: vi.fn(async () => []),
    getSessionCapacityWait: vi.fn((): string | undefined => undefined),
    getDeferDeliveryReadiness: vi.fn(() => ({ ready: true })),
  };
  const sessionMetaStore = { setScheduleMeta: vi.fn(), isArchived: vi.fn(() => false), setArchived: vi.fn() };
  const runner = createTriggerTaskRunner({
    store,
    taskStore,
    taskHistoryStore: createTaskHistoryStore(db),
    sessionManager: sm as any,
    sessionMetaStore: sessionMetaStore as any,
    globalBus: bus,
  });
  return { bus, events, taskStore, owner, group, store, trigger, sm, sessionMetaStore, runner };
}

async function runOnce(runner: ReturnType<typeof createTriggerTaskRunner>) {
  runner.start();
  await vi.advanceTimersByTimeAsync(0);
  await runner.waitForIdle();
}

describe("trigger task runner", () => {
  it("starts a fresh chat in its task, records it before launching, and moves to the next cron slot", async () => {
    const { events, taskStore, owner, store, trigger, sm, sessionMetaStore, runner } = setup();
    sm.startWorkAndWaitForDelivery.mockImplementation(async () => {
      // The chat is linked and recorded before the launch, so a crash here cannot start it twice.
      expect(taskStore.getTask(owner.id)!.sessionIds).toContain("chat-1");
      expect(store.listRuns(trigger.id).runs).toHaveLength(1);
    });

    await runOnce(runner);
    expect(sm.createTaskSession).toHaveBeenCalledWith(
      owner.id, "Release train", [], "", owner.cwd,
      expect.objectContaining({ name: "Daily review", type: "cron", runCount: 0 }),
    );
    expect(sm.startWorkAndWaitForDelivery).toHaveBeenCalledWith("chat-1", "Review yesterday's builds.", undefined, { origin: "schedule", promptSource: "automation-schedule" });
    expect(store.get(trigger.id)).toMatchObject({
      status: "active", runCount: 1, fireCount: 1, lastSessionId: "chat-1", nextRunAt: "2026-11-16T16:00:00.000Z",
    });
    expect(sessionMetaStore.setScheduleMeta).toHaveBeenCalledWith("chat-1", trigger.id, "Daily review");
    expect(events).toContainEqual(expect.objectContaining({ type: "trigger:fired", triggerId: trigger.id, sessionId: "chat-1", taskId: owner.id }));
    runner.shutdown();
  });

  it("rolls a failed launch back and counts it, but only waits when the Bridge has no room", async () => {
    const { taskStore, owner, store, trigger, sm, runner } = setup();
    sm.startWorkAndWaitForDelivery
      .mockRejectedValueOnce(new SessionCapacityError("context-limit", { contexts: 9, contextLimit: 8, localMcpInstances: 9, capacityUnits: 9, capacityLimit: 8 }))
      .mockRejectedValueOnce(new Error("model refused"));

    await runOnce(runner);
    expect(store.get(trigger.id)).toMatchObject({ status: "active", runCount: 0, attempts: 0 });
    expect(sm.deleteSession).toHaveBeenCalledWith("chat-1");
    // Held for a while rather than tried again at once.
    expect(sm.createTaskSession).toHaveBeenCalledOnce();

    await vi.advanceTimersByTimeAsync(TRIGGER_TASK_WAIT_RETRY_MS);
    await runner.waitForIdle();
    expect(store.get(trigger.id)).toMatchObject({ status: "active", runCount: 1, fireCount: 0, attempts: 1, lastError: "model refused" });
    expect(sm.deleteSession).toHaveBeenCalledWith("chat-2");
    expect(taskStore.getTask(owner.id)!.sessionIds).toEqual([]);
    expect(store.listRuns(trigger.id).total).toBe(0);
    runner.shutdown();
  });

  it("skips a cron slot missed by more than an hour instead of running it late", async () => {
    const { store, trigger, sm, runner } = setup({ nextRunAt: "2026-11-16T13:00:00.000Z" });

    await runOnce(runner);
    expect(sm.createTaskSession).not.toHaveBeenCalled();
    expect(store.get(trigger.id)).toMatchObject({ status: "active", runCount: 0, nextRunAt: "2026-11-16T16:00:00.000Z" });
    runner.shutdown();
  });

  it("settles a run recovered after a crash from its recorded chat instead of starting another", async () => {
    const { store, trigger, sm, runner } = setup();
    const claimed = store.claimDue(trigger.id, LEASE_MS)!;
    store.recordRun({ triggerId: trigger.id, sessionId: "chat-before-crash", occurrence: claimed.claimToken });
    await vi.advanceTimersByTimeAsync(LEASE_MS + 1_000);

    await runOnce(runner);
    expect(sm.createTaskSession).not.toHaveBeenCalled();
    expect(store.get(trigger.id)).toMatchObject({ status: "active", runCount: 1, fireCount: 1, lastSessionId: "chat-before-crash" });
    runner.shutdown();
  });

  it("stops a trigger whose task is gone instead of waking for it forever", async () => {
    const { owner, store, trigger, sm, runner } = setup();
    db.prepare("DELETE FROM tasks WHERE id = ?").run(owner.id);

    await runOnce(runner);
    expect(sm.createTaskSession).not.toHaveBeenCalled();
    expect(store.get(trigger.id)).toMatchObject({ status: "cancelled", lastError: "Its task no longer exists." });
    runner.shutdown();
  });

  it("creates tasks in the owner's group, one open task at a time", async () => {
    const { taskStore, group, store, trigger, sm, runner } = setup({
      action: { kind: "new_task", title: "Triage new alerts" },
      when: { kind: "every", seconds: 300 },
      maxRuns: 5,
    });

    await runOnce(runner);
    const made = store.get(trigger.id)!.lastTaskId!;
    expect(taskStore.getTask(made)).toMatchObject({ title: "Triage new alerts", groupId: group.id, sessionIds: ["chat-1"] });
    expect(store.isTriggerMadeTask(made)).toBe(true);

    await vi.advanceTimersByTimeAsync(300_000);
    await runner.waitForIdle();
    expect(sm.createTaskSession).toHaveBeenCalledOnce();
    expect(store.get(trigger.id)).toMatchObject({ runCount: 2, fireCount: 1 });

    taskStore.updateTask(made, { status: "archived" });
    await vi.advanceTimersByTimeAsync(300_000);
    await runner.waitForIdle();
    expect(sm.createTaskSession).toHaveBeenCalledTimes(2);
    expect(store.get(trigger.id)!.lastTaskId).not.toBe(made);
    runner.shutdown();
  });
});
