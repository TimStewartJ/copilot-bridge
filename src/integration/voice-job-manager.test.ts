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
import type { ChatMicSettings } from "../shared/chat-mic.js";

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function createRestartRuntimePaths() {
  return makeTestRuntimePaths("voice-jobs");
}

const CLEAN_COVERAGE = { largestGapSeconds: 0.4, gapStartSeconds: 0 };

function createManagerHarness(transcribe = vi.fn(), chatMic?: ChatMicSettings) {
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
  const settingsStore = { getSettings: () => ({ chatMic }) } as any;
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
    settingsStore,
  });
  return { runtimePaths, store, sessionManager, manager, settingsStore };
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
      const transcribe = vi.fn().mockResolvedValue({ text: "hello bridge", provider: "speech-engine", coverage: CLEAN_COVERAGE });
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
    const transcribe = vi.fn().mockResolvedValue({ text: "fix the flaky tests", provider: "speech-engine", coverage: CLEAN_COVERAGE });
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
    store.updateVoiceJob(id, { transcript: "fix the flaky tests", speechGapSeconds: 0.4 });
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
    const transcribe = vi.fn().mockResolvedValue({ text: "skip that, do this", provider: "speech-engine", coverage: CLEAN_COVERAGE });
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
    const transcribe = vi.fn().mockResolvedValue({ text: "do this next", provider: "speech-engine", coverage: CLEAN_COVERAGE });
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

  describe("holding a dictation for review", () => {
    async function dictate(harness: ReturnType<typeof createManagerHarness>) {
      const sourceFilePath = join(harness.runtimePaths.dataDir, `input-${randomUUID()}.wav`);
      writeFileSync(sourceFilePath, "test-audio");
      return harness.manager.acceptVoiceJob({
        composerKey: "existing-session",
        targetSessionId: "existing-session",
        sourceFilePath,
        originalFilename: "recording.wav",
      });
    }

    it.each([
      {
        name: "a speech gap",
        coverage: { largestGapSeconds: 2.5, gapStartSeconds: 7 },
        reason: "coverage",
      },
      {
        name: "a transcript whose coverage could not be measured",
        coverage: null,
        reason: "unchecked",
      },
    ])("holds $name and sends nothing", async ({ coverage, reason }) => {
      const transcribe = vi.fn().mockResolvedValue({ text: "hello bridge", provider: "speech-engine", coverage });
      const harness = createManagerHarness(transcribe);

      const accepted = await dictate(harness);
      await vi.waitFor(() => expect(harness.store.getVoiceJob(accepted.id)?.status).toBe("held"));

      expect(harness.sessionManager.startWork).not.toHaveBeenCalled();
      expect(harness.store.getVoiceJob(accepted.id)).toMatchObject({ transcript: "hello bridge", reviewReason: reason });
      await harness.manager.shutdown();
    });

    it("lists running and held dictations for a client catching up, until the held one's chat is deleted", async () => {
      const harness = createManagerHarness();
      for (const [id, status] of [["running", "transcribing"], ["held", "held"], ["sent", "done"], ["opened", "recovered"]] as const) {
        harness.store.createVoiceJob({ id, composerKey: "chat", targetSessionId: "chat", audioPath: join(harness.runtimePaths.dataDir, id) });
        harness.store.updateVoiceJob(id, { status });
      }
      harness.store.createVoiceJob({ id: "held-elsewhere", composerKey: "other", targetSessionId: "other", audioPath: join(harness.runtimePaths.dataDir, "elsewhere") });
      harness.store.updateVoiceJob("held-elsewhere", { status: "held" });

      expect(harness.manager.listOpenVoiceJobs().map((job) => job.id).sort()).toEqual(["held", "held-elsewhere", "running"]);

      harness.manager.forgetHeldForChat("chat");

      expect(harness.manager.listOpenVoiceJobs().map((job) => job.id).sort()).toEqual(["held-elsewhere", "running"]);
      await harness.manager.shutdown();
    });

    it("still sweeps old jobs when the settings cannot be read", async () => {
      const harness = createManagerHarness();
      harness.settingsStore.getSettings = () => { throw new Error("settings row unreadable"); };

      await expect(harness.manager.runMaintenance()).resolves.toBeDefined();
      await harness.manager.shutdown();
    });

    it("holds a dictation into a busy chat instead of steering with it", async () => {
      const transcribe = vi.fn().mockResolvedValue({
        text: "skip that",
        provider: "speech-engine",
        coverage: { largestGapSeconds: 2.5, gapStartSeconds: 7 },
      });
      const harness = createManagerHarness(transcribe);
      harness.sessionManager.isSessionBusy.mockReturnValue(true);

      const accepted = await dictate(harness);
      await vi.waitFor(() => expect(harness.store.getVoiceJob(accepted.id)?.status).toBe("held"));

      expect(harness.sessionManager.steerSession).not.toHaveBeenCalled();
      expect(harness.sessionManager.startWork).not.toHaveBeenCalled();
      await harness.manager.shutdown();
    });

    it("sends a dictation with clean coverage", async () => {
      const transcribe = vi.fn().mockResolvedValue({ text: "hello bridge", provider: "speech-engine", coverage: CLEAN_COVERAGE });
      const harness = createManagerHarness(transcribe);
      harness.sessionManager.readMessagesFromDisk.mockResolvedValue({
        messages: [{ type: "message", role: "user", content: "hello bridge", timestamp: new Date().toISOString() }],
        total: 1,
        hasMore: false,
      });

      const accepted = await dictate(harness);
      await vi.waitFor(() => expect(harness.store.getVoiceJob(accepted.id)?.status).toBe("done"));

      expect(harness.sessionManager.startWork).toHaveBeenCalledOnce();
      expect(harness.sessionManager.startWork.mock.calls[0].slice(0, 2)).toEqual(["existing-session", "hello bridge"]);
      await harness.manager.shutdown();
    });

    it.each([
      { name: "a saved verdict", fields: { speechGapSeconds: 2.5, reviewReason: "coverage" as const }, reason: "coverage" },
      { name: "a transcript saved before verdicts existed", fields: {}, reason: "unchecked" },
    ])("still holds after a restart with $name", async ({ fields, reason }) => {
      const transcribe = vi.fn();
      const harness = createManagerHarness(transcribe);
      const id = randomUUID();
      const audioPath = join(harness.runtimePaths.dataDir, "voice-jobs", id, "recording.wav");
      mkdirSync(dirname(audioPath), { recursive: true });
      writeFileSync(audioPath, "test-audio");
      harness.store.createVoiceJob({ id, composerKey: "existing-session", targetSessionId: "existing-session", audioPath });
      harness.store.updateVoiceJob(id, { transcript: "hello bridge", ...fields });

      harness.manager.resumePendingJobs();
      await harness.manager.shutdown();

      expect(harness.store.getVoiceJob(id)).toMatchObject({ status: "held", transcript: "hello bridge", reviewReason: reason });
      expect(transcribe).not.toHaveBeenCalled();
      expect(harness.sessionManager.startWork).not.toHaveBeenCalled();
    });

    it.each([
      { keepHeldRecordings: false, keptAfterOpening: false },
      { keepHeldRecordings: true, keptAfterOpening: true },
    ])("keeps a held recording until it is opened, then for 2 days unless asked: $keepHeldRecordings", async ({ keepHeldRecordings, keptAfterOpening }) => {
      const transcribe = vi.fn().mockResolvedValue({ text: "hello bridge", provider: "speech-engine", coverage: null });
      const harness = createManagerHarness(transcribe, { keepHeldRecordings });

      const accepted = await dictate(harness);
      await vi.waitFor(() => expect(harness.store.getVoiceJob(accepted.id)?.status).toBe("held"));
      const recording = harness.manager.getRecordingPath(accepted.id)!;
      expect(existsSync(recording)).toBe(true);

      const heldAt = Date.parse(harness.store.getVoiceJob(accepted.id)!.updatedAt);
      await harness.manager.runMaintenance(heldAt + VOICE_JOB_AUDIO_RETENTION_MS + 1);
      expect(existsSync(recording)).toBe(true);

      harness.store.markRecovered(accepted.id);
      const openedAt = Date.parse(harness.store.getVoiceJob(accepted.id)!.updatedAt);
      await harness.manager.runMaintenance(openedAt + VOICE_JOB_AUDIO_RETENTION_MS + 1);

      expect(existsSync(recording)).toBe(keptAfterOpening);
      await harness.manager.shutdown();
    });
  });
});
