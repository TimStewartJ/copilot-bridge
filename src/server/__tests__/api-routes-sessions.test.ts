import { describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
import type { ApiRouteTestState } from "./api-routes-test-helpers.js";
import {
  createMockSessionManager,
  createRestartRuntimePaths,
  createTestApp,
  installApiRouteTestHooks,
  join,
  makeTestDir,
  mkdirSync,
  RESTART_PENDING_MESSAGE,
  request,
  writeFileSync,
  writeRestartState,
} from "./api-routes-test-helpers.js";

let app: ApiRouteTestState["app"];
let ctx: ApiRouteTestState["ctx"];
let db: ApiRouteTestState["db"];

installApiRouteTestHooks((state) => {
  ({ app, ctx, db } = state);
});

describe("Session routes (mocked)", () => {
  it("GET /api/sessions returns wrapped response", async () => {
    const res = await request(app).get("/api/sessions");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("sessions");
  });

  it("GET /api/sessions restores event-log sizes for visible CLI catalog sessions", async () => {
    const copilotHome = join(makeTestDir("api-cli-catalog"), ".copilot");
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
      `).run("cli-sized-session", "D:\\work", "Sized session", "2026-04-16T12:00:00.000Z", "2026-04-16T12:00:00.000Z");
      cliDb.prepare(`
        INSERT INTO sessions (id, cwd, summary, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run("cli-missing-events", "D:\\work", "Missing events", "2026-04-16T11:00:00.000Z", "2026-04-16T11:00:00.000Z");
    } finally {
      cliDb.close();
    }
    const events = "{\"type\":\"message\",\"text\":\"hello\"}\n{\"type\":\"done\"}\n";
    mkdirSync(join(copilotHome, "session-state", "cli-sized-session"), { recursive: true });
    writeFileSync(join(copilotHome, "session-state", "cli-sized-session", "events.jsonl"), events);
    const sessionManager = createMockSessionManager();
    sessionManager.listSessionsFromDisk = vi.fn(async () => {
      throw new Error("should use CLI catalog");
    });
    ({ app, ctx } = createTestApp({ copilotHome, sessionManager }));

    const res = await request(app).get("/api/sessions");

    expect(res.status).toBe(200);
    expect(sessionManager.listSessionsFromDisk).not.toHaveBeenCalled();
    expect(res.body.sessions).toEqual(expect.arrayContaining([
      expect.objectContaining({
        sessionId: "cli-sized-session",
        eventLogSizeBytes: Buffer.byteLength(events),
      }),
      expect.objectContaining({
        sessionId: "cli-missing-events",
        eventLogSizeBytes: 0,
      }),
    ]));
  });

  it("GET /api/sessions overlays CLI catalog summaries with workspace names after cheap filtering", async () => {
    const copilotHome = join(makeTestDir("api-cli-catalog-name-overlay"), ".copilot");
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
      const insert = cliDb.prepare(`
        INSERT INTO sessions (id, cwd, summary, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      insert.run(
        "cli-named-session",
        "D:\\work",
        "ok luycyd lyte was sold! update he selling db",
        "2026-04-16T12:00:00.000Z",
        "2026-04-16T12:00:00.000Z",
      );
      insert.run(
        "b17e1000-0000-4000-8000-000000000001",
        "D:\\work",
        "Disposable helper",
        "2026-04-16T13:00:00.000Z",
        "2026-04-16T13:00:00.000Z",
      );
    } finally {
      cliDb.close();
    }
    mkdirSync(join(copilotHome, "session-state", "cli-named-session"), { recursive: true });
    writeFileSync(
      join(copilotHome, "session-state", "cli-named-session", "workspace.yaml"),
      [
        "created_at: 2026-04-16T12:00:00.000Z",
        "name: Record Lucyd Lyte Sale",
        "summary: Record Lucyd Lyte Sale",
      ].join("\n"),
    );
    const sessionManager = createMockSessionManager();
    sessionManager.listSessionsFromDisk = vi.fn(async () => {
      throw new Error("should use CLI catalog");
    });
    ({ app, ctx } = createTestApp({ copilotHome, sessionManager }));

    const res = await request(app).get("/api/sessions");

    expect(res.status).toBe(200);
    expect(sessionManager.listSessionsFromDisk).not.toHaveBeenCalled();
    expect(res.body.sessions).toEqual([
      expect.objectContaining({
        sessionId: "cli-named-session",
        summary: "Record Lucyd Lyte Sale",
      }),
    ]);
  });

  it("GET /api/sessions keeps sessions visible when a CLI-owned summary exists", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.listSessionsFromDisk = vi.fn().mockResolvedValue([
      {
        sessionId: "fork-session",
        summary: "Fork of Original session",
        modifiedTime: "2026-04-16T12:00:00.000Z",
        lastVisibleActivityAt: "2026-04-16T12:00:00.000Z",
      },
    ]);
    ({ app, ctx } = createTestApp({ sessionManager }));

    const res = await request(app).get("/api/sessions");

    expect(res.status).toBe(200);
    expect(res.body.sessions).toEqual([
      expect.objectContaining({
        sessionId: "fork-session",
        summary: "Fork of Original session",
      }),
    ]);
  });

  it("GET /api/sessions keeps linked untitled task sessions visible", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.listSessionsFromDisk = vi.fn().mockResolvedValue([
      {
        sessionId: "new-task-session",
        modifiedTime: "2026-04-16T12:00:00.000Z",
        lastVisibleActivityAt: "2026-04-16T12:00:00.000Z",
      },
    ]);
    ({ app, ctx } = createTestApp({ sessionManager }));
    const task = ctx.taskStore.createTask("Task with new session");
    ctx.taskStore.linkSession(task.id, "new-task-session");

    const res = await request(app).get("/api/sessions");

    expect(res.status).toBe(200);
    expect(res.body.sessions).toEqual([
      expect.objectContaining({
        sessionId: "new-task-session",
        summary: "New session",
        linkedTaskIds: [task.id],
      }),
    ]);
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
    ({ app, ctx } = createTestApp({ sessionManager }));

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
        busy: true,
      }),
    ]);
    expect(sessionManager.listSessionsFromDisk).toHaveBeenCalledTimes(1);
  });

  it("task changes do not clear the raw disk session list cache", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.invalidateSessionListCache = vi.fn();
    ({ app, ctx } = createTestApp({ sessionManager }));

    ctx.taskStore.createTask("Task cache metadata update");

    expect(sessionManager.invalidateSessionListCache).not.toHaveBeenCalled();
  });

  it("session archive events clear the raw disk session list cache synchronously", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.invalidateSessionListCache = vi.fn();
    sessionManager.listSessionsFromDisk = vi.fn().mockResolvedValue([
      {
        sessionId: "archive-me",
        summary: "Archive me",
        modifiedTime: "2026-04-16T12:00:00.000Z",
        lastVisibleActivityAt: "2026-04-16T12:00:00.000Z",
      },
    ]);
    ({ app, ctx } = createTestApp({ sessionManager }));

    const before = await request(app).get("/api/sessions");
    const patch = await request(app).patch("/api/sessions/archive-me").send({ archived: true });
    const after = await request(app).get("/api/sessions");

    expect(before.status).toBe(200);
    expect(before.body.sessions).toEqual([expect.objectContaining({ sessionId: "archive-me" })]);
    expect(patch.status).toBe(200);
    expect(after.status).toBe(200);
    expect(after.body.sessions).toEqual([]);
    expect(sessionManager.invalidateSessionListCache).toHaveBeenCalledWith("bus:session:archived");
  });

  it("GET /api/sessions hides idle sessions linked only to archived tasks by default", async () => {
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
    ({ app, ctx } = createTestApp({ sessionManager }));
    const archivedTask = ctx.taskStore.createTask("Archived parent task");
    ctx.taskStore.linkSession(archivedTask.id, "archived-task-session");
    ctx.taskStore.updateTask(archivedTask.id, { status: "archived" });

    const activeRes = await request(app).get("/api/sessions");
    const allRes = await request(app).get("/api/sessions?includeArchived=true");

    expect(activeRes.status).toBe(200);
    expect(activeRes.body.sessions.map((session: any) => session.sessionId)).toEqual(["unlinked-session"]);
    expect(allRes.status).toBe(200);
    expect(allRes.body.sessions.map((session: any) => session.sessionId)).toEqual([
      "unlinked-session",
      "archived-task-session",
    ]);
  });

  it("GET /api/sessions keeps sessions visible when any linked task is active", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.listSessionsFromDisk = vi.fn().mockResolvedValue([
      {
        sessionId: "mixed-task-session",
        summary: "Mixed task session",
        modifiedTime: "2026-04-16T12:00:00.000Z",
        lastVisibleActivityAt: "2026-04-16T12:00:00.000Z",
      },
    ]);
    ({ app, ctx } = createTestApp({ sessionManager }));
    const archivedTask = ctx.taskStore.createTask("Archived parent task");
    const activeTask = ctx.taskStore.createTask("Active parent task");
    ctx.taskStore.linkSession(archivedTask.id, "mixed-task-session");
    ctx.taskStore.linkSession(activeTask.id, "mixed-task-session");
    ctx.taskStore.updateTask(archivedTask.id, { status: "archived" });

    const res = await request(app).get("/api/sessions");

    expect(res.status).toBe(200);
    expect(res.body.sessions).toEqual([
      expect.objectContaining({ sessionId: "mixed-task-session" }),
    ]);
  });

  it("GET /api/sessions uses attention activity for unread inclusion and ordering", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.listSessionsFromDisk = vi.fn().mockResolvedValue([
      {
        sessionId: "attention-session",
        summary: "Attention session",
        modifiedTime: "2026-04-16T12:00:00.000Z",
      },
      {
        sessionId: "visible-session",
        summary: "Visible session",
        modifiedTime: "2026-04-16T11:00:00.000Z",
        lastVisibleActivityAt: "2026-04-16T12:30:00.000Z",
      },
    ]);
    ({ app, ctx, db } = createTestApp({ sessionManager }));
    ctx.sessionMetaStore.setLastAttentionAt("attention-session", "2026-04-16T13:00:00.000Z");
    db.prepare("INSERT INTO read_state (sessionId, lastReadAt) VALUES (?, ?)")
      .run("attention-session", "2026-04-16T12:59:00.000Z");

    const res = await request(app).get("/api/sessions");

    expect(res.status).toBe(200);
    expect(res.body.sessions.map((session: any) => session.sessionId)).toEqual([
      "attention-session",
      "visible-session",
    ]);
    expect(res.body.sessions[0]).toMatchObject({
      sessionId: "attention-session",
      lastAttentionAt: "2026-04-16T13:00:00.000Z",
      lastActivityAt: "2026-04-16T13:00:00.000Z",
      modifiedTime: "2026-04-16T13:00:00.000Z",
    });
  });

  it("GET /api/sessions keeps busy archived-task sessions visible by default", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.getSessionRunState = vi.fn().mockReturnValue("busy");
    sessionManager.listSessionsFromDisk = vi.fn().mockResolvedValue([
      {
        sessionId: "busy-archived-task-session",
        summary: "Busy archived task session",
        modifiedTime: "2026-04-16T12:00:00.000Z",
        lastVisibleActivityAt: "2026-04-16T12:00:00.000Z",
      },
    ]);
    ({ app, ctx } = createTestApp({ sessionManager }));
    const archivedTask = ctx.taskStore.createTask("Archived parent task");
    ctx.taskStore.linkSession(archivedTask.id, "busy-archived-task-session");
    ctx.taskStore.updateTask(archivedTask.id, { status: "archived" });

    const res = await request(app).get("/api/sessions");

    expect(res.status).toBe(200);
    expect(res.body.sessions).toEqual([
      expect.objectContaining({
        sessionId: "busy-archived-task-session",
        runState: "busy",
        busy: true,
      }),
    ]);
  });

  it("GET /api/sessions includes runState while keeping busy derived for stalled sessions", async () => {
    ctx.sessionManager.listSessionsFromDisk = async () => [
      { sessionId: "s1", summary: "Session one", startTime: "2026-04-19T00:00:00.000Z" } as any,
    ];
    ctx.sessionManager.getSessionRunState = vi.fn().mockReturnValue("stalled");
    ctx.sessionManager.isSessionBusy = vi.fn().mockReturnValue(true);

    const res = await request(app).get("/api/sessions");

    expect(res.status).toBe(200);
    expect(res.body.sessions[0]).toMatchObject({ sessionId: "s1", runState: "stalled", busy: true });
  });

  it("GET /api/sessions includes input-required status for sessions waiting on answers", async () => {
    ctx.sessionManager.listSessionsFromDisk = async () => [
      { sessionId: "s1", summary: "Session one", startTime: "2026-04-19T00:00:00.000Z" } as any,
    ];
    ctx.sessionManager.getSessionRunState = vi.fn().mockReturnValue("busy");
    ctx.sessionManager.getPendingUserInputCount = vi.fn().mockReturnValue(1);

    const res = await request(app).get("/api/sessions");

    expect(res.status).toBe(200);
    expect(res.body.sessions[0]).toMatchObject({
      sessionId: "s1",
      runState: "busy",
      busy: true,
      pendingUserInputCount: 1,
      needsUserInput: true,
    });
  });

  it("POST /api/sessions creates a session", async () => {
    const res = await request(app).post("/api/sessions");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("sessionId");
  });

  it("POST /api/sessions creates a session when restart is active in persisted state", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.createSession = vi.fn().mockResolvedValue({ sessionId: "new-session" });
    const runtimePaths = createRestartRuntimePaths();
    await writeRestartState(join(runtimePaths.dataDir, "restart-state.json"), {
      requestId: "req-session-create",
      phase: "queued",
      requestedAt: "2026-04-24T12:00:00.000Z",
      waitingSessions: 0,
      launcherHeartbeatAt: null,
    });
    ({ app, ctx } = createTestApp({ sessionManager, runtimePaths }));

    const res = await request(app).post("/api/sessions");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sessionId: "new-session" });
    expect(sessionManager.createSession).toHaveBeenCalledOnce();
  });

  it("POST /api/sessions rejects session creation while launcher restart cutover is in progress", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.createSession = vi.fn();
    const runtimePaths = createRestartRuntimePaths();
    await writeRestartState(join(runtimePaths.dataDir, "restart-state.json"), {
      requestId: "req-session-create-restarting",
      phase: "restarting",
      requestedAt: "2026-04-24T12:00:00.000Z",
      waitingSessions: 0,
      launcherHeartbeatAt: "2026-04-24T12:00:05.000Z",
    });
    ({ app, ctx } = createTestApp({ sessionManager, runtimePaths }));

    const res = await request(app).post("/api/sessions");

    expect(res.status).toBe(503);
    expect(res.body.error).toBe(RESTART_PENDING_MESSAGE);
    expect(sessionManager.createSession).not.toHaveBeenCalled();
  });

  it("POST /api/sessions/:id/fork forks a session when restart is active in persisted state", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.forkSession = vi.fn().mockResolvedValue({ sessionId: "fork-session" });
    const runtimePaths = createRestartRuntimePaths();
    await writeRestartState(join(runtimePaths.dataDir, "restart-state.json"), {
      requestId: "req-session-fork",
      phase: "queued",
      requestedAt: "2026-04-24T12:00:00.000Z",
      waitingSessions: 0,
      launcherHeartbeatAt: null,
    });
    ({ app, ctx } = createTestApp({ sessionManager, runtimePaths }));

    const res = await request(app).post("/api/sessions/source-session/fork");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sessionId: "fork-session" });
    expect(sessionManager.forkSession).toHaveBeenCalledWith("source-session", {});
  });

  it("POST /api/tasks/:id/session creates a task session when restart is active in persisted state", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.createTaskSession = vi.fn().mockResolvedValue({ sessionId: "task-session" });
    const runtimePaths = createRestartRuntimePaths();
    await writeRestartState(join(runtimePaths.dataDir, "restart-state.json"), {
      requestId: "req-task-session",
      phase: "waiting-for-sessions",
      requestedAt: "2026-04-24T12:00:00.000Z",
      waitingSessions: 2,
      launcherHeartbeatAt: null,
    });
    ({ app, ctx } = createTestApp({ sessionManager, runtimePaths }));
    const task = ctx.taskStore.createTask("Task for restart");

    const res = await request(app).post(`/api/tasks/${task.id}/session`);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sessionId: "task-session" });
    expect(sessionManager.createTaskSession).toHaveBeenCalledOnce();
    expect(ctx.taskStore.getTask(task.id)?.sessionIds).toContain("task-session");
  });

  it("POST /api/chat requires sessionId and prompt", async () => {
    const res = await request(app)
      .post("/api/chat")
      .send({});
    expect(res.status).toBe(400);
  });

  it("POST /api/chat accepts new work when restart is active in persisted state", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.startWork = vi.fn();
    const runtimePaths = createRestartRuntimePaths();
    await writeRestartState(join(runtimePaths.dataDir, "restart-state.json"), {
      requestId: "req-chat-gating",
      phase: "waiting-for-sessions",
      requestedAt: "2026-04-24T12:00:00.000Z",
      waitingSessions: 2,
      launcherHeartbeatAt: null,
    });
    ({ app, ctx } = createTestApp({ sessionManager, runtimePaths }));

    const res = await request(app)
      .post("/api/chat")
      .send({ sessionId: "test-session", prompt: "hello" });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: "accepted" });
    expect(sessionManager.startWork).toHaveBeenCalledWith("test-session", "hello", undefined);
  });

  it("POST /api/chat passes autopilot mode to new work", async () => {
    ctx.sessionManager.startWork = vi.fn();

    const res = await request(app)
      .post("/api/chat")
      .send({ sessionId: "test-session", prompt: "hello", mode: "autopilot" });

    expect(res.status).toBe(202);
    expect(ctx.sessionManager.startWork).toHaveBeenCalledWith("test-session", "hello", undefined, { mode: "autopilot" });
  });

  it("POST /api/chat rejects unsupported send modes", async () => {
    ctx.sessionManager.startWork = vi.fn();

    const res = await request(app)
      .post("/api/chat")
      .send({ sessionId: "test-session", prompt: "hello", mode: "plan" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("mode must be one of");
    expect(ctx.sessionManager.startWork).not.toHaveBeenCalled();
  });

  it("POST /api/chat steers busy sessions instead of rejecting them", async () => {
    ctx.sessionManager.isSessionBusy = vi.fn().mockReturnValue(true);
    ctx.sessionManager.startWork = vi.fn();
    ctx.sessionManager.steerSession = vi.fn().mockResolvedValue(undefined);

    const res = await request(app)
      .post("/api/chat")
      .send({ sessionId: "busy-session", prompt: "adjust course", mode: "autopilot" });

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: "accepted", mode: "steered" });
    expect(ctx.sessionManager.steerSession).toHaveBeenCalledWith("busy-session", "adjust course", undefined);
    expect(ctx.sessionManager.startWork).not.toHaveBeenCalled();
  });

  it("POST /api/chat routes busy slash commands through command steering", async () => {
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

  it("GET /api/sessions/:id/slash-commands returns command metadata", async () => {
    ctx.sessionManager.listSlashCommands = vi.fn().mockResolvedValue({
      supported: true,
      commands: [{
        name: "goal",
        aliases: ["autopilot"],
        description: "Set an autopilot objective",
        kind: "builtin",
        input: { hint: "objective" },
        allowDuringAgentExecution: true,
      }],
    });

    const res = await request(app).get("/api/sessions/test-session/slash-commands");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      supported: true,
      commands: [{
        name: "goal",
        aliases: ["autopilot"],
        description: "Set an autopilot objective",
        kind: "builtin",
        input: { hint: "objective" },
        allowDuringAgentExecution: true,
      }],
    });
    expect(ctx.sessionManager.listSlashCommands).toHaveBeenCalledWith("test-session");
  });

  it("POST /api/chat reports when a busy session cannot accept steering yet", async () => {
    ctx.sessionManager.isSessionBusy = vi.fn().mockReturnValue(true);
    ctx.sessionManager.steerSession = vi.fn().mockRejectedValue(new Error("Session is still reconnecting; try again shortly"));

    const res = await request(app)
      .post("/api/chat")
      .send({ sessionId: "busy-session", prompt: "adjust course" });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("reconnecting");
  });

  it("POST /api/chat rejects new work while launcher restart cutover is in progress", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.startWork = vi.fn();
    const runtimePaths = createRestartRuntimePaths();
    await writeRestartState(join(runtimePaths.dataDir, "restart-state.json"), {
      requestId: "req-chat-restarting",
      phase: "restarting",
      requestedAt: "2026-04-24T12:00:00.000Z",
      waitingSessions: 0,
      launcherHeartbeatAt: "2026-04-24T12:00:05.000Z",
    });
    ({ app, ctx } = createTestApp({ sessionManager, runtimePaths }));

    const res = await request(app)
      .post("/api/chat")
      .send({ sessionId: "test-session", prompt: "hello" });

    expect(res.status).toBe(503);
    expect(res.body.error).toBe(RESTART_PENDING_MESSAGE);
    expect(sessionManager.startWork).not.toHaveBeenCalled();
  });


  it("GET /api/busy returns activity summary", async () => {
    const res = await request(app).get("/api/busy");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("busy");
    expect(res.body).toHaveProperty("count");
    expect(Array.isArray(res.body.sessions)).toBe(true);
  });

  it("GET /api/health returns ok", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      ok: true,
      docsFts: { ok: true, status: "available" },
    });
  });
});
