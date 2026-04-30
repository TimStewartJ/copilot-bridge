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
