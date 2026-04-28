import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { get } from "node:http";
import { mkdirSync, writeFileSync } from "node:fs";
import request from "supertest";
import type { Express } from "express";
import { join } from "node:path";
import type { AppContext } from "../app-context.js";
import type { DeferredPromptRunner } from "../deferred-prompt-runner.js";
import { publishOutboundAttachment } from "../outbound-attachments.js";
import { writeRestartState } from "../restart-state.js";
import { clearRestartPending, RESTART_PENDING_MESSAGE } from "../session-manager.js";
import * as scheduler from "../scheduler.js";
import * as providers from "../providers/index.js";
import { createMockSessionManager, createMockTranscriptionService, createTestApp, makeTestDir, makeTestRuntimePaths } from "./helpers.js";

let app: Express;
let ctx: AppContext;
const TRANSCRIPTION_ENV_KEYS = [
  "BRIDGE_TRANSCRIPTION_PROVIDER",
  "BRIDGE_TRANSCRIPTION_TIMEOUT_MS",
  "BRIDGE_TRANSCRIPTION_MAX_DURATION_SECONDS",
  "BRIDGE_WHISPER_CPP_COMMAND",
  "BRIDGE_WHISPER_CPP_MODEL",
  "BRIDGE_WHISPER_CPP_LANGUAGE",
  "BRIDGE_WHISPER_CPP_ARGS_JSON",
  "BRIDGE_WHISPER_CPP_NO_GPU",
] as const;
function createCopilotUsageTestHome(options?: { dotDir?: boolean }): string {
  const rootDir = makeTestDir("api-copilot-usage");
  if (options?.dotDir) {
    const copilotHome = join(rootDir, ".copilot");
    mkdirSync(copilotHome, { recursive: true });
    return copilotHome;
  }
  return rootDir;
}

function writeCopilotUsageEvents(copilotHome: string, sessionId: string, events: unknown[]): void {
  const sessionDir = join(copilotHome, "session-state", sessionId);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(sessionDir, "events.jsonl"),
    `${events.map((event) => JSON.stringify(event)).join("\n")}\n`,
  );
}

function writeRawCopilotUsageEvents(copilotHome: string, sessionId: string, lines: string[]): void {
  const sessionDir = join(copilotHome, "session-state", sessionId);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(join(sessionDir, "events.jsonl"), `${lines.join("\n")}\n`);
}

beforeEach(() => {
  clearRestartPending();
  for (const key of TRANSCRIPTION_ENV_KEYS) {
    vi.stubEnv(key, undefined);
  }
  ({ app, ctx } = createTestApp());
});

afterEach(() => {
  vi.useRealTimers();
  clearRestartPending();
  scheduler.shutdown();
});

function createRestartRuntimePaths() {
  return makeTestRuntimePaths("api-restart");
}

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

describe("Fleet route", () => {
  it("POST /api/sessions/:id/fleet starts Fleet for sessions with a plan", async () => {
    const startFleet = vi.fn();
    ctx.sessionManager.hasPlan = vi.fn().mockReturnValue(true);
    ctx.sessionManager.startFleet = startFleet;

    const res = await request(app)
      .post("/api/sessions/session-123/fleet")
      .send({});

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ status: "accepted" });
    expect(startFleet).toHaveBeenCalledWith("session-123", undefined);
  });

  it("POST /api/sessions/:id/fleet rejects sessions without a plan", async () => {
    ctx.sessionManager.hasPlan = vi.fn().mockReturnValue(false);

    const res = await request(app)
      .post("/api/sessions/session-123/fleet")
      .send({});

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("no plan");
  });

  it("POST /api/sessions/:id/fleet rejects invalid prompts", async () => {
    ctx.sessionManager.hasPlan = vi.fn().mockReturnValue(true);

    const res = await request(app)
      .post("/api/sessions/session-123/fleet")
      .send({ prompt: 42 });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("prompt must be a string");
  });

  it("POST /api/sessions/:id/fleet rejects busy sessions", async () => {
    ctx.sessionManager.hasPlan = vi.fn().mockReturnValue(true);
    ctx.sessionManager.isSessionBusy = vi.fn().mockReturnValue(true);

    const res = await request(app)
      .post("/api/sessions/session-123/fleet")
      .send({});

    expect(res.status).toBe(429);
    expect(res.body.error).toContain("busy");
  });

  it("GET /api/sessions/:id/stream replays completed Fleet runs as terminal SSE events", async () => {
    const bus = ctx.eventBusRegistry.getOrCreateBus("session-123");
    bus.emit({ type: "done", content: "Fleet finished" });

    const res = await request(app)
      .get("/api/sessions/session-123/stream");

    expect(res.status).toBe(200);
    expect(res.text).toContain('data: {"type":"done","content":"Fleet finished"}');
    expect(res.text).not.toContain('"type":"snapshot"');
  });

  it("GET /api/sessions/:id/stream normalizes completed snapshots emitted during subscribe", async () => {
    ctx.eventBusRegistry.getBus = vi.fn().mockReturnValue({
      subscribe(listener: (event: unknown) => void) {
        listener({
          type: "snapshot",
          complete: true,
          terminalType: "done",
          finalContent: "Fleet finished",
        });
        return () => {};
      },
    });

    const res = await request(app)
      .get("/api/sessions/session-123/stream");

    expect(res.status).toBe(200);
    expect(res.text).toContain('data: {"type":"done","content":"Fleet finished"}');
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
          setTimeout(() => {
            ctx.globalBus.emit({ type: "session:stalled", sessionId: "session-123" });
          }, 10);
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
            if (text.includes('"type":"server:restart-pending","waitingSessions":2')) {
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

      expect(body).toContain('data: {"type":"server:restart-pending","waitingSessions":2}');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
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

function createWavBuffer(durationSeconds: number, sampleRate = 16_000): Buffer {
  const channelCount = 1;
  const bitsPerSample = 16;
  const bytesPerSample = bitsPerSample / 8;
  const sampleCount = Math.max(1, Math.ceil(durationSeconds * sampleRate));
  const dataSize = sampleCount * channelCount * bytesPerSample;
  const byteRate = sampleRate * channelCount * bytesPerSample;
  const blockAlign = channelCount * bytesPerSample;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);
  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(channelCount, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  return buffer;
}

async function eventually(assertion: () => void | Promise<void>, timeoutMs = 1_500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;

  while (Date.now() < deadline) {
    try {
      await assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

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

describe("Transcription routes", () => {
  it("GET /api/transcribe/status returns the configured status", async () => {
    const res = await request(app).get("/api/transcribe/status");

    expect(res.status).toBe(200);
    expect(res.body).toEqual(ctx.transcriptionService.getStatus());
  });

  it("GET /api/transcribe/status falls back when the context service is missing", async () => {
    const fallbackApp = createTestApp({ transcriptionService: undefined as any }).app;

    const res = await request(fallbackApp).get("/api/transcribe/status");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      available: false,
      provider: "disabled",
    });
  });

  it("POST /api/transcribe returns a transcript for uploaded wav audio", async () => {
    const transcribe = vi.fn().mockResolvedValue({ text: "Hello bridge", provider: "whisper.cpp" });
    ({ app, ctx } = createTestApp({
      transcriptionService: createMockTranscriptionService({
        getStatus: () => ({
          available: true,
          provider: "whisper.cpp",
          label: "whisper.cpp",
          maxDurationSeconds: 120,
        }),
        transcribe,
      }),
    }));

    const res = await request(app)
      .post("/api/transcribe")
      .attach("audio", createWavBuffer(1), {
        filename: "recording.wav",
        contentType: "audio/wav",
      });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ text: "Hello bridge", provider: "whisper.cpp" });
    expect(transcribe).toHaveBeenCalledOnce();
    expect(transcribe).toHaveBeenCalledWith(expect.objectContaining({
      filePath: expect.stringContaining("recording.wav"),
      workingDir: expect.any(String),
    }));
  });

  it("POST /api/transcribe returns 503 when voice input is unavailable", async () => {
    const transcribe = vi.fn();
    ({ app } = createTestApp({
      transcriptionService: createMockTranscriptionService({
        getStatus: () => ({
          available: false,
          provider: "disabled",
          label: "Unavailable",
          reason: "Voice input is not configured on the server.",
          maxDurationSeconds: 120,
        }),
        transcribe,
      }),
    }));

    const res = await request(app)
      .post("/api/transcribe")
      .attach("audio", createWavBuffer(1), {
        filename: "recording.wav",
        contentType: "audio/wav",
      });

    expect(res.status).toBe(503);
    expect(res.body.error).toContain("Voice input is not configured");
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("POST /api/transcribe rejects malformed wav uploads", async () => {
    const transcribe = vi.fn();
    ({ app } = createTestApp({
      transcriptionService: createMockTranscriptionService({
        getStatus: () => ({
          available: true,
          provider: "whisper.cpp",
          label: "whisper.cpp",
          maxDurationSeconds: 120,
        }),
        transcribe,
      }),
    }));

    const res = await request(app)
      .post("/api/transcribe")
      .attach("audio", Buffer.from("not-a-wav"), {
        filename: "recording.wav",
        contentType: "audio/wav",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("WAV");
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("POST /api/transcribe enforces the configured duration limit", async () => {
    const transcribe = vi.fn();
    ({ app } = createTestApp({
      transcriptionService: createMockTranscriptionService({
        getStatus: () => ({
          available: true,
          provider: "whisper.cpp",
          label: "whisper.cpp",
          maxDurationSeconds: 1,
        }),
        transcribe,
      }),
    }));

    const res = await request(app)
      .post("/api/transcribe")
      .attach("audio", createWavBuffer(2), {
        filename: "recording.wav",
        contentType: "audio/wav",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Audio exceeds 1 seconds");
    expect(transcribe).not.toHaveBeenCalled();
  });
});

describe("Voice job routes", () => {
  it("POST /api/voice-jobs accepts and starts a server-owned autosend for an existing session", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.startWork = vi.fn();
    sessionManager.readMessagesFromDisk = vi.fn().mockResolvedValue({
      messages: [{
        type: "message",
        role: "user",
        content: "Hello bridge",
        timestamp: new Date().toISOString(),
      }],
      total: 1,
      hasMore: false,
    });
    const transcribe = vi.fn().mockResolvedValue({ text: "Hello bridge", provider: "whisper.cpp" });
    ({ app, ctx } = createTestApp({
      sessionManager,
      transcriptionService: createMockTranscriptionService({
        getStatus: () => ({
          available: true,
          provider: "whisper.cpp",
          label: "whisper.cpp",
          maxDurationSeconds: 120,
        }),
        transcribe,
      }),
    }));

    const res = await request(app)
      .post("/api/voice-jobs")
      .field("composerKey", "existing-session")
      .field("sessionId", "existing-session")
      .attach("audio", createWavBuffer(1), {
        filename: "recording.wav",
        contentType: "audio/wav",
      });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      composerKey: "existing-session",
      targetSessionId: "existing-session",
      status: "accepted",
      safeToLeave: true,
    });

    await eventually(() => {
      expect(transcribe).toHaveBeenCalledOnce();
      expect(sessionManager.startWork).toHaveBeenCalledWith("existing-session", "Hello bridge");
    });

    const jobRes = await request(app).get(`/api/voice-jobs/${res.body.id}`);
    expect(jobRes.status).toBe(200);
    expect(jobRes.body.status).toBe("done");
  });

  it("POST /api/voice-jobs accepts draft-session autosend while restart is active in persisted state", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.createSession = vi.fn().mockResolvedValue({ sessionId: "new-session" });
    const runtimePaths = createRestartRuntimePaths();
    await writeRestartState(join(runtimePaths.dataDir, "restart-state.json"), {
      requestId: "req-voice-job",
      phase: "queued",
      requestedAt: "2026-04-24T12:00:00.000Z",
      waitingSessions: 0,
      launcherHeartbeatAt: null,
    });
    ({ app } = createTestApp({
      runtimePaths,
      sessionManager,
      transcriptionService: createMockTranscriptionService({
        getStatus: () => ({
          available: true,
          provider: "whisper.cpp",
          label: "whisper.cpp",
          maxDurationSeconds: 120,
        }),
      }),
    }));

    const res = await request(app)
      .post("/api/voice-jobs")
      .field("composerKey", "draft:quickchat")
      .attach("audio", createWavBuffer(1), {
        filename: "recording.wav",
        contentType: "audio/wav",
      });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      composerKey: "draft:quickchat",
      targetSessionId: "new-session",
      status: "accepted",
      safeToLeave: true,
    });
    expect(sessionManager.createSession).toHaveBeenCalledOnce();
  });

  it("draft-route voice jobs recover through the materialized session when autosend fails", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.createSession = vi.fn().mockResolvedValue({ sessionId: "new-session" });
    sessionManager.startWork = vi.fn(() => {
      throw new Error("Session is busy, please wait");
    });
    const transcribe = vi.fn().mockResolvedValue({ text: "Hello draft route", provider: "whisper.cpp" });
    ({ app, ctx } = createTestApp({
      sessionManager,
      transcriptionService: createMockTranscriptionService({
        getStatus: () => ({
          available: true,
          provider: "whisper.cpp",
          label: "whisper.cpp",
          maxDurationSeconds: 120,
        }),
        transcribe,
      }),
    }));

    const res = await request(app)
      .post("/api/voice-jobs")
      .field("composerKey", "draft:quickchat")
      .attach("audio", createWavBuffer(1), {
        filename: "recording.wav",
        contentType: "audio/wav",
      });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      composerKey: "draft:quickchat",
      targetSessionId: "new-session",
      status: "accepted",
      safeToLeave: true,
    });

    await eventually(async () => {
      const jobRes = await request(app).get(`/api/voice-jobs/${res.body.id}`);
      expect(jobRes.status).toBe(200);
      expect(jobRes.body.status).toBe("error");
      expect(jobRes.body.transcript).toBe("Hello draft route");
    });

    const latestDraft = await request(app).get("/api/voice-jobs/latest").query({ composerKey: "draft:quickchat" });
    expect(latestDraft.status).toBe(200);
    expect(latestDraft.body).toMatchObject({
      id: res.body.id,
      status: "error",
      targetSessionId: "new-session",
      transcript: "Hello draft route",
    });

    const latestSession = await request(app).get("/api/voice-jobs/latest").query({ composerKey: "new-session" });
    expect(latestSession.status).toBe(200);
    expect(latestSession.body.id).toBe(res.body.id);

    const recovered = await request(app).post(`/api/voice-jobs/${res.body.id}/recovered`);
    expect(recovered.status).toBe(200);
    expect(recovered.body.status).toBe("recovered");

    const afterRecovery = await request(app).get("/api/voice-jobs/latest").query({ composerKey: "new-session" });
    expect(afterRecovery.status).toBe(404);
  });
});

// ── Task CRUD ────────────────────────────────────────────────────

describe("Task routes", () => {
  it("GET /api/tasks returns empty list initially", async () => {
    const res = await request(app).get("/api/tasks");
    expect(res.status).toBe(200);
    expect(res.body.tasks).toEqual([]);
  });

  it("POST /api/tasks creates a task", async () => {
    const res = await request(app)
      .post("/api/tasks")
      .send({ title: "Test Task" });
    expect(res.status).toBe(200);
    expect(res.body.task.title).toBe("Test Task");
    expect(res.body.task.id).toBeTruthy();
    expect(res.body.task.kind).toBe("task");
    expect(res.body.task.status).toBe("active");
  });

  it("POST /api/tasks accepts kind and returns it from list/get", async () => {
    const create = await request(app)
      .post("/api/tasks")
      .send({ title: "Keep running", kind: "ongoing" });
    expect(create.status).toBe(200);
    expect(create.body.task.kind).toBe("ongoing");

    const id = create.body.task.id;
    const get = await request(app).get(`/api/tasks/${id}`);
    expect(get.status).toBe(200);
    expect(get.body.task.kind).toBe("ongoing");

    const list = await request(app).get("/api/tasks");
    expect(list.status).toBe(200);
    expect(list.body.tasks).toEqual(
      expect.arrayContaining([expect.objectContaining({ id, kind: "ongoing" })]),
    );
  });

  it("GET /api/tasks/:id returns the created task", async () => {
    const create = await request(app)
      .post("/api/tasks")
      .send({ title: "Lookup Task" });
    const id = create.body.task.id;

    const res = await request(app).get(`/api/tasks/${id}`);
    expect(res.status).toBe(200);
    expect(res.body.task.title).toBe("Lookup Task");
  });

  it("GET /api/tasks/:id returns 404 for missing task", async () => {
    const res = await request(app).get("/api/tasks/nonexistent");
    expect(res.status).toBe(404);
  });

  it("PATCH /api/tasks/:id updates a task", async () => {
    const create = await request(app)
      .post("/api/tasks")
      .send({ title: "Original" });
    const id = create.body.task.id;

    const res = await request(app)
      .patch(`/api/tasks/${id}`)
      .send({
        title: "Updated",
        notes: "Some notes",
        doneWhen: "Shipped to production",
        nextAction: "Verify telemetry",
        waitingOn: "Customer confirmation",
        nextTouchAt: "2026-05-02T09:00:00.000Z",
      });
    expect(res.status).toBe(200);
    expect(res.body.task.title).toBe("Updated");
    expect(res.body.task.notes).toBe("Some notes");
    expect(res.body.task.doneWhen).toBe("Shipped to production");
    expect(res.body.task.nextAction).toBe("Verify telemetry");
    expect(res.body.task.waitingOn).toBe("Customer confirmation");
    expect(res.body.task.nextTouchAt).toBe("2026-05-02T09:00:00.000Z");

    const get = await request(app).get(`/api/tasks/${id}`);
    expect(get.status).toBe(200);
    expect(get.body.task).toEqual(expect.objectContaining({
      doneWhen: "Shipped to production",
      nextAction: "Verify telemetry",
      waitingOn: "Customer confirmation",
      nextTouchAt: "2026-05-02T09:00:00.000Z",
    }));
  });

  it("PATCH /api/tasks/:id updates kind and rejects invalid kinds", async () => {
    const create = await request(app)
      .post("/api/tasks")
      .send({ title: "Kind patch" });
    const id = create.body.task.id;

    const update = await request(app)
      .patch(`/api/tasks/${id}`)
      .send({ kind: "ongoing" });
    expect(update.status).toBe(200);
    expect(update.body.task.kind).toBe("ongoing");

    const get = await request(app).get(`/api/tasks/${id}`);
    expect(get.status).toBe(200);
    expect(get.body.task.kind).toBe("ongoing");

    const invalid = await request(app)
      .patch(`/api/tasks/${id}`)
      .send({ kind: "invalid" });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toContain("kind must be either 'task' or 'ongoing'");
  });

  it("PATCH /api/tasks/:id normalizes kind-only switches to ongoing", async () => {
    const create = await request(app)
      .post("/api/tasks")
      .send({ title: "Kind patch normalize" });
    const id = create.body.task.id;

    const seeded = await request(app)
      .patch(`/api/tasks/${id}`)
      .send({ status: "done", doneWhen: "Shipped to production" });
    expect(seeded.status).toBe(200);

    const update = await request(app)
      .patch(`/api/tasks/${id}`)
      .send({ kind: "ongoing" });
    expect(update.status).toBe(200);
    expect(update.body.task.kind).toBe("ongoing");
    expect(update.body.task.status).toBe("active");
    expect(update.body.task.doneWhen).toBeUndefined();

    const get = await request(app).get(`/api/tasks/${id}`);
    expect(get.status).toBe(200);
    expect(get.body.task.kind).toBe("ongoing");
    expect(get.body.task.status).toBe("active");
    expect(get.body.task.doneWhen).toBeUndefined();
  });

  it("PATCH /api/tasks/:id derives completedAt from explicit completion and reopening only", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T10:00:00.000Z"));

    const create = await request(app)
      .post("/api/tasks")
      .send({ title: "Complete via route" });
    const id = create.body.task.id;

    vi.setSystemTime(new Date("2026-04-01T12:34:56.000Z"));
    const completed = await request(app)
      .patch(`/api/tasks/${id}`)
      .send({ completionAction: "complete-and-archive", completedAt: "1999-01-01T00:00:00.000Z" });
    expect(completed.status).toBe(200);
    expect(completed.body.task.status).toBe("archived");
    expect(completed.body.task.completedAt).toBe("2026-04-01T12:34:56.000Z");

    vi.setSystemTime(new Date("2026-04-01T13:00:00.000Z"));
    const preserved = await request(app)
      .patch(`/api/tasks/${id}`)
      .send({ notes: "done already", completedAt: "2030-01-01T00:00:00.000Z" });
    expect(preserved.status).toBe(200);
    expect(preserved.body.task.completedAt).toBe("2026-04-01T12:34:56.000Z");

    vi.setSystemTime(new Date("2026-04-01T14:00:00.000Z"));
    const reopened = await request(app)
      .patch(`/api/tasks/${id}`)
      .send({ status: "active", completedAt: "2030-01-01T00:00:00.000Z" });
    expect(reopened.status).toBe(200);
    expect(reopened.body.task.completedAt).toBeUndefined();
  });

  it("PATCH /api/tasks/:id normalizes legacy done updates into complete-and-archive", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T10:00:00.000Z"));

    const create = await request(app)
      .post("/api/tasks")
      .send({ title: "Legacy complete via route" });
    const id = create.body.task.id;

    vi.setSystemTime(new Date("2026-04-01T12:34:56.000Z"));
    const completed = await request(app)
      .patch(`/api/tasks/${id}`)
      .send({ status: "done", completedAt: "1999-01-01T00:00:00.000Z" });

    expect(completed.status).toBe(200);
    expect(completed.body.task.status).toBe("archived");
    expect(completed.body.task.completedAt).toBe("2026-04-01T12:34:56.000Z");
  });

  it("PATCH /api/tasks/:id rejects re-completing archived tasks", async () => {
    const create = await request(app)
      .post("/api/tasks")
      .send({ title: "Archive protection via route" });
    const id = create.body.task.id;

    const archived = await request(app)
      .patch(`/api/tasks/${id}`)
      .send({ status: "archived" });
    expect(archived.status).toBe(200);

    const completionAction = await request(app)
      .patch(`/api/tasks/${id}`)
      .send({ completionAction: "complete-and-archive" });
    expect(completionAction.status).toBe(400);
    expect(completionAction.body.error).toContain("Archived tasks cannot be completed again");

    const legacyDone = await request(app)
      .patch(`/api/tasks/${id}`)
      .send({ status: "done" });
    expect(legacyDone.status).toBe(400);
    expect(legacyDone.body.error).toContain("Archived tasks cannot be completed again");
  });

  it("PATCH /api/tasks/:id archiving an incomplete task does not set completedAt", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-01T10:00:00.000Z"));

    const create = await request(app)
      .post("/api/tasks")
      .send({ title: "Archive via route" });
    const id = create.body.task.id;

    vi.setSystemTime(new Date("2026-04-01T12:34:56.000Z"));
    const archived = await request(app)
      .patch(`/api/tasks/${id}`)
      .send({ status: "archived", completedAt: "1999-01-01T00:00:00.000Z" });
    expect(archived.status).toBe(200);
    expect(archived.body.task.status).toBe("archived");
    expect(archived.body.task.completedAt).toBeUndefined();
  });

  it("DELETE /api/tasks/:id removes a task", async () => {
    const create = await request(app)
      .post("/api/tasks")
      .send({ title: "To Delete" });
    const id = create.body.task.id;

    const del = await request(app).delete(`/api/tasks/${id}`);
    expect(del.status).toBe(200);
    expect(del.body.ok).toBe(true);

    const get = await request(app).get(`/api/tasks/${id}`);
    expect(get.status).toBe(404);
  });

  it("POST /api/tasks/:id/link links a work item", async () => {
    const create = await request(app)
      .post("/api/tasks")
      .send({ title: "Linked Task" });
    const id = create.body.task.id;

    const res = await request(app)
      .post(`/api/tasks/${id}/link`)
      .send({ type: "workItem", workItemId: "42", provider: "github" });
    expect(res.status).toBe(200);
    expect(res.body.task.workItems).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "42", provider: "github" })]),
    );
  });

  it("DELETE /api/tasks/:id/link removes a work item link", async () => {
    const create = await request(app)
      .post("/api/tasks")
      .send({ title: "Unlink Task" });
    const id = create.body.task.id;

    await request(app)
      .post(`/api/tasks/${id}/link`)
      .send({ type: "workItem", workItemId: "99", provider: "github" });

    const res = await request(app)
      .delete(`/api/tasks/${id}/link`)
      .send({ type: "workItem", workItemId: "99", provider: "github" });
    expect(res.status).toBe(200);
    expect(res.body.task.workItems).toEqual([]);
  });

  it("PUT /api/tasks/reorder reorders tasks", async () => {
    const t1 = (await request(app).post("/api/tasks").send({ title: "A" })).body.task;
    const t2 = (await request(app).post("/api/tasks").send({ title: "B" })).body.task;

    const res = await request(app)
      .put("/api/tasks/reorder")
      .send({ taskIds: [t2.id, t1.id] });
    expect(res.status).toBe(200);

    const list = await request(app).get("/api/tasks");
    expect(list.body.tasks[0].id).toBe(t2.id);
    expect(list.body.tasks[1].id).toBe(t1.id);
  });

  it("POST /api/tasks with groupId assigns to group", async () => {
    const group = (await request(app).post("/api/task-groups").send({ name: "G" })).body.group;

    const res = await request(app)
      .post("/api/tasks")
      .send({ title: "Grouped Task", groupId: group.id });
    expect(res.status).toBe(200);
    expect(res.body.task.groupId).toBe(group.id);
  });

  it("PATCH /api/tasks/:id normalizes paused status updates to active", async () => {
    const create = await request(app).post("/api/tasks").send({ title: "Normalize status" });
    const id = create.body.task.id;

    const update = await request(app).patch(`/api/tasks/${id}`).send({ status: "paused" });
    expect(update.status).toBe(200);
    expect(update.body.task.status).toBe("active");

    const get = await request(app).get(`/api/tasks/${id}`);
    expect(get.status).toBe(200);
    expect(get.body.task.status).toBe("active");
  });

  it("PATCH /api/tasks/:id clears momentum fields when passed empty strings", async () => {
    const create = await request(app).post("/api/tasks").send({ title: "Clear Momentum" });
    const id = create.body.task.id;

    await request(app).patch(`/api/tasks/${id}`).send({
      doneWhen: "Merged",
      nextAction: "Deploy",
      waitingOn: "Review",
      nextTouchAt: "2030-01-01T00:00:00.000Z",
    });

    const cleared = await request(app).patch(`/api/tasks/${id}`).send({
      doneWhen: "",
      nextAction: "",
      waitingOn: "   ",
      nextTouchAt: "",
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body.task.doneWhen).toBeUndefined();
    expect(cleared.body.task.nextAction).toBeUndefined();
    expect(cleared.body.task.waitingOn).toBeUndefined();
    expect(cleared.body.task.nextTouchAt).toBeUndefined();

    // Verify persistence via GET
    const get = await request(app).get(`/api/tasks/${id}`);
    expect(get.body.task.doneWhen).toBeUndefined();
    expect(get.body.task.nextAction).toBeUndefined();
    expect(get.body.task.waitingOn).toBeUndefined();
    expect(get.body.task.nextTouchAt).toBeUndefined();
  });

  it("PATCH /api/tasks/:id clears parked momentum when a task is marked done", async () => {
    const create = await request(app).post("/api/tasks").send({ title: "Close me out" });
    const id = create.body.task.id;

    await request(app).patch(`/api/tasks/${id}`).send({
      doneWhen: "Rolled out to all tenants",
      nextAction: "Check the dashboard",
      waitingOn: "Support confirmation",
      nextTouchAt: "2030-01-01T00:00:00.000Z",
    });

    const done = await request(app).patch(`/api/tasks/${id}`).send({ status: "done" });
    expect(done.status).toBe(200);
    expect(done.body.task.status).toBe("archived");
    expect(done.body.task.doneWhen).toBe("Rolled out to all tenants");
    expect(done.body.task.nextAction).toBeUndefined();
    expect(done.body.task.waitingOn).toBeUndefined();
    expect(done.body.task.nextTouchAt).toBeUndefined();

    const get = await request(app).get(`/api/tasks/${id}`);
    expect(get.status).toBe(200);
    expect(get.body.task.status).toBe("archived");
    expect(get.body.task.doneWhen).toBe("Rolled out to all tenants");
    expect(get.body.task.nextAction).toBeUndefined();
    expect(get.body.task.waitingOn).toBeUndefined();
    expect(get.body.task.nextTouchAt).toBeUndefined();
  });

  it("PATCH /api/tasks/:id clears parked momentum when a task is archived", async () => {
    const create = await request(app).post("/api/tasks").send({ title: "Archive me" });
    const id = create.body.task.id;

    await request(app).patch(`/api/tasks/${id}`).send({
      nextAction: "Check the dashboard",
      waitingOn: "Support confirmation",
      nextTouchAt: "2030-01-01T00:00:00.000Z",
    });

    const archived = await request(app).patch(`/api/tasks/${id}`).send({ status: "archived" });
    expect(archived.status).toBe(200);
    expect(archived.body.task.status).toBe("archived");
    expect(archived.body.task.nextAction).toBeUndefined();
    expect(archived.body.task.waitingOn).toBeUndefined();
    expect(archived.body.task.nextTouchAt).toBeUndefined();

    const get = await request(app).get(`/api/tasks/${id}`);
    expect(get.status).toBe(200);
    expect(get.body.task.status).toBe("archived");
    expect(get.body.task.nextAction).toBeUndefined();
    expect(get.body.task.waitingOn).toBeUndefined();
    expect(get.body.task.nextTouchAt).toBeUndefined();
  });

  it("PATCH /api/tasks/:id rejects parked momentum updates for done tasks", async () => {
    const create = await request(app).post("/api/tasks").send({ title: "Stay closed" });
    const id = create.body.task.id;

    await request(app).patch(`/api/tasks/${id}`).send({ status: "done" });

    const invalid = await request(app)
      .patch(`/api/tasks/${id}`)
      .send({ nextAction: "Actually keep working on this" });

    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toContain("nextAction, waitingOn, and nextTouchAt can only be set on active tasks");

    const get = await request(app).get(`/api/tasks/${id}`);
    expect(get.status).toBe(200);
    expect(get.body.task.status).toBe("archived");
    expect(get.body.task.nextAction).toBeUndefined();
  });

  it("PATCH /api/tasks/:id rejects invalid nextTouchAt values", async () => {
    const create = await request(app).post("/api/tasks").send({ title: "Invalid touch" });
    const id = create.body.task.id;

    for (const nextTouchAt of ["not-a-date", "2026-02-31T00:00:00.000Z", "2026-05-02 09:30", 123]) {
      const invalid = await request(app)
        .patch(`/api/tasks/${id}`)
        .send({ nextTouchAt });

      expect(invalid.status).toBe(400);
      expect(invalid.body.error).toContain("nextTouchAt must be a valid ISO timestamp with timezone");
    }

    const get = await request(app).get(`/api/tasks/${id}`);
    expect(get.status).toBe(200);
    expect(get.body.task.nextTouchAt).toBeUndefined();
  });

  it("PATCH /api/tasks/:id rejects invalid status values", async () => {
    const create = await request(app).post("/api/tasks").send({ title: "Invalid status" });
    const id = create.body.task.id;

    const invalid = await request(app)
      .patch(`/api/tasks/${id}`)
      .send({ status: "bogus" });

    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toContain("status must be one of: active, done, archived");

    const get = await request(app).get(`/api/tasks/${id}`);
    expect(get.status).toBe(200);
    expect(get.body.task.status).toBe("active");
  });
});

// ── Task Group CRUD ──────────────────────────────────────────────

describe("Task group routes", () => {
  it("GET /api/task-groups returns empty list initially", async () => {
    const res = await request(app).get("/api/task-groups");
    expect(res.status).toBe(200);
    expect(res.body.groups).toEqual([]);
  });

  it("POST /api/task-groups creates a group", async () => {
    const res = await request(app)
      .post("/api/task-groups")
      .send({ name: "Frontend" });
    expect(res.status).toBe(200);
    expect(res.body.group.name).toBe("Frontend");
    expect(res.body.group.id).toBeTruthy();
  });

  it("PATCH /api/task-groups/:id updates a group", async () => {
    const create = await request(app)
      .post("/api/task-groups")
      .send({ name: "Old Name" });
    const id = create.body.group.id;

    const res = await request(app)
      .patch(`/api/task-groups/${id}`)
      .send({ name: "New Name" });
    expect(res.status).toBe(200);
    expect(res.body.group.name).toBe("New Name");
  });

  it("DELETE /api/task-groups/:id deletes a group", async () => {
    const create = await request(app)
      .post("/api/task-groups")
      .send({ name: "Temp" });
    const id = create.body.group.id;

    const del = await request(app).delete(`/api/task-groups/${id}`);
    expect(del.status).toBe(200);
    expect(del.body.success).toBe(true);

    const list = await request(app).get("/api/task-groups");
    expect(list.body.groups).toEqual([]);
  });

  it("PUT /api/task-groups/reorder reorders groups", async () => {
    const g1 = (await request(app).post("/api/task-groups").send({ name: "A" })).body.group;
    const g2 = (await request(app).post("/api/task-groups").send({ name: "B" })).body.group;

    const res = await request(app)
      .put("/api/task-groups/reorder")
      .send({ groupIds: [g2.id, g1.id] });
    expect(res.status).toBe(200);
  });
});

// ── Checklist CRUD ───────────────────────────────────────────────

describe("Checklist routes", () => {
  let taskId: string;

  beforeEach(async () => {
    const task = await request(app)
      .post("/api/tasks")
      .send({ title: "Checklist Host" });
    taskId = task.body.task.id;
  });

  it("GET /api/tasks/:taskId/checklist-items returns empty list initially", async () => {
    const res = await request(app).get(`/api/tasks/${taskId}/checklist-items`);
    expect(res.status).toBe(200);
    expect(res.body.checklistItems).toEqual([]);
  });

  it("POST /api/tasks/:taskId/checklist-items creates a checklist item", async () => {
    const res = await request(app)
      .post(`/api/tasks/${taskId}/checklist-items`)
      .send({ text: "Write tests" });
    expect(res.status).toBe(200);
    expect(res.body.checklistItem.text).toBe("Write tests");
    expect(res.body.checklistItem.done).toBe(false);
  });

  it("PATCH /api/checklist-items/:id updates a checklist item", async () => {
    const create = await request(app)
      .post(`/api/tasks/${taskId}/checklist-items`)
      .send({ text: "Draft" });
    const id = create.body.checklistItem.id;

    const res = await request(app)
      .patch(`/api/checklist-items/${id}`)
      .send({ text: "Final", done: true });
    expect(res.status).toBe(200);
    expect(res.body.checklistItem.text).toBe("Final");
    expect(res.body.checklistItem.done).toBe(true);
  });

  it("DELETE /api/checklist-items/:id removes a checklist item", async () => {
    const create = await request(app)
      .post(`/api/tasks/${taskId}/checklist-items`)
      .send({ text: "Ephemeral" });
    const id = create.body.checklistItem.id;

    const del = await request(app).delete(`/api/checklist-items/${id}`);
    expect(del.status).toBe(200);
    expect(del.body.ok).toBe(true);

    const list = await request(app).get(`/api/tasks/${taskId}/checklist-items`);
    expect(list.body.checklistItems).toEqual([]);
  });

  it("POST /api/checklist-items creates a global checklist item", async () => {
    const res = await request(app)
      .post("/api/checklist-items")
      .send({ text: "Global checklist item" });
    expect(res.status).toBe(200);
    expect(res.body.checklistItem.text).toBe("Global checklist item");
    expect(res.body.checklistItem.taskId).toBeNull();
  });

  it("GET /api/checklist-items/open returns open checklist items", async () => {
    await request(app)
      .post(`/api/tasks/${taskId}/checklist-items`)
      .send({ text: "Open one" });

    const res = await request(app).get("/api/checklist-items/open");
    expect(res.status).toBe(200);
    expect(res.body.checklistItems.length).toBeGreaterThanOrEqual(1);
    expect(res.body.checklistItems[0].text).toBe("Open one");
  });

  it("PUT /api/tasks/:taskId/checklist-items/reorder reorders checklist items", async () => {
    const t1 = (await request(app).post(`/api/tasks/${taskId}/checklist-items`).send({ text: "First" })).body.checklistItem;
    const t2 = (await request(app).post(`/api/tasks/${taskId}/checklist-items`).send({ text: "Second" })).body.checklistItem;

    const res = await request(app)
      .put(`/api/tasks/${taskId}/checklist-items/reorder`)
      .send({ checklistItemIds: [t2.id, t1.id] });
    expect(res.status).toBe(200);

    const list = await request(app).get(`/api/tasks/${taskId}/checklist-items`);
    expect(list.body.checklistItems[0].id).toBe(t2.id);
    expect(list.body.checklistItems[1].id).toBe(t1.id);
  });

  it("POST /api/tasks/:taskId/checklist-items with deadline", async () => {
    const res = await request(app)
      .post(`/api/tasks/${taskId}/checklist-items`)
      .send({ text: "Due soon", deadline: "2026-12-31" });
    expect(res.status).toBe(200);
    expect(res.body.checklistItem.deadline).toBe("2026-12-31");
  });

  it("old /api/todos routes are not exposed", async () => {
    expect((await request(app).get(`/api/tasks/${taskId}/todos`)).status).toBe(404);
    expect((await request(app).post(`/api/tasks/${taskId}/todos`).send({ text: "Old route" })).status).toBe(404);
    expect((await request(app).post("/api/todos").send({ text: "Old route" })).status).toBe(404);
    expect((await request(app).get("/api/todos/open")).status).toBe(404);
    expect((await request(app).put(`/api/tasks/${taskId}/todos/reorder`).send({ todoIds: [] })).status).toBe(404);
  });
});

// ── Tag CRUD ─────────────────────────────────────────────────────

describe("Tag routes", () => {
  it("GET /api/tags returns empty list initially", async () => {
    const res = await request(app).get("/api/tags");
    expect(res.status).toBe(200);
    expect(res.body.tags).toEqual([]);
  });

  it("POST /api/tags creates a tag", async () => {
    const res = await request(app)
      .post("/api/tags")
      .send({ name: "urgent", color: "rose" });
    expect(res.status).toBe(200);
    expect(res.body.tag.name).toBe("urgent");
    expect(res.body.tag.color).toBe("rose");
  });

  it("PATCH /api/tags/:id updates a tag", async () => {
    const create = await request(app)
      .post("/api/tags")
      .send({ name: "old" });
    const id = create.body.tag.id;

    const res = await request(app)
      .patch(`/api/tags/${id}`)
      .send({ name: "new", color: "blue" });
    expect(res.status).toBe(200);
    expect(res.body.tag.name).toBe("new");
  });

  it("DELETE /api/tags/:id deletes a tag", async () => {
    const create = await request(app)
      .post("/api/tags")
      .send({ name: "temp" });
    const id = create.body.tag.id;

    const del = await request(app).delete(`/api/tags/${id}`);
    expect(del.status).toBe(200);
    expect(del.body.success).toBe(true);

    const list = await request(app).get("/api/tags");
    expect(list.body.tags).toEqual([]);
  });

  it("PUT /api/tags/reorder reorders tags", async () => {
    const t1 = (await request(app).post("/api/tags").send({ name: "alpha" })).body.tag;
    const t2 = (await request(app).post("/api/tags").send({ name: "beta" })).body.tag;

    const res = await request(app)
      .put("/api/tags/reorder")
      .send({ tagIds: [t2.id, t1.id] });
    expect(res.status).toBe(200);
  });

  it("PUT /api/tasks/:id/tags assigns tags to a task", async () => {
    const task = (await request(app).post("/api/tasks").send({ title: "Tagged" })).body.task;
    const tag = (await request(app).post("/api/tags").send({ name: "priority" })).body.tag;

    const res = await request(app)
      .put(`/api/tasks/${task.id}/tags`)
      .send({ tagIds: [tag.id] });
    expect(res.status).toBe(200);

    const get = await request(app).get(`/api/tasks/${task.id}`);
    expect(get.body.task.tags).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: tag.id, name: "priority" })]),
    );
  });
});

// ── Settings ─────────────────────────────────────────────────────

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

  it("GET /api/schedules returns empty list initially", async () => {
    const res = await request(app).get("/api/schedules");
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
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

  it("POST /api/schedules serializes new schedules without targetSessionId", async () => {
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
      sessionMode: "new",
      reuseSession: false,
    });
    expect(res.body).not.toHaveProperty("targetSessionId");
  });

  it("POST /api/schedules still honors legacy reuseSession=true", async () => {
    const res = await request(app)
      .post("/api/schedules")
      .send({
        taskId,
        name: "Legacy reuse",
        prompt: "Continue the conversation",
        type: "cron",
        cron: "0 0 * * *",
        reuseSession: true,
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ sessionMode: "reuse-last", reuseSession: true });
  });

  it("POST /api/schedules rejects invalid reuse-target mode", async () => {
    const res = await request(app)
      .post("/api/schedules")
      .send({
        taskId,
        name: "Wrong mode",
        prompt: "Continue the conversation",
        type: "cron",
        cron: "0 0 * * *",
        sessionMode: "reuse-target",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid sessionMode: reuse-target");
  });

  it("POST /api/schedules rejects legacy targetSessionId input", async () => {
    const res = await request(app)
      .post("/api/schedules")
      .send({
        taskId,
        name: "Wrong target field",
        prompt: "Continue the conversation",
        type: "cron",
        cron: "0 0 * * *",
        targetSessionId: "linked-session",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("targetSessionId is no longer supported for schedules; use defer_session for same-session follow-ups");
  });

  it("PATCH /api/schedules rejects invalid reuse-target mode", async () => {
    const schedule = ctx.scheduleStore.createSchedule({
      taskId,
      name: "Keep target",
      prompt: "Continue the conversation",
      type: "cron",
      cron: "0 0 * * *",
    });

    const res = await request(app)
      .patch(`/api/schedules/${schedule.id}`)
      .send({ sessionMode: "reuse-target" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Invalid sessionMode: reuse-target");
  });

  it("PATCH /api/schedules rejects legacy targetSessionId input", async () => {
    const schedule = ctx.scheduleStore.createSchedule({
      taskId,
      name: "Ignore target field",
      prompt: "Continue the conversation",
      type: "cron",
      cron: "0 0 * * *",
    });

    const res = await request(app)
      .patch(`/api/schedules/${schedule.id}`)
      .send({ name: "Renamed", targetSessionId: "linked-session" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("targetSessionId is no longer supported for schedules; use defer_session for same-session follow-ups");
  });

  it("PATCH /api/schedules still honors legacy reuseSession=false", async () => {
    const schedule = ctx.scheduleStore.createSchedule({
      taskId,
      name: "Legacy patch",
      prompt: "Continue the conversation",
      type: "cron",
      cron: "0 0 * * *",
      sessionMode: "reuse-last",
    });

    const res = await request(app)
      .patch(`/api/schedules/${schedule.id}`)
      .send({ reuseSession: false });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ sessionMode: "new", reuseSession: false });
  });

  it("GET /api/schedules/:id/sessions returns sessions for a schedule", async () => {
    const schedule = ctx.scheduleStore.createSchedule({
      taskId, name: "Test Sched", prompt: "Do stuff", type: "cron", cron: "0 0 * * *",
    });

    ctx.sessionMetaStore.recordScheduleRun(schedule.id, "sess-1");
    ctx.sessionMetaStore.recordScheduleRun(schedule.id, "sess-2");

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

// ── Session routes (mock-based) ──────────────────────────────────

describe("Session routes (mocked)", () => {
  it("GET /api/sessions returns wrapped response", async () => {
    const res = await request(app).get("/api/sessions");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("sessions");
  });

  it("GET /api/sessions keeps sessions visible when only a title override exists", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.listSessionsFromDisk = vi.fn().mockResolvedValue([
      {
        sessionId: "dup-session",
        modifiedTime: "2026-04-16T12:00:00.000Z",
        lastVisibleActivityAt: "2026-04-16T12:00:00.000Z",
      },
    ]);
    ({ app, ctx } = createTestApp({ sessionManager }));
    ctx.sessionTitles.setTitle("dup-session", "Copy of Original session");

    const res = await request(app).get("/api/sessions");

    expect(res.status).toBe(200);
    expect(res.body.sessions).toEqual([
      expect.objectContaining({
        sessionId: "dup-session",
        summary: "Copy of Original session",
      }),
    ]);
  });

  it("GET /api/sessions keeps linked untitled task sessions visible", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.listSessionsFromDisk = vi.fn().mockResolvedValue([
      {
        sessionId: "new-task-session",
        summary: "Generate a concise 3-6 word title for this conversation.",
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
        summary: "Generate a concise 3-6 word title for this conversation.",
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

  it("POST /api/sessions/:id/duplicate duplicates a session when restart is active in persisted state", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.duplicateSession = vi.fn().mockResolvedValue({ sessionId: "dup-session" });
    const runtimePaths = createRestartRuntimePaths();
    await writeRestartState(join(runtimePaths.dataDir, "restart-state.json"), {
      requestId: "req-session-duplicate",
      phase: "queued",
      requestedAt: "2026-04-24T12:00:00.000Z",
      waitingSessions: 0,
      launcherHeartbeatAt: null,
    });
    ({ app, ctx } = createTestApp({ sessionManager, runtimePaths }));

    const res = await request(app).post("/api/sessions/source-session/duplicate");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sessionId: "dup-session" });
    expect(sessionManager.duplicateSession).toHaveBeenCalledWith("source-session");
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

  it("GET /api/dashboard tolerates preview contexts without dashboard stores", async () => {
    ({ app, ctx } = createTestApp({
      taskGroupStore: undefined as any,
      scheduleStore: undefined as any,
      checklistStore: undefined as any,
      voiceJobManager: {} as any,
    }));
    ctx.taskStore.createTask("Dashboard Task");

    const res = await request(app).get("/api/dashboard");

    expect(res.status).toBe(200);
    expect(res.body.lastActiveTask).toEqual(expect.objectContaining({
      task: expect.objectContaining({ title: "Dashboard Task" }),
      checklistSummary: { total: 0, done: 0, open: 0, overdue: 0 },
    }));
    expect(res.body.openChecklistItems).toEqual([]);
    expect(res.body.completedChecklistItems).toEqual([]);
    expect(res.body.schedules).toEqual([]);
  });

  it("GET /api/dashboard keeps sessions visible when only a title override exists", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.listSessionsFromDisk = vi.fn().mockResolvedValue([
      {
        sessionId: "dup-session",
        modifiedTime: "2026-04-16T12:00:00.000Z",
        lastVisibleActivityAt: "2026-04-16T12:00:00.000Z",
      },
    ]);
    ({ app, ctx } = createTestApp({ sessionManager }));
    ctx.sessionTitles.setTitle("dup-session", "Copy of Original session");

    const res = await request(app).get("/api/dashboard");

    expect(res.status).toBe(200);
    expect(res.body.unreadSessions).toEqual([
      expect.objectContaining({
        sessionId: "dup-session",
        title: "Copy of Original session",
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
            "gpt-4o": {
              requests: { count: 3, cost: 99 },
              usage: { inputTokens: 12, outputTokens: 8, cacheReadTokens: 2, cacheWriteTokens: 1, reasoningTokens: 4 },
            },
          },
        },
      },
    ]);
    ({ app } = createTestApp({ copilotHome }));

    const res = await request(app).get("/api/copilot-usage");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      generatedAt: expect.any(String),
      totals: {
        requests: 3,
        inputTokens: 12,
        outputTokens: 8,
        cacheReadTokens: 2,
        cacheWriteTokens: 1,
        reasoningTokens: 4,
        totalTokens: 27,
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
        {
          model: "gpt-4o",
          sessions: 1,
          requests: 3,
          inputTokens: 12,
          outputTokens: 8,
          cacheReadTokens: 2,
          cacheWriteTokens: 1,
          reasoningTokens: 4,
          totalTokens: 27,
        },
      ],
      sessions: [
        {
          sessionId: "usage-session",
          shutdownAt: "2026-05-01T12:00:00.000Z",
          requests: 3,
          inputTokens: 12,
          outputTokens: 8,
          cacheReadTokens: 2,
          cacheWriteTokens: 1,
          reasoningTokens: 4,
          totalTokens: 27,
          models: [
            {
              model: "gpt-4o",
              sessions: 1,
              requests: 3,
              inputTokens: 12,
              outputTokens: 8,
              cacheReadTokens: 2,
              cacheWriteTokens: 1,
              reasoningTokens: 4,
              totalTokens: 27,
            },
          ],
        },
      ],
    });
    expect(res.body.totals).not.toHaveProperty("cost");
    expect(res.body.models[0]).not.toHaveProperty("cost");
    expect(JSON.stringify(res.body)).not.toContain(copilotHome);
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
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
    });
    expect(res.body.models).toEqual([]);
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
      requests: 3,
      inputTokens: 10,
      outputTokens: 3,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 6,
      totalTokens: 19,
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
      requests: 2,
      inputTokens: 10,
      outputTokens: 3,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 13,
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
      { sessionId: "s1", summary: "Session one", startTime: "2026-04-19T00:00:00.000Z" } as any,
      { sessionId: "s2", summary: "Session two", startTime: "2026-04-19T00:00:00.000Z" } as any,
    ];

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

  it("POST /api/sessions/:id/duplicate duplicates a session", async () => {
    const res = await request(app).post("/api/sessions/test-id/duplicate");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("sessionId");
  });

  it("POST /api/sessions/:id/duplicate seeds the copied title from the source summary", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.listSessionsFromDisk = vi.fn().mockResolvedValue([
      {
        sessionId: "test-id",
        summary: "Original session",
        modifiedTime: "2026-04-16T12:00:00.000Z",
        lastVisibleActivityAt: "2026-04-16T12:00:00.000Z",
      },
    ]);
    ({ app, ctx } = createTestApp({ sessionManager }));

    const res = await request(app).post("/api/sessions/test-id/duplicate");

    expect(res.status).toBe(200);
    expect(ctx.sessionTitles.getTitle("dup-session")).toBe("Copy of Original session");
  });

  it("POST /api/sessions/:id/duplicate preserves all task links from the source session", async () => {
    const sessionManager = createMockSessionManager();
    ({ app, ctx } = createTestApp({ sessionManager }));
    const taskA = ctx.taskStore.createTask("Task A");
    ctx.taskStore.linkSession(taskA.id, "test-id");
    const taskB = ctx.taskStore.createTask("Task B");
    ctx.taskStore.linkSession(taskB.id, "test-id");

    const res = await request(app).post("/api/sessions/test-id/duplicate");

    expect(res.status).toBe(200);
    expect(ctx.taskStore.getTask(taskA.id)?.sessionIds).toContain("dup-session");
    expect(ctx.taskStore.getTask(taskB.id)?.sessionIds).toContain("dup-session");
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

// ── Tag MCP server routes ────────────────────────────────────────

describe("Tag MCP server routes", () => {
  let tagId: string;

  beforeEach(async () => {
    const tag = (await request(app).post("/api/tags").send({ name: "mcp-test" })).body.tag;
    tagId = tag.id;
  });

  it("GET /api/tags/:id/mcp returns empty servers initially", async () => {
    const res = await request(app).get(`/api/tags/${tagId}/mcp`);
    expect(res.status).toBe(200);
    expect(res.body.servers).toEqual(expect.any(Object));
  });

  it("PUT /api/tags/:id/mcp/:serverName sets an MCP server", async () => {
    const res = await request(app)
      .put(`/api/tags/${tagId}/mcp/test-server`)
      .send({ command: "echo", args: ["hello"] });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("PUT /api/tags/:id/mcp/:serverName stores remote MCP server configs", async () => {
    const remoteConfig = {
      type: "sse",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer tag-token" },
      tools: ["search"],
    };

    const put = await request(app)
      .put(`/api/tags/${tagId}/mcp/remote-server`)
      .send(remoteConfig);

    expect(put.status).toBe(200);

    const get = await request(app).get(`/api/tags/${tagId}/mcp`);
    expect(get.body.servers).toEqual([
      {
        serverName: "remote-server",
        config: remoteConfig,
      },
    ]);
  });

  it("DELETE /api/tags/:id/mcp/:serverName removes an MCP server", async () => {
    await request(app)
      .put(`/api/tags/${tagId}/mcp/to-delete`)
      .send({ command: "echo" });

    const res = await request(app).delete(`/api/tags/${tagId}/mcp/to-delete`);
    expect(res.status).toBe(200);

    const get = await request(app).get(`/api/tags/${tagId}/mcp`);
    expect(get.body.servers["to-delete"]).toBeUndefined();
  });
});

// ── Task group tags ──────────────────────────────────────────────

describe("Task group tag routes", () => {
  it("PUT /api/task-groups/:id/tags assigns tags to a group", async () => {
    const group = (await request(app).post("/api/task-groups").send({ name: "Tagged Group" })).body.group;
    const tag = (await request(app).post("/api/tags").send({ name: "group-tag" })).body.tag;

    const res = await request(app)
      .put(`/api/task-groups/${group.id}/tags`)
      .send({ tagIds: [tag.id] });
    expect(res.status).toBe(200);

    const list = await request(app).get("/api/task-groups");
    const found = list.body.groups.find((g: any) => g.id === group.id);
    expect(found.tags).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "group-tag" })]),
    );
  });
});

// ── Docs routes ──────────────────────────────────────────────────

describe("Docs routes", () => {
  it("GET /api/docs/tree returns empty tree initially", async () => {
    const res = await request(app).get("/api/docs/tree");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("tree");
    expect(res.body).toHaveProperty("hasRootIndex");
  });

  it("PUT /api/docs/pages writes a page", async () => {
    const res = await request(app)
      .put("/api/docs/pages/test-page")
      .send({ content: "# Test Page\n\nHello world" });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.path).toBe("test-page");
  });

  it("PUT /api/docs/pages allows tagged pages without a description", async () => {
    const res = await request(app)
      .put("/api/docs/pages/tagged-page")
      .send({
        content: `---
title: Tagged page
tags:
  - deploy
---

# Tagged page
`,
      });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(ctx.docsStore!.readPage("tagged-page")?.frontmatter.tags).toEqual(["deploy"]);
    expect(ctx.docsStore!.readPage("tagged-page")?.frontmatter.description).toBeUndefined();
  });

  it("GET /api/docs/pages reads a written page", async () => {
    await request(app)
      .put("/api/docs/pages/read-me")
      .send({ content: "# Read Me\n\nContent here" });

    const res = await request(app).get("/api/docs/pages/read-me");
    expect(res.status).toBe(200);
    expect(res.body.body).toContain("Content here");
    expect(res.body.title).toBe("read-me");
    expect(res.body.isDbItem).toBe(false);
  });

  it("GET /api/docs/pages returns 404 for missing page", async () => {
    const res = await request(app).get("/api/docs/pages/nonexistent");
    expect(res.status).toBe(404);
  });

  it("DELETE /api/docs/pages deletes a page", async () => {
    await request(app)
      .put("/api/docs/pages/to-delete")
      .send({ content: "# Delete Me" });

    const res = await request(app).delete("/api/docs/pages/to-delete");
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);

    const get = await request(app).get("/api/docs/pages/to-delete");
    expect(get.status).toBe(404);
  });

  it("PUT /api/docs/pages overwrites an existing page", async () => {
    // Write a page, then verify it can be read back
    const write = await request(app)
      .put("/api/docs/pages/overwrite-me")
      .send({ content: "# First Version" });
    expect(write.status).toBe(200);

    const read = await request(app).get("/api/docs/pages/overwrite-me");
    expect(read.status).toBe(200);
    expect(read.body.body).toContain("First Version");
  });

  it("GET /api/docs/tree reflects created pages", async () => {
    await request(app)
      .put("/api/docs/pages/notes/first")
      .send({ content: "# First Note" });

    const res = await request(app).get("/api/docs/tree");
    expect(res.status).toBe(200);
    const tree = res.body.tree;
    expect(tree.length).toBeGreaterThan(0);
  });

  it("GET /api/docs/search finds indexed pages", async () => {
    await request(app)
      .put("/api/docs/pages/searchable")
      .send({ content: "# Unique Keyword\n\nThis page has xylophone content" });

    const res = await request(app).get("/api/docs/search?q=xylophone");
    expect(res.status).toBe(200);
    expect(res.body.results.length).toBeGreaterThan(0);
  });

  it("POST /api/docs/reindex rebuilds the index", async () => {
    const res = await request(app).post("/api/docs/reindex");
    expect(res.status).toBe(200);
    expect(typeof res.body.indexed).toBe("number");
  });

  it("GET /api/docs/search returns empty for no match", async () => {
    const res = await request(app).get("/api/docs/search?q=nonexistentterm12345");
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
  });
});

// ── Docs DB (database collections) ───────────────────────────────

describe("Docs DB routes", () => {
  const folder = "incidents";

  beforeEach(async () => {
    await request(app)
      .put(`/api/docs/schema/${folder}`)
      .send({
        name: "Incidents",
        fields: [
          { name: "severity", type: "select", options: ["sev1", "sev2", "sev3"] },
          { name: "date", type: "date" },
          { name: "resolved", type: "boolean" },
        ],
      });
  });

  it("PUT /api/docs/schema creates a collection schema", async () => {
    const res = await request(app).get(`/api/docs/schema/${folder}`);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Incidents");
    expect(res.body.fields.length).toBe(3);
    expect(typeof res.body.entryCount).toBe("number");
  });

  it("POST /api/docs/db creates an entry", async () => {
    const res = await request(app)
      .post(`/api/docs/db/${folder}`)
      .send({
        fields: { title: "March Outage", severity: "sev1", date: "2026-03-15" },
        body: "The database went down.",
      });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.slug).toBeTruthy();
  });

  it("POST /api/docs/db normalizes top-level fields into a DB entry", async () => {
    const res = await request(app)
      .post(`/api/docs/db/${folder}`)
      .send({
        title: "Top-level outage",
        severity: "sev2",
        body: "Normalized from top-level fields.",
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const page = ctx.docsStore!.readPage(`${folder}/${res.body.slug}`);
    expect(page?.frontmatter.title).toBe("Top-level outage");
    expect(page?.frontmatter.severity).toBe("sev2");
    expect(page?.body).toBe("Normalized from top-level fields.");
  });

  it("GET /api/docs/pages marks DB entries", async () => {
    const create = await request(app)
      .post(`/api/docs/db/${folder}`)
      .send({
        fields: { title: "Marked outage", severity: "sev1" },
        body: "Body content",
      });

    const res = await request(app).get(`/api/docs/pages/${folder}/${create.body.slug}`);
    expect(res.status).toBe(200);
    expect(res.body.isDbItem).toBe(true);
    expect(res.body.folder).toBe(folder);
  });

  it("POST /api/docs/db extracts DB fields from body frontmatter when fields are missing", async () => {
    const res = await request(app)
      .post(`/api/docs/db/${folder}`)
      .send({
        body: "---\ntitle: Frontmatter outage\nseverity: sev1\nresolved: false\ncreated: 2026-04-09T00:00:00.000Z\nmodified: 2026-04-09T00:00:00.000Z\n---\n\nRecovered from pasted raw markdown.",
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const page = ctx.docsStore!.readPage(`${folder}/${res.body.slug}`);
    expect(page?.frontmatter.title).toBe("Frontmatter outage");
    expect(page?.frontmatter.severity).toBe("sev1");
    expect(page?.frontmatter.resolved).toBe(false);
    expect(page?.body).toBe("Recovered from pasted raw markdown.");
  });

  it("GET /api/docs/db queries entries", async () => {
    await request(app)
      .post(`/api/docs/db/${folder}`)
      .send({ fields: { title: "Entry A", severity: "sev1" } });
    await request(app)
      .post(`/api/docs/db/${folder}`)
      .send({ fields: { title: "Entry B", severity: "sev2" } });

    const res = await request(app).get(`/api/docs/db/${folder}`);
    expect(res.status).toBe(200);
    expect(res.body.entries.length).toBe(2);
    expect(typeof res.body.total).toBe("number");
    expect(res.body.entries.every((entry: any) => !("body" in entry))).toBe(true);
  });

  it("GET /api/docs/db can include markdown bodies", async () => {
    await request(app)
      .post(`/api/docs/db/${folder}`)
      .send({ fields: { title: "Body entry", severity: "sev1" }, body: "Body text for query results." });

    const res = await request(app).get(`/api/docs/db/${folder}?_includeBody=true`);
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0].body).toBe("Body text for query results.");
  });

  it("PATCH /api/docs/db updates an entry", async () => {
    const create = await request(app)
      .post(`/api/docs/db/${folder}`)
      .send({ fields: { title: "Patchable", severity: "sev3" } });
    const slug = create.body.slug;

    const res = await request(app)
      .patch(`/api/docs/db/${folder}/${slug}`)
      .send({ fields: { severity: "sev1" } });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("PATCH /api/docs/db normalizes top-level update fields", async () => {
    const create = await request(app)
      .post(`/api/docs/db/${folder}`)
      .send({ fields: { title: "Patch top-level", severity: "sev3" } });
    const slug = create.body.slug;

    const res = await request(app)
      .patch(`/api/docs/db/${folder}/${slug}`)
      .send({ severity: "sev1" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(ctx.docsStore!.readPage(`${folder}/${slug}`)?.frontmatter.severity).toBe("sev1");
  });

  it("PATCH /api/docs/db allows body-only updates", async () => {
    const create = await request(app)
      .post(`/api/docs/db/${folder}`)
      .send({ fields: { title: "Body only patch", severity: "sev3" }, body: "Original body" });
    const slug = create.body.slug;

    const res = await request(app)
      .patch(`/api/docs/db/${folder}/${slug}`)
      .send({ body: "Updated body only" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(ctx.docsStore!.readPage(`${folder}/${slug}`)?.body).toBe("Updated body only");

    const updatedSearch = await request(app).get("/api/docs/search?q=Updated%20body%20only");
    expect(updatedSearch.status).toBe(200);
    expect(updatedSearch.body.results.map((r: any) => r.path)).toContain(`${folder}/${slug}`);

    const staleSearch = await request(app).get("/api/docs/search?q=Original%20body");
    expect(staleSearch.status).toBe(200);
    expect(staleSearch.body.results.map((r: any) => r.path)).not.toContain(`${folder}/${slug}`);
  });

  it("POST /api/docs/db validates required title", async () => {
    const res = await request(app)
      .post(`/api/docs/db/${folder}`)
      .send({ fields: { severity: "sev1" } });
    expect(res.status).toBe(400);
  });

  it("POST /api/docs/db returns actionable guidance when no fields can be inferred", async () => {
    const res = await request(app)
      .post(`/api/docs/db/${folder}`)
      .send({ body: "# Just markdown" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("docs_db_add expects");
    expect(res.body.error).toContain(`folder: "${folder}"`);
  });

  it("PUT /api/docs/pages rejects DB-folder writes with docs_db_add guidance", async () => {
    const res = await request(app)
      .put(`/api/docs/pages/${folder}/manual-write`)
      .send({ content: "# Raw write" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain(`Cannot write raw content to DB folder "${folder}"`);
    expect(res.body.error).toContain("docs_db_add");
    expect(res.body.error).toContain(`folder: "${folder}"`);
  });
});

// ── Enriched task route ──────────────────────────────────────────

describe("Task enrichment routes", () => {
  it("GET /api/tasks/:id/enriched returns task with empty enrichment", async () => {
    const task = (await request(app).post("/api/tasks").send({ title: "Enriched" })).body.task;

    const res = await request(app).get(`/api/tasks/${task.id}/enriched`);
    expect(res.status).toBe(200);
    expect(res.body.task.title).toBe("Enriched");
    expect(res.body.workItems).toEqual([]);
    expect(res.body.pullRequests).toEqual([]);
  });

  it("GET /api/tasks/:id/enriched returns 404 for missing task", async () => {
    const res = await request(app).get("/api/tasks/nonexistent/enriched");
    expect(res.status).toBe(404);
  });
});
