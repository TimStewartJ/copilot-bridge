import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createTaskStore } from "../task-store.js";
import { createTaskGroupStore } from "../task-group-store.js";
import { createSessionMetaStore } from "../session-meta-store.js";
import { createScheduleStore } from "../schedule-store.js";
import { createDeferredPromptStore } from "../deferred-prompt-store.js";
import { createDeferLoopStore } from "../defer-loop-store.js";
import { createManagementJobStore } from "../management-job-store.js";
import { createReturnedDeferDelivery } from "../defer-result-message.js";
import { buildTaskOverview, toOverviewSessions, type TaskOverviewContext } from "../task-overview.js";
import { createTestBus, setupTestDb, makeTestDir } from "./helpers.js";
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
      getSessionContinuationState: vi.fn(() => ({ runningAgentCount: 0, runningCommandCount: 0, held: false })),
    };
    const ctx = {
      taskStore: createTaskStore(db, bus), taskGroupStore: createTaskGroupStore(db, bus),
      sessionMetaStore: createSessionMetaStore(db), scheduleStore: createScheduleStore(db),
      deferredPromptStore: createDeferredPromptStore(db), deferLoopStore: createDeferLoopStore(db),
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

  it("is read-only and keeps manual task/group order separate from its evidence", () => {
    const { ctx, task, read } = setup();
    const before = ctx.taskStore.getTask(task.id);
    const activity = read().activity;
    expect(activity).toMatchObject({ known: true, runCount: 0, deferredCount: 0, pendingDeliveryCount: 0 });
    expect(ctx.taskStore.getTask(task.id)).toEqual(before);
  });

  it("counts queued result deliveries even when no defer remains, excluding failed and completed results", () => {
    const { ctx, read } = setup();
    const result = ctx.deferredPromptStore.enqueueDelivery(createReturnedDeferDelivery(
      { deferId: "once_result", kind: "once", parentSessionId: "conversation" }, "Result", { deliveryId: "result-1" },
    ));
    expect(ctx.deferredPromptStore.getSummaryForSession("conversation").count).toBe(0);
    expect(read().activity?.pendingDeliveryCount).toBe(1);
    const claim = ctx.deferredPromptStore.claimDue(result.id, 60_000);
    expect(claim).toBeDefined();
    expect(read().activity?.pendingDeliveryCount).toBe(1);
    ctx.deferredPromptStore.complete(result.id, { claimToken: claim!.claimToken });
    expect(read().activity?.pendingDeliveryCount).toBe(0);
    const failed = ctx.deferredPromptStore.enqueueDelivery(createReturnedDeferDelivery(
      { deferId: "once_failed", kind: "once", parentSessionId: "conversation" }, "Result", { deliveryId: "result-2" },
    ));
    ctx.deferredPromptStore.fail(failed.id, "Delivery failed");
    expect(read().activity?.pendingDeliveryCount).toBe(0);
  });

  it("counts defers and valid enabled schedules without treating terminal plans as work", () => {
    const { ctx, task, read } = setup();
    const prompt = ctx.deferredPromptStore.create("conversation", "Check", "2026-10-20T22:00:00Z");
    ctx.scheduleStore.createSchedule({ taskId: task.id, name: "Daily", prompt: "Check", type: "cron", cron: "0 9 * * *" });
    expect(read().activity).toMatchObject({ deferredCount: 1, scheduledCount: 1 });
    ctx.deferredPromptStore.cancelById(prompt.id);
    expect(read().activity?.deferredCount).toBe(0);
    const schedule = ctx.scheduleStore.listSchedules(task.id)[0];
    ctx.scheduleStore.updateSchedule(schedule.id, { enabled: false });
    expect(read().activity?.scheduledCount).toBe(0);
    ctx.scheduleStore.updateSchedule(schedule.id, { enabled: true, expiresAt: "2026-10-19T21:00:00Z" });
    expect(read().activity?.scheduledCount).toBe(0);
    ctx.scheduleStore.updateSchedule(schedule.id, { expiresAt: "2026-10-20T22:00:00Z", maxRuns: 1 });
    db.prepare("UPDATE schedules SET runCount = 1 WHERE id = ?").run(schedule.id);
    expect(read().activity?.scheduledCount).toBe(0);
    expect(read().activity?.known).toBe(true);
    ctx.scheduleStore.updateSchedule(schedule.id, { expiresAt: "invalid date" });
    expect(read().activity).toMatchObject({ known: false, scheduledCount: 0 });
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

  it("retains command, agent, held and external-use evidence", () => {
    const { read, manager } = setup();
    manager.getSessionContinuationState.mockReturnValue({ runningAgentCount: 2, runningCommandCount: 1, held: true });
    expect(read([{ sessionId: "conversation", externallyInUse: true }]).activity)
      .toMatchObject({ known: true, runningAgentCount: 2, runningCommandCount: 1, heldCount: 1, externalCount: 1 });
  });

  it("treats a linked conversation absent from a fully read list as deleted, and archived ones as archived", () => {
    const { ctx, read } = setup();
    expect(read([]).activity).toMatchObject({ known: true, sessionIndexKnown: true });
    expect(read([]).activity?.unavailable).toBeUndefined();
    ctx.sessionMetaStore.setArchived("conversation", true);
    expect(read([]).activity).toMatchObject({ known: true, sessionIndexKnown: true });
    ctx.deferredPromptStore.create("conversation", "Check archived work", "2026-10-20T22:00:00Z");
    expect(read([]).activity?.deferredCount).toBe(1);
  });

  it("keeps unavailable sources distinct from an empty source", () => {
    const { ctx } = setup();
    expect(buildTaskOverview(ctx, null, NOW).tasks[0].activity).toMatchObject({ known: false, sessionIndexKnown: false });
    expect(buildTaskOverview({ ...ctx, managementJobStore: undefined }, [{ sessionId: "conversation", archived: false, activity: "" }], NOW)
      .tasks[0].activity?.known).toBe(false);
    ctx.taskStore.unlinkSession(ctx.taskStore.listTasks()[0].id, "conversation");
    expect(buildTaskOverview(ctx, null, NOW).tasks[0].activity).toMatchObject({ known: true, sessionIndexKnown: true });
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

  it("keeps expected preview gaps out of source errors without inventing complete evidence", () => {
    const { ctx } = setup();
    const other = ctx.taskStore.createTask("Another copied task");
    ctx.taskStore.linkSession(other.id, "other-conversation");
    const overview = buildTaskOverview({ ...ctx, isStaging: true }, [], NOW);
    expect(overview.tasks.every(row => row.activity?.unavailable?.scope === "source"
      && row.activity.unavailable.expectedInPreview === true)).toBe(true);
    expect(overview.sourceErrors).toEqual([]);
    expect(overview.tasks.every(row => row.activity?.known === false)).toBe(true);
  });

  it("does not hide a genuine runtime source failure behind an expected preview gap", () => {
    const { ctx } = setup();
    const overview = buildTaskOverview({
      ...ctx, isStaging: true,
      sessionManager: { getSessionRunState: () => "idle", getPendingUserInputCount: () => 0 },
    }, [], NOW);
    expect(overview.tasks[0].activity?.unavailable).toEqual({ scope: "source", reason: "Runtime continuation status is unavailable." });
    expect(overview.sourceErrors).toEqual(["Runtime continuation status is unavailable."]);
  });

  it("keeps known questions visible even when the conversation index is unavailable", () => {
    const { ctx, manager } = setup();
    manager.getPendingUserInputCount.mockReturnValue(1);
    expect(buildTaskOverview(ctx, null, NOW).tasks[0].inputCount).toBe(1);
  });
});
