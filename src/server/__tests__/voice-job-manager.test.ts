import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { makeTestRuntimePaths } from "./helpers.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openMemoryDatabase } from "../db.js";
import { createGlobalBus } from "../global-bus.js";
import { writeRestartState } from "../restart-state.js";
import { clearRestartPending, configureRestartStateStore, RESTART_PENDING_MESSAGE } from "../session-manager.js";
import { createTaskGroupStore } from "../task-group-store.js";
import { createTaskStore } from "../task-store.js";
import { createVoiceJobManager } from "../voice-job-manager.js";
import { createVoiceJobStore } from "../voice-job-store.js";

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

async function waitForAssertion(assertion: () => void): Promise<void> {
  let lastError: unknown;
  for (let i = 0; i < 20; i += 1) {
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
  throw lastError;
}

function createRestartRuntimePaths() {
  return makeTestRuntimePaths("voice-jobs");
}

beforeEach(() => {
  clearRestartPending();
});

afterEach(() => {
  clearRestartPending();
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
    const taskStore = createTaskStore(db, createGlobalBus(), { runtimePaths });
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
      taskGroupStore: createTaskGroupStore(db),
    });

    const sourceFilePath = join(runtimePaths.dataDir, "input.wav");
    writeFileSync(sourceFilePath, "test-audio");

    const result = await manager.acceptVoiceJob({
      composerKey: "draft:quickchat",
      sourceFilePath,
      originalFilename: "recording.wav",
    });

    expect(result).toMatchObject({
      composerKey: "draft:quickchat",
      targetSessionId: "new-session",
      status: "accepted",
      safeToLeave: true,
    });
    expect(sessionManager.createSession).toHaveBeenCalledOnce();
    expect(store.getVoiceJob(result.id)).toMatchObject({
      composerKey: "draft:quickchat",
      targetSessionId: "new-session",
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
    const taskStore = createTaskStore(db, createGlobalBus(), { runtimePaths });
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
      taskGroupStore: createTaskGroupStore(db),
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
    const taskStore = createTaskStore(db, createGlobalBus(), { runtimePaths });
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
      taskGroupStore: createTaskGroupStore(db),
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
    await flushMicrotasks();

    await waitForAssertion(() => {
      expect(sessionManager.startWork).toHaveBeenCalledWith("existing-session", "Hello bridge");
    });
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
    const taskStore = createTaskStore(db, createGlobalBus(), { runtimePaths });
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
      taskGroupStore: createTaskGroupStore(db),
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
});
