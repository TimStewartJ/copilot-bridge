import { beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseSync } from "node:sqlite";
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

const REASONING_PRICING_ASSUMPTION = "reasoning_tokens_priced_at_output_rate" as const;

function expectedUsageTotals(overrides: Partial<Record<
  "requests" | "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "reasoningTokens" | "totalTokens",
  number
>> = {}) {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    ...overrides,
  };
}

function expectedCostBreakdownUsd(overrides: Partial<Record<
  "input" | "cachedInput" | "cacheWrite" | "output" | "reasoning" | "total",
  number
>> = {}) {
  return {
    input: 0,
    cachedInput: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
    total: 0,
    ...overrides,
  };
}

function expectedCostEstimate(overrides: {
  estimatedCostUsd?: number;
  estimatedAiCredits?: number;
  costBreakdownUsd?: ReturnType<typeof expectedCostBreakdownUsd>;
  billableOutputTokens?: number;
} = {}) {
  const costBreakdownUsd = overrides.costBreakdownUsd ?? expectedCostBreakdownUsd();
  const estimatedCostUsd = overrides.estimatedCostUsd ?? costBreakdownUsd.total;
  return {
    estimatedCostUsd,
    estimatedAiCredits: overrides.estimatedAiCredits ?? estimatedCostUsd / 0.01,
    costBreakdownUsd,
    billableOutputTokens: overrides.billableOutputTokens ?? 0,
    reasoningPricingAssumption: REASONING_PRICING_ASSUMPTION,
  };
}

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

  it("POST /api/sessions/:id/fleet accepts new fleet work when restart is active in persisted state", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.hasPlan = vi.fn().mockReturnValue(true);
    sessionManager.startFleet = vi.fn();
    const runtimePaths = createRestartRuntimePaths();
    await writeRestartState(join(runtimePaths.dataDir, "restart-state.json"), {
      requestId: "req-fleet-gating",
      phase: "waiting-for-sessions",
      requestedAt: "2026-04-24T12:00:00.000Z",
      waitingSessions: 2,
      launcherHeartbeatAt: null,
    });
    ({ app, ctx } = createTestApp({ sessionManager, runtimePaths }));

    const res = await request(app)
      .post("/api/sessions/test-session/fleet")
      .send({});

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: "accepted" });
    expect(sessionManager.startFleet).toHaveBeenCalledWith("test-session", undefined);
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
    expect(res.body).toEqual({ ok: true });
  });

  it("GET /api/dashboard includes schedules array", async () => {
    const res = await request(app).get("/api/dashboard");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("schedules");
    expect(Array.isArray(res.body.schedules)).toBe(true);
  });

  it("GET /api/dashboard requests active-only sessions from disk", async () => {
    const sessionManager = createMockSessionManager();
    const listSessionsFromDisk = vi.fn(async (opts?: { includeArchived?: boolean }) => {
      if (opts?.includeArchived !== false) {
        throw new Error("dashboard should not scan archived sessions");
      }
      return [
        {
          sessionId: "active-session",
          summary: "Active session",
          lastVisibleActivityAt: "2026-04-16T12:00:00.000Z",
        },
      ];
    });
    sessionManager.listSessionsFromDisk = listSessionsFromDisk;
    ({ app, ctx } = createTestApp({ sessionManager }));

    const res = await request(app).get("/api/dashboard");

    expect(res.status).toBe(200);
    expect(listSessionsFromDisk).toHaveBeenCalledWith({ includeArchived: false });
    expect(res.body.unreadSessions).toEqual([
      expect.objectContaining({ sessionId: "active-session", title: "Active session" }),
    ]);
  });

  it("GET /api/dashboard treats attention-only activity as unread", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.listSessionsFromDisk = vi.fn().mockResolvedValue([
      {
        sessionId: "attention-session",
        summary: "Attention session",
        modifiedTime: "2026-04-16T12:00:00.000Z",
      },
    ]);
    ({ app, ctx, db } = createTestApp({ sessionManager }));
    ctx.sessionMetaStore.setLastAttentionAt("attention-session", "2026-04-16T13:00:00.000Z");
    db.prepare("INSERT INTO read_state (sessionId, lastReadAt) VALUES (?, ?)")
      .run("attention-session", "2026-04-16T12:59:00.000Z");

    const res = await request(app).get("/api/dashboard");

    expect(res.status).toBe(200);
    expect(res.body.unreadSessions).toEqual([
      expect.objectContaining({
        sessionId: "attention-session",
        lastAttentionAt: "2026-04-16T13:00:00.000Z",
        lastActivityAt: "2026-04-16T13:00:00.000Z",
      }),
    ]);
  });

  it("GET /api/dashboard reuses the warmed active session cache", async () => {
    const sessionManager = createMockSessionManager();
    const listSessionsFromDisk = vi.fn(async () => [
      {
        sessionId: "cached-dashboard-session",
        summary: "Cached dashboard session",
        lastVisibleActivityAt: "2026-04-16T12:00:00.000Z",
      },
    ]);
    sessionManager.listSessionsFromDisk = listSessionsFromDisk;
    ({ app, ctx } = createTestApp({ sessionManager }));

    const sessionsRes = await request(app).get("/api/sessions");
    const dashboardRes = await request(app).get("/api/dashboard");

    expect(sessionsRes.status).toBe(200);
    expect(dashboardRes.status).toBe(200);
    expect(dashboardRes.body.unreadSessions).toEqual([
      expect.objectContaining({ sessionId: "cached-dashboard-session", title: "Cached dashboard session" }),
    ]);
    expect(listSessionsFromDisk).toHaveBeenCalledTimes(1);
  });

  it("GET /api/dashboard fails clearly when dashboard stores are missing", async () => {
    ({ app, ctx } = createTestApp({
      taskGroupStore: undefined as any,
      scheduleStore: undefined as any,
      checklistStore: undefined as any,
      voiceJobManager: {} as any,
    }));
    ctx.taskStore.createTask("Dashboard Task");

    const res = await request(app).get("/api/dashboard");

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("Dashboard stores are not configured.");
  });

  it("GET /api/dashboard keeps sessions visible when a CLI-owned summary exists", async () => {
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

    const res = await request(app).get("/api/dashboard");

    expect(res.status).toBe(200);
    expect(res.body.unreadSessions).toEqual([
      expect.objectContaining({
        sessionId: "fork-session",
        title: "Fork of Original session",
      }),
    ]);
  });

  it("GET /api/dashboard enriches schedules with task title", async () => {
    // Create a task and schedule via stores
    const task = await request(app).post("/api/tasks").send({ title: "Dashboard Task" });
    const taskId = task.body.task.id;
    ctx.scheduleStore.createSchedule({
      taskId, name: "Dash Sched", prompt: "test", type: "cron", cron: "0 0 * * *",
    });

    const res = await request(app).get("/api/dashboard");
    expect(res.status).toBe(200);
    const sched = res.body.schedules.find((s: any) => s.name === "Dash Sched");
    expect(sched).toBeDefined();
    expect(sched.taskTitle).toBe("Dashboard Task");
  });

  it("GET /api/dashboard treats stalled sessions as active and suppresses unread", async () => {
    ctx.sessionManager.listSessionsFromDisk = async () => [
      {
        sessionId: "stall-1",
        summary: "Stalled session",
        lastVisibleActivityAt: "2026-04-19T01:00:00.000Z",
        context: { branch: "main" },
      } as any,
    ];
    ctx.sessionManager.getSessionRunState = vi.fn().mockImplementation((sessionId: string) => (
      sessionId === "stall-1" ? "stalled" : "idle"
    ));
    ctx.sessionManager.isSessionBusy = vi.fn().mockImplementation((sessionId: string) => sessionId === "stall-1");

    const res = await request(app).get("/api/dashboard");

    expect(res.status).toBe(200);
    expect(res.body.busySessions).toEqual([
      expect.objectContaining({ sessionId: "stall-1", runState: "stalled", busy: true }),
    ]);
    expect(res.body.unreadSessions).toEqual([]);
    expect(res.body.orphanSessions).toEqual([
      expect.objectContaining({ sessionId: "stall-1", runState: "stalled", busy: true, unread: true }),
    ]);
  });

  it("GET /api/dashboard treats tasks with input-waiting sessions as unread", async () => {
    ctx.sessionManager.listSessionsFromDisk = async () => [
      {
        sessionId: "ask-1",
        summary: "Awaiting decision",
        lastVisibleActivityAt: "2026-04-19T01:00:00.000Z",
      } as any,
    ];
    ctx.sessionManager.getSessionRunState = vi.fn().mockImplementation((sessionId: string) => (
      sessionId === "ask-1" ? "busy" : "idle"
    ));
    ctx.sessionManager.getPendingUserInputCount = vi.fn().mockImplementation((sessionId: string) => (
      sessionId === "ask-1" ? 1 : 0
    ));
    const task = ctx.taskStore.createTask("Needs user choice");
    ctx.taskStore.linkSession(task.id, "ask-1");

    const res = await request(app).get("/api/dashboard");

    expect(res.status).toBe(200);
    expect(res.body.lastActiveTask).toEqual(expect.objectContaining({
      task: expect.objectContaining({ id: task.id }),
      hasUnread: true,
      hasBusySession: true,
    }));
    expect(res.body.unreadSessions).toEqual([]);
  });

  it("GET /api/dashboard returns derived task momentum queues", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T12:00:00.000Z"));

    try {
      const testApp = createTestApp();
      app = testApp.app;
      ctx = testApp.ctx;
      const { db } = testApp;

      const decisionTask = ctx.taskStore.createTask("Needs a decision");
      const followUpTask = ctx.taskStore.createTask("Follow up now");
      const waitingTask = ctx.taskStore.createTask("Waiting on someone");
      const closeTask = ctx.taskStore.createTask("Candidate to close");
      const staleTask = ctx.taskStore.createTask("Stale task");

      ctx.taskStore.updateTask(followUpTask.id, {
        nextAction: "Reply to the thread",
        nextTouchAt: "2026-05-01T11:00:00.000Z",
      });
      ctx.taskStore.updateTask(waitingTask.id, {
        nextAction: "Review when it lands",
        waitingOn: "Design feedback",
      });
      ctx.taskStore.updateTask(closeTask.id, {
        nextAction: "Close it out",
      });
      ctx.taskStore.updateTask(staleTask.id, {
        nextAction: "Revisit later",
      });
      ctx.checklistStore.createChecklistItem(staleTask.id, "Still blocked");
      db.prepare("UPDATE tasks SET updatedAt = ? WHERE id = ?").run("2026-04-20T09:00:00.000Z", staleTask.id);

      const res = await request(app).get("/api/dashboard");
      const needsDecisionIds = res.body.taskMomentum.needsDecision.map((entry: any) => entry.task.id);
      const followUpNowIds = res.body.taskMomentum.followUpNow.map((entry: any) => entry.task.id);
      const waitingIds = res.body.taskMomentum.waiting.map((entry: any) => entry.task.id);
      const candidateToCloseIds = res.body.taskMomentum.candidateToClose.map((entry: any) => entry.task.id);
      const staleIds = res.body.taskMomentum.stale.map((entry: any) => entry.task.id);

      expect(res.status).toBe(200);
      expect(res.body.taskMomentum.summary).toEqual({
        needsDecision: 1,
        followUpNow: 1,
        waiting: 1,
        candidateToClose: res.body.taskMomentum.candidateToClose.length,
        stale: 1,
      });
      expect(needsDecisionIds).toEqual([decisionTask.id]);
      expect(followUpNowIds).toEqual([followUpTask.id]);
      expect(waitingIds).toEqual([waitingTask.id]);
      expect(candidateToCloseIds).toContain(closeTask.id);
      expect(candidateToCloseIds).not.toContain(staleTask.id);
      expect(staleIds).toEqual([staleTask.id]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("GET /api/dashboard taskMomentum.summary counts match queue lengths", async () => {
    const res = await request(app).get("/api/dashboard");
    expect(res.status).toBe(200);
    const { summary, needsDecision, followUpNow, waiting, candidateToClose, stale } = res.body.taskMomentum;
    expect(summary.needsDecision).toBe(needsDecision.length);
    expect(summary.followUpNow).toBe(followUpNow.length);
    expect(summary.waiting).toBe(waiting.length);
    expect(summary.candidateToClose).toBe(candidateToClose.length);
    expect(summary.stale).toBe(stale.length);
  });

  it("GET /api/dashboard taskMomentum.followUpNow excludes tasks with future nextTouchAt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T12:00:00.000Z"));

    try {
      const testApp = createTestApp();
      app = testApp.app;
      ctx = testApp.ctx;

      const futureTask = ctx.taskStore.createTask("Future reminder");
      ctx.taskStore.updateTask(futureTask.id, {
        nextAction: "Check in",
        nextTouchAt: "2026-05-01T13:00:00.000Z", // 1 hour in the future
      });
      const pastTask = ctx.taskStore.createTask("Past reminder");
      ctx.taskStore.updateTask(pastTask.id, {
        nextAction: "Already due",
        nextTouchAt: "2026-05-01T11:00:00.000Z", // 1 hour in the past
      });

      const res = await request(app).get("/api/dashboard");
      const followUpNowIds = res.body.taskMomentum.followUpNow.map((e: any) => e.task.id);

      expect(res.status).toBe(200);
      expect(followUpNowIds).not.toContain(futureTask.id);
      expect(followUpNowIds).toContain(pastTask.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it("GET /api/dashboard taskMomentum.needsDecision excludes deferred tasks with nextTouchAt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T12:00:00.000Z"));

    try {
      const testApp = createTestApp();
      app = testApp.app;
      ctx = testApp.ctx;

      const deferredTask = ctx.taskStore.createTask("Deferred");
      ctx.taskStore.updateTask(deferredTask.id, {
        nextTouchAt: "2026-05-02T12:00:00.000Z",
      });
      const undecidedTask = ctx.taskStore.createTask("Needs decision");

      const res = await request(app).get("/api/dashboard");
      const needsDecisionIds = res.body.taskMomentum.needsDecision.map((e: any) => e.task.id);

      expect(res.status).toBe(200);
      expect(needsDecisionIds).toContain(undecidedTask.id);
      expect(needsDecisionIds).not.toContain(deferredTask.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it("GET /api/dashboard taskMomentum.candidateToClose excludes tasks with open checklist items", async () => {
    const testApp = createTestApp();
    app = testApp.app;
    ctx = testApp.ctx;

    const clean = ctx.taskStore.createTask("Ready to close");
    const blocked = ctx.taskStore.createTask("Has open checklist");
    ctx.checklistStore.createChecklistItem(blocked.id, "Unfinished item");

    const res = await request(app).get("/api/dashboard");
    const candidateIds = res.body.taskMomentum.candidateToClose.map((e: any) => e.task.id);

    expect(res.status).toBe(200);
    expect(candidateIds).toContain(clean.id);
    expect(candidateIds).not.toContain(blocked.id);
  });

  it("GET /api/dashboard taskMomentum.candidateToClose excludes tasks with busy sessions", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.listSessionsFromDisk = vi.fn().mockResolvedValue([
      {
        sessionId: "busy-sess",
        summary: "Active work",
        lastVisibleActivityAt: new Date().toISOString(),
      },
    ]);
    sessionManager.getSessionRunState = vi.fn().mockImplementation((id: string) =>
      id === "busy-sess" ? "running" : "idle",
    );

    const testApp = createTestApp({ sessionManager });
    app = testApp.app;
    ctx = testApp.ctx;

    const busyTask = ctx.taskStore.createTask("Has busy session");
    ctx.taskStore.linkSession(busyTask.id, "busy-sess");
    const idleTask = ctx.taskStore.createTask("No busy session");

    const res = await request(app).get("/api/dashboard");
    const candidateIds = res.body.taskMomentum.candidateToClose.map((e: any) => e.task.id);

    expect(res.status).toBe(200);
    expect(candidateIds).not.toContain(busyTask.id);
    expect(candidateIds).toContain(idleTask.id);
  });

  it("GET /api/dashboard taskMomentum.candidateToClose excludes tasks with unknown PR status", async () => {
    const enrichPullRequestsSpy = vi.spyOn(providers, "enrichPullRequests").mockResolvedValue([
      {
        repoId: "repo-1",
        repoName: "repo-1",
        prId: 42,
        provider: "github",
        title: null,
        status: null,
        createdBy: null,
        reviewerCount: 0,
        url: "https://example.test/repo-1/pull/42",
      },
    ]);

    try {
      const testApp = createTestApp();
      app = testApp.app;
      ctx = testApp.ctx;

      const unknownPrTask = ctx.taskStore.createTask("PR status unavailable");
      ctx.taskStore.linkPR(unknownPrTask.id, {
        repoId: "repo-1",
        repoName: "repo-1",
        prId: 42,
        provider: "github",
      });

      const cleanTask = ctx.taskStore.createTask("Ready to close");

      const res = await request(app).get("/api/dashboard");
      const candidateIds = res.body.taskMomentum.candidateToClose.map((e: any) => e.task.id);

      expect(res.status).toBe(200);
      expect(candidateIds).toContain(cleanTask.id);
      expect(candidateIds).not.toContain(unknownPrTask.id);
    } finally {
      enrichPullRequestsSpy.mockRestore();
    }
  });

  it("GET /api/dashboard keeps ongoing tasks in open queues but out of candidateToClose", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T12:00:00.000Z"));

    try {
      const testApp = createTestApp();
      app = testApp.app;
      ctx = testApp.ctx;
      const { db } = testApp;

      const ongoingDecision = ctx.taskStore.createTask("Ongoing decision");
      ctx.taskStore.updateTask(ongoingDecision.id, { kind: "ongoing" });

      const ongoingFollowUp = ctx.taskStore.createTask("Ongoing follow-up");
      ctx.taskStore.updateTask(ongoingFollowUp.id, {
        kind: "ongoing",
        nextAction: "Check in",
        nextTouchAt: "2026-05-01T11:00:00.000Z",
      });

      const ongoingWaiting = ctx.taskStore.createTask("Ongoing waiting");
      ctx.taskStore.updateTask(ongoingWaiting.id, {
        kind: "ongoing",
        nextAction: "Review update",
        waitingOn: "External input",
      });

      const ongoingStale = ctx.taskStore.createTask("Ongoing stale");
      ctx.taskStore.updateTask(ongoingStale.id, {
        kind: "ongoing",
        nextAction: "Keep monitoring",
      });
      db.prepare("UPDATE tasks SET updatedAt = ? WHERE id = ?").run("2026-04-20T09:00:00.000Z", ongoingStale.id);

      const closeableTask = ctx.taskStore.createTask("One-off task");
      ctx.taskStore.updateTask(closeableTask.id, {
        nextAction: "Wrap it up",
      });

      const res = await request(app).get("/api/dashboard");
      const needsDecisionIds = res.body.taskMomentum.needsDecision.map((e: any) => e.task.id);
      const followUpNowIds = res.body.taskMomentum.followUpNow.map((e: any) => e.task.id);
      const waitingIds = res.body.taskMomentum.waiting.map((e: any) => e.task.id);
      const candidateIds = res.body.taskMomentum.candidateToClose.map((e: any) => e.task.id);
      const staleIds = res.body.taskMomentum.stale.map((e: any) => e.task.id);

      expect(res.status).toBe(200);
      expect(res.body.taskMomentum.summary).toEqual({
        needsDecision: 1,
        followUpNow: 1,
        waiting: 1,
        candidateToClose: 1,
        stale: 1,
      });
      expect(needsDecisionIds).toContain(ongoingDecision.id);
      expect(followUpNowIds).toContain(ongoingFollowUp.id);
      expect(waitingIds).toContain(ongoingWaiting.id);
      expect(staleIds).toContain(ongoingStale.id);
      expect(candidateIds).toContain(closeableTask.id);
      expect(candidateIds).not.toContain(ongoingDecision.id);
      expect(candidateIds).not.toContain(ongoingFollowUp.id);
      expect(candidateIds).not.toContain(ongoingWaiting.id);
      expect(candidateIds).not.toContain(ongoingStale.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it("GET /api/dashboard taskMomentum.stale excludes tasks with nextTouchAt set", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T12:00:00.000Z"));

    try {
      const testApp = createTestApp();
      app = testApp.app;
      ctx = testApp.ctx;
      const { db } = testApp;

      // Both tasks are "old" (last touched > 7 days ago)
      const trueStale = ctx.taskStore.createTask("Truly stale");
      const touchedStale = ctx.taskStore.createTask("Stale but scheduled");
      ctx.taskStore.updateTask(touchedStale.id, {
        nextTouchAt: "2026-06-01T00:00:00.000Z",
      });

      const staleTs = "2026-04-20T09:00:00.000Z";
      db.prepare("UPDATE tasks SET updatedAt = ? WHERE id = ?").run(staleTs, trueStale.id);
      db.prepare("UPDATE tasks SET updatedAt = ? WHERE id = ?").run(staleTs, touchedStale.id);

      const res = await request(app).get("/api/dashboard");
      const staleIds = res.body.taskMomentum.stale.map((e: any) => e.task.id);

      expect(res.status).toBe(200);
      expect(staleIds).toContain(trueStale.id);
      expect(staleIds).not.toContain(touchedStale.id);
    } finally {
      vi.useRealTimers();
    }
  });

  it("GET /api/copilot-usage returns a safe aggregated payload", async () => {
    const copilotHome = createCopilotUsageTestHome();
    writeCopilotUsageEvents(copilotHome, "usage-session", [
      {
        type: "session.shutdown",
        timestamp: "2026-05-01T12:00:00.000Z",
        data: {
          modelMetrics: {
            "gpt-5.4": {
              requests: { count: 3, cost: 99, path: "secret-request-path", details: "secret-request-details" },
              usage: {
                inputTokens: 1_000_000,
                outputTokens: 1_000_000,
                cacheReadTokens: 1_000_000,
                cacheWriteTokens: 1_000_000,
                reasoningTokens: 1_000_000,
                path: "secret-usage-path",
                details: { trace: "secret-usage-details" },
              },
              path: "secret-model-path",
              details: { raw: "secret-model-details" },
            },
            "unknown-model": {
              requests: { count: 1 },
              usage: {
                inputTokens: 100,
                outputTokens: 50,
                cacheReadTokens: 5,
                cacheWriteTokens: 10,
                reasoningTokens: 25,
              },
            },
          },
        },
        path: "secret-event-path",
        details: { trace: "secret-event-details" },
      },
    ]);
    ({ app } = createTestApp({ copilotHome }));

    const res = await request(app).get("/api/copilot-usage");
    const pricedTotals = expectedUsageTotals({
      requests: 3,
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
      reasoningTokens: 1_000_000,
      totalTokens: 5_000_000,
    });
    const unpricedTotals = expectedUsageTotals({
      requests: 1,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 5,
      cacheWriteTokens: 10,
      reasoningTokens: 25,
      totalTokens: 190,
    });
    const aggregateTotals = expectedUsageTotals({
      requests: 4,
      inputTokens: 1_000_100,
      outputTokens: 1_000_050,
      cacheReadTokens: 1_000_005,
      cacheWriteTokens: 1_000_010,
      reasoningTokens: 1_000_025,
      totalTokens: 5_000_190,
    });
    const pricedCostBreakdownUsd = expectedCostBreakdownUsd({
      input: 2.5,
      cachedInput: 0.25,
      output: 15,
      reasoning: 15,
      total: 32.75,
    });
    const pricedCostEstimate = expectedCostEstimate({
      costBreakdownUsd: pricedCostBreakdownUsd,
      billableOutputTokens: 2_000_000,
    });
    const unpricedCostEstimate = expectedCostEstimate({ billableOutputTokens: 75 });
    const aggregateCostEstimate = expectedCostEstimate({
      costBreakdownUsd: pricedCostBreakdownUsd,
      billableOutputTokens: 2_000_075,
    });
    const pricedModelRow = {
      model: "gpt-5.4",
      sessions: 1,
      ...pricedTotals,
      ...pricedCostEstimate,
      pricingKey: "gpt-5.4",
      pricedAs: "gpt-5.4",
      pricingStatus: "exact",
      pricingSource: "exact",
      normalizedPricingModel: "gpt-5.4",
    };
    const unpricedModelRow = {
      model: "unknown-model",
      sessions: 1,
      ...unpricedTotals,
      ...unpricedCostEstimate,
      pricingKey: null,
      pricedAs: null,
      pricingStatus: "unpriced",
      pricingSource: "unpriced",
      normalizedPricingModel: "unknown-model",
    };
    const unpricedModelReportRow = {
      model: "unknown-model",
      sessions: 1,
      ...unpricedTotals,
      pricingKey: null,
      pricedAs: null,
      pricingStatus: "unpriced",
      pricingSource: "unpriced",
      normalizedPricingModel: "unknown-model",
    };

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      generatedAt: expect.any(String),
      totals: {
        ...aggregateTotals,
        ...aggregateCostEstimate,
        unpricedModelCount: 1,
        unpricedTokens: unpricedTotals,
      },
      coverage: {
        sessionsSeen: 1,
        sessionsWithEvents: 1,
        sessionsIncluded: 1,
        sessionsSkipped: 0,
        skippedByReason: {
          no_events: 0,
          no_shutdown: 0,
          empty_model_metrics: 0,
          parse_error: 0,
        },
        earliestIncludedAt: "2026-05-01T12:00:00.000Z",
        latestIncludedAt: "2026-05-01T12:00:00.000Z",
        earliestSkippedAt: null,
        latestSkippedAt: null,
      },
      models: [
        pricedModelRow,
        unpricedModelRow,
      ],
      sessions: [
        {
          sessionId: "usage-session",
          shutdownAt: "2026-05-01T12:00:00.000Z",
          ...aggregateTotals,
          ...aggregateCostEstimate,
          models: [
            pricedModelRow,
            unpricedModelRow,
          ],
          unpricedModels: [unpricedModelReportRow],
        },
      ],
      unpricedModels: [unpricedModelReportRow],
    });
    expect(res.body.totals).not.toHaveProperty("cost");
    expect(res.body.models[0]).not.toHaveProperty("cost");
    expect(res.body.models[0]).not.toHaveProperty("path");
    expect(res.body.models[0]).not.toHaveProperty("details");
    expect(res.body.sessions[0]).not.toHaveProperty("path");
    expect(res.body.sessions[0]).not.toHaveProperty("details");
    expect(JSON.stringify(res.body)).not.toContain(copilotHome);
    expect(JSON.stringify(res.body)).not.toContain("secret-");
  });

  it("GET /api/copilot-usage resolves observed SDK model IDs through listModels metadata", async () => {
    const copilotHome = createCopilotUsageTestHome();
    writeCopilotUsageEvents(copilotHome, "usage-session", [
      {
        type: "session.shutdown",
        timestamp: "2026-05-01T13:00:00.000Z",
        data: {
          modelMetrics: {
            "opaque-sdk-id": {
              requests: { count: 1 },
              usage: { inputTokens: 1_000_000, outputTokens: 1_000_000 },
            },
          },
        },
      },
    ]);
    const listModels = vi.fn(async () => [{
      id: "opaque-sdk-id",
      name: "Claude Opus 4.7",
      billing: { note: "secret-sdk-field" },
    }]);
    ({ app } = createTestApp({
      copilotHome,
      sessionManager: { ...createMockSessionManager(), listModels },
    }));

    const res = await request(app).get("/api/copilot-usage");

    expect(res.status).toBe(200);
    expect(listModels).toHaveBeenCalledTimes(1);
    expect(res.body.models[0]).toMatchObject({
      model: "opaque-sdk-id",
      pricingKey: "claude-opus-4.7",
      pricedAs: "claude-opus-4.7",
      pricingStatus: "sdk-name",
      pricingSource: "sdk-name",
      normalizedPricingModel: "claude-opus-4.7",
    });
    expect(res.body.models[0].estimatedCostUsd).toBeCloseTo(30);
    expect(res.body.totals.unpricedModelCount).toBe(0);
    expect(JSON.stringify(res.body)).not.toContain("secret-sdk-field");
  });

  it("GET /api/copilot-usage resolves SDK model objects through their serialized metadata", async () => {
    const copilotHome = createCopilotUsageTestHome();
    writeCopilotUsageEvents(copilotHome, "usage-session", [
      {
        type: "session.shutdown",
          timestamp: "2026-05-01T13:30:00.000Z",
          data: {
            modelMetrics: {
            "opaque-serialized-sdk-id": {
              requests: { count: 1 },
              usage: { outputTokens: 10 },
            },
          },
        },
      },
    ]);
    const listModels = vi.fn(async () => [
      {
        toJSON: () => ({
          id: "opaque-serialized-sdk-id",
          name: "Claude Opus 4.7 (Context Low)",
          billing: { note: "secret-sdk-field" },
        }),
      },
    ]);
    ({ app } = createTestApp({
      copilotHome,
      sessionManager: { ...createMockSessionManager(), listModels },
    }));

    const res = await request(app).get("/api/copilot-usage");

    expect(res.status).toBe(200);
    expect(listModels).toHaveBeenCalledTimes(1);
    expect(res.body.models[0]).toMatchObject({
      model: "opaque-serialized-sdk-id",
      pricingKey: "claude-opus-4.7",
      pricedAs: "claude-opus-4.7",
      pricingStatus: "sdk-name",
      pricingSource: "sdk-name",
      normalizedPricingModel: "claude-opus-4.7",
    });
    expect(res.body.models[0].estimatedCostUsd).toBeCloseTo(0.00025);
    expect(res.body.totals.unpricedModelCount).toBe(0);
    expect(JSON.stringify(res.body)).not.toContain("secret-sdk-field");
  });

  it("GET /api/copilot-usage continues without SDK metadata when listModels fails", async () => {
    const copilotHome = createCopilotUsageTestHome();
    writeCopilotUsageEvents(copilotHome, "usage-session", [
      {
        type: "session.shutdown",
        timestamp: "2026-05-01T14:00:00.000Z",
        data: {
          modelMetrics: {
            "opaque-sdk-id": {
              requests: { count: 1 },
              usage: { inputTokens: 10, outputTokens: 5 },
            },
          },
        },
      },
    ]);
    const listModels = vi.fn(async () => {
      throw new Error("models unavailable");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    try {
      ({ app } = createTestApp({
        copilotHome,
        sessionManager: { ...createMockSessionManager(), listModels },
      }));

      const res = await request(app).get("/api/copilot-usage");

      expect(res.status).toBe(200);
      expect(listModels).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        "[copilot-usage] Failed to load Copilot model metadata; pricing may be incomplete.",
        expect.any(Error),
      );
      expect(res.body.models[0]).toMatchObject({
        model: "opaque-sdk-id",
        pricingKey: null,
        pricedAs: null,
        pricingStatus: "unpriced",
        pricingSource: "unpriced",
        normalizedPricingModel: "opaque-sdk-id",
        estimatedCostUsd: 0,
      });
      expect(res.body.totals.unpricedModelCount).toBe(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("GET /api/copilot-usage supports refresh=1 cache bypass", async () => {
    const copilotHome = createCopilotUsageTestHome();
    writeCopilotUsageEvents(copilotHome, "usage-session", [
      {
        type: "session.shutdown",
        timestamp: "2026-05-01T12:00:00.000Z",
        data: {
          modelMetrics: {
            "gpt-4o": {
              requests: { count: 1 },
              usage: { inputTokens: 5, outputTokens: 4 },
            },
          },
        },
      },
    ]);
    ({ app } = createTestApp({ copilotHome }));

    const initial = await request(app).get("/api/copilot-usage");
    expect(initial.status).toBe(200);
    expect(initial.body.totals.totalTokens).toBe(9);

    writeCopilotUsageEvents(copilotHome, "usage-session", [
      {
        type: "session.shutdown",
        timestamp: "2026-05-02T12:00:00.000Z",
        data: {
          modelMetrics: {
            "gpt-4o": {
              requests: { count: 2 },
              usage: { inputTokens: 20, outputTokens: 10 },
            },
          },
        },
      },
    ]);

    const cached = await request(app).get("/api/copilot-usage");
    expect(cached.status).toBe(200);
    expect(cached.body.totals.totalTokens).toBe(9);

    const refreshed = await request(app).get("/api/copilot-usage?refresh=1");
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.totals.totalTokens).toBe(30);
    expect(refreshed.body.totals.requests).toBe(2);
  });

  it("GET /api/copilot-usage reads from injected copilotHome", async () => {
    const copilotHome = createCopilotUsageTestHome({ dotDir: true });
    writeCopilotUsageEvents(copilotHome, "usage-session", [
      {
        type: "session.shutdown",
        timestamp: "2026-05-03T12:00:00.000Z",
        data: {
          modelMetrics: {
            "claude-sonnet": {
              requests: { count: 2 },
              usage: { outputTokens: 11 },
            },
          },
        },
      },
    ]);
    ({ app } = createTestApp({ copilotHome }));

    const res = await request(app).get("/api/copilot-usage");

    expect(res.status).toBe(200);
    expect(res.body.models).toEqual([
      expect.objectContaining({
        model: "claude-sonnet",
        requests: 2,
        totalTokens: 11,
      }),
    ]);
  });

  it("GET /api/copilot-usage handles zero-includable histories cleanly", async () => {
    const copilotHome = createCopilotUsageTestHome();
    mkdirSync(join(copilotHome, "session-state", "no-events"), { recursive: true });
    writeCopilotUsageEvents(copilotHome, "no-shutdown", [
      { type: "assistant.message", timestamp: "2026-05-04T12:00:00.000Z", data: { content: "still running" } },
    ]);
    writeCopilotUsageEvents(copilotHome, "empty-metrics", [
      {
        type: "session.shutdown",
        timestamp: "2026-05-04T13:00:00.000Z",
        data: { modelMetrics: {} },
      },
    ]);
    ({ app } = createTestApp({ copilotHome }));

    const res = await request(app).get("/api/copilot-usage");

    expect(res.status).toBe(200);
    expect(res.body.totals).toEqual({
      ...expectedUsageTotals(),
      ...expectedCostEstimate(),
      unpricedModelCount: 0,
      unpricedTokens: expectedUsageTotals(),
    });
    expect(res.body.models).toEqual([]);
    expect(res.body.unpricedModels).toEqual([]);
    expect(res.body.coverage).toEqual({
      sessionsSeen: 3,
      sessionsWithEvents: 2,
      sessionsIncluded: 0,
      sessionsSkipped: 3,
      skippedByReason: {
        no_events: 1,
        no_shutdown: 1,
        empty_model_metrics: 1,
        parse_error: 0,
      },
      earliestIncludedAt: null,
      latestIncludedAt: null,
      earliestSkippedAt: "2026-05-04T13:00:00.000Z",
      latestSkippedAt: "2026-05-04T13:00:00.000Z",
    });
  });

  it("GET /api/copilot-usage omits malformed shutdown timestamps from coverage fields", async () => {
    const copilotHome = createCopilotUsageTestHome();
    writeCopilotUsageEvents(copilotHome, "usage-session", [
      {
        type: "session.shutdown",
        timestamp: "not-a-real-timestamp",
        data: {
          modelMetrics: {
            "gpt-4o": {
              requests: { count: 2 },
              usage: { inputTokens: 7, outputTokens: 5 },
            },
          },
        },
      },
    ]);
    ({ app } = createTestApp({ copilotHome }));

    const res = await request(app).get("/api/copilot-usage");

    expect(res.status).toBe(200);
    expect(res.body.totals.totalTokens).toBe(12);
    expect(res.body.coverage).toEqual({
      sessionsSeen: 1,
      sessionsWithEvents: 1,
      sessionsIncluded: 1,
      sessionsSkipped: 0,
      skippedByReason: {
        no_events: 0,
        no_shutdown: 0,
        empty_model_metrics: 0,
        parse_error: 0,
      },
      earliestIncludedAt: null,
      latestIncludedAt: null,
      earliestSkippedAt: null,
      latestSkippedAt: null,
    });
  });

  it("GET /api/copilot-usage keeps earlier persisted shutdown summaries when a session resumes", async () => {
    const copilotHome = createCopilotUsageTestHome();
    writeCopilotUsageEvents(copilotHome, "usage-session", [
      {
        type: "session.shutdown",
        timestamp: "2026-05-05T08:00:00.000Z",
        data: {
          modelMetrics: {
            "gpt-4o": {
              requests: { count: 2 },
              usage: { inputTokens: 10, outputTokens: 3 },
            },
          },
        },
      },
      {
        type: "assistant.message",
        timestamp: "2026-05-05T08:05:00.000Z",
        data: { content: "session resumed" },
      },
      {
        type: "session.shutdown",
        timestamp: "2026-05-05T09:00:00.000Z",
        data: {
          modelMetrics: {
            o3: {
              requests: { count: 1 },
              usage: { reasoningTokens: 6 },
            },
          },
        },
      },
      {
        type: "assistant.message",
        timestamp: "2026-05-05T09:05:00.000Z",
        data: { content: "active tail" },
      },
    ]);
    ({ app } = createTestApp({ copilotHome }));

    const res = await request(app).get("/api/copilot-usage");

    expect(res.status).toBe(200);
    expect(res.body.totals).toEqual({
      ...expectedUsageTotals({
        requests: 3,
        inputTokens: 10,
        outputTokens: 3,
        reasoningTokens: 6,
        totalTokens: 19,
      }),
      ...expectedCostEstimate({ billableOutputTokens: 9 }),
      unpricedModelCount: 2,
      unpricedTokens: expectedUsageTotals({
        requests: 3,
        inputTokens: 10,
        outputTokens: 3,
        reasoningTokens: 6,
        totalTokens: 19,
      }),
    });
    expect(res.body.coverage).toEqual({
      sessionsSeen: 1,
      sessionsWithEvents: 1,
      sessionsIncluded: 1,
      sessionsSkipped: 0,
      skippedByReason: {
        no_events: 0,
        no_shutdown: 0,
        empty_model_metrics: 0,
        parse_error: 0,
      },
      earliestIncludedAt: "2026-05-05T08:00:00.000Z",
      latestIncludedAt: "2026-05-05T09:00:00.000Z",
      earliestSkippedAt: null,
      latestSkippedAt: null,
    });
  });

  it("GET /api/copilot-usage ignores malformed active tail lines after shutdown summaries", async () => {
    const copilotHome = createCopilotUsageTestHome();
    writeRawCopilotUsageEvents(copilotHome, "usage-session", [
      JSON.stringify({
        type: "session.shutdown",
        timestamp: "2026-05-06T08:00:00.000Z",
        data: {
          modelMetrics: {
            "gpt-4o": {
              requests: { count: 2 },
              usage: { inputTokens: 10, outputTokens: 3 },
            },
          },
        },
      }),
      "{not valid json",
    ]);
    ({ app } = createTestApp({ copilotHome }));

    const res = await request(app).get("/api/copilot-usage");

    expect(res.status).toBe(200);
    expect(res.body.totals).toEqual({
      ...expectedUsageTotals({
        requests: 2,
        inputTokens: 10,
        outputTokens: 3,
        totalTokens: 13,
      }),
      ...expectedCostEstimate({ billableOutputTokens: 3 }),
      unpricedModelCount: 1,
      unpricedTokens: expectedUsageTotals({
        requests: 2,
        inputTokens: 10,
        outputTokens: 3,
        totalTokens: 13,
      }),
    });
    expect(res.body.coverage).toEqual({
      sessionsSeen: 1,
      sessionsWithEvents: 1,
      sessionsIncluded: 1,
      sessionsSkipped: 0,
      skippedByReason: {
        no_events: 0,
        no_shutdown: 0,
        empty_model_metrics: 0,
        parse_error: 0,
      },
      earliestIncludedAt: "2026-05-06T08:00:00.000Z",
      latestIncludedAt: "2026-05-06T08:00:00.000Z",
      earliestSkippedAt: null,
      latestSkippedAt: null,
    });
  });

  it("GET /api/copilot-usage returns a safe error for unreadable session-state", async () => {
    const copilotHome = createCopilotUsageTestHome();
    writeFileSync(join(copilotHome, "session-state"), "not a directory");
    ({ app } = createTestApp({ copilotHome }));

    const res = await request(app).get("/api/copilot-usage");

    expect(res.status).toBe(500);
    expect(res.body).toEqual({ error: "Unable to read local Copilot usage history." });
    expect(JSON.stringify(res.body)).not.toContain(copilotHome);
  });
});

// ── Error handling ───────────────────────────────────────────────

describe("Error handling", () => {
  it("PATCH /api/tasks/:id returns 404 for nonexistent task", async () => {
    const res = await request(app)
      .patch("/api/tasks/nonexistent")
      .send({ title: "Nope" });
    expect(res.status).toBe(404);
  });

  it("POST /api/tasks/:id/link returns error for nonexistent task", async () => {
    const res = await request(app)
      .post("/api/tasks/nonexistent/link")
      .send({ type: "session", sessionId: "s1" });
    expect([400, 404]).toContain(res.status);
  });

  it("DELETE /api/tasks/:id/link returns error for nonexistent task", async () => {
    const res = await request(app)
      .delete("/api/tasks/nonexistent/link")
      .send({ type: "session", sessionId: "s1" });
    expect([400, 404]).toContain(res.status);
  });
});

// ── Session archive/delete (store-based) ─────────────────────────

describe("Session metadata routes", () => {
  it("PATCH /api/sessions/:id archives a session", async () => {
    const res = await request(app)
      .patch("/api/sessions/test-sess")
      .send({ archived: true });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.archived).toBe(true);
  });

  it("PATCH /api/sessions/:id unarchives a session", async () => {
    await request(app)
      .patch("/api/sessions/test-sess")
      .send({ archived: true });

    const res = await request(app)
      .patch("/api/sessions/test-sess")
      .send({ archived: false });
    expect(res.status).toBe(200);
    expect(res.body.archived).toBe(false);
  });

  it("DELETE /api/sessions/:id deletes a session", async () => {
    const res = await request(app).delete("/api/sessions/some-sess");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("POST /api/sessions/batch archives multiple sessions", async () => {
    const res = await request(app)
      .post("/api/sessions/batch")
      .send({ sessionIds: ["s1", "s2"], action: "archive" });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });

  it("POST /api/sessions/batch invalidates the cached session list after archiving", async () => {
    ctx.sessionManager.listSessionsFromDisk = async () => [
      { sessionId: "s1", summary: "Session one", startTime: "2026-04-19T00:00:00.000Z", lastVisibleActivityAt: "2026-04-19T00:00:00.000Z" } as any,
      { sessionId: "s2", summary: "Session two", startTime: "2026-04-19T00:00:00.000Z", lastVisibleActivityAt: "2026-04-19T00:00:00.000Z" } as any,
    ];
    ctx.readStateStore.markRead("s1");
    ctx.readStateStore.markRead("s2");

    const before = await request(app).get("/api/sessions");
    expect(before.status).toBe(200);
    expect(before.body.sessions.map((session: { sessionId: string }) => session.sessionId)).toEqual(["s1", "s2"]);

    const archive = await request(app)
      .post("/api/sessions/batch")
      .send({ sessionIds: ["s1"], action: "archive" });
    expect(archive.status).toBe(200);
    expect(archive.body.ok).toBe(true);

    const after = await request(app).get("/api/sessions");
    expect(after.status).toBe(200);
    expect(after.body.sessions.map((session: { sessionId: string }) => session.sessionId)).toEqual(["s2"]);
  });

  it("POST /api/sessions/batch requires sessionIds", async () => {
    const res = await request(app)
      .post("/api/sessions/batch")
      .send({ action: "archive" });
    expect(res.status).toBe(400);
  });

  it("POST /api/sessions/batch marks sessions read", async () => {
    const res = await request(app)
      .post("/api/sessions/batch")
      .send({ sessionIds: ["s1"], action: "markRead" });
    expect(res.status).toBe(200);
  });
});

// ── Session manager routes (mock-based) ──────────────────────────

describe("Session manager routes", () => {
  it("GET /api/sessions/:id/messages returns paginated messages", async () => {
    const res = await request(app).get("/api/sessions/test-id/messages");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("messages");
    expect(res.body).toHaveProperty("total");
    expect(res.body).toHaveProperty("hasMore");
    expect(res.body).toHaveProperty("runState");
    expect(res.body).toHaveProperty("busy");
  });

  it("GET /api/sessions/:id/messages returns runState for stalled sessions", async () => {
    ctx.sessionManager.getSessionRunState = vi.fn().mockReturnValue("stalled");
    ctx.sessionManager.isSessionBusy = vi.fn().mockReturnValue(true);

    const res = await request(app).get("/api/sessions/test-id/messages");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ runState: "stalled", busy: true });
  });

  it("GET /api/sessions/:id/messages includes visible activity metadata", async () => {
    ctx.sessionManager.getSessionMessages = vi.fn().mockResolvedValue({
      messages: [],
      total: 0,
      hasMore: false,
      lastVisibleActivityAt: "2026-04-29T12:00:00.000Z",
    });

    const res = await request(app).get("/api/sessions/test-id/messages");

    expect(res.status).toBe(200);
    expect(res.body.lastVisibleActivityAt).toBe("2026-04-29T12:00:00.000Z");
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
    expect(sessionManager.setSessionName).toHaveBeenCalledWith("bounded-fork", "Fork from Original session");
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

  it("POST /api/sessions/:id/fork seeds the forked title from the source summary", async () => {
    const sessionManager = createMockSessionManager();
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

    const res = await request(app).post("/api/sessions/test-id/fork");

    expect(res.status).toBe(200);
    expect(sessionManager.setSessionName).toHaveBeenCalledWith("fork-session", "Fork of Original session");
  });

  it("POST /api/sessions/:id/fork preserves all task links from the source session", async () => {
    const sessionManager = createMockSessionManager();
    ({ app, ctx } = createTestApp({ sessionManager }));
    const taskA = ctx.taskStore.createTask("Task A");
    ctx.taskStore.linkSession(taskA.id, "test-id");
    const taskB = ctx.taskStore.createTask("Task B");
    ctx.taskStore.linkSession(taskB.id, "test-id");

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
});
