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

describe("Shutdown route", () => {
  it("POST /api/shutdown pauses scheduling until sessions drain, then shuts the scheduler down", async () => {
    const order: string[] = [];
    const pauseSpy = vi.spyOn(scheduler, "setGlobalPause").mockImplementation((paused: boolean) => {
      order.push(paused ? "pause" : "resume");
    });
    const shutdownSpy = vi.spyOn(scheduler, "shutdown").mockImplementation(() => {
      order.push("shutdown");
    });
    const deferredPromptRunner: DeferredPromptRunner = {
      start: vi.fn(),
      poke: vi.fn(),
      shutdown: vi.fn(() => {
        order.push("deferred");
      }),
    };
    ctx.deferredPromptRunner = deferredPromptRunner;
    ctx.sessionManager.gracefulShutdown = vi.fn(async () => {
      order.push("graceful");
    });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as any);
    try {
      const res = await request(app)
        .post("/api/shutdown")
        .send({});
      await Promise.resolve();

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, message: "Shutting down..." });
      expect(order).toEqual(["pause", "deferred", "graceful", "shutdown"]);
    } finally {
      pauseSpy.mockRestore();
      shutdownSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});

describe("Session stream route", () => {
  it("GET /api/sessions/:id/stream replays completed runs as terminal SSE events", async () => {
    const bus = ctx.eventBusRegistry.getOrCreateBus("session-123");
    bus.emit({ type: "done", content: "Run finished" });

    const res = await request(app)
      .get("/api/sessions/session-123/stream");

    expect(res.status).toBe(200);
    expect(res.text).toContain('data: {"type":"done","content":"Run finished"}');
    expect(res.text).not.toContain('"type":"snapshot"');
  });

  it("GET /api/sessions/:id/stream normalizes completed snapshots emitted during subscribe", async () => {
    ctx.eventBusRegistry.getBus = vi.fn().mockReturnValue({
      subscribe(listener: (event: unknown) => void) {
        listener({
          type: "snapshot",
          complete: true,
          terminalType: "done",
          finalContent: "Run finished",
        });
        return () => {};
      },
    });

    const res = await request(app)
      .get("/api/sessions/session-123/stream");

    expect(res.status).toBe(200);
    expect(res.text).toContain('data: {"type":"done","content":"Run finished"}');
    expect(res.text).not.toContain('"type":"snapshot"');
  });

  it("GET /api/sessions/:id/stream normalizes shutdown snapshots emitted during subscribe", async () => {
    ctx.eventBusRegistry.getBus = vi.fn().mockReturnValue({
      subscribe(listener: (event: unknown) => void) {
        listener({
          type: "snapshot",
          complete: true,
          terminalType: "shutdown",
          finalContent: "Partial answer",
        });
        return () => {};
      },
    });

    const res = await request(app)
      .get("/api/sessions/session-123/stream");

    expect(res.status).toBe(200);
    expect(res.text).toContain('data: {"type":"shutdown","content":"Partial answer"}');
    expect(res.text).not.toContain('"type":"snapshot"');
  });

  it("GET /api/sessions/:id/stream includes pending user input requests in live snapshots", async () => {
    const snapshot = {
      type: "snapshot",
      accumulatedContent: "",
      activeTools: [],
      intentText: "",
      complete: false,
      pendingUserInputs: [
        {
          requestId: "request-1",
          question: "Pick one",
          choices: ["yes", "no"],
          allowFreeform: false,
          requestedAt: "2026-04-29T12:00:00.000Z",
        },
      ],
    };
    ctx.eventBusRegistry.getBus = vi.fn().mockReturnValue({
      subscribe(listener: (event: unknown) => void) {
        listener(snapshot);
        listener({ type: "done", content: "" });
        return () => {};
      },
    });

    const res = await request(app)
      .get("/api/sessions/session-123/stream");

    expect(res.status).toBe(200);
    expect(res.text).toContain(`data: ${JSON.stringify(snapshot)}`);
  });
});

describe("User input response route", () => {
  it("POST /api/sessions/:sessionId/user-input/:requestId/respond submits an answer", async () => {
    const submittedAt = "2026-04-29T12:34:56.000Z";
    const submitUserInputResponse = vi.fn().mockResolvedValue({
      requestId: "request-1",
      answer: "yes",
      wasFreeform: false,
      timestamp: submittedAt,
    });
    ctx.sessionManager.submitUserInputResponse = submitUserInputResponse;

    const res = await request(app)
      .post("/api/sessions/session-123/user-input/request-1/respond")
      .send({ answer: "yes", wasFreeform: false });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      requestId: "request-1",
      answer: "yes",
      wasFreeform: false,
      timestamp: submittedAt,
    });
    expect(submitUserInputResponse).toHaveBeenCalledWith(
      "session-123",
      "request-1",
      { answer: "yes", wasFreeform: false },
    );
  });

  it("POST /api/sessions/:sessionId/user-input/:requestId/respond maps broker validation errors", async () => {
    ctx.sessionManager.submitUserInputResponse = vi.fn().mockRejectedValue(
      new UserInputBrokerError("invalid_response", "Response answer cannot be blank"),
    );

    const res = await request(app)
      .post("/api/sessions/session-123/user-input/request-1/respond")
      .send({ answer: " ", wasFreeform: true });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "Response answer cannot be blank",
      code: "invalid_response",
    });
  });

  it("POST /api/sessions/:sessionId/user-input/:requestId/respond maps missing requests", async () => {
    ctx.sessionManager.submitUserInputResponse = vi.fn().mockRejectedValue(
      new UserInputBrokerError("request_not_found", "Pending user input request not found", { statusCode: 404 }),
    );

    const res = await request(app)
      .post("/api/sessions/session-123/user-input/missing/respond")
      .send({ answer: "yes", wasFreeform: false });

    expect(res.status).toBe(404);
    expect(res.body).toEqual({
      error: "Pending user input request not found",
      code: "request_not_found",
    });
  });
});

describe("Status stream", () => {
  it("GET /api/status-stream forwards stalled session events", async () => {
    const server = app.listen(0);
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Unable to determine test server port");

      const body = await new Promise<string>((resolve, reject) => {
        const req = get(`http://127.0.0.1:${address.port}/api/status-stream`, (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            text += chunk;
            if (text.includes('"type":"session:stalled","sessionId":"session-123"')) {
              req.destroy();
              resolve(text);
            }
          });
          res.on("error", reject);
          queueMicrotask(() => {
            ctx.globalBus.emit({ type: "session:stalled", sessionId: "session-123" });
          });
        });
        req.on("error", (error: NodeJS.ErrnoException) => {
          if (error.code === "ECONNRESET") return;
          reject(error);
        });
      });

      expect(body).toContain('data: {"type":"session:stalled","sessionId":"session-123"}');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("GET /api/status-stream forwards user-input status events", async () => {
    const server = app.listen(0);
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Unable to determine test server port");

      const body = await new Promise<string>((resolve, reject) => {
        const req = get(`http://127.0.0.1:${address.port}/api/status-stream`, (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            text += chunk;
            if (text.includes('"type":"session:user-input","sessionId":"session-123"')) {
              req.destroy();
              resolve(text);
            }
          });
          res.on("error", reject);
          queueMicrotask(() => {
            ctx.globalBus.emit({
              type: "session:user-input",
              sessionId: "session-123",
              pendingUserInputCount: 1,
              needsUserInput: true,
            });
          });
        });
        req.on("error", (error: NodeJS.ErrnoException) => {
          if (error.code === "ECONNRESET") return;
          reject(error);
        });
      });

      expect(body).toContain('data: {"type":"session:user-input","sessionId":"session-123","pendingUserInputCount":1,"needsUserInput":true}');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("GET /api/status-stream seeds restart-pending from persisted restart state", async () => {
    const runtimePaths = createRestartRuntimePaths();
    await writeRestartState(join(runtimePaths.dataDir, "restart-state.json"), {
      requestId: "req-status-stream",
      phase: "waiting-for-sessions",
      requestedAt: "2026-04-24T12:00:00.000Z",
      waitingSessions: 2,
      launcherHeartbeatAt: null,
    });
    ({ app, ctx } = createTestApp({ runtimePaths }));

    const server = app.listen(0);
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Unable to determine test server port");

      const body = await new Promise<string>((resolve, reject) => {
        const req = get(`http://127.0.0.1:${address.port}/api/status-stream`, (res) => {
          let text = "";
          res.setEncoding("utf8");
          res.on("data", (chunk) => {
            text += chunk;
            if (
              text.includes('"type":"server:restart-pending"')
              && text.includes('"waitingSessions":2')
              && text.includes('"phase":"waiting-for-sessions"')
              && text.includes('"canAcceptNewWork":true')
              && text.includes('"serverInstanceId"')
            ) {
              req.destroy();
              resolve(text);
            }
          });
          res.on("error", reject);
        });
        req.on("error", (error: NodeJS.ErrnoException) => {
          if (error.code === "ECONNRESET") return;
          reject(error);
        });
      });

      expect(body).toContain('"type":"server:restart-pending"');
      expect(body).toContain('"waitingSessions":2');
      expect(body).toContain('"phase":"waiting-for-sessions"');
      expect(body).toContain('"canAcceptNewWork":true');
      expect(body).toContain('"serverInstanceId"');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it("GET /api/restart-status returns persisted restart state", async () => {
    const runtimePaths = createRestartRuntimePaths();
    await writeRestartState(join(runtimePaths.dataDir, "restart-state.json"), {
      requestId: "req-restart-status",
      phase: "waiting-for-sessions",
      requestedAt: "2026-04-24T12:00:00.000Z",
      waitingSessions: 2,
      launcherHeartbeatAt: null,
    });
    ({ app, ctx } = createTestApp({ runtimePaths }));

    const res = await request(app).get("/api/restart-status");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      pending: true,
      phase: "waiting-for-sessions",
      requestedAt: "2026-04-24T12:00:00.000Z",
      serverInstanceId: expect.any(String),
      waitingSessions: 2,
      canAcceptNewWork: true,
    });
  });

  it("GET /api/restart-status returns idle state when no restart is pending", async () => {
    const runtimePaths = createRestartRuntimePaths();
    ({ app, ctx } = createTestApp({ runtimePaths }));

    const res = await request(app).get("/api/restart-status");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      pending: false,
      phase: "idle",
      requestedAt: null,
      serverInstanceId: expect.any(String),
      waitingSessions: 0,
      canAcceptNewWork: true,
    });
  });
});

describe("Attachment routes", () => {
  const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  it("GET /api/sessions/:id/attachments/:attachmentId downloads non-inline attachments", async () => {
    const copilotHome = makeTestDir("route-home");
    const { app: attachmentApp } = createTestApp({ copilotHome });
    const published = publishOutboundAttachment({
      copilotHome,
      sessionId,
      content: "hello from bridge",
      displayName: "note.md",
    });
    if (!published.ok) throw new Error(published.error);

    const res = await request(attachmentApp)
      .get(`/api/sessions/${sessionId}/attachments/${encodeURIComponent(published.value.attachmentId)}`);

    expect(res.status).toBe(200);
    expect(res.text).toBe("hello from bridge");
    expect(res.headers["content-disposition"]).toContain("attachment;");
  });

  it("GET /api/sessions/:id/attachments/:attachmentId serves raster images inline", async () => {
    const copilotHome = makeTestDir("route-home");
    const { app: attachmentApp } = createTestApp({ copilotHome });
    const published = publishOutboundAttachment({
      copilotHome,
      sessionId,
      content: "not-a-real-png",
      displayName: "chart.png",
    });
    if (!published.ok) throw new Error(published.error);

    const res = await request(attachmentApp)
      .get(`/api/sessions/${sessionId}/attachments/${encodeURIComponent(published.value.attachmentId)}`);

    expect(res.status).toBe(200);
    expect(res.headers["content-type"]).toMatch(/^image\/png/);
    expect(res.headers["content-disposition"]).toBeUndefined();
  });

  it("GET /api/sessions/:id/attachments/:attachmentId serves files from dot-directory copilot homes", async () => {
    const parent = makeTestDir("route-home");
    const copilotHome = join(parent, ".copilot");
    const { app: attachmentApp } = createTestApp({ copilotHome });
    const published = publishOutboundAttachment({
      copilotHome,
      sessionId,
      content: "hello from dot copilot",
      displayName: "note.txt",
    });
    if (!published.ok) throw new Error(published.error);

    const res = await request(attachmentApp)
      .get(`/api/sessions/${sessionId}/attachments/${encodeURIComponent(published.value.attachmentId)}`);

    expect(res.status).toBe(200);
    expect(res.text).toBe("hello from dot copilot");
  });

  it("GET /api/sessions/:id/attachments/:attachmentId rejects invalid attachment ids", async () => {
    const copilotHome = makeTestDir("route-home");
    const { app: attachmentApp } = createTestApp({ copilotHome });

    const res = await request(attachmentApp)
      .get(`/api/sessions/${sessionId}/attachments/..secret.txt`);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("invalid");
  });

  it("GET /api/sessions/:id/attachments/:attachmentId rejects traversal in session ids", async () => {
    const copilotHome = makeTestDir("route-home");
    const { app: attachmentApp } = createTestApp({ copilotHome });
    const victimSessionId = "11111111-1111-1111-1111-111111111111";
    const published = publishOutboundAttachment({
      copilotHome,
      sessionId: victimSessionId,
      content: "leak",
      displayName: "secret.txt",
    });
    if (!published.ok) throw new Error(published.error);

    const res = await request(attachmentApp)
      .get(`/api/sessions/x%2F..%2F${victimSessionId}/attachments/secret.txt`);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("sessionId");
  });

  it("GET /api/sessions/:id/attachments/:attachmentId returns 404 for missing attachments", async () => {
    const copilotHome = makeTestDir("route-home");
    const { app: attachmentApp } = createTestApp({ copilotHome });

    const res = await request(attachmentApp)
      .get(`/api/sessions/${sessionId}/attachments/missing.txt`);

    expect(res.status).toBe(404);
    expect(res.body.error).toContain("not found");
  });
});

describe("Telemetry routes", () => {
  it("POST /api/telemetry records a single client span", async () => {
    const res = await request(app)
      .post("/api/telemetry")
      .send({ name: "page.load", duration: 42, metadata: { page: "dashboard" } });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(ctx.telemetryStore!.querySpans({ name: "page.load", source: "client" })).toHaveLength(1);
  });

  it("POST /api/telemetry/batch records multiple client spans", async () => {
    const res = await request(app)
      .post("/api/telemetry/batch")
      .send({
        spans: [
          { id: "span-1", name: "api.tasks", duration: 12 },
          { id: "span-2", name: "api.task-groups", duration: 18, sessionId: "sess-1", metadata: { count: 3 } },
        ],
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true, accepted: 2 });
    const spans = ctx.telemetryStore!.querySpans({ source: "client", limit: 10 });
    expect(spans).toHaveLength(2);
  });

  it("POST /api/telemetry/batch ignores duplicate span ids", async () => {
    const payload = {
      spans: [
        { id: "span-1", name: "api.tasks", duration: 12 },
        { id: "span-2", name: "api.task-groups", duration: 18 },
      ],
    };

    const first = await request(app).post("/api/telemetry/batch").send(payload);
    const second = await request(app).post("/api/telemetry/batch").send(payload);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(ctx.telemetryStore!.querySpans({ source: "client", limit: 10 })).toHaveLength(2);
  });

  it("POST /api/telemetry/batch rejects invalid spans", async () => {
    const res = await request(app)
      .post("/api/telemetry/batch")
      .send({ spans: [{ name: "ok", duration: 10 }, { name: 123, duration: 5 }] });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("index 1");
    expect(ctx.telemetryStore!.querySpans({ source: "client" })).toHaveLength(0);
  });
});

describe("Dashboard route", () => {
  it("overlays fresh session meta activity onto cached disk sessions", async () => {
    const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    ctx.sessionManager.listSessionsFromDisk = vi.fn().mockResolvedValue([
      {
        sessionId,
        summary: "Cached session",
        lastVisibleActivityAt: "2026-04-30T10:00:00.000Z",
        modifiedTime: "2026-04-30T10:00:00.000Z",
      },
    ]);
    ctx.sessionMetaStore.setLastVisibleActivityAt(sessionId, "2026-04-30T11:00:00.000Z");

    const res = await request(app).get("/api/dashboard");

    expect(res.status).toBe(200);
    expect(res.body.orphanSessions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId,
          lastVisibleActivityAt: "2026-04-30T11:00:00.000Z",
          unread: true,
        }),
      ]),
    );
  });
});
