import { describe, expect, it } from "vitest";
import type { ApiRouteTestState } from "./api-routes-test-helpers.js";
import { installApiRouteTestHooks, request, scheduler } from "./api-routes-test-helpers.js";
import { deleteTaskWithOwnedState } from "../task-deletion.js";

let app: ApiRouteTestState["app"];
let ctx: ApiRouteTestState["ctx"];
let db: ApiRouteTestState["db"];

installApiRouteTestHooks((state) => {
  ({ app, ctx, db } = state);
});

function initScheduler(): void {
  scheduler.initialize(ctx.sessionManager as any, {
    scheduleStore: ctx.scheduleStore,
    taskStore: ctx.taskStore,
    sessionMetaStore: ctx.sessionMetaStore,
    globalBus: ctx.globalBus,
  });
}

function seedSchedules(taskId: string): { cronId: string; onceId: string } {
  const cronSchedule = ctx.scheduleStore.createSchedule({
    taskId,
    name: "Cron child",
    prompt: "run",
    type: "cron",
    cron: "0 0 * * *",
  });
  const onceSchedule = ctx.scheduleStore.createSchedule({
    taskId,
    name: "One-shot child",
    prompt: "run once",
    type: "once",
    runAt: new Date(Date.now() + 60 * 60_000).toISOString(),
  });
  scheduler.registerSchedule(cronSchedule.id);
  scheduler.armOneShot(onceSchedule.id, onceSchedule.runAt!);
  return { cronId: cronSchedule.id, onceId: onceSchedule.id };
}

describe("task deletion removes child schedules", () => {
  it("DELETE /api/tasks/:id deletes child schedules and unregisters their timers", async () => {
    initScheduler();
    const task = ctx.taskStore.createTask("Scheduled task");
    const otherTask = ctx.taskStore.createTask("Other task");
    const { cronId, onceId } = seedSchedules(task.id);
    const survivor = ctx.scheduleStore.createSchedule({
      taskId: otherTask.id,
      name: "Survivor",
      prompt: "run",
      type: "cron",
      cron: "0 1 * * *",
    });
    scheduler.registerSchedule(survivor.id);

    db.prepare("INSERT INTO schedule_runs (scheduleId, sessionId, recordedAt) VALUES (?, ?, ?)")
      .run(cronId, "run-session", new Date().toISOString());

    const before = scheduler.getRegisteredScheduleIdsForTests();
    expect(before.cron).toContain(cronId);
    expect(before.oneShot).toContain(onceId);

    await request(app).delete(`/api/tasks/${task.id}`).expect(200);

    expect(ctx.scheduleStore.getSchedule(cronId)).toBeUndefined();
    expect(ctx.scheduleStore.getSchedule(onceId)).toBeUndefined();
    expect(ctx.scheduleStore.getSchedule(survivor.id)).toBeDefined();

    const after = scheduler.getRegisteredScheduleIdsForTests();
    expect(after.cron).not.toContain(cronId);
    expect(after.oneShot).not.toContain(onceId);
    expect(after.cron).toContain(survivor.id);

    // No enabled orphan schedule survives its parent task.
    const orphans = db.prepare(`
      SELECT s.id FROM schedules s
      LEFT JOIN tasks t ON t.id = s.taskId
      WHERE t.id IS NULL AND s.enabled = 1
    `).all() as Array<{ id: string }>;
    expect(orphans).toEqual([]);

    // Run history for the deleted schedules is gone too.
    expect(
      (db.prepare("SELECT COUNT(*) AS count FROM schedule_runs WHERE scheduleId = ?").get(cronId) as any).count,
    ).toBe(0);
  });

  it("rolls back the whole cascade when the task delete fails mid-transaction", () => {
    const task = ctx.taskStore.createTask("Rollback task");
    const schedule = ctx.scheduleStore.createSchedule({
      taskId: task.id,
      name: "Child",
      prompt: "run",
      type: "cron",
      cron: "0 0 * * *",
    });
    db.prepare("INSERT INTO schedule_runs (scheduleId, sessionId, recordedAt) VALUES (?, ?, ?)")
      .run(schedule.id, "run-session", new Date().toISOString());

    // The task row is deleted last, so dropping `tasks` makes the final
    // statement in the transaction throw after the schedule deletes ran.
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("ALTER TABLE tasks RENAME TO tasks_hidden");

    expect(() => ctx.taskStore.deleteTaskCascade(task.id)).toThrow();

    db.exec("ALTER TABLE tasks_hidden RENAME TO tasks");
    db.exec("PRAGMA foreign_keys = ON");

    expect(ctx.scheduleStore.getSchedule(schedule.id)).toBeDefined();
    expect(
      (db.prepare("SELECT COUNT(*) AS count FROM schedule_runs WHERE scheduleId = ?").get(schedule.id) as any).count,
    ).toBe(1);
    expect(ctx.taskStore.getTask(task.id)).toBeDefined();
  });

  it("clears entity tags through the shared deletion path", () => {
    const task = ctx.taskStore.createTask("Tagged task");
    const tag = ctx.tagStore!.createTag("release");
    ctx.tagStore!.setEntityTags("task", task.id, [tag.id]);
    expect(ctx.tagStore!.getEntityTags("task", task.id)).toHaveLength(1);

    deleteTaskWithOwnedState(ctx, task.id);

    expect(ctx.tagStore!.getEntityTags("task", task.id)).toHaveLength(0);
    expect(ctx.taskStore.getTask(task.id)).toBeUndefined();
  });

  it("restores entity tags when the cascade rolls back", () => {
    const task = ctx.taskStore.createTask("Tagged rollback");
    const tag = ctx.tagStore!.createTag("release");
    ctx.tagStore!.setEntityTags("task", task.id, [tag.id]);

    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("ALTER TABLE tasks RENAME TO tasks_hidden");
    expect(() => deleteTaskWithOwnedState(ctx, task.id)).toThrow();
    db.exec("ALTER TABLE tasks_hidden RENAME TO tasks");
    db.exec("PRAGMA foreign_keys = ON");

    // Tag removal is inside the cascade transaction, so a surviving task keeps
    // its tags instead of silently losing them.
    expect(ctx.tagStore!.getEntityTags("task", task.id)).toHaveLength(1);
    expect(ctx.taskStore.getTask(task.id)).toBeDefined();
  });
});

describe("scheduler self-heals pre-existing orphaned schedules", () => {
  it("disables and unregisters a schedule whose task is already gone", async () => {
    initScheduler();
    const task = ctx.taskStore.createTask("Doomed");
    const schedule = ctx.scheduleStore.createSchedule({
      taskId: task.id,
      name: "Orphan",
      prompt: "run",
      type: "cron",
      cron: "0 0 * * *",
    });
    scheduler.registerSchedule(schedule.id);

    // Simulate a legacy install where the task row vanished without cascade.
    db.prepare("DELETE FROM tasks WHERE id = ?").run(task.id);

    const result = await scheduler.triggerSchedule(schedule.id, { source: "manual" });

    expect(result).toMatchObject({ skipped: "Parent task not found" });
    expect(ctx.scheduleStore.getSchedule(schedule.id)?.enabled).toBe(false);
    expect(scheduler.getRegisteredScheduleIdsForTests().cron).not.toContain(schedule.id);
  });
});

describe("task group deletion clears groupId", () => {
  it("DELETE /api/task-groups/:id persists groupId = null for member tasks", async () => {
    const group = ctx.taskGroupStore!.createGroup("Group A");
    const task = ctx.taskStore.createTask("Grouped", group.id);
    expect((db.prepare("SELECT groupId FROM tasks WHERE id = ?").get(task.id) as any).groupId).toBe(group.id);

    await request(app).delete(`/api/task-groups/${group.id}`).expect(200);

    expect((db.prepare("SELECT groupId FROM tasks WHERE id = ?").get(task.id) as any).groupId).toBeNull();
    expect(ctx.taskStore.getTask(task.id)!.groupId).toBeUndefined();
  });
});

describe("schedule deletion is atomic", () => {
  it("deletes the schedule, its runs, and its claims together", () => {
    const task = ctx.taskStore.createTask("Schedule host");
    const schedule = ctx.scheduleStore.createSchedule({
      taskId: task.id,
      name: "Cascade",
      prompt: "run",
      type: "cron",
      cron: "0 0 * * *",
    });
    db.prepare("INSERT INTO schedule_runs (scheduleId, sessionId, recordedAt) VALUES (?, ?, ?)")
      .run(schedule.id, "run-1", new Date().toISOString());
    db.prepare(`
      INSERT INTO schedule_run_claims (scheduleId, runKey, source, status, claimedAt, leaseExpiresAt)
      VALUES (?, 'key', 'cron', 'claimed', ?, ?)
    `).run(schedule.id, new Date().toISOString(), new Date(Date.now() + 60_000).toISOString());

    ctx.scheduleStore.deleteSchedule(schedule.id);

    expect(ctx.scheduleStore.getSchedule(schedule.id)).toBeUndefined();
    expect((db.prepare("SELECT COUNT(*) AS count FROM schedule_runs WHERE scheduleId = ?").get(schedule.id) as any).count).toBe(0);
    expect((db.prepare("SELECT COUNT(*) AS count FROM schedule_run_claims WHERE scheduleId = ?").get(schedule.id) as any).count).toBe(0);
  });

  it("rolls back run history when the schedule row delete fails", () => {
    const task = ctx.taskStore.createTask("Schedule host");
    const schedule = ctx.scheduleStore.createSchedule({
      taskId: task.id,
      name: "Rollback",
      prompt: "run",
      type: "cron",
      cron: "0 0 * * *",
    });
    db.prepare("INSERT INTO schedule_runs (scheduleId, sessionId, recordedAt) VALUES (?, ?, ?)")
      .run(schedule.id, "run-1", new Date().toISOString());

    db.exec("ALTER TABLE schedules RENAME TO schedules_hidden");
    expect(() => ctx.scheduleStore.deleteSchedule(schedule.id)).toThrow();
    db.exec("ALTER TABLE schedules_hidden RENAME TO schedules");

    expect(ctx.scheduleStore.getSchedule(schedule.id)).toBeDefined();
    expect((db.prepare("SELECT COUNT(*) AS count FROM schedule_runs WHERE scheduleId = ?").get(schedule.id) as any).count).toBe(1);
  });
});
