import { BRIDGE_RESTARTING_MESSAGE } from "../server/backend-availability.js";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { makeTestRuntimePaths } from "../server/__tests__/helpers.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openMemoryDatabase } from "../server/db.js";
import { createGlobalBus } from "../server/global-bus.js";

import { createSessionMetaStore } from "../server/session-meta-store.js";
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
    isSessionSettling: vi.fn(() => false),
    startWork: vi.fn(),
    steerSession: vi.fn(async () => {}),
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
    chatDelivery: { sessionManager, sessionMetaStore: createSessionMetaStore(db), globalBus } as any,
  });
  return { runtimePaths, store, sessionManager, manager };
}

beforeEach(async () => {

});

afterEach(async () => {

  vi.useRealTimers();
});

describe("voice job restart gating", () => {

  it("passes launch options through task draft voice session creation", async () => {
    const runtimePaths = createRestartRuntimePaths();
    const db = openMemoryDatabase();
    const store = createVoiceJobStore(db);
    const globalBus = createGlobalBus();
    const taskStore = createTaskStore(db, globalBus, { runtimePaths });
    const task = taskStore.createTask("Voice task");
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
      chatDelivery: { sessionManager, sessionMetaStore: createSessionMetaStore(db), globalBus } as any,
    });
    const sourceFilePath = join(runtimePaths.dataDir, "task-input.wav");
    writeFileSync(sourceFilePath, "test-audio");

    await manager.acceptVoiceJob({
      composerKey: `draft:task:${task.id}`,
      taskId: task.id,
      sourceFilePath,
      sessionOptions: { model: "gpt-5.6-sol" },
    });

    expect(sessionManager.createTaskSession).toHaveBeenCalledWith(
      task.id,
      task.title,
      task.workItems,
      task.notes,
      task.cwd,
      undefined,
      { model: "gpt-5.6-sol" },
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
      const { runtimePaths, store, manager } = createManagerHarness(transcribe);
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
      const { runtimePaths, store, manager } = createManagerHarness();
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

      const activeId = randomUUID();
      const activeAudio = join(runtimePaths.dataDir, "voice-jobs", activeId, "recording.wav");
      mkdirSync(dirname(activeAudio), { recursive: true });
      writeFileSync(activeAudio, "active-audio");
      utimesSync(dirname(activeAudio), oldTime, oldTime);
      store.createVoiceJob({ id: activeId, composerKey: "existing-session", targetSessionId: "existing-session", audioPath: activeAudio });
      store.updateVoiceJob(activeId, { status: "transcribing" });

      const result = await manager.runMaintenance(now);
      await manager.shutdown();

      expect(existsSync(oldDir)).toBe(false);
      expect(existsSync(youngDir)).toBe(true);
      expect(existsSync(activeAudio)).toBe(true);
      expect(store.getVoiceJob(activeId)?.status).toBe("transcribing");
      expect(result.orphanDirectoriesRemoved).toBe(1);
    });

  });

  it("starts an Autopilot recording's run in Autopilot, once, including after a restart", async () => {
    const transcribe = vi.fn().mockResolvedValue({ text: "fix the flaky tests", provider: "speech-engine" });
    const { runtimePaths, store, sessionManager, manager } = createManagerHarness(transcribe);
    const sourceFilePath = join(runtimePaths.dataDir, "input.wav");
    writeFileSync(sourceFilePath, "test-audio");

    const accepted = await manager.acceptVoiceJob({
      composerKey: "existing-session",
      targetSessionId: "existing-session",
      sourceFilePath,
      originalFilename: "recording.wav",
      mode: "autopilot",
    });
    await vi.waitFor(() => expect(store.getVoiceJob(accepted.id)?.status).toBe("done"));
    expect(accepted.mode).toBe("autopilot");
    expect(sessionManager.startWork).toHaveBeenCalledExactlyOnceWith(
      "existing-session",
      "fix the flaky tests",
      undefined,
      { mode: "autopilot", clientMessageId: `voice-job-${accepted.id}`, keepUndelivered: true },
    );

    const id = randomUUID();
    const audioPath = join(runtimePaths.dataDir, "voice-jobs", id, "recording.wav");
    mkdirSync(dirname(audioPath), { recursive: true });
    writeFileSync(audioPath, "test-audio");
    store.createVoiceJob({ id, composerKey: "existing-session", targetSessionId: "existing-session", audioPath, mode: "autopilot" });
    store.updateVoiceJob(id, { transcript: "fix the flaky tests" });
    sessionManager.startWork.mockClear();

    manager.resumePendingJobs();
    await manager.shutdown();

    expect(sessionManager.startWork).toHaveBeenCalledExactlyOnceWith(
      "existing-session",
      "fix the flaky tests",
      undefined,
      expect.objectContaining({ mode: "autopilot", clientMessageId: `voice-job-${id}` }),
    );
    expect(store.getVoiceJob(id)).toMatchObject({ status: "done", mode: "autopilot" });
  });

  async function dictateTo(harness: ReturnType<typeof createManagerHarness>) {
    const sourceFilePath = join(harness.runtimePaths.dataDir, "input.wav");
    writeFileSync(sourceFilePath, "test-audio");
    return harness.manager.acceptVoiceJob({
      composerKey: "busy-session",
      targetSessionId: "busy-session",
      sourceFilePath,
      originalFilename: "recording.wav",
    });
  }

  it("sends a transcript into a busy chat as steering that sets open questions aside", async () => {
    const transcribe = vi.fn().mockResolvedValue({ text: "skip that, do this", provider: "speech-engine" });
    const harness = createManagerHarness(transcribe);
    harness.sessionManager.isSessionBusy.mockReturnValue(true);

    const accepted = await dictateTo(harness);
    await harness.manager.shutdown();

    expect(harness.sessionManager.steerSession).toHaveBeenCalledExactlyOnceWith(
      "busy-session",
      "skip that, do this",
      undefined,
      `voice-job-${accepted.id}`,
      { skipOpenQuestions: true },
    );
    expect(harness.sessionManager.startWork).not.toHaveBeenCalled();
    expect(harness.store.getVoiceJob(accepted.id)).toMatchObject({ status: "done", transcript: "skip that, do this" });
  });

  it("tries again while a busy chat refuses for a moment, and gives the transcript back when it stays closed", async () => {
    const transcribe = vi.fn().mockResolvedValue({ text: "do this next", provider: "speech-engine" });
    const harness = createManagerHarness(transcribe);
    harness.sessionManager.isSessionBusy.mockReturnValue(true);
    harness.sessionManager.steerSession.mockRejectedValueOnce(
      new Error("Session is still starting the current turn; try again shortly"),
    );

    const retried = await dictateTo(harness);
    await vi.waitFor(() => expect(harness.store.getVoiceJob(retried.id)?.status).toBe("done"));
    expect(harness.sessionManager.steerSession).toHaveBeenCalledTimes(2);

    harness.sessionManager.steerSession.mockClear();
    harness.sessionManager.steerSession.mockRejectedValue(
      new Error("Session is stalled and cannot be steered; stop it or wait for recovery"),
    );
    const refused = await dictateTo(harness);
    await harness.manager.shutdown();

    expect(harness.sessionManager.steerSession).toHaveBeenCalledOnce();
    expect(harness.store.getVoiceJob(refused.id)).toMatchObject({ status: "error", transcript: "do this next" });
    expect(harness.store.getVoiceJob(refused.id)?.error).toContain("Transcript was saved to the composer");
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
