import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { muxOggOpus } from "../shared/ogg-opus.js";
import { oggOpusToneFixture } from "../test-support/ogg-opus-fixture.js";
import type { ApiRouteTestState, DeferredPromptRunner } from "../test-support/api-routes.js";
import {
  createCopilotUsageTestHome,
  createMockSessionManager,
  createMockTranscriptionService,
  createRestartRuntimePaths,
  createTestApp,
  createWavBuffer,
  get,
  installApiRouteTestHooks,
  join,
  makeTestDir,
  mkdirSync,
  providers,
  publishOutboundAttachment,
  request,
  scheduler,
  writeCopilotUsageEvents,
  writeRawCopilotUsageEvents,
  writeFileSync,
  writeRestartState,
} from "../test-support/api-routes.js";

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
    const transcribe = vi.fn().mockResolvedValue({ text: "Hello bridge", provider: "speech-engine" });
    ({ app, ctx } = createTestApp({
      transcriptionService: createMockTranscriptionService({
        getStatus: () => ({
          available: true,
          provider: "speech-engine",
          label: "Parakeet v3 (local)",
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
    expect(res.body).toEqual({ text: "Hello bridge", provider: "speech-engine" });
    expect(transcribe).toHaveBeenCalledOnce();
    expect(transcribe).toHaveBeenCalledWith({
      filePath: expect.stringContaining("recording.wav"),
    });
  });

  it("POST /api/transcribe returns 503 when voice input is unavailable", async () => {
    const transcribe = vi.fn();
    ({ app } = createTestApp({
      transcriptionService: createMockTranscriptionService({
        getStatus: () => ({
          available: false,
          provider: "disabled",
          label: "Unavailable",
          reason: "Set up the speech engine in Settings → Voice, or from Helm's hands-free mode.",
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
    expect(res.body.error).toContain("Set up the speech engine");
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("POST /api/transcribe rejects malformed wav uploads", async () => {
    const transcribe = vi.fn();
    ({ app } = createTestApp({
      transcriptionService: createMockTranscriptionService({
        getStatus: () => ({
          available: true,
          provider: "speech-engine",
          label: "Parakeet v3 (local)",
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
          provider: "speech-engine",
          label: "Parakeet v3 (local)",
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

  describe("compressed recordings", () => {
    /** A valid stream of 20 ms packets; nothing here decodes it, so the payload can be anything. */
    const oggOpusRecording = (seconds: number) => Buffer.from(muxOggOpus({
      channels: 1,
      preSkip: 312,
      inputSampleRate: 16_000,
      packets: Array.from({ length: Math.round(seconds * 50) }, () => new Uint8Array([0x48, 1, 2, 3])),
    }));

    function createAppWithLimit(maxDurationSeconds: number) {
      const transcribe = vi.fn().mockResolvedValue({ text: "Hello bridge", provider: "speech-engine" });
      ({ app } = createTestApp({
        transcriptionService: createMockTranscriptionService({
          getStatus: () => ({ available: true, provider: "speech-engine", label: "Parakeet v3 (local)", maxDurationSeconds, opusUploads: true }),
          transcribe,
        }),
      }));
      return transcribe;
    }

    it("POST /api/transcribe accepts an Ogg Opus recording", async () => {
      const transcribe = createAppWithLimit(120);

      const res = await request(app)
        .post("/api/transcribe")
        .attach("audio", oggOpusRecording(3), { filename: "voice-input.ogg", contentType: "audio/ogg" });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ text: "Hello bridge", provider: "speech-engine" });
      expect(transcribe.mock.calls[0]![0].filePath).toMatch(/voice-input\.ogg$/);
    });

    it("POST /api/transcribe measures an Ogg Opus recording against the duration limit", async () => {
      const transcribe = createAppWithLimit(1);

      const tooLong = await request(app)
        .post("/api/transcribe")
        .attach("audio", oggOpusRecording(2), { filename: "voice-input.ogg", contentType: "audio/ogg" });
      expect(tooLong.status).toBe(400);
      expect(tooLong.body.error).toContain("Audio exceeds 1 seconds");

      // A recording stopped exactly at the limit: the encoder padded it to 51 packets, and it still fits.
      const atTheLimit = Buffer.from(muxOggOpus({
        channels: 1,
        preSkip: 312,
        inputSampleRate: 16_000,
        packets: Array.from({ length: 51 }, () => new Uint8Array([0x48, 1, 2, 3])),
        endSample: 312 + 48_000,
      }));
      const fits = await request(app)
        .post("/api/transcribe")
        .attach("audio", atTheLimit, { filename: "voice-input.ogg", contentType: "audio/ogg" });
      expect(fits.status).toBe(200);
      expect(transcribe).toHaveBeenCalledOnce();
    });

    it("POST /api/transcribe rejects a damaged or empty Ogg Opus recording as a bad upload", async () => {
      const transcribe = createAppWithLimit(120);
      const recording = oggOpusRecording(3);

      const truncated = await request(app)
        .post("/api/transcribe")
        .attach("audio", recording.subarray(0, recording.length - 10), { filename: "voice-input.ogg", contentType: "audio/ogg" });
      expect(truncated.status).toBe(400);
      expect(truncated.body.error).toContain("truncated");

      const empty = await request(app)
        .post("/api/transcribe")
        .attach("audio", oggOpusRecording(0), { filename: "voice-input.ogg", contentType: "audio/ogg" });
      expect(empty.status).toBe(400);
      expect(empty.body.error).toContain("does not contain audio");
      expect(transcribe).not.toHaveBeenCalled();
    });
  });
});

describe("Voice job routes", () => {
  it.each(["wav", "opus"] as const)("POST /api/voice-jobs accepts %s and starts a server-owned autosend for an existing session", async (format) => {
    const sessionManager = createMockSessionManager();
    sessionManager.startWork = vi.fn();
    sessionManager.readMessagesFromDisk = vi.fn().mockImplementation(async () => ({
      messages: [{
        type: "message",
        role: "user",
        content: "Hello bridge",
        timestamp: new Date().toISOString(),
      }],
      total: 1,
      hasMore: false,
    }));
    const transcribe = vi.fn().mockResolvedValue({ text: "Hello bridge", provider: "speech-engine" });
    ({ app, ctx } = createTestApp({
      sessionManager,
      transcriptionService: createMockTranscriptionService({
        getStatus: () => ({
          available: true,
          provider: "speech-engine",
          label: "Parakeet v3 (local)",
          maxDurationSeconds: 120,
        }),
        transcribe,
      }),
    }));

    const res = await request(app)
      .post("/api/voice-jobs")
      .field("composerKey", "existing-session")
      .field("sessionId", "existing-session")
      .attach("audio", format === "opus" ? Buffer.from(oggOpusToneFixture()) : createWavBuffer(1), {
        filename: format === "opus" ? "recording.ogg" : "recording.wav",
        contentType: format === "opus" ? "audio/ogg" : "audio/wav",
      });

    expect(res.status).toBe(202);
    expect(res.body).toMatchObject({
      composerKey: "existing-session",
      targetSessionId: "existing-session",
      status: "accepted",
      safeToLeave: true,
    });

    await ctx.voiceJobManager.shutdown();

    expect(transcribe).toHaveBeenCalledOnce();
    expect(sessionManager.startWork).toHaveBeenCalledWith("existing-session", "Hello bridge");

    const jobRes = await request(app).get(`/api/voice-jobs/${res.body.id}`);
    expect(jobRes.status).toBe(200);
    expect(jobRes.body.status).toBe("done");
  });

  it("POST /api/voice-jobs accepts draft-session autosend while restart is active in persisted state", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.createSession = vi.fn().mockResolvedValue({ sessionId: "new-session" });
    sessionManager.validateModelSelection = vi.fn().mockResolvedValue({ ok: true });
    const runtimePaths = createRestartRuntimePaths();
    await writeRestartState(join(runtimePaths.dataDir, "restart-state.json"), { phase: "restarting", releaseFailure: null });
    ({ app } = createTestApp({
      runtimePaths,
      sessionManager,
      transcriptionService: createMockTranscriptionService({
        getStatus: () => ({
          available: true,
          provider: "speech-engine",
          label: "Parakeet v3 (local)",
          maxDurationSeconds: 120,
        }),
      }),
    }));

    const res = await request(app)
      .post("/api/voice-jobs")
      .field("composerKey", "draft:quickchat")
      .field("sessionOptions", JSON.stringify({
        model: "gpt-5.6-sol",
        reasoningEffort: "xhigh",
        contextTier: "long_context",
      }))
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
    expect(sessionManager.createSession).toHaveBeenCalledWith({
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
      contextTier: "long_context",
    });
    expect(sessionManager.validateModelSelection).toHaveBeenCalledWith({
      model: "gpt-5.6-sol",
      reasoningEffort: "xhigh",
      contextTier: "long_context",
    });
  });

  it("draft-route voice jobs recover through the materialized session when autosend fails", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.createSession = vi.fn().mockResolvedValue({ sessionId: "new-session" });
    sessionManager.startWork = vi.fn(() => {
      throw new Error("Session is busy, please wait");
    });
    const transcribe = vi.fn().mockResolvedValue({ text: "Hello draft route", provider: "speech-engine" });
    ({ app, ctx } = createTestApp({
      sessionManager,
      transcriptionService: createMockTranscriptionService({
        getStatus: () => ({
          available: true,
          provider: "speech-engine",
          label: "Parakeet v3 (local)",
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

    // Processing is registered before the 202 response. shutdown() awaits every
    // in-flight run, so the job is terminal before the assertion instead of
    // racing a fixed number of HTTP polls against real filesystem work.
    await ctx.voiceJobManager.shutdown();
    const jobRes = await request(app).get(`/api/voice-jobs/${res.body.id}`);
    expect(jobRes.status).toBe(200);
    expect(jobRes.body.status).toBe("error");
    expect(jobRes.body.transcript).toBe("Hello draft route");

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

  it("POST /api/voice-jobs/:id/recovered removes retained audio artifacts", async () => {
    const id = randomUUID();
    const dataDir = ctx.runtimePaths!.dataDir;
    const audioPath = join(dataDir, "voice-jobs", id, "recording.wav");
    mkdirSync(join(dataDir, "voice-jobs", id), { recursive: true });
    writeFileSync(audioPath, "test-audio");
    const now = new Date().toISOString();
    db.prepare(`
      INSERT INTO voice_jobs (
        id, composerKey, taskId, targetSessionId, status, audioPath, transcript, error, createdAt, updatedAt
      ) VALUES (?, ?, NULL, ?, 'error', ?, ?, ?, ?, ?)
    `).run(
      id,
      "existing-session",
      "existing-session",
      audioPath,
      "Recovered transcript",
      "Auto-send failed",
      now,
      now,
    );

    const recovered = await request(app).post(`/api/voice-jobs/${id}/recovered`);

    expect(recovered.status).toBe(200);
    expect(recovered.body.status).toBe("recovered");
    expect(existsSync(join(dataDir, "voice-jobs", id))).toBe(false);
  });
});

// ── Task CRUD ────────────────────────────────────────────────────
