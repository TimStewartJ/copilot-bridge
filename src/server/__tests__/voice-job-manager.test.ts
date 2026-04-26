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
  it("rejects accepting a new draft voice job while restart is active", async () => {
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

  it("does not resume pending voice jobs while restart is active", async () => {
    vi.useFakeTimers();

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
      status: "sending",
      transcript: "Hello bridge",
    });

    manager.resumePendingJobs();
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks();

    expect(sessionManager.startWork).not.toHaveBeenCalled();
    expect(store.getVoiceJob("job-1")?.status).toBe("sending");
  });
});
