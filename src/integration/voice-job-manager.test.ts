import { BRIDGE_RESTARTING_MESSAGE } from "../server/backend-availability.js";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { makeTestRuntimePaths } from "../server/__tests__/helpers.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openMemoryDatabase } from "../server/db.js";
import { createGlobalBus } from "../server/global-bus.js";
import { writeRestartState } from "../server/restart-state.js";

import { createTaskGroupStore } from "../server/task-group-store.js";
import { createTaskStore } from "../server/task-store.js";
import {
  createVoiceJobManager,
  VOICE_JOB_AUDIO_RETENTION_MS,
  VOICE_JOB_ORPHAN_GRACE_MS,
} from "../server/voice-job-manager.js";
import { createVoiceJobStore } from "../server/voice-job-store.js";

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
        provider: "speech-engine",
        label: "Parakeet v3 (local)",
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

});

afterEach(async () => {

  vi.useRealTimers();
});

describe("voice job restart gating", () => {
  it("accepts a new draft voice job while restart is active", async () => {
    const runtimePaths = createRestartRuntimePaths();

    await writeRestartState(join(runtimePaths.dataDir, "restart-state.json"), { phase: "restarting", releaseFailure: null });

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
          provider: "speech-engine",
          label: "Parakeet v3 (local)",
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

  it("passes a selected task agent through draft voice session creation", async () => {
    const runtimePaths = createRestartRuntimePaths();
    const db = openMemoryDatabase();
    const store = createVoiceJobStore(db);
    const globalBus = createGlobalBus();
    const taskStore = createTaskStore(db, globalBus, { runtimePaths });
    const task = taskStore.createTask("Voice agent task");
    const sessionManager = {
      createTaskSession: vi.fn().mockResolvedValue({ sessionId: "task-session" }),
    } as any;
    const manager = createVoiceJobManager({
      dataDir: runtimePaths.dataDir,
      store,
      transcriptionService: {
        getStatus: () => ({
          available: true,
          provider: "speech-engine",
          label: "Parakeet v3 (local)",
          maxDurationSeconds: 120,
        }),
        transcribe: vi.fn(),
      },
      sessionManager,
      taskStore,
      taskGroupStore: createTaskGroupStore(db, globalBus),
    });
    const sourceFilePath = join(runtimePaths.dataDir, "task-input.wav");
    writeFileSync(sourceFilePath, "test-audio");

    await manager.acceptVoiceJob({
      composerKey: `draft:task:${task.id}`,
      taskId: task.id,
      sourceFilePath,
      sessionOptions: { agent: "api-reviewer" },
    });

    expect(sessionManager.createTaskSession).toHaveBeenCalledWith(
      task.id,
      task.title,
      task.workItems,
      [],
      task.notes,
      task.cwd,
      undefined,
      null,
      { agent: "api-reviewer" },
    );
  });

  describe("voice job artifact retention", () => {
    it("keeps the recording when transcription fails", async () => {
      const transcribe = vi.fn().mockRejectedValue(new Error("speech engine failed"));
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
        error: "speech engine failed",
      });
      expect(existsSync(join(runtimePaths.dataDir, "voice-jobs", accepted.id, "recording.wav"))).toBe(true);
    });

    it("keeps a sent recording until the audio retention window passes", async () => {
      const transcribe = vi.fn().mockResolvedValue({ text: "hello bridge", provider: "speech-engine" });
      const { runtimePaths, store, sessionManager, manager } = createManagerHarness(transcribe);
      sessionManager.readMessagesFromDisk.mockResolvedValue({
        messages: [{ type: "message", role: "user", content: "hello bridge", timestamp: new Date().toISOString() }],
        total: 1,
        hasMore: false,
      });
      const sourceFilePath = join(runtimePaths.dataDir, "input.wav");
      writeFileSync(sourceFilePath, "test-audio");

      const accepted = await manager.acceptVoiceJob({
        composerKey: "existing-session",
        targetSessionId: "existing-session",
        sourceFilePath,
        originalFilename: "recording.wav",
      });
      await vi.waitFor(() => expect(store.getVoiceJob(accepted.id)?.status).toBe("done"));
      const jobDir = join(runtimePaths.dataDir, "voice-jobs", accepted.id);
      expect(transcribe).toHaveBeenCalledWith(expect.objectContaining({ label: `job ${accepted.id}` }));
      const finishedAt = Date.parse(store.getVoiceJob(accepted.id)!.updatedAt);

      await manager.runMaintenance(finishedAt + VOICE_JOB_AUDIO_RETENTION_MS - 1);
      expect(existsSync(join(jobDir, "recording.wav"))).toBe(true);

      await manager.runMaintenance(finishedAt + VOICE_JOB_AUDIO_RETENTION_MS + 1);
      await manager.shutdown();
      expect(existsSync(jobDir)).toBe(false);
      expect(store.getVoiceJob(accepted.id)?.status).toBe("done");
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
      store.markError(id, "speech engine failed");

      await manager.runMaintenance(Date.parse(store.getVoiceJob(id)!.updatedAt) + VOICE_JOB_AUDIO_RETENTION_MS + 1);
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

  it("resumes pending voice jobs while restart is active", async () => {
    const runtimePaths = createRestartRuntimePaths();

    await writeRestartState(join(runtimePaths.dataDir, "restart-state.json"), { phase: "restarting", releaseFailure: null });

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
          provider: "speech-engine",
          label: "Parakeet v3 (local)",
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

  it("keeps restart-pending processing failures retryable instead of marking them terminal", async () => {
    vi.useFakeTimers();
    const { runtimePaths, store, manager } = createManagerHarness();

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
        throw new Error(BRIDGE_RESTARTING_MESSAGE);
      })
      .mockImplementation(originalGetVoiceJob);

    manager.resumePendingJobs();
    await vi.advanceTimersByTimeAsync(0);

    expect(store.getVoiceJob("job-restart-pending")?.status).toBe("accepted");
    await manager.shutdown();
  });
});
