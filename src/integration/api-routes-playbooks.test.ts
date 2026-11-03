import { describe, expect, it, vi } from "vitest";
import { createTestApp, request, scheduler } from "../test-support/api-routes.js";

const sessionId = "11111111-1111-4111-8111-111111111111";

describe("playbook routes", () => {
  it("passes a launch playbook to task and taskless session creation and rejects malformed names", async () => {
    const { app, ctx } = createTestApp();
    const task = await request(app).post("/api/tasks").send({ title: "Playbook host" });
    const createTaskSession = vi.spyOn(ctx.sessionManager, "createTaskSession");

    const created = await request(app).post(`/api/tasks/${task.body.task.id}/session`).send({ playbook: "watch" });
    expect(created.status).toBe(200);
    expect(createTaskSession.mock.calls[0]?.[6]).toMatchObject({ playbook: "watch" });

    const rejected = await request(app).post(`/api/tasks/${task.body.task.id}/session`).send({ playbook: "../escape" });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toMatch(/playbook/);
    expect(createTaskSession).toHaveBeenCalledTimes(1);

    const createSession = vi.spyOn(ctx.sessionManager, "createSession").mockResolvedValue({ sessionId });
    expect((await request(app).post("/api/sessions").send({ playbook: "none" })).status).toBe(200);
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ playbook: "none" }));
  });

  it("reports and changes a chat's playbook, mapping errors to status codes", async () => {
    const { app, ctx } = createTestApp();
    vi.spyOn(ctx.sessionManager, "getSessionPlaybook").mockReturnValue({ playbook: "research", source: "agent", label: "Research" });
    const model = await request(app).get(`/api/sessions/${sessionId}/model`);
    expect(model.body).toMatchObject({ playbook: { playbook: "research", source: "agent" } });

    const setSessionPlaybook = vi.spyOn(ctx.sessionManager, "setSessionPlaybook")
      .mockResolvedValue({ playbook: "bug-fix", source: "user", label: "Bug fix" });
    const changed = await request(app).put(`/api/sessions/${sessionId}/playbook`).send({ playbook: "bug-fix" });
    expect(changed.status).toBe(200);
    expect(changed.body.playbook).toMatchObject({ playbook: "bug-fix", source: "user" });
    expect(setSessionPlaybook).toHaveBeenCalledWith(sessionId, "bug-fix", "user");

    await request(app).put(`/api/sessions/${sessionId}/playbook`).send({ playbook: null }).expect(200);
    expect(setSessionPlaybook).toHaveBeenLastCalledWith(sessionId, null, "user");
    expect((await request(app).put(`/api/sessions/${sessionId}/playbook`).send({})).status).toBe(400);
    expect((await request(app).put("/api/sessions/not-a-uuid/playbook").send({ playbook: "none" })).status).toBe(400);

    setSessionPlaybook.mockRejectedValueOnce(new Error('Playbook "x" is not installed'));
    expect((await request(app).put(`/api/sessions/${sessionId}/playbook`).send({ playbook: "x" })).status).toBe(409);
    setSessionPlaybook.mockRejectedValueOnce(new Error("Session not found"));
    expect((await request(app).put(`/api/sessions/${sessionId}/playbook`).send({ playbook: "none" })).status).toBe(404);
  });

  it("stores, validates and clears a schedule's and a task's playbook", async () => {
    const { app, ctx } = createTestApp();
    const task = await request(app).post("/api/tasks").send({ title: "Schedule host" });
    scheduler.initialize(ctx.sessionManager as any, {
      scheduleStore: ctx.scheduleStore,
      taskStore: ctx.taskStore,
      sessionMetaStore: ctx.sessionMetaStore,
      globalBus: ctx.globalBus,
    });
    const base = { taskId: task.body.task.id, name: "Watch", prompt: "Check it", type: "cron", cron: "0 8 * * *" };

    expect((await request(app).post("/api/schedules").send({ ...base, playbook: "a b" })).status).toBe(400);
    const created = await request(app).post("/api/schedules").send({ ...base, playbook: "watch" });
    expect(created.status).toBe(201);
    expect(ctx.scheduleStore.getSchedule(created.body.id)?.playbook).toBe("watch");
    await request(app).patch(`/api/schedules/${created.body.id}`).send({ playbook: null }).expect(200);
    expect(ctx.scheduleStore.getSchedule(created.body.id)?.playbook).toBeUndefined();

    await request(app).patch(`/api/tasks/${task.body.task.id}`).send({ playbook: "research" }).expect(200);
    expect(ctx.taskStore.getTask(task.body.task.id)?.playbook).toBe("research");
    await request(app).patch(`/api/tasks/${task.body.task.id}`).send({ playbook: null }).expect(200);
    expect(ctx.taskStore.getTask(task.body.task.id)?.playbook).toBeUndefined();
  });

  it("drops the retired default profile setting", async () => {
    const { app, ctx } = createTestApp();
    expect((await request(app).patch("/api/settings").send({ promptProfile: "assistant" })).status).toBe(200);
    expect(ctx.settingsStore.getSettings()).not.toHaveProperty("promptProfile");
  });
});
