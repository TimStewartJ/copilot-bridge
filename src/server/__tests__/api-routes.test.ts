import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { get } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import request from "supertest";
import type { Express } from "express";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { AppContext } from "../app-context.js";
import { publishOutboundAttachment } from "../outbound-attachments.js";
import { clearRestartPending, RESTART_PENDING_MESSAGE, triggerRestartPending } from "../session-manager.js";
import * as scheduler from "../scheduler.js";
import { createMockSessionManager, createMockTranscriptionService, createTestApp } from "./helpers.js";

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
const ORIGINAL_TRANSCRIPTION_ENV = Object.fromEntries(
  TRANSCRIPTION_ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof TRANSCRIPTION_ENV_KEYS)[number], string | undefined>;
const COPILOT_USAGE_TEST_ROOT = join(process.cwd(), "data", "test-api-copilot-usage");
const copilotUsageTestDirs: string[] = [];

function createCopilotUsageTestHome(options?: { dotDir?: boolean }): string {
  const rootDir = join(COPILOT_USAGE_TEST_ROOT, randomUUID());
  const copilotHome = options?.dotDir ? join(rootDir, ".copilot") : rootDir;
  mkdirSync(copilotHome, { recursive: true });
  copilotUsageTestDirs.push(rootDir);
  return copilotHome;
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
    delete process.env[key];
  }
  ({ app, ctx } = createTestApp());
});

afterEach(() => {
  clearRestartPending();
  scheduler.shutdown();
  for (const key of TRANSCRIPTION_ENV_KEYS) {
    const original = ORIGINAL_TRANSCRIPTION_ENV[key];
    if (original === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = original;
    }
  }
  for (const dir of copilotUsageTestDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
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
      expect(order).toEqual(["pause", "graceful", "shutdown"]);
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
});

describe("Attachment routes", () => {
  const tempDirs: string[] = [];
  const sessionId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("GET /api/sessions/:id/attachments/:attachmentId downloads non-inline attachments", async () => {
    const copilotHome = mkdtempSync(join(tmpdir(), "bridge-route-home-"));
    tempDirs.push(copilotHome);
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
    const copilotHome = mkdtempSync(join(tmpdir(), "bridge-route-home-"));
    tempDirs.push(copilotHome);
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
    const parent = mkdtempSync(join(tmpdir(), "bridge-route-home-"));
    tempDirs.push(parent);
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
    const copilotHome = mkdtempSync(join(tmpdir(), "bridge-route-home-"));
    tempDirs.push(copilotHome);
    const { app: attachmentApp } = createTestApp({ copilotHome });

    const res = await request(attachmentApp)
      .get(`/api/sessions/${sessionId}/attachments/..secret.txt`);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("invalid");
  });

  it("GET /api/sessions/:id/attachments/:attachmentId rejects traversal in session ids", async () => {
    const copilotHome = mkdtempSync(join(tmpdir(), "bridge-route-home-"));
    tempDirs.push(copilotHome);
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
    const copilotHome = mkdtempSync(join(tmpdir(), "bridge-route-home-"));
    tempDirs.push(copilotHome);
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
    expect(res.body.task.status).toBe("active");
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
      .send({ title: "Updated", notes: "Some notes" });
    expect(res.status).toBe(200);
    expect(res.body.task.title).toBe("Updated");
    expect(res.body.task.notes).toBe("Some notes");
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

// ── Todo CRUD ────────────────────────────────────────────────────

describe("Todo routes", () => {
  let taskId: string;

  beforeEach(async () => {
    const task = await request(app)
      .post("/api/tasks")
      .send({ title: "Todo Host" });
    taskId = task.body.task.id;
  });

  it("GET /api/tasks/:taskId/todos returns empty list initially", async () => {
    const res = await request(app).get(`/api/tasks/${taskId}/todos`);
    expect(res.status).toBe(200);
    expect(res.body.todos).toEqual([]);
  });

  it("POST /api/tasks/:taskId/todos creates a todo", async () => {
    const res = await request(app)
      .post(`/api/tasks/${taskId}/todos`)
      .send({ text: "Write tests" });
    expect(res.status).toBe(200);
    expect(res.body.todo.text).toBe("Write tests");
    expect(res.body.todo.done).toBe(false);
  });

  it("PATCH /api/todos/:id updates a todo", async () => {
    const create = await request(app)
      .post(`/api/tasks/${taskId}/todos`)
      .send({ text: "Draft" });
    const id = create.body.todo.id;

    const res = await request(app)
      .patch(`/api/todos/${id}`)
      .send({ text: "Final", done: true });
    expect(res.status).toBe(200);
    expect(res.body.todo.text).toBe("Final");
    expect(res.body.todo.done).toBe(true);
  });

  it("DELETE /api/todos/:id removes a todo", async () => {
    const create = await request(app)
      .post(`/api/tasks/${taskId}/todos`)
      .send({ text: "Ephemeral" });
    const id = create.body.todo.id;

    const del = await request(app).delete(`/api/todos/${id}`);
    expect(del.status).toBe(200);
    expect(del.body.ok).toBe(true);

    const list = await request(app).get(`/api/tasks/${taskId}/todos`);
    expect(list.body.todos).toEqual([]);
  });

  it("POST /api/todos creates a global todo", async () => {
    const res = await request(app)
      .post("/api/todos")
      .send({ text: "Global todo" });
    expect(res.status).toBe(200);
    expect(res.body.todo.text).toBe("Global todo");
    expect(res.body.todo.taskId).toBeNull();
  });

  it("GET /api/todos/open returns open todos", async () => {
    await request(app)
      .post(`/api/tasks/${taskId}/todos`)
      .send({ text: "Open one" });

    const res = await request(app).get("/api/todos/open");
    expect(res.status).toBe(200);
    expect(res.body.todos.length).toBeGreaterThanOrEqual(1);
    expect(res.body.todos[0].text).toBe("Open one");
  });

  it("PUT /api/tasks/:taskId/todos/reorder reorders todos", async () => {
    const t1 = (await request(app).post(`/api/tasks/${taskId}/todos`).send({ text: "First" })).body.todo;
    const t2 = (await request(app).post(`/api/tasks/${taskId}/todos`).send({ text: "Second" })).body.todo;

    const res = await request(app)
      .put(`/api/tasks/${taskId}/todos/reorder`)
      .send({ todoIds: [t2.id, t1.id] });
    expect(res.status).toBe(200);

    const list = await request(app).get(`/api/tasks/${taskId}/todos`);
    expect(list.body.todos[0].id).toBe(t2.id);
    expect(list.body.todos[1].id).toBe(t1.id);
  });

  it("POST /api/tasks/:taskId/todos with deadline", async () => {
    const res = await request(app)
      .post(`/api/tasks/${taskId}/todos`)
      .send({ text: "Due soon", deadline: "2026-12-31" });
    expect(res.status).toBe(200);
    expect(res.body.todo.deadline).toBe("2026-12-31");
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

  it("POST /api/schedules accepts reuse-target mode for linked task sessions", async () => {
    ctx.taskStore.linkSession(taskId, "linked-session");
    ctx.sessionManager.listSessionsFromDisk = async () => [{ sessionId: "linked-session" }];
    scheduler.initialize(ctx.sessionManager as any, {
      scheduleStore: ctx.scheduleStore,
      taskStore: ctx.taskStore,
      sessionMetaStore: ctx.sessionMetaStore,
      globalBus: ctx.globalBus,
    });

    const res = await request(app)
      .post("/api/schedules")
      .send({
        taskId,
        name: "Target linked session",
        prompt: "Continue the conversation",
        type: "cron",
        cron: "0 0 * * *",
        sessionMode: "reuse-target",
        targetSessionId: "linked-session",
      });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      sessionMode: "reuse-target",
      targetSessionId: "linked-session",
    });
    expect(res.body).not.toHaveProperty("reuseSession");
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

  it("POST /api/schedules rejects reuse-target mode for sessions outside the task", async () => {
    ctx.sessionManager.listSessionsFromDisk = async () => [{ sessionId: "linked-session" }];

    const res = await request(app)
      .post("/api/schedules")
      .send({
        taskId,
        name: "Wrong target",
        prompt: "Continue the conversation",
        type: "cron",
        cron: "0 0 * * *",
        sessionMode: "reuse-target",
        targetSessionId: "linked-session",
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/same task/i);
  });

  it("PATCH /api/schedules preserves the existing target for reuse-target schedules", async () => {
    ctx.taskStore.linkSession(taskId, "linked-session");
    ctx.taskStore.linkSession(taskId, "other-session");
    ctx.sessionManager.listSessionsFromDisk = async () => [
      { sessionId: "linked-session" },
      { sessionId: "other-session" },
    ];
    scheduler.initialize(ctx.sessionManager as any, {
      scheduleStore: ctx.scheduleStore,
      taskStore: ctx.taskStore,
      sessionMetaStore: ctx.sessionMetaStore,
      globalBus: ctx.globalBus,
    });
    const schedule = ctx.scheduleStore.createSchedule({
      taskId,
      name: "Keep target",
      prompt: "Continue the conversation",
      type: "cron",
      cron: "0 0 * * *",
      sessionMode: "reuse-target",
      targetSessionId: "linked-session",
    });

    const res = await request(app)
      .patch(`/api/schedules/${schedule.id}`)
      .send({ sessionMode: "reuse-target" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      sessionMode: "reuse-target",
      targetSessionId: "linked-session",
    });
    expect(res.body).not.toHaveProperty("reuseSession");
  });

  it("PATCH /api/schedules preserves a missing existing target for reuse-target schedules", async () => {
    ctx.taskStore.linkSession(taskId, "linked-session");
    ctx.sessionManager.listSessionsFromDisk = async () => [];
    const schedule = ctx.scheduleStore.createSchedule({
      taskId,
      name: "Keep missing target",
      prompt: "Continue the conversation",
      type: "cron",
      cron: "0 0 * * *",
      sessionMode: "reuse-target",
      targetSessionId: "linked-session",
    });

    const res = await request(app)
      .patch(`/api/schedules/${schedule.id}`)
      .send({ sessionMode: "reuse-target", name: "Renamed" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      name: "Renamed",
      sessionMode: "reuse-target",
      targetSessionId: "linked-session",
    });
  });

  it("PATCH /api/schedules rejects preserving a target that is no longer linked to the task", async () => {
    ctx.taskStore.linkSession(taskId, "linked-session");
    ctx.taskStore.unlinkSession(taskId, "linked-session");
    ctx.sessionManager.listSessionsFromDisk = async () => [];
    const schedule = ctx.scheduleStore.createSchedule({
      taskId,
      name: "Broken target",
      prompt: "Continue the conversation",
      type: "cron",
      cron: "0 0 * * *",
      sessionMode: "reuse-target",
      targetSessionId: "linked-session",
    });

    const res = await request(app)
      .patch(`/api/schedules/${schedule.id}`)
      .send({ sessionMode: "reuse-target", name: "Renamed" });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/same task/i);
  });

  it("PATCH /api/schedules ignores legacy reuseSession for existing reuse-target schedules", async () => {
    ctx.taskStore.linkSession(taskId, "linked-session");
    ctx.sessionManager.listSessionsFromDisk = async () => [{ sessionId: "linked-session" }];
    const schedule = ctx.scheduleStore.createSchedule({
      taskId,
      name: "Keep target legacy",
      prompt: "Continue the conversation",
      type: "cron",
      cron: "0 0 * * *",
      sessionMode: "reuse-target",
      targetSessionId: "linked-session",
    });

    const res = await request(app)
      .patch(`/api/schedules/${schedule.id}`)
      .send({ reuseSession: true, name: "Renamed" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      name: "Renamed",
      sessionMode: "reuse-target",
      targetSessionId: "linked-session",
    });
    expect(res.body).not.toHaveProperty("reuseSession");
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

  it("POST /api/chat requires sessionId and prompt", async () => {
    const res = await request(app)
      .post("/api/chat")
      .send({});
    expect(res.status).toBe(400);
  });

  it("POST /api/chat rejects new work when restart is imminent (no active sessions)", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.startWork = vi.fn();
    ({ app, ctx } = createTestApp({ sessionManager }));
    triggerRestartPending();

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
    expect(res.body).toEqual({ ok: true });
  });

  it("GET /api/dashboard includes schedules array", async () => {
    const res = await request(app).get("/api/dashboard");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("schedules");
    expect(Array.isArray(res.body.schedules)).toBe(true);
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
