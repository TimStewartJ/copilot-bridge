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

  it("clears entity tags through the shared deletion path", async () => {
    const task = ctx.taskStore.createTask("Tagged task");
    const tag = ctx.tagStore!.createTag("release");
    ctx.tagStore!.setEntityTags("task", task.id, [tag.id]);
    expect(ctx.tagStore!.getEntityTags("task", task.id)).toHaveLength(1);

    await deleteTaskWithOwnedState(ctx, task.id, { sessionDisposition: "archive" });

    expect(ctx.tagStore!.getEntityTags("task", task.id)).toHaveLength(0);
    expect(ctx.taskStore.getTask(task.id)).toBeUndefined();
  });

  it("restores entity tags when the cascade rolls back", async () => {
    const task = ctx.taskStore.createTask("Tagged rollback");
    const tag = ctx.tagStore!.createTag("release");
    ctx.tagStore!.setEntityTags("task", task.id, [tag.id]);

    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("ALTER TABLE tasks RENAME TO tasks_hidden");
    await expect(
      deleteTaskWithOwnedState(ctx, task.id, { sessionDisposition: "archive" }),
    ).rejects.toThrow();
    db.exec("ALTER TABLE tasks_hidden RENAME TO tasks");
    db.exec("PRAGMA foreign_keys = ON");

    // Tag removal is inside the cascade transaction, so a surviving task keeps
    // its tags instead of silently losing them.
    expect(ctx.tagStore!.getEntityTags("task", task.id)).toHaveLength(1);
    expect(ctx.taskStore.getTask(task.id)).toBeDefined();
  });
});

describe("task deletion session disposition", () => {
  function isArchived(sessionId: string): boolean {
    const row = db
      .prepare("SELECT archived FROM bridge_session_state WHERE sessionId = ?")
      .get(sessionId) as { archived?: number } | undefined;
    return row?.archived === 1;
  }

  it("requires an explicit disposition when the task has linked sessions", async () => {
    const task = ctx.taskStore.createTask("Has sessions");
    ctx.taskStore.linkSession(task.id, "session-a");
    ctx.taskStore.linkSession(task.id, "session-b");

    const res = await request(app).delete(`/api/tasks/${task.id}`).expect(409);

    expect(res.body.error).toBe("confirmation_required");
    expect(res.body.preview.sessionCount).toBe(2);
    // The whole point: nothing is destroyed and nothing is silently detached.
    expect(ctx.taskStore.getTask(task.id)).toBeDefined();
  });

  it("still deletes a task with no linked sessions without a disposition", async () => {
    const task = ctx.taskStore.createTask("No sessions");

    await request(app).delete(`/api/tasks/${task.id}`).expect(200);

    expect(ctx.taskStore.getTask(task.id)).toBeUndefined();
  });

  it("archive disposition archives every linked session and deletes the task", async () => {
    const task = ctx.taskStore.createTask("Archive me");
    ctx.taskStore.linkSession(task.id, "session-a");
    ctx.taskStore.linkSession(task.id, "session-b");

    const res = await request(app)
      .delete(`/api/tasks/${task.id}?sessionDisposition=archive`)
      .expect(200);

    expect(res.body.archivedSessionIds).toEqual(["session-a", "session-b"]);
    expect(isArchived("session-a")).toBe(true);
    expect(isArchived("session-b")).toBe(true);
    expect(ctx.taskStore.getTask(task.id)).toBeUndefined();
  });

  it("does not leave sessions archived when the task delete rolls back", async () => {
    const task = ctx.taskStore.createTask("Atomic archive");
    ctx.taskStore.linkSession(task.id, "session-a");

    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("ALTER TABLE tasks RENAME TO tasks_hidden");
    await expect(
      deleteTaskWithOwnedState(ctx, task.id, { sessionDisposition: "archive" }),
    ).rejects.toThrow();
    db.exec("ALTER TABLE tasks_hidden RENAME TO tasks");
    db.exec("PRAGMA foreign_keys = ON");

    // Archiving commits with the cascade, so a surviving task cannot be left
    // with all of its sessions mysteriously archived.
    expect(isArchived("session-a")).toBe(false);
    expect(ctx.taskStore.getTask(task.id)).toBeDefined();
  });

  it("delete disposition deletes linked sessions and the task", async () => {
    const task = ctx.taskStore.createTask("Delete me");
    ctx.taskStore.linkSession(task.id, "session-a");
    ctx.taskStore.linkSession(task.id, "session-b");
    const deleted: string[] = [];
    ctx.sessionManager.deleteSession = (async (id: string) => { deleted.push(id); }) as any;

    const res = await request(app)
      .delete(`/api/tasks/${task.id}?sessionDisposition=delete`)
      .expect(200);

    expect(deleted).toEqual(["session-a", "session-b"]);
    expect(res.body.deletedSessionIds).toEqual(["session-a", "session-b"]);
    expect(ctx.taskStore.getTask(task.id)).toBeUndefined();
  });

  it("unlinks sessions another task still owns instead of deleting them", async () => {
    const task = ctx.taskStore.createTask("Owner");
    const otherTask = ctx.taskStore.createTask("Co-owner");
    ctx.taskStore.linkSession(task.id, "exclusive-session");
    ctx.taskStore.linkSession(task.id, "shared-session");
    ctx.taskStore.linkSession(otherTask.id, "shared-session");
    const deleted: string[] = [];
    ctx.sessionManager.deleteSession = (async (id: string) => { deleted.push(id); }) as any;

    const res = await request(app)
      .delete(`/api/tasks/${task.id}?sessionDisposition=delete`)
      .expect(200);

    // Deleting a session unlinks it from every task, so a shared session must
    // never be destroyed on behalf of just one of its owners.
    expect(deleted).toEqual(["exclusive-session"]);
    expect(res.body.unlinkedSharedSessionIds).toEqual(["shared-session"]);
    expect(ctx.taskStore.getTask(otherTask.id)!.sessionIds).toEqual(["shared-session"]);
  });

  it("refuses to delete while a linked session is busy, keeping the task", async () => {
    const task = ctx.taskStore.createTask("Busy task");
    ctx.taskStore.linkSession(task.id, "busy-session");
    ctx.sessionManager.isSessionBusy = ((id: string) => id === "busy-session") as any;

    const res = await request(app)
      .delete(`/api/tasks/${task.id}?sessionDisposition=delete`)
      .expect(409);

    expect(res.body.error).toBe("sessions_busy");
    expect(res.body.preview.busySessionIds).toEqual(["busy-session"]);
    expect(ctx.taskStore.getTask(task.id)).toBeDefined();
  });

  it("keeps the task when a session delete fails so the operation can be retried", async () => {
    const task = ctx.taskStore.createTask("Partial failure");
    ctx.taskStore.linkSession(task.id, "ok-session");
    ctx.taskStore.linkSession(task.id, "doomed-session");
    ctx.sessionManager.deleteSession = (async (id: string) => {
      if (id === "doomed-session") throw new Error("backend exploded");
    }) as any;

    const res = await request(app)
      .delete(`/api/tasks/${task.id}?sessionDisposition=delete`)
      .expect(409);

    expect(res.body.error).toBe("session_disposition_failed");
    expect(res.body.sessionErrors).toMatchObject({ "doomed-session": "backend exploded" });
    // Sessions are disposed before the task, so the survivor is the task itself
    // rather than a set of orphaned sessions.
    expect(ctx.taskStore.getTask(task.id)).toBeDefined();
    expect(ctx.taskStore.getTask(task.id)!.sessionIds).toEqual(["doomed-session"]);
  });

  it("cancels deferred work for sessions archived in bulk", async () => {
    const task = ctx.taskStore.createTask("Deferred host");
    ctx.taskStore.linkSession(task.id, "session-a");
    ctx.taskStore.linkSession(task.id, "session-b");
    const cancelledPrompts: string[] = [];
    const cancelledLoops: string[] = [];
    ctx.deferredPromptStore!.cancelForSession = ((id: string) => {
      cancelledPrompts.push(id);
      return 1;
    }) as any;
    ctx.deferLoopStore!.cancelForSession = ((id: string) => {
      cancelledLoops.push(id);
      return 1;
    }) as any;

    await request(app).delete(`/api/tasks/${task.id}?sessionDisposition=archive`).expect(200);

    // Per-session `session:archived` events are what normally cancel deferred
    // work; the bulk path skips them, so it must cancel explicitly or an
    // archived session could still fire a deferred prompt.
    expect(cancelledPrompts).toEqual(["session-a", "session-b"]);
    expect(cancelledLoops).toEqual(["session-a", "session-b"]);
  });

  it("keeps the task when a session is linked while the delete runs", async () => {
    const task = ctx.taskStore.createTask("Racing task");
    ctx.taskStore.linkSession(task.id, "session-a");
    ctx.sessionManager.deleteSession = (async () => {
      // Simulate an agent linking a new session mid-delete.
      ctx.taskStore.linkSession(task.id, "late-session");
    }) as any;

    const res = await request(app)
      .delete(`/api/tasks/${task.id}?sessionDisposition=delete`)
      .expect(409);

    expect(res.body.error).toBe("session_disposition_failed");
    expect(res.body.sessionErrors).toHaveProperty("late-session");
    // The cascade would have dropped the new link silently — precisely the
    // orphaning this path exists to prevent.
    expect(ctx.taskStore.getTask(task.id)).toBeDefined();
    expect(ctx.taskStore.getTask(task.id)!.sessionIds).toContain("late-session");
  });

  it("rejects a stale preview fingerprint", async () => {
    const task = ctx.taskStore.createTask("Drifting");
    ctx.taskStore.linkSession(task.id, "session-a");
    const preview = await request(app).get(`/api/tasks/${task.id}/deletion-preview`).expect(200);

    ctx.taskStore.linkSession(task.id, "session-b");

    const res = await request(app)
      .delete(`/api/tasks/${task.id}?sessionDisposition=delete&fingerprint=${preview.body.preview.fingerprint}`)
      .expect(409);

    expect(res.body.error).toBe("preview_stale");
    expect(ctx.taskStore.getTask(task.id)).toBeDefined();
  });

  it("rejects an unknown disposition", async () => {
    const task = ctx.taskStore.createTask("Bad param");
    ctx.taskStore.linkSession(task.id, "session-a");

    await request(app).delete(`/api/tasks/${task.id}?sessionDisposition=nuke`).expect(400);

    expect(ctx.taskStore.getTask(task.id)).toBeDefined();
  });

  it("reports counts, shared sessions and busy sessions in the preview", async () => {
    const task = ctx.taskStore.createTask("Preview host");
    const otherTask = ctx.taskStore.createTask("Co-owner");
    ctx.taskStore.linkSession(task.id, "plain-session");
    ctx.taskStore.linkSession(task.id, "archived-session");
    ctx.taskStore.linkSession(task.id, "shared-session");
    ctx.taskStore.linkSession(otherTask.id, "shared-session");
    ctx.sessionMetaStore.setArchived("archived-session", true);
    ctx.sessionManager.isSessionBusy = ((id: string) => id === "plain-session") as any;

    const res = await request(app).get(`/api/tasks/${task.id}/deletion-preview`).expect(200);

    expect(res.body.preview).toMatchObject({
      sessionCount: 3,
      archivedCount: 1,
      unarchivedCount: 2,
      sharedSessionCount: 1,
      busySessionIds: ["plain-session"],
    });
  });

  it("clears a dangling scheduleId on sessions that survive the task", async () => {
    const task = ctx.taskStore.createTask("Scheduled");
    const schedule = ctx.scheduleStore.createSchedule({
      taskId: task.id,
      name: "Nightly",
      prompt: "run",
      type: "cron",
      cron: "0 0 * * *",
    });
    ctx.taskStore.linkSession(task.id, "run-session");
    ctx.sessionMetaStore.setScheduleMeta("run-session", schedule.id, "Nightly");

    await request(app).delete(`/api/tasks/${task.id}?sessionDisposition=archive`).expect(200);

    const row = db
      .prepare("SELECT scheduleId, scheduleName FROM bridge_session_state WHERE sessionId = ?")
      .get("run-session") as { scheduleId: string | null; scheduleName: string | null };
    // The name is provenance worth keeping; the ID now points at nothing.
    expect(row.scheduleId).toBeNull();
    expect(row.scheduleName).toBe("Nightly");
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
