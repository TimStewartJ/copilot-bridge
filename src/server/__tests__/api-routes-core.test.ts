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
  PendingInteractionError,
  publishOutboundAttachment,
  RESTART_PENDING_MESSAGE,
  request,
  scheduler,
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
    // The shutdown route sends its HTTP response BEFORE awaiting the
    // graceful-shutdown chain and finally calling process.exit. If we restore
    // exitSpy before that async chain finishes, the unmocked process.exit(0)
    // can fire in this worker — or in the next worker that reuses this
    // process — and silently kill it ("Worker exited unexpectedly"). Resolve
    // exitFired only when the handler actually reaches process.exit so the
    // spy stays in place for the entire async tail.
    let resolveExitFired: () => void = () => undefined;
    const exitFired = new Promise<void>((resolve) => { resolveExitFired = resolve; });
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      order.push(`exit:${code ?? 0}`);
      resolveExitFired();
      return undefined as never;
    }) as any);
    try {
      const res = await request(app)
        .post("/api/shutdown")
        .send({});
      await exitFired;

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ ok: true, message: "Shutting down..." });
      expect(order).toEqual(["pause", "deferred", "graceful", "shutdown", "exit:0"]);
    } finally {
      pauseSpy.mockRestore();
      shutdownSpy.mockRestore();
      exitSpy.mockRestore();
    }
  });
});

describe("Session stream route", () => {
  it("GET /api/sessions/:id/stream replays completed runs as ephemeral snapshots", async () => {
    const bus = ctx.eventBusRegistry.getOrCreateBus("session-123");
    bus.emit({ type: "done", content: "Run finished" });

    const res = await request(app)
      .get("/api/sessions/session-123/stream");

    expect(res.status).toBe(200);
    expect(res.text).toContain('"type":"snapshot"');
    expect(res.text).toContain('"terminalType":"done"');
    // A locally-answered run has no SDK terminal event, so its output survives as a run notice.
    expect(res.text).toContain('"runNotice"');
    expect(res.text).toContain('"kind":"command"');
    expect(res.text).toContain('"content":"Run finished"');
    // Nothing that events.jsonl already owns is re-projected onto the stream.
    expect(res.text).not.toContain('"finalAssistantEntry"');
    expect(res.text).not.toContain('"currentTurnTools"');
    expect(res.text).not.toContain('"entryOrder"');
  });

  it("GET /api/sessions/:id/stream leaves terminal completion cards to disk history", async () => {
    const bus = ctx.eventBusRegistry.getOrCreateBus("session-123");
    bus.emit({
      type: "done",
      content: "Task summary",
      terminalCompletion: {
        content: "Task summary",
        title: "Task complete",
        status: "success",
        sourceEventType: "session.task_complete",
      },
    });

    const res = await request(app)
      .get("/api/sessions/session-123/stream");

    expect(res.status).toBe(200);
    expect(res.text).toContain('"type":"snapshot"');
    // The completion card is replayed from events.jsonl, so the stream carries no copy of it.
    expect(res.text).not.toContain('"terminalCompletion"');
    expect(res.text).not.toContain('"runNotice"');
  });

  it("GET /api/sessions/:id/stream forwards completed snapshots without transport normalization", async () => {
    ctx.eventBusRegistry.getBus = vi.fn().mockReturnValue({
      subscribeWithSnapshot() {
        return {
          snapshot: {
          type: "snapshot",
          complete: true,
          terminalType: "done",
          finalContent: "Run finished",
          },
          unsubscribe: () => {},
        };
      },
    });

    const res = await request(app)
      .get("/api/sessions/session-123/stream");

    expect(res.status).toBe(200);
    expect(res.text).toContain('"type":"snapshot"');
    expect(res.text).toContain('"finalContent":"Run finished"');
  });

  it("GET /api/sessions/:id/stream forwards shutdown snapshots", async () => {
    ctx.eventBusRegistry.getBus = vi.fn().mockReturnValue({
      subscribeWithSnapshot() {
        return {
          snapshot: {
            type: "snapshot",
            complete: true,
            terminalType: "shutdown",
            finalContent: "Partial answer",
          },
          unsubscribe: () => {},
        };
      },
    });

    const res = await request(app)
      .get("/api/sessions/session-123/stream");

    expect(res.status).toBe(200);
    expect(res.text).toContain('"type":"snapshot"');
    expect(res.text).toContain('"terminalType":"shutdown"');
    expect(res.text).toContain('"finalContent":"Partial answer"');
  });

  it("GET /api/sessions/:id/stream forwards a pending terminal completion on an aborted snapshot replay", async () => {
    ctx.eventBusRegistry.getBus = vi.fn().mockReturnValue({
      subscribeWithSnapshot() {
        return {
          snapshot: {
            type: "snapshot",
            complete: true,
            terminalType: "aborted",
            finalContent: "Partial answer",
            terminalCompletion: {
              content: "Wrapped up before abort",
              title: "Task complete",
              status: "success",
              sourceEventType: "tool.execution_complete",
            },
          },
          unsubscribe: () => {},
        };
      },
    });

    const res = await request(app)
      .get("/api/sessions/session-123/stream");

    expect(res.status).toBe(200);
    expect(res.text).toContain('"type":"snapshot"');
    expect(res.text).toContain('"terminalType":"aborted"');
    expect(res.text).toContain('"terminalCompletion"');
    expect(res.text).toContain('"content":"Wrapped up before abort"');
  });

  it("GET /api/sessions/:id/stream replays a persisted run notice without rebuilding transcript content", async () => {
    ctx.sessionMetaStore.setTerminalOverlay("session-123", {
      type: "shutdown",
      runId: "run-1",
      turnId: "provider-turn-1",
      timestamp: "2026-07-23T16:00:00.000Z",
      notice: { kind: "interrupted", timestamp: "2026-07-23T16:00:00.000Z" },
    });

    const res = await request(app)
      .get("/api/sessions/session-123/stream");

    expect(res.status).toBe(200);
    expect(res.text).toContain('"type":"snapshot"');
    expect(res.text).toContain('"terminalType":"shutdown"');
    expect(res.text).toContain('"kind":"interrupted"');
    // The assistant text itself is replayed from disk, never rebuilt here.
    expect(res.text).not.toContain('"finalAssistantEntry"');
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
    ctx.sessionManager.hydratePendingInteractions = vi.fn().mockResolvedValue({
      pendingUserInputs: snapshot.pendingUserInputs,
      pendingElicitations: [],
    });
    ctx.eventBusRegistry.getBus = vi.fn().mockReturnValue({
      subscribeWithSnapshot(listener: (event: unknown) => void) {
        queueMicrotask(() => listener({ type: "done", content: "" }));
        return {
          snapshot: { ...snapshot, pendingElicitations: [] },
          unsubscribe: () => {},
        };
      },
    });

    const res = await request(app)
      .get("/api/sessions/session-123/stream");

    expect(res.status).toBe(200);
    expect(res.text).toContain('"pendingUserInputs":[{"requestId":"request-1"');
  });

  it("never lets hydration overwrite the bus snapshot's listing index", async () => {
    const busPending = {
      requestId: "request-index",
      question: "Pick one",
      choices: ["yes", "no"],
      allowFreeform: false,
      requestedAt: "2026-04-29T12:00:00.000Z",
    };
    // `subscribeWithSnapshot` is the linearization barrier, and its copy of the
    // listing index is the one buffered cancellations refer to. Hydration only
    // settles terminal cleanup; it must never replace what the barrier captured.
    ctx.sessionManager.hydratePendingInteractions = vi.fn().mockResolvedValue({
      pendingUserInputs: [],
      pendingElicitations: [],
    });
    ctx.eventBusRegistry.getBus = vi.fn().mockReturnValue({
      subscribeWithSnapshot(listener: (event: unknown) => void) {
        queueMicrotask(() => listener({ type: "done", content: "" }));
        return {
          snapshot: {
            type: "snapshot",
            complete: false,
            pendingUserInputs: [busPending],
            pendingElicitations: [],
          },
          unsubscribe: () => {},
        };
      },
    });

    const res = await request(app)
      .get("/api/sessions/session-123/stream");

    expect(res.status).toBe(200);
    expect(res.text).toContain('"pendingUserInputs":[{"requestId":"request-index"');
  });

  it("keeps the SSE stream usable when pending snapshot hydration fails", async () => {
    ctx.sessionManager.hydratePendingInteractions = vi.fn().mockRejectedValue(
      new Error("session connection closed"),
    );
    ctx.eventBusRegistry.getBus = vi.fn().mockReturnValue({
      subscribeWithSnapshot(listener: (event: unknown) => void) {
        queueMicrotask(() => listener({ type: "done", content: "" }));
        return {
          snapshot: {
            type: "snapshot",
            complete: false,
            pendingUserInputs: [],
            pendingElicitations: [],
          },
          unsubscribe: () => {},
        };
      },
    });

    const res = await request(app)
      .get("/api/sessions/session-123/stream");

    expect(res.status).toBe(200);
    expect(res.text).toContain('"type":"snapshot"');
    expect(res.text).toContain('"type":"done"');
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

  it("POST /api/sessions/:sessionId/user-input/:requestId/respond maps transport errors to status codes", async () => {
    const cases = [
      {
        label: "validation error",
        error: new PendingInteractionError("invalid_response", "Response answer cannot be blank"),
        path: "/api/sessions/session-123/user-input/request-1/respond",
        body: { answer: " ", wasFreeform: true },
        status: 400,
        expected: { error: "Response answer cannot be blank", code: "invalid_response" },
      },
      {
        label: "missing request",
        error: new PendingInteractionError("request_not_found", "Pending user input request not found", { statusCode: 404 }),
        path: "/api/sessions/session-123/user-input/missing/respond",
        body: { answer: "yes", wasFreeform: false },
        status: 404,
        expected: { error: "Pending user input request not found", code: "request_not_found" },
      },
    ];

    for (const { label, error, path, body, status, expected } of cases) {
      ctx.sessionManager.submitUserInputResponse = vi.fn().mockRejectedValue(error);
      const res = await request(app).post(path).send(body);
      expect(res.status, label).toBe(status);
      expect(res.body, label).toEqual(expected);
    }
  });
});

describe("Elicitation response route", () => {
  it("submits a sanitized elicitation response", async () => {
    const submittedAt = "2026-07-13T12:34:56.000Z";
    const submitElicitationResponse = vi.fn().mockResolvedValue({
      requestId: "el-1",
      action: "accept",
      timestamp: submittedAt,
    });
    ctx.sessionManager.submitElicitationResponse = submitElicitationResponse;

    const payload = {
      action: "accept",
      content: {
        target: "staging",
        reason: "Safer",
      },
    };
    const res = await request(app)
      .post("/api/sessions/session-123/elicitation/el-1/respond")
      .send(payload);

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      requestId: "el-1",
      action: "accept",
      timestamp: submittedAt,
    });
    expect(res.body).not.toHaveProperty("content");
    expect(submitElicitationResponse).toHaveBeenCalledWith("session-123", "el-1", payload);
  });

  it("maps elicitation validation errors", async () => {
    ctx.sessionManager.submitElicitationResponse = vi.fn().mockRejectedValue(
      new PendingInteractionError("invalid_response", "Missing required field"),
    );

    const res = await request(app)
      .post("/api/sessions/session-123/elicitation/el-1/respond")
      .send({ action: "accept", content: {} });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      error: "Missing required field",
      code: "invalid_response",
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

  it("GET /api/restart-status reports persisted restart state and falls back to idle", async () => {
    const pendingPaths = createRestartRuntimePaths();
    await writeRestartState(join(pendingPaths.dataDir, "restart-state.json"), {
      requestId: "req-restart-status",
      phase: "waiting-for-sessions",
      requestedAt: "2026-04-24T12:00:00.000Z",
      waitingSessions: 2,
      launcherHeartbeatAt: null,
    });
    ({ app, ctx } = createTestApp({ runtimePaths: pendingPaths }));

    const pending = await request(app).get("/api/restart-status");
    expect(pending.status).toBe(200);
    expect(pending.body).toEqual({
      pending: true,
      phase: "waiting-for-sessions",
      requestedAt: "2026-04-24T12:00:00.000Z",
      serverInstanceId: expect.any(String),
      waitingSessions: 2,
      canAcceptNewWork: true,
    });

    // A fresh runtime with no persisted state reports idle.
    ({ app, ctx } = createTestApp({ runtimePaths: createRestartRuntimePaths() }));

    const idle = await request(app).get("/api/restart-status");
    expect(idle.status).toBe(200);
    expect(idle.body).toEqual({
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

  it("GET /api/sessions/:id/attachments/:attachmentId rejects unsafe ids and reports missing files", async () => {
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

    // Traversal must be rejected in both the attachment id and the session id,
    // so an encoded path cannot reach another session's published files.
    const cases: [string, string, number, string][] = [
      ["invalid attachment id", `/api/sessions/${sessionId}/attachments/..secret.txt`, 400, "invalid"],
      ["traversal in session id", `/api/sessions/x%2F..%2F${victimSessionId}/attachments/secret.txt`, 400, "sessionId"],
      ["missing attachment", `/api/sessions/${sessionId}/attachments/missing.txt`, 404, "not found"],
    ];

    for (const [label, path, status, errorFragment] of cases) {
      const res = await request(attachmentApp).get(path);
      expect(res.status, label).toBe(status);
      expect(res.body.error, label).toContain(errorFragment);
    }
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

describe("Models client-info route", () => {
  it("GET /api/models/client-info reports the backend creation timestamp or null", async () => {
    for (const createdAt of ["2026-05-01T12:00:00.000Z", null]) {
      ctx.sessionManager.getBackendCreatedAt = () => createdAt;
      const res = await request(app).get("/api/models/client-info");
      expect(res.status, String(createdAt)).toBe(200);
      expect(res.body, String(createdAt)).toEqual({ createdAt });
    }
  });
});
