import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTaskStore } from "../task-store.js";
import { createTaskGroupStore } from "../task-group-store.js";
import { createSessionMetaStore } from "../session-meta-store.js";
import { createDeferredPromptStore } from "../deferred-prompt-store.js";
import { createTriggerStore } from "../triggers/store.js";
import { createManagementJobStore } from "../management-job-store.js";
import { createTriggerResultDelivery } from "../triggers/messages.js";
import { buildTaskOverview, toOverviewSessions, type TaskOverviewContext } from "../task-overview.js";
import { createChatTrigger, createTestBus, endTrigger, setupTestDb, makeTestDir } from "./helpers.js";
import type { DatabaseSync } from "../db.js";

const NOW = Date.parse("2026-10-19T22:00:00Z");

describe("task continuation evidence", () => {
  let db: DatabaseSync;
  beforeEach(() => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(NOW); db = setupTestDb(); });
  afterEach(() => { db.close(); vi.useRealTimers(); });
  function setup() {
    const bus = createTestBus();
    const manager = {
      getSessionRunState: vi.fn< TaskOverviewContext["sessionManager"]["getSessionRunState"] >(() => "idle"),
      getPendingUserInputCount: vi.fn(() => 0),
      getSessionContinuationState: vi.fn((_sessionId: string) => ({ runningAgentCount: 0, runningCommandCount: 0, held: false })),
    };
    const ctx = {
      taskStore: createTaskStore(db, bus), taskGroupStore: createTaskGroupStore(db, bus),
      sessionMetaStore: createSessionMetaStore(db),
      deferredPromptStore: createDeferredPromptStore(db), triggerStore: createTriggerStore(db),
      managementJobStore: createManagementJobStore(db, { dataDir: makeTestDir("task-attention-jobs") }),
      sessionManager: manager,
    } satisfies TaskOverviewContext;
    const task = ctx.taskStore.createTask("Review delivery");
    ctx.taskStore.linkSession(task.id, "conversation");
    const read = (raw: unknown[] = [{ sessionId: "conversation" }]) => {
      const parsed = toOverviewSessions(raw);
      return buildTaskOverview(ctx, parsed.sessions, NOW, undefined, parsed.invalid).tasks[0];
    };
    return { ctx, task, read, manager };
  }

  it("shows a task’s pending results without changing the task or counting finished deliveries", () => {
    const { ctx, task, read } = setup();
    const before = ctx.taskStore.getTask(task.id);
    const result = ctx.deferredPromptStore.enqueueDelivery(createTriggerResultDelivery(
      { triggerId: "result", parentSessionId: "conversation" }, "Result", { deliveryId: "result-1" },
    ));
    expect(read().activity?.pendingDeliveryCount).toBe(1);
    const claim = ctx.deferredPromptStore.claimDue(result.id, 60_000);
    expect(claim).toBeDefined();
    expect(read().activity?.pendingDeliveryCount).toBe(1);
    ctx.deferredPromptStore.complete(result.id, { claimToken: claim!.claimToken });
    expect(read().activity).toMatchObject({ known: true, runCount: 0, chatTriggerCount: 0, pendingDeliveryCount: 0 });
    expect(ctx.taskStore.getTask(task.id)).toEqual(before);
    const failed = ctx.deferredPromptStore.enqueueDelivery(createTriggerResultDelivery(
      { triggerId: "failed", parentSessionId: "conversation" }, "Result", { deliveryId: "result-2" },
    ));
    ctx.deferredPromptStore.fail(failed.id, "Delivery failed");
    expect(read().activity?.pendingDeliveryCount).toBe(0);
  });

  it("attributes live runtime, chat triggers and task triggers that will run again to their own tasks", () => {
    const { ctx, task, manager } = setup();
    const terminal = ctx.taskStore.createTask("Terminal plans");
    ctx.taskStore.linkSession(terminal.id, "terminal-chat");
    const daily = (taskId: string, name: string) => ctx.triggerStore.create({
      taskId, name, prompt: "Check", when: { kind: "cron", cron: "0 9 * * *", timezone: "UTC" },
      action: { kind: "new_chat" }, nextRunAt: "2026-10-20T09:00:00Z",
    });
    daily(task.id, "Ready");
    ctx.triggerStore.pause(daily(terminal.id, "Paused").id);
    endTrigger(db, daily(terminal.id, "Expired").id, "expired");
    ctx.triggerStore.cancel(daily(terminal.id, "Cancelled").id);

    createChatTrigger(ctx.triggerStore, "conversation");
    expect(ctx.triggerStore.cancel(createChatTrigger(ctx.triggerStore, "terminal-chat").id)).toBe(true);    manager.getSessionContinuationState.mockImplementation((id) => id === "conversation"
      ? { runningAgentCount: 2, runningCommandCount: 1, held: true }
      : { runningAgentCount: 0, runningCommandCount: 0, held: false });
    const { sessions } = toOverviewSessions([{ sessionId: "conversation", externallyInUse: true }, { sessionId: "terminal-chat" }]);

    const overview = buildTaskOverview(ctx, sessions, NOW);
    const activity = new Map(overview.tasks.map((row) => [row.id, row.activity]));
    expect(activity.get(task.id)).toMatchObject({ known: true, chatTriggerCount: 1, taskTriggerCount: 1,
      runningAgentCount: 2, runningCommandCount: 1, heldCount: 1, externalCount: 1 });
    expect(activity.get(terminal.id)).toMatchObject({ known: true, chatTriggerCount: 0, taskTriggerCount: 0,
      runningAgentCount: 0, runningCommandCount: 0, heldCount: 0, externalCount: 0 });
  });

  it("counts management jobs and deploys awaiting activation without counting terminal jobs", () => {
    const { ctx, read } = setup();
    const preview = ctx.managementJobStore.enqueue("staging_preview", { stagingDir: "fixture" }, { originSessionId: "conversation" });
    const deploy = ctx.managementJobStore.enqueue("staging_deploy", {}, { originSessionId: "conversation" });
    expect(read().activity?.managementJobCount).toBe(2);
    ctx.managementJobStore.fail(preview.id, "Build failed");
    expect(read().activity?.managementJobCount).toBe(1);
    ctx.managementJobStore.succeed(deploy.id, { restartQueued: true, restartActivated: false });
    expect(ctx.managementJobStore.listActive()).toHaveLength(0);
    expect(read().activity?.managementJobCount).toBe(1);
    db.prepare("UPDATE management_jobs SET result = ? WHERE id = ?")
      .run(JSON.stringify({ restartQueued: true, restartActivated: true }), deploy.id);
    expect(read().activity?.managementJobCount).toBe(0);
  });

  it("treats a linked conversation absent from a fully read list as deleted, and archived ones as archived", () => {
    const { ctx, read } = setup();
    expect(read([]).activity).toMatchObject({ known: true, sessionIndexKnown: true });
    expect(read([]).activity?.unavailable).toBeUndefined();
    ctx.sessionMetaStore.setArchived("conversation", true);
    expect(read([]).activity).toMatchObject({ known: true, sessionIndexKnown: true });
    createChatTrigger(ctx.triggerStore, "conversation");
    expect(read([]).activity?.chatTriggerCount).toBe(1);
  });

  it("keeps known questions visible on linked tasks when the conversation source is unavailable", () => {
    const { ctx, task, manager } = setup();
    const unlinked = ctx.taskStore.createTask("No conversation");
    ctx.taskStore.linkSession(unlinked.id, "removed-chat");
    ctx.taskStore.unlinkSession(unlinked.id, "removed-chat");
    manager.getPendingUserInputCount.mockReturnValue(1);

    const overview = buildTaskOverview(ctx, null, NOW);
    expect(overview.tasks.find((row) => row.id === task.id)).toMatchObject({
      inputCount: 1, activity: { known: false, sessionIndexKnown: false },
    });
    expect(overview.tasks.find((row) => row.id === unlinked.id)).toMatchObject({
      inputCount: 0, activity: { known: true, sessionIndexKnown: true },
    });

    const { sessions } = toOverviewSessions([{ sessionId: "conversation" }]);
    const missingJobs = buildTaskOverview({ ...ctx, managementJobStore: undefined }, sessions, NOW);
    expect(missingJobs.tasks.find((row) => row.id === task.id)?.activity?.known).toBe(false);
  });

  it("does not spread one missing or unreadable conversation across unrelated tasks", () => {
    const { ctx, task } = setup();
    const other = ctx.taskStore.createTask("Unrelated work");
    ctx.taskStore.linkSession(other.id, "other-conversation");
    const parsed = toOverviewSessions([{ sessionId: "other-conversation" }, { broken: true }]);
    const overview = buildTaskOverview(ctx, parsed.sessions, NOW, undefined, parsed.invalid);
    expect(overview.sessionsComplete).toBe(false);
    expect(overview.tasks.find(row => row.id === other.id)?.activity).toMatchObject({ known: true, sessionIndexKnown: true });
    expect(overview.tasks.find(row => row.id === task.id)?.activity)
      .toMatchObject({ known: false, unavailable: { scope: "task", reason: expect.stringContaining("could not be read") } });
  });

  it("marks expected preview gaps as expected without inventing complete evidence", () => {
    const { ctx } = setup();
    const other = ctx.taskStore.createTask("Another copied task");
    ctx.taskStore.linkSession(other.id, "other-conversation");
    const overview = buildTaskOverview({ ...ctx, isStaging: true }, [], NOW);
    expect(overview.tasks.every(row => row.activity?.unavailable?.scope === "source"
      && row.activity.unavailable.expectedInPreview === true)).toBe(true);
    expect(overview.tasks.every(row => row.activity?.known === false)).toBe(true);
  });

  it("does not hide a genuine runtime source failure behind an expected preview gap", () => {
    const { ctx } = setup();
    const overview = buildTaskOverview({
      ...ctx, isStaging: true,
      sessionManager: { getSessionRunState: () => "idle", getPendingUserInputCount: () => 0 },
    }, [], NOW);
    expect(overview.tasks[0].activity?.unavailable).toEqual({ scope: "source", reason: "Runtime continuation status is unavailable." });
  });
});
