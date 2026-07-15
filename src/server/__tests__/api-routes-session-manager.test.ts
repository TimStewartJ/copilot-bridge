import { describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { ApiRouteTestState } from "./api-routes-test-helpers.js";
import {
  createMockSessionManager,
  createTestApp,
  installApiRouteTestHooks,
  join,
  makeTestDir,
  mkdirSync,
  request,
} from "./api-routes-test-helpers.js";
import { SessionCapacityError, SessionHistoryUndoError } from "../session-manager.js";

let app: ApiRouteTestState["app"];
let ctx: ApiRouteTestState["ctx"];

installApiRouteTestHooks((state) => {
  ({ app, ctx } = state);
});

// ── Session manager routes (mock-based) ──────────────────────────

describe("Session manager routes", () => {
  it("GET /api/sessions/:id/messages-fast returns paginated messages", async () => {
    const res = await request(app).get("/api/sessions/test-id/messages-fast");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("messages");
    expect(res.body).toHaveProperty("total");
    expect(res.body).toHaveProperty("hasMore");
    expect(res.body).toHaveProperty("runState");
    expect(res.body).toHaveProperty("busy");
    expect(res.body).toHaveProperty("warm");
  });

  it("GET /api/sessions/:id/messages-fast returns runState for stalled sessions", async () => {
    ctx.sessionManager.getSessionRunState = vi.fn().mockReturnValue("stalled");
    ctx.sessionManager.isSessionBusy = vi.fn().mockReturnValue(true);

    const res = await request(app).get("/api/sessions/test-id/messages-fast");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ runState: "stalled", busy: true });
  });

  it("GET /api/sessions/:id/messages-fast includes visible activity metadata", async () => {
    ctx.sessionManager.readMessagesFromDisk = vi.fn().mockResolvedValue({
      messages: [],
      total: 0,
      hasMore: false,
      lastVisibleActivityAt: "2026-04-29T12:05:00.000Z",
    });

    const res = await request(app).get("/api/sessions/test-id/messages-fast");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      lastVisibleActivityAt: "2026-04-29T12:05:00.000Z",
      warm: false,
    });
  });

  it("POST /api/sessions/:id/fork passes safe event boundaries to the session manager", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.forkSession = vi.fn().mockResolvedValue({ sessionId: "bounded-fork" });
    sessionManager.warmSession = vi.fn().mockResolvedValue(undefined);
    sessionManager.setSessionName = vi.fn().mockResolvedValue(undefined);
    sessionManager.listSessionsFromDisk = vi.fn().mockResolvedValue([
      {
        sessionId: "test-id",
        summary: "Original session",
        modifiedTime: "2026-04-16T12:00:00.000Z",
        lastVisibleActivityAt: "2026-04-16T12:00:00.000Z",
      },
    ]);
    ({ app, ctx } = createTestApp({ sessionManager }));

    const res = await request(app)
      .post("/api/sessions/test-id/fork")
      .send({ toEventId: "next-event" });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sessionId: "bounded-fork" });
    expect(sessionManager.forkSession).toHaveBeenCalledWith("test-id", { toEventId: "next-event" });
    expect(sessionManager.warmSession).toHaveBeenCalledWith("bounded-fork");
    expect(sessionManager.setSessionName).toHaveBeenCalledWith("bounded-fork", "Fork from Original session");
    expect(sessionManager.warmSession.mock.invocationCallOrder[0]).toBeLessThan(
      sessionManager.setSessionName.mock.invocationCallOrder[0],
    );
  });

  it("POST /api/sessions/:id/fork rejects empty event boundaries", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.forkSession = vi.fn();
    ({ app, ctx } = createTestApp({ sessionManager }));

    const res = await request(app)
      .post("/api/sessions/test-id/fork")
      .send({ toEventId: "   " });

    expect(res.status).toBe(400);
    expect(sessionManager.forkSession).not.toHaveBeenCalled();
  });

  it("POST /api/sessions/:id/fork reports unforkable sessions as a client error", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.forkSession = vi.fn().mockRejectedValue(new Error("Session test-id not found or has no persisted events"));
    ({ app, ctx } = createTestApp({ sessionManager }));

    const res = await request(app).post("/api/sessions/test-id/fork");

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("persisted conversation history");
  });

  it("POST /api/sessions/:id/fork seeds the forked title from the CLI source summary", async () => {
    const copilotHome = join(makeTestDir("api-fork-cli-catalog"), ".copilot");
    mkdirSync(copilotHome, { recursive: true });
    const cliDb = new DatabaseSync(join(copilotHome, "session-store.db"));
    try {
      cliDb.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          cwd TEXT,
          summary TEXT,
          created_at TEXT,
          updated_at TEXT
        );
      `);
      cliDb.prepare(`
        INSERT INTO sessions (id, cwd, summary, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run("test-id", "/work", "Original session", "2026-04-16T12:00:00.000Z", "2026-04-16T12:00:00.000Z");
    } finally {
      cliDb.close();
    }
    const sessionManager = createMockSessionManager();
    sessionManager.warmSession = vi.fn().mockResolvedValue(undefined);
    sessionManager.setSessionName = vi.fn().mockResolvedValue(undefined);
    sessionManager.listSessionsFromDisk = vi.fn(async () => {
      throw new Error("source title should come from CLI catalog");
    });
    ({ app, ctx } = createTestApp({ copilotHome, sessionManager }));

    const res = await request(app).post("/api/sessions/test-id/fork");

    expect(res.status).toBe(200);
    expect(sessionManager.warmSession).toHaveBeenCalledWith("fork-session");
    expect(sessionManager.setSessionName).toHaveBeenCalledWith("fork-session", "Fork of Original session");
    expect(sessionManager.listSessionsFromDisk).not.toHaveBeenCalled();
  });

  it("POST /api/sessions/:id/fork still succeeds when fork title seeding fails", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.warmSession = vi.fn().mockResolvedValue(undefined);
    sessionManager.setSessionName = vi.fn().mockRejectedValue(new Error("Session not found: fork-session"));
    sessionManager.listSessionsFromDisk = vi.fn().mockResolvedValue([
      {
        sessionId: "test-id",
        summary: "Original session",
        modifiedTime: "2026-04-16T12:00:00.000Z",
        lastVisibleActivityAt: "2026-04-16T12:00:00.000Z",
      },
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      ({ app, ctx } = createTestApp({ sessionManager }));
      const task = ctx.taskStore.createTask("Linked task");
      ctx.taskStore.linkSession(task.id, "test-id");
      const events: any[] = [];
      const unsubscribe = ctx.globalBus.subscribe((event) => events.push(event));

      try {
        const res = await request(app).post("/api/sessions/test-id/fork");

        expect(res.status).toBe(200);
        expect(res.body).toEqual({ sessionId: "fork-session" });
        expect(sessionManager.warmSession).toHaveBeenCalledWith("fork-session");
        expect(ctx.taskStore.getTask(task.id)?.sessionIds).toContain("fork-session");
        expect(events).toEqual(expect.arrayContaining([
          expect.objectContaining({ type: "sessions:changed", sessionId: "fork-session" }),
        ]));
        expect(warn).toHaveBeenCalledWith(
          "[sessions] Fork fork-ses created but could not be renamed:",
          "Session not found: fork-session",
        );
      } finally {
        unsubscribe();
      }
    } finally {
      warn.mockRestore();
    }
  });

  it("POST /api/sessions/:id/fork returns the created fork when immediate warm fails", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.warmSession = vi.fn().mockRejectedValue(new Error("warm failed"));
    sessionManager.setSessionName = vi.fn().mockResolvedValue(undefined);
    sessionManager.listSessionsFromDisk = vi.fn().mockResolvedValue([
      {
        sessionId: "test-id",
        summary: "Original session",
        modifiedTime: "2026-04-16T12:00:00.000Z",
        lastVisibleActivityAt: "2026-04-16T12:00:00.000Z",
      },
    ]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      ({ app, ctx } = createTestApp({ sessionManager }));
      const task = ctx.taskStore.createTask("Linked task");
      ctx.taskStore.linkSession(task.id, "test-id");

      const res = await request(app).post("/api/sessions/test-id/fork");

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ sessionId: "fork-session" });
      expect(ctx.taskStore.getTask(task.id)?.sessionIds).toContain("fork-session");
      expect(sessionManager.warmSession).toHaveBeenCalledWith("fork-session");
      expect(sessionManager.setSessionName).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        "[sessions] Fork fork-ses created but could not be warmed:",
        "warm failed",
      );
      expect(warn).toHaveBeenCalledWith(
        "[sessions] Fork fork-ses rename skipped because warm resume failed",
      );
    } finally {
      warn.mockRestore();
    }
  });

  it("POST /api/sessions/:id/undo passes a validated turn boundary to the session manager", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.undoSessionTurn = vi.fn().mockResolvedValue({
      eventsRemoved: 4,
      lastVisibleActivityAt: "2026-04-16T12:00:00.000Z",
    });
    ({ app, ctx } = createTestApp({ sessionManager }));

    const res = await request(app)
      .post("/api/sessions/test-id/undo")
      .send({ eventId: " user-event-2 " });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      eventsRemoved: 4,
      lastVisibleActivityAt: "2026-04-16T12:00:00.000Z",
    });
    expect(sessionManager.undoSessionTurn).toHaveBeenCalledWith("test-id", "user-event-2");
  });

  it("POST /api/sessions/:id/undo rejects empty and stale boundaries", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.undoSessionTurn = vi.fn().mockRejectedValue(
      new SessionHistoryUndoError("stale-boundary", "This turn is no longer available to undo."),
    );
    ({ app, ctx } = createTestApp({ sessionManager }));

    const empty = await request(app)
      .post("/api/sessions/test-id/undo")
      .send({ eventId: "   " });
    expect(empty.status).toBe(400);
    expect(sessionManager.undoSessionTurn).not.toHaveBeenCalled();

    const stale = await request(app)
      .post("/api/sessions/test-id/undo")
      .send({ eventId: "user-event-2" });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toContain("no longer available");
    expect(stale.body.code).toBe("stale-boundary");
  });

  it("POST /api/sessions/:id/undo reports unsupported backends clearly", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.undoSessionTurn = vi.fn().mockRejectedValue(
      new SessionHistoryUndoError("unsupported", "Session history undo is not available in this agent backend"),
    );
    ({ app, ctx } = createTestApp({ sessionManager }));

    const res = await request(app)
      .post("/api/sessions/test-id/undo")
      .send({ eventId: "user-event-2" });

    expect(res.status).toBe(501);
    expect(res.body.code).toBe("unsupported");
  });

  it("POST /api/sessions/:id/fork preserves all task links from the source session", async () => {
    const sessionManager = createMockSessionManager();
    ({ app, ctx } = createTestApp({ sessionManager }));
    const taskA = ctx.taskStore.createTask("Task A");
    ctx.taskStore.linkSession(taskA.id, "test-id");
    const taskB = ctx.taskStore.createTask("Task B");
    ctx.taskStore.linkSession(taskB.id, "test-id");
    sessionManager.warmSession = vi.fn().mockImplementation(async (sessionId: string) => {
      expect(ctx.taskStore.getTask(taskA.id)?.sessionIds).toContain(sessionId);
      expect(ctx.taskStore.getTask(taskB.id)?.sessionIds).toContain(sessionId);
    });

    const res = await request(app).post("/api/sessions/test-id/fork");

    expect(res.status).toBe(200);
    expect(ctx.taskStore.getTask(taskA.id)?.sessionIds).toContain("fork-session");
    expect(ctx.taskStore.getTask(taskB.id)?.sessionIds).toContain("fork-session");
  });

  it("POST /api/sessions/:id/reload reloads a session", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.reloadSession = vi.fn().mockResolvedValue([
      { name: "demo", status: "connected", source: "settings" },
    ]);
    ({ app, ctx } = createTestApp({ sessionManager }));

    const res = await request(app).post("/api/sessions/test-id/reload");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ready: true,
      servers: [{ name: "demo", status: "connected", source: "settings" }],
    });
    expect(sessionManager.reloadSession).toHaveBeenCalledWith("test-id");
  });

  it("POST /api/sessions/:id/reload rejects busy sessions", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.isSessionBusy = vi.fn().mockReturnValue(true);
    ({ app, ctx } = createTestApp({ sessionManager }));

    const res = await request(app).post("/api/sessions/test-id/reload");

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Cannot reload a busy session");
  });

  it("POST /api/sessions/:id/reload maps late busy errors to 409", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.reloadSession = vi.fn().mockRejectedValue(new Error("Cannot reload a busy session"));
    ({ app, ctx } = createTestApp({ sessionManager }));

    const res = await request(app).post("/api/sessions/test-id/reload");

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Cannot reload a busy session");
  });

  it("POST /api/sessions/:id/abort aborts a session", async () => {
    const res = await request(app).post("/api/sessions/test-id/abort");
    expect(res.status).toBe(200);
  });

  it("GET /api/sessions/:id/mcp-status returns MCP status", async () => {
    const res = await request(app).get("/api/sessions/test-id/mcp-status");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("servers");
  });
  it("POST /api/sessions/:id/mcp-login starts MCP OAuth for a session server", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.loginMcpServer = vi.fn().mockResolvedValue({
      serverName: "ado",
      authorizationUrl: "https://login.example.test",
      servers: [{ name: "ado", status: "needs-auth" }],
    });
    ({ app, ctx } = createTestApp({ sessionManager }));

    const res = await request(app)
      .post("/api/sessions/test-id/mcp-login")
      .send({ serverName: "ado", forceReauth: true });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      serverName: "ado",
      authorizationUrl: "https://login.example.test",
      servers: [{ name: "ado", status: "needs-auth" }],
    });
    expect(sessionManager.loginMcpServer).toHaveBeenCalledWith("test-id", "ado", { forceReauth: true });
  });

  it("POST /api/sessions/:id/mcp-login validates the request body", async () => {
    const res = await request(app)
      .post("/api/sessions/test-id/mcp-login")
      .send({ forceReauth: true });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("serverName is required");
  });

  it("POST /api/sessions/:id/mcp-login maps busy sessions to 409", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.loginMcpServer = vi.fn().mockRejectedValue(new Error("Cannot authenticate MCP server for a busy session"));
    ({ app, ctx } = createTestApp({ sessionManager }));

    const res = await request(app)
      .post("/api/sessions/test-id/mcp-login")
      .send({ serverName: "ado" });

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("Cannot authenticate MCP server for a busy session");
  });


  it("GET /api/mcp-status returns global MCP status", async () => {
    const res = await request(app).get("/api/mcp-status");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("servers");
  });

  it("POST /api/tasks/:id/session creates a task-linked session", async () => {
    const task = (await request(app).post("/api/tasks").send({ title: "Session Task" })).body.task;

    const res = await request(app)
      .post(`/api/tasks/${task.id}/session`)
      .send({ prompt: "Hello" });
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("sessionId");
  });

  it("POST /api/tasks/:id/session leaves the task unchanged when capacity stays full", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.createTaskSession = vi.fn().mockRejectedValue(
      new SessionCapacityError("context-limit", {
        contexts: 17,
        contextLimit: 16,
        localMcpInstances: 40,
        capacityUnits: 27,
        capacityLimit: 64,
      }),
    );
    ({ app, ctx } = createTestApp({ sessionManager }));
    const task = (await request(app).post("/api/tasks").send({ title: "Queued task" })).body.task;

    const res = await request(app).post(`/api/tasks/${task.id}/session`);

    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({
      code: "session_capacity",
      details: {
        reason: "context-limit",
        contexts: 17,
        contextLimit: 16,
      },
    });
    expect(ctx.taskStore.getTask(task.id)?.sessionIds).toEqual([]);
  });
});
