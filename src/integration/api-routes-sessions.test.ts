import { describe, expect, it, vi } from "vitest";
import {
  createMockSessionManager,
  createTestApp,
  installApiRouteTestHooks,
  request,
} from "../test-support/api-routes.js";
import { BRIDGE_RESTARTING_MESSAGE } from "../server/backend-availability.js";
import { SessionCapacityError } from "../server/session-manager.js";

installApiRouteTestHooks();

describe("Session routes (mocked)", () => {
  it("POST /api/sessions/external-use passes valid IDs to the session manager", async () => {
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const result = { status: "available" as const, inUse: [sessionId], checkedAt: "2026-08-26T20:00:00.000Z" };
    const sessionManager = createMockSessionManager();
    sessionManager.getExternalSessionUse = vi.fn(async () => result);
    const { app } = createTestApp({ sessionManager });

    const res = await request(app).post("/api/sessions/external-use").send({ sessionIds: [sessionId] });

    expect(res.status).toBe(200);
    expect(sessionManager.getExternalSessionUse).toHaveBeenCalledWith([sessionId]);
    expect(res.body).toEqual(result);
  });

  it("POST /api/sessions/external-use rejects invalid session IDs", async () => {
    const { app } = createTestApp();
    const res = await request(app)
      .post("/api/sessions/external-use")
      .send({ sessionIds: ["not-a-session-id"] });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/valid session IDs/);
  });

  it("GET /api/sessions keeps the warm cache when an untitled session becomes busy", async () => {
    const sessionManager = createMockSessionManager();
    let runState = "idle";
    sessionManager.getSessionRunState = vi.fn(() => runState);
    sessionManager.listSessionsFromDisk = vi.fn().mockResolvedValue([
      {
        sessionId: "untitled-session",
        modifiedTime: "2026-04-16T12:00:00.000Z",
        lastVisibleActivityAt: "2026-04-16T12:00:00.000Z",
      },
    ]);
    const { app, ctx } = createTestApp({ sessionManager });

    const idleRes = await request(app).get("/api/sessions");
    expect(idleRes.status).toBe(200);
    expect(idleRes.body.sessions).toEqual([]);

    runState = "busy";
    ctx.globalBus.emit({ type: "session:busy", sessionId: "untitled-session" });
    const busyRes = await request(app).get("/api/sessions");

    expect(busyRes.status).toBe(200);
    expect(busyRes.body.sessions).toEqual([
      expect.objectContaining({
        sessionId: "untitled-session",
        summary: "New session",
        runState: "busy",
      }),
    ]);
    expect(sessionManager.listSessionsFromDisk).toHaveBeenCalledTimes(1);
  });

  it("GET /api/sessions/:id/agents/:agentId returns one agent's brief and report in full", async () => {
    const sessionManager = createMockSessionManager();
    // Far more than the list carries of each agent, and well short of the bound on a single one.
    const report = "r".repeat(20_000);
    const prompt = "p".repeat(12_000);
    sessionManager.listSessionAgents = vi.fn(async () => ({
      tasks: [
        { id: "agent-docs", status: "idle" as const, executionMode: "background" as const, latestResponse: "Docs updated." },
        { id: "agent-moves", status: "running" as const, executionMode: "background" as const, name: "moves-agent", latestResponse: report, result: report, prompt },
      ],
      source: "live" as const,
      refreshedAt: "2026-04-16T12:00:00.000Z",
    }));
    sessionManager.getBackgroundAgentsSummary = vi.fn(() => ({ running: 1, idle: 1, failed: 0, total: 2, source: "live" as const }));
    const { app } = createTestApp({ sessionManager });

    const list = await request(app).get("/api/sessions/agents-host/agents").expect(200);
    expect(list.body).toMatchObject({ source: "live", backgroundAgents: { running: 1, source: "live" } });
    expect(list.body.tasks.map((task: { id: string }) => task.id)).toEqual(["agent-docs", "agent-moves"]);
    const selected = list.body.tasks[1];
    expect(selected.result.length).toBeLessThan(report.length);
    expect(selected.result).toContain("(truncated)");
    expect(selected.latestResponse.length).toBeLessThan(report.length);
    const res = await request(app).get(`/api/sessions/agents-host/agents/${selected.id}`);

    expect(res.status).toBe(200);
    expect(sessionManager.listSessionAgents).toHaveBeenCalledWith("agents-host");
    expect(res.body).toMatchObject({ source: "live", refreshedAt: "2026-04-16T12:00:00.000Z", task: { id: "agent-moves", name: "moves-agent" } });
    expect(res.body.task.latestResponse).toBe(report);
    expect(res.body.task.prompt).toBe(prompt);

    expect(res.body.task.result).toBe(report);
  });

  it("GET /api/sessions/:id/agents/:agentId says when the runtime no longer tracks the agent", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.listSessionAgents = vi.fn(async () => ({ tasks: [], source: "unknown" as const }));
    const { app } = createTestApp({ sessionManager });

    const res = await request(app).get("/api/sessions/agents-host/agents/agent-gone");

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/no longer tracked/);
  });

  it("POST /api/sessions/:id/agents/:agentId/cancel returns 409 when unavailable", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.cancelSessionAgent = vi.fn(async () => undefined);
    const { app } = createTestApp({ sessionManager });

    const res = await request(app).post("/api/sessions/s1/agents/explore-docs/cancel").send({});
    expect(res.status).toBe(409);
  });

  it("POST /api/sessions/:id/agents/:agentId/cancel delegates to the session manager", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.cancelSessionAgent = vi.fn(async () => ({ cancelled: true }));
    const { app } = createTestApp({ sessionManager });

    const res = await request(app).post("/api/sessions/s1/agents/explore-docs/cancel").send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ cancelled: true });
    expect(sessionManager.cancelSessionAgent).toHaveBeenCalledWith("s1", "explore-docs");
  });

  it("POST /api/sessions/:id/agents/:agentId/dismiss dismisses through the session manager", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.dismissSessionAgent = vi.fn(async () => ({ dismissed: true as const }));
    const { app } = createTestApp({ sessionManager });

    const res = await request(app).post("/api/sessions/s1/agents/explore-docs/dismiss").send({});
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ dismissed: true });
    expect(sessionManager.dismissSessionAgent).toHaveBeenCalledWith("s1", "explore-docs");
  });

  it("POST /api/sessions/:id/agents/:agentId/dismiss says why an agent was not dismissed", async () => {
    const cases = [
      ["unavailable", 409, /not loaded/],
      ["not-found", 404, /no longer tracked/],
      ["running", 409, /Stop it first/],
      ["refused", 409, /did not remove/],
    ] as const;
    let reason: (typeof cases)[number][0] = "unavailable";
    const sessionManager = createMockSessionManager();
    sessionManager.dismissSessionAgent = vi.fn(async () => ({ dismissed: false as const, reason }));
    const { app } = createTestApp({ sessionManager });

    for (const [refusal, status, message] of cases) {
      reason = refusal;
      const res = await request(app).post("/api/sessions/s1/agents/explore-docs/dismiss").send({});
      expect(res.status, reason).toBe(status);
      expect(res.body.reason).toBe(reason);
      expect(res.body.error).toMatch(message);
    }
  });

  it("GET /api/sessions includes unarchived sessions linked only to archived tasks", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.listSessionsFromDisk = vi.fn().mockResolvedValue([
      {
        sessionId: "archived-task-session",
        summary: "Archived task session",
        modifiedTime: "2026-04-16T12:00:00.000Z",
        lastVisibleActivityAt: "2026-04-16T12:00:00.000Z",
      },
      {
        sessionId: "unlinked-session",
        summary: "Unlinked session",
        modifiedTime: "2026-04-16T13:00:00.000Z",
        lastVisibleActivityAt: "2026-04-16T13:00:00.000Z",
      },
    ]);
    const { app, ctx } = createTestApp({ sessionManager });
    const archivedTask = ctx.taskStore.createTask("Archived parent task");
    ctx.taskStore.linkSession(archivedTask.id, "archived-task-session");
    ctx.taskStore.updateTask(archivedTask.id, { status: "archived" });

    const activeRes = await request(app).get("/api/sessions");
    const allRes = await request(app).get("/api/sessions?includeArchived=true");

    expect(activeRes.status).toBe(200);
    expect(activeRes.body.sessions.map((session: any) => session.sessionId)).toEqual([
      "unlinked-session",
      "archived-task-session",
    ]);
    expect(activeRes.body.sessions.find((session: any) => session.sessionId === "archived-task-session"))
      .toMatchObject({ linkedTaskIds: [archivedTask.id], archived: false });
    expect(allRes.status).toBe(200);
    expect(allRes.body.sessions.map((session: any) => session.sessionId)).toEqual([
      "unlinked-session",
      "archived-task-session",
    ]);
  });

  it("GET /api/tasks/:id/archived-sessions pages only that task's archived sessions, newest first", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.listSessionsFromDisk = vi.fn().mockResolvedValue([
      { sessionId: "active-linked", summary: "Active", modifiedTime: "2026-04-16T15:00:00.000Z" },
      { sessionId: "archived-old", summary: "Old", modifiedTime: "2026-04-16T10:00:00.000Z" },
      { sessionId: "archived-mid", summary: "Mid", modifiedTime: "2026-04-16T12:00:00.000Z" },
      { sessionId: "archived-new", summary: "New", modifiedTime: "2026-04-16T14:00:00.000Z" },
      { sessionId: "archived-elsewhere", summary: "Other task", modifiedTime: "2026-04-16T16:00:00.000Z" },
    ]);
    const { app, ctx } = createTestApp({ sessionManager });
    const task = ctx.taskStore.createTask("Busy task");
    const other = ctx.taskStore.createTask("Other task");
    for (const id of ["active-linked", "archived-old", "archived-mid", "archived-new"]) ctx.taskStore.linkSession(task.id, id);
    ctx.taskStore.linkSession(other.id, "archived-elsewhere");
    for (const id of ["archived-old", "archived-mid", "archived-new", "archived-elsewhere"]) {
      expect((await request(app).patch(`/api/sessions/${id}`).send({ archived: true })).status).toBe(200);
    }

    const first = await request(app).get(`/api/tasks/${task.id}/archived-sessions?limit=2`);
    expect(first.status).toBe(200);
    expect(first.body.total).toBe(3);
    expect(first.body.offset).toBe(0);
    expect(first.body.sessions.map((session: any) => session.sessionId)).toEqual(["archived-new", "archived-mid"]);
    expect(first.body.sessions.every((session: any) => session.archived === true)).toBe(true);

    const second = await request(app).get(`/api/tasks/${task.id}/archived-sessions?limit=2&offset=2`);
    expect(second.body.sessions.map((session: any) => session.sessionId)).toEqual(["archived-old"]);
    expect(second.body.total).toBe(3);

    expect((await request(app).get("/api/tasks/missing-task/archived-sessions")).status).toBe(404);
    expect((await request(app).get(`/api/tasks/${task.id}/archived-sessions?limit=0`)).status).toBe(400);
  });

  it("task routes send active session IDs and counts, never the full link list", async () => {
    const { app, ctx } = createTestApp();
    const task = ctx.taskStore.createTask("Scheduled task");
    ctx.taskStore.createTask("Empty task");
    for (const id of ["run-1", "run-2", "run-3"]) ctx.taskStore.linkSession(task.id, id);
    for (const id of ["run-1", "run-2"]) {
      expect((await request(app).patch(`/api/sessions/${id}`).send({ archived: true })).status).toBe(200);
    }

    const list = await request(app).get("/api/tasks");
    expect(list.status).toBe(200);
    const listed = list.body.tasks.find((candidate: any) => candidate.id === task.id);
    expect(listed).toMatchObject({ activeSessionIds: ["run-3"], sessionCount: 3, archivedSessionCount: 2 });
    expect(listed).not.toHaveProperty("sessionIds");
    expect(list.body.tasks.find((candidate: any) => candidate.title === "Empty task"))
      .toMatchObject({ activeSessionIds: [], sessionCount: 0, archivedSessionCount: 0 });

    const single = await request(app).get(`/api/tasks/${task.id}`);
    expect(single.body.task).toMatchObject({ activeSessionIds: ["run-3"], sessionCount: 3, sessionLinksRevision: listed.sessionLinksRevision });
    expect(single.body.task).not.toHaveProperty("sessionIds");

    // Swapping one link for another keeps the count but must change the revision.
    const invalidate = vi.spyOn(ctx.sessionManager, "invalidateSessionConfig");
    await request(app).delete(`/api/tasks/${task.id}/link`).send({ type: "session", sessionId: "run-1" }).expect(200);
    expect(invalidate).toHaveBeenLastCalledWith("run-1", "task link changed");
    const linked = await request(app).post(`/api/tasks/${task.id}/link`).send({ type: "session", sessionId: "run-4" });
    expect(linked.status).toBe(200);
    expect(invalidate).toHaveBeenLastCalledWith("run-4", "task link changed");
    expect(linked.body.task).toMatchObject({ activeSessionIds: ["run-3", "run-4"], sessionCount: 3, archivedSessionCount: 1 });
    expect(linked.body.task.sessionLinksRevision).not.toBe(listed.sessionLinksRevision);
    expect(linked.body.task).not.toHaveProperty("sessionIds");
  });

  it("GET /api/sessions orders attention and visible activity and reports each chat’s runtime status", async () => {
    const { app, ctx, db } = createTestApp();
    ctx.sessionManager.listSessionsFromDisk = vi.fn().mockResolvedValue([
      {
        sessionId: "attention-session",
        modifiedTime: "2026-04-16T12:00:00.000Z",
      },
      {
        sessionId: "visible-session",
        summary: "Visible session",
        modifiedTime: "2026-04-16T11:00:00.000Z",
        lastVisibleActivityAt: "2026-04-16T12:30:00.000Z",
      },
      { sessionId: "waiting", startTime: "2026-04-16T10:00:00.000Z" },
      { sessionId: "stalled", startTime: "2026-04-16T09:00:00.000Z" },
    ]);
    ctx.sessionManager.getSessionRunState = (id) => id === "stalled" ? "stalled" : id === "waiting" ? "busy" : "idle";
    ctx.sessionManager.isSessionBusy = (id) => id === "waiting" || id === "stalled";
    ctx.sessionManager.getPendingUserInputCount = (id) => id === "waiting" ? 1 : 0;
    ctx.sessionManager.getBackgroundAgentsSummary = (id) => id === "waiting"
      ? { running: 1, idle: 1, failed: 0, total: 2, source: "live" }
      : { running: 0, idle: 0, failed: 0, total: 0, source: "live" };
    ctx.sessionMetaStore.setLastAttentionAt("attention-session", "2026-04-16T13:00:00.000Z");
    db.prepare("INSERT INTO read_state (sessionId, lastReadAt) VALUES (?, ?)")
      .run("attention-session", "2026-04-16T12:59:00.000Z");

    const res = await request(app).get("/api/sessions");

    expect(res.status).toBe(200);
    expect(res.body.sessions).toMatchObject([
      {
        sessionId: "attention-session", runState: "idle", pendingUserInputCount: 0, needsUserInput: false,
        lastAttentionAt: "2026-04-16T13:00:00.000Z", lastActivityAt: "2026-04-16T13:00:00.000Z",
        modifiedTime: "2026-04-16T13:00:00.000Z", backgroundAgents: { total: 0 },
      },
      { sessionId: "visible-session", runState: "idle" },
      {
        sessionId: "waiting", runState: "busy", pendingUserInputCount: 1, needsUserInput: true,
        backgroundAgents: { running: 1, idle: 1, failed: 0, total: 2, source: "live" },
      },
      { sessionId: "stalled", runState: "stalled", pendingUserInputCount: 0, needsUserInput: false },
    ]);
  });

  it("POST /api/sessions reports saturated weighted capacity as retryable", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.createSession = vi.fn().mockRejectedValue(
      new SessionCapacityError("weighted-capacity", {
        contexts: 12,
        contextLimit: 16,
        localMcpInstances: 80,
        capacityUnits: 32,
        capacityLimit: 32,
      }),
    );
    const { app } = createTestApp({ sessionManager });

    const res = await request(app).post("/api/sessions");

    expect(res.status).toBe(429);
    expect(res.headers["retry-after"]).toBe("2");
    expect(res.body).toEqual({
      error: "Live Copilot capacity is full at 32/32 units across 12 contexts and 80 estimated local MCP slots. Wait for work to finish, or stop a running chat or agent, then try again.",
      code: "session_capacity",
      details: {
        reason: "weighted-capacity",
        retryAfterSeconds: 2,
        contexts: 12,
        contextLimit: 16,
        localMcpInstances: 80,
        capacityUnits: 32,
        capacityLimit: 32,
      },
    });
  });

  it("POST /api/sessions rejects unavailable and disabled models before creation", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.validateModelSelection = vi.fn(async ({ model }: { model: string }) => ({
      ok: false as const,
      error: model === "disabled-model"
        ? "Model is disabled by policy: disabled-model"
        : `Model is not available: ${model}`,
    }));
    sessionManager.createSession = vi.fn();
    sessionManager.createTaskSession = vi.fn();
    const { app, ctx } = createTestApp({ sessionManager });
    const task = ctx.taskStore.createTask("Invalid model task");

    const unavailable = await request(app)
      .post("/api/sessions")
      .send({ model: "missing-model" });
    const disabled = await request(app)
      .post("/api/sessions")
      .send({ model: "disabled-model" });
    const taskUnavailable = await request(app)
      .post(`/api/tasks/${task.id}/session`)
      .send({ model: "missing-model" });

    expect(unavailable.status).toBe(400);
    expect(unavailable.body.error).toContain("not available");
    expect(disabled.status).toBe(400);
    expect(disabled.body.error).toContain("disabled by policy");
    expect(taskUnavailable.status).toBe(400);
    expect(taskUnavailable.body.error).toContain("not available");
    expect(sessionManager.createSession).not.toHaveBeenCalled();
    expect(sessionManager.createTaskSession).not.toHaveBeenCalled();
  });

  it("POST /api/sessions validates effort and context against the configured default model", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.validateModelSelection = vi.fn().mockResolvedValue({ ok: true });
    sessionManager.createSession = vi.fn().mockResolvedValue({ sessionId: "new-session" });
    const { app, ctx } = createTestApp({ sessionManager });
    ctx.settingsStore.updateSettings({ model: "default-model" });

    const res = await request(app)
      .post("/api/sessions")
      .send({ reasoningEffort: "medium", contextTier: "long_context" });

    expect(res.status).toBe(200);
    expect(sessionManager.createSession).toHaveBeenCalledWith({
      background: true,
      reasoningEffort: "medium",
      contextTier: "long_context",
    });
    expect(sessionManager.validateModelSelection).toHaveBeenCalledWith({
      model: "default-model",
      reasoningEffort: "medium",
      contextTier: "long_context",
    });
  });

  it("POST /api/tasks/:id/tidy starts a linked chat with the tidy prompt and keeps it when the prompt isn't confirmed", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.createTaskSession = vi.fn()
      .mockResolvedValueOnce({ sessionId: "tidy-1" })
      .mockResolvedValueOnce({ sessionId: "tidy-2" });
    sessionManager.startWorkAndWaitForDelivery = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("offline"));
    const { app, ctx } = createTestApp({ sessionManager });
    const task = ctx.taskStore.createTask("Selling");

    const started = await request(app).post(`/api/tasks/${task.id}/tidy`);
    expect(started.status).toBe(200);
    expect(started.body).toEqual({ sessionId: "tidy-1" });
    expect(ctx.taskStore.getTask(task.id)?.sessionIds).toContain("tidy-1");
    expect(sessionManager.startWorkAndWaitForDelivery).toHaveBeenCalledWith("tidy-1", expect.stringContaining(`(taskId: ${task.id})`));

    const unconfirmed = await request(app).post(`/api/tasks/${task.id}/tidy`);
    expect(unconfirmed.status).toBe(200);
    expect(unconfirmed.body).toEqual({ sessionId: "tidy-2", error: expect.stringMatching(/wasn't confirmed/) });
    expect((await request(app).post("/api/tasks/missing/tidy")).status).toBe(404);
  });

  it("POST /api/chat requires sessionId and prompt", async () => {
    const { app } = createTestApp();
    const res = await request(app)
      .post("/api/chat")
      .send({});
    expect(res.status).toBe(400);
  });

  it("POST /api/chat records Tim's message for task states only once delivery is accepted", async () => {
    const { app, ctx } = createTestApp();
    const task = ctx.taskStore.createTask("Linked");
    ctx.taskStore.linkSession(task.id, "test-session");
    ctx.sessionManager.startWork = vi.fn(() => { throw new Error("offline"); });
    expect((await request(app).post("/api/chat").send({ sessionId: "test-session", prompt: "hello" })).status).not.toBe(202);
    expect(ctx.taskStore.listMomentumSignals().get(task.id)?.lastMessageAt).toBeUndefined();
    ctx.sessionManager.startWork = vi.fn();
    expect((await request(app).post("/api/chat").send({ sessionId: "test-session", prompt: "hello" })).status).toBe(202);
    expect(ctx.taskStore.listMomentumSignals().get(task.id)?.lastMessageAt).toEqual(expect.any(String));
  });

  it("POST /api/chat keeps a first message that was stopped before the agent got it", async () => {
    const { app, ctx } = createTestApp();
    ctx.sessionManager.startWorkAndWaitForDelivery = vi.fn().mockRejectedValue(
      new Error("Session was aborted before the prompt was accepted"),
    );

    const res = await request(app)
      .post("/api/chat")
      .send({ sessionId: "test-session", prompt: "hello", clientMessageId: "client-stopped", waitForDelivery: true });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: "accepted", mode: "stopped" });
  });

  it("resends a not-sent message once, from whichever device asks first", async () => {
    const { app, ctx } = createTestApp();
    const store = ctx.unsentMessageStore!;
    store.recordPending({ sessionId: "test-session", id: "client-old", content: "hello again" });
    store.markUndelivered("test-session", "client-old", "stopped");
    ctx.sessionManager.startWork = vi.fn();

    const first = await request(app)
      .post("/api/sessions/test-session/unsent-messages/client-old/resend")
      .send({ clientMessageId: "client-new" });
    const second = await request(app)
      .post("/api/sessions/test-session/unsent-messages/client-old/resend")
      .send({ clientMessageId: "client-newer" });

    expect(first.status).toBe(202);
    expect(second.status).toBe(409);
    expect(ctx.sessionManager.startWork).toHaveBeenCalledTimes(1);
    expect(ctx.sessionManager.startWork).toHaveBeenCalledWith("test-session", "hello again", undefined, {
      clientMessageId: "client-new",
      keepUndelivered: true,
    });
    expect(store.list("test-session")).toEqual([]);
    expect((await request(app).delete("/api/sessions/test-session/unsent-messages/client-old")).status).toBe(404);
  });

  it("POST /api/chat waits for first-prompt delivery when requested", async () => {
    const { app, ctx } = createTestApp();
    ctx.sessionManager.startWork = vi.fn();
    ctx.sessionManager.startWorkAndWaitForDelivery = vi.fn().mockResolvedValue(undefined);

    const res = await request(app)
      .post("/api/chat")
      .send({
        sessionId: "test-session",
        prompt: "hello",
        mode: "autopilot",
        waitForDelivery: true,
      });

    expect(res.status).toBe(202);
    expect(ctx.sessionManager.startWorkAndWaitForDelivery).toHaveBeenCalledWith(
      "test-session",
      "hello",
      undefined,
      { mode: "autopilot" },
    );
    expect(ctx.sessionManager.startWork).not.toHaveBeenCalled();
  });

  it("POST /api/chat rejects unsupported send modes", async () => {
    const { app, ctx } = createTestApp();
    ctx.sessionManager.startWork = vi.fn();

    const res = await request(app)
      .post("/api/chat")
      .send({ sessionId: "test-session", prompt: "hello", mode: "plan" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("mode must be one of");
    expect(ctx.sessionManager.startWork).not.toHaveBeenCalled();
  });

  it("POST /api/chat passes the client message id to busy-session steering", async () => {
    const { app, ctx } = createTestApp();
    ctx.sessionManager.isSessionBusy = vi.fn().mockReturnValue(true);
    ctx.sessionManager.steerSession = vi.fn().mockResolvedValue(undefined);
    const start = vi.spyOn(ctx.sessionManager, "startWork");

    const res = await request(app)
      .post("/api/chat")
      .send({
        sessionId: "busy-session",
        prompt: "adjust course",
        mode: "autopilot",
        clientMessageId: "client-message-2",
      });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: "accepted", mode: "steered" });
    expect(start).not.toHaveBeenCalled();
    expect(ctx.sessionManager.steerSession).toHaveBeenCalledWith(
      "busy-session",
      "adjust course",
      undefined,
      "client-message-2",
      { skipOpenQuestions: true },
    );
  });

  it("POST /api/chat routes busy slash commands through command steering", async () => {
    const { app, ctx } = createTestApp();
    ctx.sessionManager.isSessionBusy = vi.fn().mockReturnValue(true);
    ctx.sessionManager.startWork = vi.fn();
    ctx.sessionManager.steerSession = vi.fn().mockResolvedValue(undefined);

    const res = await request(app)
      .post("/api/chat")
      .send({ sessionId: "busy-session", prompt: "/goal finish the migration" });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: "accepted", mode: "command" });
    expect(ctx.sessionManager.steerSession).toHaveBeenCalledWith("busy-session", "/goal finish the migration", undefined);
    expect(ctx.sessionManager.startWork).not.toHaveBeenCalled();
  });

  it("POST /api/chat keeps a message a busy session cannot take yet and sends it later", async () => {
    const { app, ctx } = createTestApp();
    ctx.sessionManager.isSessionBusy = vi.fn().mockReturnValue(true);
    ctx.sessionManager.steerSession = vi.fn().mockRejectedValue(new Error("Session is still reconnecting; try again shortly"));
    const poke = vi.fn();
    ctx.deferredPromptRunner = { poke } as any;

    const send = () => request(app)
      .post("/api/chat")
      .send({ sessionId: "busy-session", prompt: "adjust course", clientMessageId: "client-1" });
    const res = await send();

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: "accepted", mode: "queued" });
    expect(ctx.deferredPromptStore?.get("chat-message:client-1")).toMatchObject({
      sessionId: "busy-session",
      prompt: "adjust course",
      purpose: "delivery",
      status: "pending",
    });
    expect(poke).toHaveBeenCalled();

    // A retry of the same message does not queue it twice.
    expect((await send()).status).toBe(202);
    expect(ctx.deferredPromptStore?.listDeliveriesForSession("busy-session")).toHaveLength(1);
  });

  it("POST /api/chat still rejects what it cannot keep for later", async () => {
    const { app, ctx } = createTestApp();
    ctx.sessionManager.isSessionBusy = vi.fn().mockReturnValue(true);
    ctx.sessionManager.steerSession = vi.fn().mockRejectedValue(new Error("Session is still reconnecting; try again shortly"));

    for (const body of [
      { prompt: "adjust course", mode: "autopilot" },
      { prompt: "adjust course", attachments: [{ type: "file", path: "D:/a.txt" }] },
      { prompt: "/goal finish" },
      { prompt: "adjust course", waitForDelivery: true },
    ]) {
      const res = await request(app).post("/api/chat").send({ sessionId: "busy-session", ...body });
      expect(res.status, JSON.stringify(body)).toBe(409);
    }
    expect(ctx.deferredPromptStore?.listDeliveriesForSession("busy-session")).toEqual([]);
  });

  it("POST /api/chat keeps a message sent while the backend reconnects", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.startWork = vi.fn(() => {
      throw new Error("Agent backend is reconnecting; try again shortly.");
    });
    const { app, ctx } = createTestApp({ sessionManager });

    const res = await request(app)
      .post("/api/chat")
      .send({ sessionId: "test-session", prompt: "hello" });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: "accepted", mode: "queued" });
    expect(ctx.deferredPromptStore?.listDeliveriesForSession("test-session")).toEqual([
      expect.objectContaining({ prompt: "hello", status: "pending" }),
    ]);
  });

  it("POST /api/chat rejects invalid client message ids", async () => {
    const { app, ctx } = createTestApp();
    ctx.sessionManager.startWork = vi.fn();

    const res = await request(app)
      .post("/api/chat")
      .send({ sessionId: "test-session", prompt: "hello", clientMessageId: " " });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("clientMessageId");
    expect(ctx.sessionManager.startWork).not.toHaveBeenCalled();
  });

  it("POST /api/chat keeps a message that reaches a stopping server for the next one", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.startWork = vi.fn(() => {
      throw new Error(BRIDGE_RESTARTING_MESSAGE);
    });
    const { app } = createTestApp({ sessionManager });

    const res = await request(app)
      .post("/api/chat")
      .send({ sessionId: "test-session", prompt: "hello" });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: "accepted", mode: "queued" });
  });

  it("POST /api/chat answers 503 once the server is stopping and the message cannot be kept", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.startWork = vi.fn(() => {
      throw new Error(BRIDGE_RESTARTING_MESSAGE);
    });
    const { app } = createTestApp({ sessionManager });

    const res = await request(app)
      .post("/api/chat")
      .send({ sessionId: "test-session", prompt: "hello", mode: "autopilot" });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe(BRIDGE_RESTARTING_MESSAGE);
  });
});
