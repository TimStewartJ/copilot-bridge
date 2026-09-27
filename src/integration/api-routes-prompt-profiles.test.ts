import { describe, expect, it, vi } from "vitest";
import { createTestApp, request, scheduler } from "../test-support/api-routes.js";

const sessionId = "11111111-1111-4111-8111-111111111111";

describe("prompt profile routes", () => {
  it("passes a valid launch profile to task session creation and rejects unknown ones", async () => {
    const { app, ctx } = createTestApp();
    const task = await request(app).post("/api/tasks").send({ title: "Profile host" });
    const createTaskSession = vi.spyOn(ctx.sessionManager, "createTaskSession");

    const created = await request(app).post(`/api/tasks/${task.body.task.id}/session`).send({ promptProfile: "monitor" });
    expect(created.status).toBe(200);
    expect(createTaskSession.mock.calls[0]?.[6]).toMatchObject({ promptProfile: "monitor" });

    const rejected = await request(app).post(`/api/tasks/${task.body.task.id}/session`).send({ promptProfile: "wizard" });
    expect(rejected.status).toBe(400);
    expect(rejected.body.error).toMatch(/promptProfile/);
    expect(createTaskSession).toHaveBeenCalledTimes(1);
  });

  it("passes a valid launch profile to taskless session creation", async () => {
    const { app, ctx } = createTestApp();
    const createSession = vi.spyOn(ctx.sessionManager, "createSession").mockResolvedValue({ sessionId });

    const res = await request(app).post("/api/sessions").send({ promptProfile: "assistant" });
    expect(res.status).toBe(200);
    expect(createSession).toHaveBeenCalledWith(expect.objectContaining({ promptProfile: "assistant" }));
  });

  it("reports each chat's profile with its model state", async () => {
    const { app, ctx } = createTestApp();
    vi.spyOn(ctx.sessionManager, "getSessionPromptProfile").mockReturnValue("assistant");

    const res = await request(app).get(`/api/sessions/${sessionId}/model`);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ source: "unknown", promptProfile: "assistant" });
  });

  it("changes a chat's profile, rejects unknown profiles, and maps busy sessions to 409", async () => {
    const { app, ctx } = createTestApp();
    const setSessionPromptProfile = vi.spyOn(ctx.sessionManager, "setSessionPromptProfile");

    const changed = await request(app).patch(`/api/sessions/${sessionId}/profile`).send({ promptProfile: "monitor" });
    expect(changed.status).toBe(200);
    expect(changed.body).toEqual({ promptProfile: "monitor" });
    expect(setSessionPromptProfile).toHaveBeenCalledWith(sessionId, "monitor");

    for (const body of [{}, { promptProfile: null }, { promptProfile: "auto" }]) {
      const invalid = await request(app).patch(`/api/sessions/${sessionId}/profile`).send(body);
      expect(invalid.status).toBe(400);
    }
    expect((await request(app).patch("/api/sessions/not-a-uuid/profile").send({ promptProfile: "engineer" })).status).toBe(400);

    setSessionPromptProfile.mockRejectedValueOnce(new Error("Cannot change the profile of a busy session"));
    const busy = await request(app).patch(`/api/sessions/${sessionId}/profile`).send({ promptProfile: "engineer" });
    expect(busy.status).toBe(409);

    setSessionPromptProfile.mockRejectedValueOnce(new Error("Session not found"));
    const missing = await request(app).patch(`/api/sessions/${sessionId}/profile`).send({ promptProfile: "engineer" });
    expect(missing.status).toBe(404);

    setSessionPromptProfile.mockRejectedValueOnce(new Error("This chat uses its own instructions, so profiles do not apply"));
    const helm = await request(app).patch(`/api/sessions/${sessionId}/profile`).send({ promptProfile: "engineer" });
    expect(helm.status).toBe(409);
  });

  it("stores, validates and clears a schedule's profile", async () => {
    const { app, ctx } = createTestApp();
    const task = await request(app).post("/api/tasks").send({ title: "Schedule host" });
    scheduler.initialize(ctx.sessionManager as any, {
      scheduleStore: ctx.scheduleStore,
      taskStore: ctx.taskStore,
      sessionMetaStore: ctx.sessionMetaStore,
      globalBus: ctx.globalBus,
    });
    const base = { taskId: task.body.task.id, name: "Watch", prompt: "Check it", type: "cron", cron: "0 8 * * *" };

    const invalid = await request(app).post("/api/schedules").send({ ...base, promptProfile: "auto" });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toMatch(/promptProfile/);

    const created = await request(app).post("/api/schedules").send({ ...base, promptProfile: "monitor" });
    expect(created.status).toBe(201);
    expect(ctx.scheduleStore.getSchedule(created.body.id)?.promptProfile).toBe("monitor");

    const cleared = await request(app).patch(`/api/schedules/${created.body.id}`).send({ promptProfile: null });
    expect(cleared.status).toBe(200);
    expect(ctx.scheduleStore.getSchedule(created.body.id)?.promptProfile).toBeUndefined();

    const rejected = await request(app).patch(`/api/schedules/${created.body.id}`).send({ promptProfile: "wizard" });
    expect(rejected.status).toBe(400);
    expect(ctx.scheduleStore.getSchedule(created.body.id)?.promptProfile).toBeUndefined();
  });

  it("accepts the default profile setting and rejects unknown values", async () => {
    const { app, ctx } = createTestApp();
    expect((await request(app).patch("/api/settings").send({ promptProfile: "assistant" })).status).toBe(200);
    expect(ctx.settingsStore.getSettings().promptProfile).toBe("assistant");
    expect((await request(app).patch("/api/settings").send({ promptProfile: "wizard" })).status).toBe(400);
    expect((await request(app).patch("/api/settings").send({ promptProfile: null })).status).toBe(200);
    expect(ctx.settingsStore.getSettings().promptProfile).toBeUndefined();
  });
});
