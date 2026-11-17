import { describe, expect, it, vi } from "vitest";
import type { ApiRouteTestState } from "../test-support/api-routes.js";
import { installApiRouteTestHooks, request } from "../test-support/api-routes.js";
import { deleteTaskWithOwnedState } from "../server/task-deletion.js";

let app: ApiRouteTestState["app"];
let ctx: ApiRouteTestState["ctx"];
let db: ApiRouteTestState["db"];

installApiRouteTestHooks((state) => {
  ({ app, ctx, db } = state);
});

function createTaskTrigger(taskId: string, name: string, timing: Record<string, unknown> = { cron: "0 0 * * *", timezone: "UTC" }): string {
  const result = ctx.triggerService!.create({ taskId, name, prompt: "run", then: "new_chat", ...timing });
  if (!result.ok) throw new Error(result.error);
  return result.trigger.id;
}

function countRuns(triggerId: string): number {
  return (db.prepare("SELECT COUNT(*) AS count FROM trigger_runs WHERE triggerId = ?").get(triggerId) as { count: number }).count;
}

describe("task deletion removes the task's triggers", () => {
  it("DELETE /api/tasks/:id deletes the task's triggers with their run history and announces each", async () => {
    const task = ctx.taskStore.createTask("Automated task");
    const otherTask = ctx.taskStore.createTask("Other task");
    const tag = ctx.tagStore!.createTag("linked");
    ctx.tagStore!.setEntityTags("task", task.id, [tag.id]);
    const child = ctx.checklistStore.createChecklistItem(task.id, "Child item");
    ctx.taskStore.linkWorkItem(task.id, "77", "github");
    const cronId = createTaskTrigger(task.id, "Cron child");
    const onceId = createTaskTrigger(task.id, "One-time child", { delaySeconds: 3600 });
    const survivorId = createTaskTrigger(otherTask.id, "Survivor", { cron: "0 1 * * *", timezone: "UTC" });
    ctx.triggerStore!.recordRun({ triggerId: cronId, sessionId: "run-session" });
    const emit = vi.spyOn(ctx.globalBus, "emit");

    const deleted = await request(app).delete(`/api/tasks/${task.id}`).expect(200);
    expect(deleted.body.ok).toBe(true);
    expect(ctx.checklistStore.getChecklistItem(child.id)).toBeUndefined();
    expect(ctx.tagStore!.getEntityTags("task", task.id)).toEqual([]);
    expect((await request(app).get(`/api/tasks/${task.id}`)).status).toBe(404);
    expect((await request(app).get(`/api/tasks/${otherTask.id}`)).body.task.title).toBe("Other task");
    expect((await request(app).get("/api/tags")).body.tags[0].id).toBe(tag.id);

    expect(ctx.triggerStore!.get(cronId)).toBeUndefined();
    expect(ctx.triggerStore!.get(onceId)).toBeUndefined();
    expect(ctx.triggerStore!.get(survivorId)).toBeDefined();
    expect(countRuns(cronId)).toBe(0);
    const announced = emit.mock.calls.map(([event]) => event).filter((event) => event.type === "trigger:changed");
    expect(announced).toEqual(expect.arrayContaining([
      { type: "trigger:changed", taskId: task.id, triggerId: cronId },
      { type: "trigger:changed", taskId: task.id, triggerId: onceId },
    ]));
  });

  it("rolls back the whole cascade when the task delete fails mid-transaction", () => {
    const task = ctx.taskStore.createTask("Rollback task");
    const triggerId = createTaskTrigger(task.id, "Child");
    ctx.triggerStore!.recordRun({ triggerId, sessionId: "run-session" });

    // The task row is deleted last, so hiding `tasks` makes the final statement throw.
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("ALTER TABLE tasks RENAME TO tasks_hidden");

    expect(() => ctx.taskStore.deleteTaskCascade(task.id)).toThrow();

    db.exec("ALTER TABLE tasks_hidden RENAME TO tasks");
    db.exec("PRAGMA foreign_keys = ON");

    expect(ctx.triggerStore!.get(triggerId)).toBeDefined();
    expect(countRuns(triggerId)).toBe(1);
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

  describe("ifUntouched", () => {
    it("deletes a task that was only created", async () => {
      const task = ctx.taskStore.createTask("New Task");

      await request(app).delete(`/api/tasks/${task.id}?ifUntouched=true`).expect(200);

      expect(ctx.taskStore.getTask(task.id)).toBeUndefined();
    });

    it.each<[string, (taskId: string) => void]>([
      ["was edited", (taskId) => {
        // An edit in the same millisecond as the creation would not move updatedAt.
        db.prepare("UPDATE tasks SET createdAt = ? WHERE id = ?").run("2026-01-01T00:00:00.000Z", taskId);
        ctx.taskStore.updateTask(taskId, { notes: "Keep this" });
      }],
      ["has a work item", (taskId) => {
        db.prepare("INSERT INTO task_work_items (taskId, itemId, provider) VALUES (?, '123', 'ado')").run(taskId);
      }],
      ["has a trigger", (taskId) => {
        createTaskTrigger(taskId, "Daily");
      }],
      ["has a checklist item", (taskId) => {
        ctx.checklistStore.createChecklistItem(taskId, "Call the dealer");
      }],
      ["has a history entry", (taskId) => {
        ctx.taskHistoryStore!.addEntry(taskId, "Decided to wait", { source: "user" });
      }],
      ["has a tag", (taskId) => {
        ctx.tagStore!.setEntityTags("task", taskId, [ctx.tagStore!.createTag("release").id]);
      }],
    ])("asks for confirmation when the task %s", async (_label, use) => {
      const task = ctx.taskStore.createTask("New Task");
      use(task.id);

      const res = await request(app).delete(`/api/tasks/${task.id}?ifUntouched=true`).expect(409);

      expect(res.body.error).toBe("confirmation_required");
      expect(res.body.preview.sessionCount).toBe(0);
      expect(ctx.taskStore.getTask(task.id)).toBeDefined();
    });
  });

  it("archive disposition archives every linked session and deletes the task", async () => {
    const task = ctx.taskStore.createTask("Archive me");
    ctx.taskStore.linkSession(task.id, "session-a");
    ctx.taskStore.linkSession(task.id, "session-b");
    const triggerId = createTaskTrigger(task.id, "Nightly");
    ctx.sessionMetaStore.setScheduleMeta("session-a", triggerId, "Nightly");
    const cancelPrompts = vi.spyOn(ctx.deferredPromptStore!, "cancelForSession");
    const cancelTriggers = vi.spyOn(ctx.triggerStore!, "cancelForSession");
    const cancelJobResults = vi.spyOn(ctx.deferredPromptStore!, "cancelManagementJobDeliveriesForSession");
    const invalidate = vi.spyOn(ctx.sessionManager, "invalidateSessionConfig");

    const res = await request(app)
      .delete(`/api/tasks/${task.id}?sessionDisposition=archive`)
      .expect(200);

    expect(res.body.archivedSessionIds).toEqual(["session-a", "session-b"]);
    // Kept chats rebuild their prompt, which named the deleted task.
    expect(invalidate.mock.calls).toEqual([["session-a", "task deleted"], ["session-b", "task deleted"]]);
    expect(cancelPrompts.mock.calls).toEqual([["session-a"], ["session-b"]]);
    expect(cancelTriggers.mock.calls).toEqual([["session-a"], ["session-b"]]);
    expect(cancelJobResults.mock.calls).toEqual([["session-a"], ["session-b"]]);
    const provenance = db.prepare("SELECT scheduleId, scheduleName FROM bridge_session_state WHERE sessionId = ?").get("session-a");
    expect(provenance).toMatchObject({ scheduleId: null, scheduleName: "Nightly" });
    expect(isArchived("session-a")).toBe(true);
    expect(isArchived("session-b")).toBe(true);
    expect(ctx.taskStore.getTask(task.id)).toBeUndefined();
  });

  it("does not leave sessions archived when the task delete rolls back", async () => {
    const task = ctx.taskStore.createTask("Atomic archive");
    ctx.taskStore.linkSession(task.id, "session-a");

    const tag = ctx.tagStore!.createTag("release");
    ctx.tagStore!.setEntityTags("task", task.id, [tag.id]);

    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("ALTER TABLE tasks RENAME TO tasks_hidden");
    await expect(
      deleteTaskWithOwnedState(ctx, task.id, { sessionDisposition: "archive" }),
    ).rejects.toThrow();
    db.exec("ALTER TABLE tasks_hidden RENAME TO tasks");
    db.exec("PRAGMA foreign_keys = ON");

    // Archiving commits with the cascade, so a surviving task never has its sessions archived.
    expect(ctx.tagStore!.getEntityTags("task", task.id).map((item) => item.id)).toEqual([tag.id]);
    expect(isArchived("session-a")).toBe(false);
    expect(ctx.taskStore.getTask(task.id)).toBeDefined();
  });

  it("unlinks sessions another task still owns instead of deleting them", async () => {
    const task = ctx.taskStore.createTask("Owner");
    const otherTask = ctx.taskStore.createTask("Co-owner");
    ctx.taskStore.linkSession(task.id, "exclusive-session");
    ctx.taskStore.linkSession(task.id, "second-exclusive");
    ctx.taskStore.linkSession(task.id, "shared-session");
    ctx.taskStore.linkSession(otherTask.id, "shared-session");
    const deleted: string[] = [];
    ctx.sessionManager.deleteSession = (async (id: string) => { deleted.push(id); }) as any;
    const invalidate = vi.spyOn(ctx.sessionManager, "invalidateSessionConfig");

    const res = await request(app)
      .delete(`/api/tasks/${task.id}?sessionDisposition=delete`)
      .expect(200);

    // A session shared with another task must not be deleted on behalf of only one owner.
    expect(deleted).toEqual(["exclusive-session", "second-exclusive"]);
    expect(res.body.deletedSessionIds).toEqual(deleted);
    expect(ctx.taskStore.getTask(task.id)).toBeUndefined();
    expect(res.body.unlinkedSharedSessionIds).toEqual(["shared-session"]);
    expect(ctx.taskStore.getTask(otherTask.id)!.sessionIds).toEqual(["shared-session"]);
    expect(invalidate.mock.calls).toEqual([["shared-session", "task deleted"]]);
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
    // Sessions are disposed before the task, so a failure leaves the task, not orphaned sessions.
    expect(ctx.taskStore.getTask(task.id)).toBeDefined();
    expect(ctx.taskStore.getTask(task.id)!.sessionIds).toEqual(["doomed-session"]);
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
    // The cascade would have silently dropped the new link, orphaning the session.
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

});
