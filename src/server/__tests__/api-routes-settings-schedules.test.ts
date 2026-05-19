import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiRouteTestState, DeferredPromptRunner } from "./api-routes-test-helpers.js";
import {
  createCopilotUsageTestHome,
  createMockSessionManager,
  createMockTranscriptionService,
  createRestartRuntimePaths,
  createTestApp,
  createWavBuffer,
  eventually,
  get,
  installApiRouteTestHooks,
  join,
  makeTestDir,
  mkdirSync,
  providers,
  publishOutboundAttachment,
  RESTART_PENDING_MESSAGE,
  request,
  scheduler,
  UserInputBrokerError,
  writeCopilotUsageEvents,
  writeRawCopilotUsageEvents,
  writeFileSync,
  writeRestartState,
} from "./api-routes-test-helpers.js";

let app: ApiRouteTestState["app"];
let ctx: ApiRouteTestState["ctx"];
let db: ApiRouteTestState["db"];

installApiRouteTestHooks((state) => {
  ({ app, ctx, db } = state);
});

describe("Settings routes", () => {
  it("GET /api/settings returns default settings", async () => {
    const res = await request(app).get("/api/settings");
    expect(res.status).toBe(200);
    expect(typeof res.body).toBe("object");
    expect(res.body).toHaveProperty("mcpServers");
  });

  it("PATCH /api/settings updates settings", async () => {
    const res = await request(app)
      .patch("/api/settings")
      .send({ mcpServers: { test: { command: "echo", args: [] } } });
    expect(res.status).toBe(200);
    expect(res.body.mcpServers).toHaveProperty("test");

    const get = await request(app).get("/api/settings");
    expect(get.body.mcpServers).toHaveProperty("test");
  });

  it("PATCH /api/settings stores remote MCP server configs", async () => {
    const remoteConfig = {
      type: "http",
      url: "https://mcp.linear.app/mcp",
      headers: { Authorization: "Bearer test-token" },
      tools: ["linear_search"],
    };

    const res = await request(app)
      .patch("/api/settings")
      .send({ mcpServers: { linear: remoteConfig } });

    expect(res.status).toBe(200);
    expect(res.body.mcpServers.linear).toEqual(remoteConfig);

    const get = await request(app).get("/api/settings");
    expect(get.body.mcpServers.linear).toEqual(remoteConfig);
  });

  it("PATCH /api/settings model change does NOT evict cached sessions", async () => {
    const sessionManager = createMockSessionManager();
    const evictSpy = vi.fn();
    sessionManager.evictAllCachedSessions = evictSpy;
    const local = createTestApp({ sessionManager });

    const res = await request(local.app)
      .patch("/api/settings")
      .send({ model: "claude-opus-4.7-1m-internal" });

    expect(res.status).toBe(200);
    // Model changes are future-only — no eviction, no setModel on cached sessions.
    expect(evictSpy).not.toHaveBeenCalled();
  });

  it("PATCH /api/settings reasoningEffort change does NOT evict cached sessions", async () => {
    const sessionManager = createMockSessionManager();
    const evictSpy = vi.fn();
    sessionManager.evictAllCachedSessions = evictSpy;
    const local = createTestApp({ sessionManager });

    await request(local.app).patch("/api/settings").send({ model: "claude-opus-4.7" });
    evictSpy.mockClear();

    const res = await request(local.app)
      .patch("/api/settings")
      .send({ reasoningEffort: "high" });

    expect(res.status).toBe(200);
    // Reasoning changes are future-only — existing sessions are not touched
    expect(evictSpy).not.toHaveBeenCalled();
  });

  it("PATCH /api/settings model cleared does NOT evict cached sessions", async () => {
    const sessionManager = createMockSessionManager();
    const evictSpy = vi.fn();
    sessionManager.evictAllCachedSessions = evictSpy;
    const local = createTestApp({ sessionManager });

    // First set a model, then clear it
    await request(local.app).patch("/api/settings").send({ model: "claude-opus-4.7" });
    evictSpy.mockClear();

    const res = await request(local.app).patch("/api/settings").send({ model: "" });

    expect(res.status).toBe(200);
    // Clearing model is future-only — no eviction
    expect(evictSpy).not.toHaveBeenCalled();
  });

  it("PATCH /api/settings MCP change still evicts cached sessions", async () => {
    const sessionManager = createMockSessionManager();
    const evictSpy = vi.fn();
    sessionManager.evictAllCachedSessions = evictSpy;
    const local = createTestApp({ sessionManager });

    const res = await request(local.app)
      .patch("/api/settings")
      .send({ mcpServers: { test: { command: "echo", args: [] } } });

    expect(res.status).toBe(200);
    expect(evictSpy).toHaveBeenCalledOnce();
  });
});

// ── Read State ───────────────────────────────────────────────────

describe("Read state routes", () => {
  it("GET /api/read-state returns empty state initially", async () => {
    const res = await request(app).get("/api/read-state");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({});
  });

  it("POST /api/read-state/:sessionId marks a session as read", async () => {
    const res = await request(app).post("/api/read-state/sess-1");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const state = await request(app).get("/api/read-state");
    expect(state.body).toHaveProperty("sess-1");
  });

  it("POST /api/read-state/:sessionId honors an explicit read-through cursor", async () => {
    const res = await request(app)
      .post("/api/read-state/sess-1")
      .send({ readThroughActivityAt: "2026-05-07T21:00:00.000Z" });

    expect(res.status).toBe(200);
    expect(res.body.lastReadAt).toBe("2026-05-07T21:00:00.000Z");

    const state = await request(app).get("/api/read-state");
    expect(state.body["sess-1"]).toBe("2026-05-07T21:00:00.000Z");
  });

  it("POST /api/read-state/:sessionId marks attention-only activity as read", async () => {
    ctx.sessionMetaStore.setLastAttentionAt("sess-1", "2026-05-07T21:03:00.000Z");

    const res = await request(app).post("/api/read-state/sess-1");

    expect(res.status).toBe(200);
    expect(res.body.lastReadAt).toBe("2026-05-07T21:03:00.000Z");
    expect(res.body.readThroughActivityAt).toBe("2026-05-07T21:03:00.000Z");
  });

  it("POST /api/read-state/:sessionId honors explicit cursors through server-known attention activity", async () => {
    ctx.sessionMetaStore.setLastVisibleActivityAt("sess-1", "2026-05-07T21:00:00.000Z");
    ctx.sessionMetaStore.setLastAttentionAt("sess-1", "2026-05-07T21:05:00.000Z");

    const res = await request(app)
      .post("/api/read-state/sess-1")
      .send({ readThroughActivityAt: "2026-05-07T21:05:00.000Z" });

    expect(res.status).toBe(200);
    expect(res.body.lastReadAt).toBe("2026-05-07T21:05:00.000Z");
    expect(res.body.readThroughActivityAt).toBe("2026-05-07T21:05:00.000Z");
  });

  it("POST /api/read-state/:sessionId clamps explicit cursors to server-known activity", async () => {
    ctx.sessionMetaStore.setLastVisibleActivityAt("sess-1", "2026-05-07T21:00:00.000Z");
    ctx.sessionMetaStore.setLastAttentionAt("sess-1", "2026-05-07T21:03:00.000Z");

    const res = await request(app)
      .post("/api/read-state/sess-1")
      .send({ readThroughActivityAt: "2026-05-07T21:05:00.000Z" });

    expect(res.status).toBe(200);
    expect(res.body.lastReadAt).toBe("2026-05-07T21:03:00.000Z");
    expect(res.body.readThroughActivityAt).toBe("2026-05-07T21:03:00.000Z");
  });

  it("POST /api/read-state/:sessionId rejects invalid read-through cursors", async () => {
    const res = await request(app)
      .post("/api/read-state/sess-1")
      .send({ readThroughActivityAt: "not-a-date" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("readThroughActivityAt");
  });

  it("DELETE /api/read-state/:sessionId marks a session as unread", async () => {
    await request(app).post("/api/read-state/sess-2");

    const del = await request(app).delete("/api/read-state/sess-2");
    expect(del.status).toBe(200);
    expect(del.body.ok).toBe(true);

    const state = await request(app).get("/api/read-state");
    expect(state.body["sess-2"]).toBeUndefined();
  });
});

// ── Schedule CRUD ────────────────────────────────────────────────

describe("Schedule routes", () => {
  let taskId: string;

  beforeEach(async () => {
    const task = await request(app)
      .post("/api/tasks")
      .send({ title: "Schedule Host" });
    taskId = task.body.task.id;
    scheduler.initialize(ctx.sessionManager as any, {
      scheduleStore: ctx.scheduleStore,
      taskStore: ctx.taskStore,
      sessionMetaStore: ctx.sessionMetaStore,
      globalBus: ctx.globalBus,
    });
  });

  it("GET /api/schedules requires a taskId query parameter", async () => {
    for (const path of [
      "/api/schedules",
      "/api/schedules?taskId=",
      "/api/schedules?taskId=one&taskId=two",
    ]) {
      const res = await request(app).get(path);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/taskId/);
    }
  });

  it("GET /api/schedules returns task-scoped schedules", async () => {
    const otherTask = await request(app)
      .post("/api/tasks")
      .send({ title: "Other Schedule Host" });
    const schedule = ctx.scheduleStore.createSchedule({
      taskId,
      name: "Task schedule",
      prompt: "Continue the conversation",
      type: "cron",
      cron: "0 0 * * *",
    });
    ctx.scheduleStore.createSchedule({
      taskId: otherTask.body.task.id,
      name: "Other task schedule",
      prompt: "Continue a different conversation",
      type: "cron",
      cron: "0 1 * * *",
    });

    const res = await request(app).get("/api/schedules").query({ taskId });
    expect(res.status).toBe(200);
    expect(res.body.map((item: { id: string }) => item.id)).toEqual([schedule.id]);

    const unknownTask = await request(app).get("/api/schedules").query({ taskId: "no-such-task" });
    expect(unknownTask.status).toBe(200);
    expect(unknownTask.body).toEqual([]);
  });

  it("POST /api/schedules validates required fields", async () => {
    const res = await request(app)
      .post("/api/schedules")
      .send({ name: "Missing fields" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/required/);
  });

  it("POST /api/schedules validates task exists", async () => {
    const res = await request(app)
      .post("/api/schedules")
      .send({ taskId: "no-such-task", name: "X", prompt: "Y", type: "cron", cron: "0 0 * * *" });
    expect(res.status).toBe(404);
  });

  it("POST /api/schedules requires cron for cron type", async () => {
    const res = await request(app)
      .post("/api/schedules")
      .send({ taskId, name: "X", prompt: "Y", type: "cron" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cron/);
  });

  it("POST /api/schedules creates a fresh-session schedule", async () => {
    const res = await request(app)
      .post("/api/schedules")
      .send({
        taskId,
        name: "Fresh schedule",
        prompt: "Continue the conversation",
        type: "cron",
        cron: "0 0 * * *",
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      taskId,
      name: "Fresh schedule",
      type: "cron",
    });
  });

  it("POST /api/schedules accepts supported cron field counts", async () => {
    for (const cron of ["*/5 * * * *", "0 */5 * * * *"]) {
      const res = await request(app)
        .post("/api/schedules")
        .send({
          taskId,
          name: `Supported ${cron}`,
          prompt: "Continue the conversation",
          type: "cron",
          cron,
          timezone: "UTC",
        });

      expect(res.status).toBe(201);
      expect(res.body.cron).toBe(cron);
    }
  });

  it("POST /api/schedules rejects unsupported non-zero seconds crons", async () => {
    const res = await request(app)
      .post("/api/schedules")
      .send({
        taskId,
        name: "Unsupported seconds",
        prompt: "Continue the conversation",
        type: "cron",
        cron: "30 */5 * * * *",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("seconds field is 0");
  });

  it("POST /api/schedules accepts autoArchiveKeep", async () => {
    const res = await request(app)
      .post("/api/schedules")
      .send({
        taskId,
        name: "Retained schedule",
        prompt: "Continue the conversation",
        type: "cron",
        cron: "0 0 * * *",
        autoArchiveKeep: 8,
      });

    expect(res.status).toBe(201);
    expect(res.body.autoArchiveKeep).toBe(8);
    expect(ctx.scheduleStore.getSchedule(res.body.id)?.autoArchiveKeep).toBe(8);
  });

  it("POST /api/schedules validates autoArchiveKeep", async () => {
    const res = await request(app)
      .post("/api/schedules")
      .send({
        taskId,
        name: "Bad retention",
        prompt: "Continue the conversation",
        type: "cron",
        cron: "0 0 * * *",
        autoArchiveKeep: 0,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/autoArchiveKeep/);
  });

  it("POST /api/schedules rejects unknown fields", async () => {
    const res = await request(app)
      .post("/api/schedules")
      .send({
        taskId,
        name: "Legacy reuse",
        prompt: "Continue the conversation",
        type: "cron",
        cron: "0 0 * * *",
        unexpectedField: true,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("unexpectedField");
  });

  it("PATCH /api/schedules rejects unknown fields", async () => {
    const schedule = ctx.scheduleStore.createSchedule({
      taskId,
      name: "Keep target",
      prompt: "Continue the conversation",
      type: "cron",
      cron: "0 0 * * *",
    });

    const res = await request(app)
      .patch(`/api/schedules/${schedule.id}`)
      .send({
        name: "Renamed",
        unexpectedField: false,
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("unexpectedField");
  });

  it("PATCH /api/schedules updates schedules", async () => {
    const schedule = ctx.scheduleStore.createSchedule({
      taskId,
      name: "Successful patch",
      prompt: "Continue the conversation",
      type: "cron",
      cron: "0 0 * * *",
    });

    const res = await request(app)
      .patch(`/api/schedules/${schedule.id}`)
      .send({ name: "Renamed schedule" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      id: schedule.id,
      name: "Renamed schedule",
    });
  });

  it("PATCH /api/schedules rejects unsupported non-zero seconds crons", async () => {
    const schedule = ctx.scheduleStore.createSchedule({
      taskId,
      name: "Reject cron patch",
      prompt: "Continue the conversation",
      type: "cron",
      cron: "0 0 * * *",
    });

    const res = await request(app)
      .patch(`/api/schedules/${schedule.id}`)
      .send({ cron: "30 */5 * * * *" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("seconds field is 0");
    expect(ctx.scheduleStore.getSchedule(schedule.id)?.cron).toBe("0 0 * * *");
  });

  it("PATCH /api/schedules allows unrelated edits to legacy unsupported crons", async () => {
    const schedule = ctx.scheduleStore.createSchedule({
      taskId,
      name: "Legacy unsupported cron",
      prompt: "Continue the conversation",
      type: "cron",
      cron: "30 */5 * * * *",
    });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const res = await request(app)
        .patch(`/api/schedules/${schedule.id}`)
        .send({ name: "Legacy renamed" });

      expect(res.status).toBe(200);
      expect(res.body).toMatchObject({
        id: schedule.id,
        name: "Legacy renamed",
        cron: "30 */5 * * * *",
      });
    } finally {
      consoleError.mockRestore();
    }
  });

  it("PATCH /api/schedules applies autoArchiveKeep retention immediately", async () => {
    const schedule = ctx.scheduleStore.createSchedule({
      taskId,
      name: "Apply retention",
      prompt: "Continue the conversation",
      type: "cron",
      cron: "0 0 * * *",
    });
    ctx.sessionMetaStore.recordScheduleRun(schedule.id, "new-session", "2026-01-02T00:00:00.000Z");
    ctx.sessionMetaStore.recordScheduleRun(schedule.id, "old-session", "2026-01-01T00:00:00.000Z");
    ctx.sessionManager.listSessionsFromDisk = async () => [
      { sessionId: "new-session", summary: "New run" } as any,
      { sessionId: "old-session", summary: "Old run" } as any,
    ];
    ctx.sessionManager.isSessionBusy = vi.fn().mockReturnValue(false);

    const res = await request(app)
      .patch(`/api/schedules/${schedule.id}`)
      .send({ autoArchiveKeep: 1 });

    expect(res.status).toBe(200);
    expect(res.body.autoArchiveKeep).toBe(1);
    expect(ctx.sessionMetaStore.isArchived("new-session")).toBe(false);
    expect(ctx.sessionMetaStore.isArchived("old-session")).toBe(true);
  });

  it("GET /api/schedules/:id/sessions returns sessions for a schedule", async () => {
    const schedule = ctx.scheduleStore.createSchedule({
      taskId, name: "Test Sched", prompt: "Do stuff", type: "cron", cron: "0 0 * * *",
    });

    ctx.sessionMetaStore.recordScheduleRun(schedule.id, "sess-1");
    ctx.sessionMetaStore.recordScheduleRun(schedule.id, "sess-2");
    ctx.taskStore.linkSession(taskId, "sess-1");

    const res = await request(app).get(`/api/schedules/${schedule.id}/sessions`);
    expect(res.status).toBe(200);
    expect(res.body.sessions).toHaveLength(2);
    expect(res.body.total).toBe(2);
    expect(res.body.sessions[0]).toMatchObject({
      sessionId: expect.any(String),
      runId: expect.any(Number),
      recordedAt: expect.any(String),
      missing: true,
    });
    expect(res.body.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sessionId: "sess-1",
        linkedTaskIds: [taskId],
      }),
    ]));
    expect(res.body).toHaveProperty("offset", 0);
    expect(res.body).toHaveProperty("limit");
  });

  it("GET /api/schedules/:id/sessions returns 404 for unknown schedule", async () => {
    const res = await request(app).get("/api/schedules/no-such-id/sessions");
    expect(res.status).toBe(404);
  });

  it("GET /api/schedules/:id/sessions respects limit and offset params", async () => {
    const schedule = ctx.scheduleStore.createSchedule({
      taskId, name: "Paged", prompt: "Do stuff", type: "cron", cron: "0 0 * * *",
    });

    ctx.sessionMetaStore.recordScheduleRun(schedule.id, "s1");
    ctx.sessionMetaStore.recordScheduleRun(schedule.id, "s2");
    ctx.sessionMetaStore.recordScheduleRun(schedule.id, "s3");

    const res = await request(app).get(`/api/schedules/${schedule.id}/sessions?limit=2&offset=1`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(3);
    expect(res.body.offset).toBe(1);
    expect(res.body.limit).toBe(2);
    expect(res.body.sessions).toHaveLength(2);
  });

  it("GET /api/schedules/:id/sessions keeps repeated runs of the same target session", async () => {
    const schedule = ctx.scheduleStore.createSchedule({
      taskId, name: "Repeated target", prompt: "Do stuff", type: "cron", cron: "0 0 * * *",
    });
    ctx.sessionManager.listSessionsFromDisk = async () => [
      { sessionId: "shared-session", summary: "Shared session" } as any,
    ];

    ctx.sessionMetaStore.recordScheduleRun(schedule.id, "shared-session");
    ctx.sessionMetaStore.recordScheduleRun(schedule.id, "shared-session");

    const res = await request(app).get(`/api/schedules/${schedule.id}/sessions`);
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(2);
    expect(res.body.sessions).toHaveLength(2);
    expect(res.body.sessions[0].sessionId).toBe("shared-session");
    expect(res.body.sessions[1].sessionId).toBe("shared-session");
    expect(res.body.sessions[0].runId).not.toBe(res.body.sessions[1].runId);
    expect(res.body.sessions[0].recordedAt).toEqual(expect.any(String));
    expect(res.body.sessions[1].recordedAt).toEqual(expect.any(String));
  });

  it("GET /api/schedules/:id/sessions includes runState while keeping busy compatibility", async () => {
    const schedule = ctx.scheduleStore.createSchedule({
      taskId, name: "Run states", prompt: "Do stuff", type: "cron", cron: "0 0 * * *",
    });
    ctx.sessionManager.listSessionsFromDisk = async () => [
      { sessionId: "shared-session", summary: "Shared session" } as any,
    ];
    ctx.sessionManager.getSessionRunState = vi.fn().mockReturnValue("stalled");
    ctx.sessionManager.isSessionBusy = vi.fn().mockReturnValue(true);
    ctx.sessionMetaStore.recordScheduleRun(schedule.id, "shared-session");

    const res = await request(app).get(`/api/schedules/${schedule.id}/sessions`);

    expect(res.status).toBe(200);
    expect(res.body.sessions[0]).toMatchObject({
      sessionId: "shared-session",
      runState: "stalled",
      busy: true,
    });
  });
});
