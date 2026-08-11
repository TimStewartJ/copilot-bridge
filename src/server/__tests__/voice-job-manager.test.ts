import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { makeTestRuntimePaths } from "./helpers.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openMemoryDatabase } from "../db.js";
import { createGlobalBus } from "../global-bus.js";
import { writeRestartState } from "../restart-state.js";
import {
  configureRestartStateStore,
  forceClearRestartPending,
  refreshRestartState,
  RESTART_PENDING_MESSAGE,
} from "../session-manager.js";
import { createTaskGroupStore } from "../task-group-store.js";
import { createTaskStore } from "../task-store.js";
import {
  createVoiceJobManager,
  VOICE_JOB_ORPHAN_GRACE_MS,
} from "../voice-job-manager.js";
import { createVoiceJobStore } from "../voice-job-store.js";

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function createRestartRuntimePaths() {
  return makeTestRuntimePaths("voice-jobs");
}

function createManagerHarness(transcribe = vi.fn()) {
  const runtimePaths = createRestartRuntimePaths();
  const db = openMemoryDatabase();
  const store = createVoiceJobStore(db);
  const globalBus = createGlobalBus();
  const sessionManager = {
    isSessionBusy: vi.fn(() => false),
    startWork: vi.fn(),
    readMessagesFromDisk: vi.fn(async () => ({ messages: [], total: 0, hasMore: false })),
  } as any;
  const manager = createVoiceJobManager({
    dataDir: runtimePaths.dataDir,
    store,
    transcriptionService: {
      getStatus: () => ({
        available: true,
        provider: "whisper.cpp",
        label: "whisper.cpp",
        maxDurationSeconds: 120,
      }),
      transcribe,
    },
    sessionManager,
    taskStore: createTaskStore(db, globalBus, { runtimePaths }),
    taskGroupStore: createTaskGroupStore(db, globalBus),
  });
  return { runtimePaths, store, sessionManager, manager };
}

beforeEach(async () => {
  forceClearRestartPending();
  await refreshRestartState();
});

afterEach(async () => {
  forceClearRestartPending();
  await refreshRestartState();
  configureRestartStateStore(undefined);
  vi.useRealTimers();
});

describe("voice job restart gating", () => {
  it("accepts a new draft voice job while restart is active", async () => {
    const runtimePaths = createRestartRuntimePaths();
    configureRestartStateStore(runtimePaths);
    await writeRestartState(join(runtimePaths.dataDir, "restart-state.json"), {
      requestId: "req-voice-accept",
      phase: "queued",
      requestedAt: new Date().toISOString(),
      waitingSessions: 0,
      launcherHeartbeatAt: null,
    });

    const db = openMemoryDatabase();
    const store = createVoiceJobStore(db);
    const globalBus = createGlobalBus();
    const taskStore = createTaskStore(db, globalBus, { runtimePaths });
    const sessionManager = {
      createSession: vi.fn().mockResolvedValue({ sessionId: "new-session" }),
    } as any;
    const manager = createVoiceJobManager({
      dataDir: runtimePaths.dataDir,
      store,
      transcriptionService: {
        getStatus: () => ({
          available: true,
          provider: "whisper.cpp",
          label: "whisper.cpp",
          maxDurationSeconds: 120,
        }),
        transcribe: vi.fn(),
      },
      sessionManager,
      taskStore,
      taskGroupStore: createTaskGroupStore(db, globalBus),
    });

    const sourceFilePath = join(runtimePaths.dataDir, "input.wav");
    writeFileSync(sourceFilePath, "test-audio");

    const result = await manager.acceptVoiceJob({
      composerKey: "draft:quickchat",
      sourceFilePath,
      originalFilename: "recording.wav",
      sessionOptions: {
        model: "gpt-5.6-sol",
        reasoningEffort: "xhigh",
        contextTier: "long_context",
      },
    });

    expect(result).toMatchObject({
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
    expect(store.getVoiceJob(result.id)).toMatchObject({
      composerKey: "draft:quickchat",
      targetSessionId: "new-session",
    });
  });

  describe("voice job artifact retention", () => {
    it("removes audio artifacts when transcription fails", async () => {
      const transcribe = vi.fn().mockRejectedValue(new Error("whisper failed"));
      const { runtimePaths, store, manager } = createManagerHarness(transcribe);
      const sourceFilePath = join(runtimePaths.dataDir, "input.wav");
      writeFileSync(sourceFilePath, "test-audio");

      const accepted = await manager.acceptVoiceJob({
        composerKey: "existing-session",
        targetSessionId: "existing-session",
        sourceFilePath,
        originalFilename: "recording.wav",
      });
      await manager.shutdown();

      expect(store.getVoiceJob(accepted.id)).toMatchObject({
        status: "error",
        error: "whisper failed",
      });
      expect(existsSync(join(runtimePaths.dataDir, "voice-jobs", accepted.id))).toBe(false);
    });

    it("does not retry terminal transcription errors after restart", async () => {
      const transcribe = vi.fn();
      const { runtimePaths, store, manager } = createManagerHarness(transcribe);
      const id = randomUUID();
      const audioPath = join(runtimePaths.dataDir, "voice-jobs", id, "recording.wav");
      mkdirSync(dirname(audioPath), { recursive: true });
      writeFileSync(audioPath, "test-audio");
      store.createVoiceJob({
        id,
        composerKey: "existing-session",
        targetSessionId: "existing-session",
        audioPath,
      });
      store.markError(id, "whisper failed");

      await manager.runMaintenance();
      manager.resumePendingJobs();
      await manager.shutdown();

      expect(transcribe).not.toHaveBeenCalled();
      expect(store.getVoiceJob(id)?.status).toBe("error");
      expect(existsSync(dirname(audioPath))).toBe(false);
    });

    it("removes old orphan job directories but preserves young candidates", async () => {
      const { runtimePaths, manager } = createManagerHarness();
      const now = Date.parse("2026-07-23T20:00:00.000Z");
      const oldId = randomUUID();
      const youngId = randomUUID();
      const oldDir = join(runtimePaths.dataDir, "voice-jobs", oldId);
      const youngDir = join(runtimePaths.dataDir, "voice-jobs", youngId);
      mkdirSync(oldDir, { recursive: true });
      mkdirSync(youngDir, { recursive: true });
      writeFileSync(join(oldDir, "recording.wav"), "old-audio");
      writeFileSync(join(youngDir, "recording.wav"), "young-audio");
      const oldTime = new Date(now - VOICE_JOB_ORPHAN_GRACE_MS - 1);
      const youngTime = new Date(now - VOICE_JOB_ORPHAN_GRACE_MS + 1);
      utimesSync(oldDir, oldTime, oldTime);
      utimesSync(youngDir, youngTime, youngTime);

      const result = await manager.runMaintenance(now);
      await manager.shutdown();

      expect(result.orphanDirectoriesRemoved).toBe(1);
      expect(existsSync(oldDir)).toBe(false);
      expect(existsSync(youngDir)).toBe(true);
    });

    it("preserves active job directories during maintenance", async () => {
      const { runtimePaths, store, manager } = createManagerHarness();
      const now = Date.parse("2026-07-23T20:00:00.000Z");
      const id = randomUUID();
      const audioPath = join(runtimePaths.dataDir, "voice-jobs", id, "recording.wav");
      mkdirSync(dirname(audioPath), { recursive: true });
      writeFileSync(audioPath, "test-audio");
      const oldTime = new Date(now - VOICE_JOB_ORPHAN_GRACE_MS - 1);
      utimesSync(dirname(audioPath), oldTime, oldTime);
      store.createVoiceJob({
        id,
        composerKey: "existing-session",
        targetSessionId: "existing-session",
        audioPath,
      });
      store.updateVoiceJob(id, { status: "transcribing" });

      const result = await manager.runMaintenance(now);
      await manager.shutdown();

      expect(result.orphanDirectoriesRemoved).toBe(0);
      expect(existsSync(dirname(audioPath))).toBe(true);
      expect(store.getVoiceJob(id)?.status).toBe("transcribing");
    });
  });

  it("rejects accepting a new draft voice job while launcher restart cutover is in progress", async () => {
    const runtimePaths = createRestartRuntimePaths();
    configureRestartStateStore(runtimePaths);
    await writeRestartState(join(runtimePaths.dataDir, "restart-state.json"), {
      requestId: "req-voice-accept-restarting",
      phase: "restarting",
      requestedAt: new Date().toISOString(),
      waitingSessions: 0,
      launcherHeartbeatAt: new Date().toISOString(),
    });

    const db = openMemoryDatabase();
    const store = createVoiceJobStore(db);
    const globalBus = createGlobalBus();
    const taskStore = createTaskStore(db, globalBus, { runtimePaths });
    const sessionManager = {
      createSession: vi.fn(),
    } as any;
    const manager = createVoiceJobManager({
      dataDir: runtimePaths.dataDir,
      store,
      transcriptionService: {
        getStatus: () => ({
          available: true,
          provider: "whisper.cpp",
          label: "whisper.cpp",
          maxDurationSeconds: 120,
        }),
        transcribe: vi.fn(),
      },
      sessionManager,
      taskStore,
      taskGroupStore: createTaskGroupStore(db, globalBus),
    });

    const sourceFilePath = join(runtimePaths.dataDir, "input.wav");
    writeFileSync(sourceFilePath, "test-audio");

    await expect(manager.acceptVoiceJob({
      composerKey: "draft:quickchat",
      sourceFilePath,
      originalFilename: "recording.wav",
    })).rejects.toThrow(RESTART_PENDING_MESSAGE);

    expect(sessionManager.createSession).not.toHaveBeenCalled();
    expect(store.listPendingVoiceJobs()).toEqual([]);
  });

  it("resumes pending voice jobs while restart is active", async () => {
    const runtimePaths = createRestartRuntimePaths();
    configureRestartStateStore(runtimePaths);
    await writeRestartState(join(runtimePaths.dataDir, "restart-state.json"), {
      requestId: "req-voice-resume",
      phase: "waiting-for-sessions",
      requestedAt: new Date().toISOString(),
      waitingSessions: 1,
      launcherHeartbeatAt: null,
    });

    const db = openMemoryDatabase();
    const store = createVoiceJobStore(db);
    const globalBus = createGlobalBus();
    const taskStore = createTaskStore(db, globalBus, { runtimePaths });
    const sessionManager = {
      isSessionBusy: vi.fn(() => false),
      startWork: vi.fn(),
      readMessagesFromDisk: vi.fn(async () => ({
        messages: [{
          type: "message",
          role: "user",
          content: "Hello bridge",
          timestamp: new Date().toISOString(),
        }],
        total: 1,
        hasMore: false,
      })),
    } as any;
    const manager = createVoiceJobManager({
      dataDir: runtimePaths.dataDir,
      store,
      transcriptionService: {
        getStatus: () => ({
          available: true,
          provider: "whisper.cpp",
          label: "whisper.cpp",
          maxDurationSeconds: 120,
        }),
        transcribe: vi.fn(),
      },
      sessionManager,
      taskStore,
      taskGroupStore: createTaskGroupStore(db, globalBus),
    });

    const audioPath = join(runtimePaths.dataDir, "voice-jobs", "persisted", "recording.wav");
    mkdirSync(dirname(audioPath), { recursive: true });
    writeFileSync(audioPath, "test-audio");
    store.createVoiceJob({
      id: "job-1",
      composerKey: "existing-session",
      targetSessionId: "existing-session",
      audioPath,
    });
    store.updateVoiceJob("job-1", {
      status: "accepted",
      transcript: "Hello bridge",
    });

    manager.resumePendingJobs();
    await manager.shutdown();

    expect(sessionManager.startWork).toHaveBeenCalledWith("existing-session", "Hello bridge");
    expect(store.getVoiceJob("job-1")?.status).toBe("done");
  });

  it("does not resume pending voice jobs while launcher restart cutover is in progress", async () => {
    vi.useFakeTimers();

    const runtimePaths = createRestartRuntimePaths();
    configureRestartStateStore(runtimePaths);
    await writeRestartState(join(runtimePaths.dataDir, "restart-state.json"), {
      requestId: "req-voice-resume-restarting",
      phase: "restarting",
      requestedAt: new Date().toISOString(),
      waitingSessions: 0,
      launcherHeartbeatAt: new Date().toISOString(),
    });

    const db = openMemoryDatabase();
    const store = createVoiceJobStore(db);
    const globalBus = createGlobalBus();
    const taskStore = createTaskStore(db, globalBus, { runtimePaths });
    const sessionManager = {
      isSessionBusy: vi.fn(() => false),
      startWork: vi.fn(),
      readMessagesFromDisk: vi.fn(async () => ({ messages: [], total: 0, hasMore: false })),
    } as any;
    const manager = createVoiceJobManager({
      dataDir: runtimePaths.dataDir,
      store,
      transcriptionService: {
        getStatus: () => ({
          available: true,
          provider: "whisper.cpp",
          label: "whisper.cpp",
          maxDurationSeconds: 120,
        }),
        transcribe: vi.fn(),
      },
      sessionManager,
      taskStore,
      taskGroupStore: createTaskGroupStore(db, globalBus),
    });

    const audioPath = join(runtimePaths.dataDir, "voice-jobs", "persisted", "recording.wav");
    mkdirSync(dirname(audioPath), { recursive: true });
    writeFileSync(audioPath, "test-audio");
    store.createVoiceJob({
      id: "job-1",
      composerKey: "existing-session",
      targetSessionId: "existing-session",
      audioPath,
    });
    store.updateVoiceJob("job-1", {
      status: "accepted",
      transcript: "Hello bridge",
    });

    manager.resumePendingJobs();
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();

    expect(sessionManager.startWork).not.toHaveBeenCalled();
    expect(store.getVoiceJob("job-1")?.status).toBe("accepted");
    await manager.shutdown();
  });

  it("marks a pending job errored when restart-state refresh fails unexpectedly", async () => {
    const { runtimePaths, store, manager } = createManagerHarness();
    configureRestartStateStore(runtimePaths);
    writeFileSync(join(runtimePaths.dataDir, "restart-state.json"), "{");
    const audioPath = join(runtimePaths.dataDir, "voice-jobs", "persisted", "recording.wav");
    mkdirSync(dirname(audioPath), { recursive: true });
    writeFileSync(audioPath, "test-audio");
    store.createVoiceJob({
      id: "job-refresh-error",
      composerKey: "existing-session",
      targetSessionId: "existing-session",
      audioPath,
    });
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    manager.resumePendingJobs();
    await manager.shutdown();

    expect(store.getVoiceJob("job-refresh-error")).toMatchObject({
      status: "error",
    });
    expect(errorSpy).toHaveBeenCalledWith(
      "[voice-jobs] Processing failed for job-refresh-error:",
      expect.any(SyntaxError),
    );
    errorSpy.mockRestore();
  });

  it("keeps restart-pending processing failures retryable instead of marking them terminal", async () => {
    vi.useFakeTimers();
    const { runtimePaths, store, manager } = createManagerHarness();
    configureRestartStateStore(runtimePaths);
    const audioPath = join(runtimePaths.dataDir, "voice-jobs", "persisted", "recording.wav");
    mkdirSync(dirname(audioPath), { recursive: true });
    writeFileSync(audioPath, "test-audio");
    store.createVoiceJob({
      id: "job-restart-pending",
      composerKey: "existing-session",
      targetSessionId: "existing-session",
      audioPath,
    });
    const originalGetVoiceJob = store.getVoiceJob.bind(store);
    vi.spyOn(store, "getVoiceJob")
      .mockImplementationOnce(() => {
        throw new Error(RESTART_PENDING_MESSAGE);
      })
      .mockImplementation(originalGetVoiceJob);

    manager.resumePendingJobs();
    await vi.advanceTimersByTimeAsync(0);

    expect(store.getVoiceJob("job-restart-pending")?.status).toBe("accepted");
    await manager.shutdown();
  });
});
