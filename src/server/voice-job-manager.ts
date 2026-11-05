import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { copyFile, readdir, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isBridgeRestartingError } from "./backend-availability.js";
import { sendChatMessage, type ChatMessageDeliveryContext } from "./chat-message-delivery.js";
import type { SessionManager } from "./session-manager.js";
import type { SettingsStore } from "./settings-store.js";
import type { TaskStore } from "./task-store.js";
import type { TranscriptionService } from "./transcription-service.js";
import type { CopilotContextTier } from "../shared/copilot-context.js";
import { decideVoiceReview, type VoiceReviewReason } from "../shared/chat-mic.js";
import type { SendMode } from "../shared/send-mode.js";
import {
  type StoredVoiceJob,
  type VoiceJob,
  type VoiceJobStore,
} from "./voice-job-store.js";

export interface VoiceJobSnapshot extends VoiceJob {
  safeToLeave: true;
}

interface AcceptVoiceJobInput {
  composerKey: string;
  taskId?: string;
  targetSessionId?: string;
  sourceFilePath: string;
  originalFilename?: string;
  mode?: SendMode;
  sessionOptions?: {
    model?: string;
    reasoningEffort?: string;
    contextTier?: CopilotContextTier;
  };
}

interface CreateVoiceJobManagerOptions {
  dataDir: string;
  store: VoiceJobStore;
  transcriptionService: TranscriptionService;
  sessionManager: SessionManager;
  taskStore: TaskStore;
  chatDelivery: ChatMessageDeliveryContext;
  /** Where the choice to keep held recordings lives. */
  settingsStore?: Pick<SettingsStore, "getSettings">;
}

const DAY_MS = 24 * 60 * 60 * 1_000;
const VOICE_JOB_MAINTENANCE_INTERVAL_MS = DAY_MS;
const VOICE_JOB_DIRECTORY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Terminal rows remain visible for recovery and diagnostics for 30 days. */
export const VOICE_JOB_TERMINAL_RETENTION_MS = 30 * DAY_MS;
/** Recordings of finished jobs are kept briefly so a poor transcript can be replayed against its audio. */
export const VOICE_JOB_AUDIO_RETENTION_MS = 2 * DAY_MS;
/** Young untracked directories may belong to an accept request that has not inserted its DB row yet. */
export const VOICE_JOB_ORPHAN_GRACE_MS = DAY_MS;

export interface VoiceJobMaintenanceResult {
  terminalRowsPruned: number;
  orphanDirectoriesRemoved: number;
}

export function createVoiceJobManager({
  dataDir,
  store,
  transcriptionService,
  sessionManager,
  taskStore,
  chatDelivery,
  settingsStore,
}: CreateVoiceJobManagerOptions) {
  const voiceJobsDir = join(dataDir, "voice-jobs");
  mkdirSync(voiceJobsDir, { recursive: true });

  const processingJobRuns = new Map<string, Promise<void>>();
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const creatingJobIds = new Set<string>();
  const SEND_REFUSED_RETRY_MS = 30_000;
  const SEND_REFUSED_POLL_MS = 500;
  /** Refused before reaching the agent, for a moment: the turn is starting, or just ended. */
  const SEND_REFUSED_FOR_NOW = /still starting|still reconnecting|not accepting steering|not busy|ended before steering|busy processing another message/i;
  const RESTART_RETRY_DELAY_MS = 30_000;
  let maintenanceRun: Promise<VoiceJobMaintenanceResult> | undefined;
  let maintenanceTimer: ReturnType<typeof setInterval> | undefined;
  let shuttingDown = false;

  function startVoiceJobProcessing(jobId: string): void {
    void processVoiceJob(jobId).catch((error) => {
      console.error(`[voice-jobs] Uncontained processing failure for ${jobId}:`, error);
    });
  }

  /** The settings API reports a settings row it cannot read. A sweep has to survive one. */
  function keepsHeldRecordings(): boolean {
    try {
      return settingsStore?.getSettings().chatMic?.keepHeldRecordings === true;
    } catch {
      return false;
    }
  }

  function toSnapshot(job: VoiceJob | undefined): VoiceJobSnapshot | undefined {
    if (!job) return undefined;
    return {
      ...job,
      safeToLeave: true,
    };
  }

  async function acceptVoiceJob({
    composerKey,
    taskId,
    targetSessionId,
    sourceFilePath,
    originalFilename,
    mode,
    sessionOptions,
  }: AcceptVoiceJobInput): Promise<VoiceJobSnapshot> {
    const id = randomUUID();
    const jobDir = join(voiceJobsDir, id);
    creatingJobIds.add(id);

    try {
      mkdirSync(jobDir, { recursive: true });
      const safeFilename = basename(originalFilename ?? "voice-input.wav").replace(/\.\./g, "_") || "voice-input.wav";
      const audioPath = join(jobDir, safeFilename);
      await copyFile(sourceFilePath, audioPath);

      const resolvedTargetSessionId = targetSessionId ?? await createTargetSession(taskId, sessionOptions);
      const job = store.createVoiceJob({
        id,
        composerKey,
        taskId,
        targetSessionId: resolvedTargetSessionId,
        audioPath,
        ...(mode ? { mode } : {}),
      });

      startVoiceJobProcessing(id);
      return toSnapshot(job)!;
    } catch (error) {
      await removeJobDirectory(jobDir, id);
      throw error;
    } finally {
      creatingJobIds.delete(id);
    }
  }

  function getVoiceJob(id: string): VoiceJobSnapshot | undefined {
    return toSnapshot(store.getVoiceJob(id));
  }

  /** Where a job's recording is, for playing it back. It may already have been cleaned up. */
  function getRecordingPath(id: string): string | undefined {
    return store.getVoiceJob(id)?.audioPath;
  }

  function findLatestRelevantForComposer(composerKey: string): VoiceJobSnapshot | undefined {
    return toSnapshot(store.findLatestRelevantForComposer(composerKey));
  }

  async function markRecovered(id: string): Promise<VoiceJobSnapshot | undefined> {
    if (!store.getVoiceJob(id)) return undefined;
    return toSnapshot(store.markRecovered(id));
  }

  /** What a client that just started missed while nothing was polling: running jobs, and dictations waiting to be read. */
  function listOpenVoiceJobs(): VoiceJobSnapshot[] {
    return [...store.listPendingVoiceJobs(), ...store.listHeldVoiceJobs()].map((job) => toSnapshot(job)!);
  }

  /** A held dictation waits in its chat, so deleting the chat leaves nothing to come back to. */
  function forgetHeldForChat(sessionId: string): void {
    for (const job of store.listHeldVoiceJobs()) {
      if (job.targetSessionId === sessionId) store.markRecovered(job.id);
    }
  }

  function resumePendingJobs(): void {
    for (const job of store.listPendingVoiceJobs()) {
      startVoiceJobProcessing(job.id);
    }
  }

  async function processVoiceJob(jobId: string): Promise<void> {
    const existingRun = processingJobRuns.get(jobId);
    if (existingRun) {
      await existingRun;
      return;
    }

    const run = (async () => {
      try {
        const job = store.getVoiceJob(jobId);
        const canResume =
          !!job && ["accepted", "transcribing", "sending"].includes(job.status);
        if (!canResume || !job) return;
        await transcribeAndSend(job, job.transcript);
      } catch (error) {
        await handleUnexpectedProcessingError(jobId, error);
      } finally {
        processingJobRuns.delete(jobId);
      }
    })();

    processingJobRuns.set(jobId, run);
    await run;
  }

  async function handleUnexpectedProcessingError(jobId: string, error: unknown): Promise<void> {
    if (isBridgeRestartingError(error)) {
      scheduleRetry(jobId);
      return;
    }

    console.error(`[voice-jobs] Processing failed for ${jobId}:`, error);
    const message = error instanceof Error ? error.message : String(error);
    let transcript: string | undefined;
    try {
      transcript = store.getVoiceJob(jobId)?.transcript;
    } catch (lookupError) {
      console.error(`[voice-jobs] Failed to reload ${jobId} after processing error:`, lookupError);
      scheduleRetry(jobId);
      return;
    }

    try {
      await markJobError(jobId, message, transcript);
    } catch (markError) {
      console.error(`[voice-jobs] Failed to mark ${jobId} as errored:`, markError);
      scheduleRetry(jobId);
    }
  }

  function runMaintenance(now = Date.now()): Promise<VoiceJobMaintenanceResult> {
    if (maintenanceRun) return maintenanceRun;
    const run = performMaintenance(now).finally(() => {
      if (maintenanceRun === run) maintenanceRun = undefined;
    });
    maintenanceRun = run;
    return run;
  }

  async function startMaintenance(): Promise<VoiceJobMaintenanceResult> {
    if (!maintenanceTimer && !shuttingDown) {
      maintenanceTimer = setInterval(() => {
        void runMaintenance().catch((error) => {
          console.error("[voice-jobs] Maintenance failed:", error);
        });
      }, VOICE_JOB_MAINTENANCE_INTERVAL_MS);
      maintenanceTimer.unref();
    }
    return runMaintenance();
  }

  async function shutdown(): Promise<void> {
    shuttingDown = true;
    if (maintenanceTimer) {
      clearInterval(maintenanceTimer);
      maintenanceTimer = undefined;
    }
    for (const timer of retryTimers.values()) {
      clearTimeout(timer);
    }
    retryTimers.clear();
    await Promise.allSettled([
      ...processingJobRuns.values(),
      ...(maintenanceRun ? [maintenanceRun] : []),
    ]);
  }

  async function transcribeAndSend(job: StoredVoiceJob, existingTranscript?: string): Promise<void> {
    let transcript = existingTranscript?.trim();
    // A transcript saved before coverage existed has no verdict, and that means it was never checked.
    let reviewReason: VoiceReviewReason | undefined = job.reviewReason
      ?? (transcript && job.speechGapSeconds === undefined ? "unchecked" : undefined);

    if (!transcript) {
      store.updateVoiceJob(job.id, {
        status: "transcribing",
        error: undefined,
      });

      try {
        const result = await transcriptionService.transcribe({ filePath: job.audioPath, label: `job ${job.id}` });
        transcript = result.text.trim();
        if (!transcript) {
          throw new Error("No transcript returned");
        }
        reviewReason = decideVoiceReview(result.coverage);
        // The verdict is saved with the transcript, so a restart can never send what should be held.
        store.updateVoiceJob(job.id, {
          transcript,
          error: undefined,
          speechGapSeconds: result.coverage?.largestGapSeconds,
          speechGapStart: result.coverage?.gapStartSeconds,
          reviewReason,
        });
      } catch (error) {
        await markJobError(job.id, error instanceof Error ? error.message : String(error));
        return;
      }
    }

    const targetSessionId = job.targetSessionId;
    if (!targetSessionId) {
      await markJobError(job.id, "Voice job target session is missing.", transcript);
      return;
    }

    const isResumingSend = job.status === "sending";
    if (isResumingSend && await sessionHasAcceptedTranscript(targetSessionId, transcript, job.updatedAt)) {
      await markJobDone(job.id, transcript);
      return;
    }

    if (reviewReason) {
      store.updateVoiceJob(job.id, { status: "held", transcript, reviewReason, error: undefined });
      return;
    }

    if (!isResumingSend) {
      store.updateVoiceJob(job.id, {
        status: "sending",
        transcript,
        error: undefined,
      });
    }

    try {
      await sendTranscript(targetSessionId, transcript, job);
      // A dictated message is Tim's own words, like a typed one: it counts toward task states.
      try { taskStore.recordUserMessage?.(targetSessionId); } catch (error) { console.warn("[voice] Could not record a sent message:", error); }
      await markJobDone(job.id, transcript);
    } catch (error) {
      if (isBridgeRestartingError(error)) {
        scheduleRetry(job.id);
        return;
      }
      await markJobError(
        job.id,
        `Auto-send failed. Transcript was saved to the composer instead. (${error instanceof Error ? error.message : String(error)})`,
        transcript,
      );
    }
  }

  function scheduleRetry(jobId: string): void {
    if (shuttingDown || retryTimers.has(jobId)) return;
    const timer = setTimeout(() => {
      retryTimers.delete(jobId);
      startVoiceJobProcessing(jobId);
    }, RESTART_RETRY_DELAY_MS);
    retryTimers.set(jobId, timer);
  }

  async function sessionHasAcceptedTranscript(
    sessionId: string,
    transcript: string,
    notBefore: string,
  ): Promise<boolean> {
    const { messages } = await sessionManager.readMessagesFromDisk(sessionId);
    const latestUserMessage = [...messages]
      .reverse()
      .find((entry) => entry?.type === "message" && entry?.role === "user");
    if (!latestUserMessage || latestUserMessage.content !== transcript) {
      return false;
    }

    const latestTimestamp = Date.parse(latestUserMessage.timestamp ?? "");
    const notBeforeTimestamp = Date.parse(notBefore);
    if (!Number.isFinite(latestTimestamp) || !Number.isFinite(notBeforeTimestamp)) {
      return true;
    }
    return latestTimestamp >= notBeforeTimestamp - 2_000;
  }

  /**
   * Sends the transcript the way a typed message goes: into a busy chat as steering, past an open
   * question, kept in the chat as not sent if its run never delivers it. Nothing here queues it,
   * since a queued voice message would show nowhere; a chat that stays closed fails the job, which
   * puts the transcript back in the composer.
   */
  async function sendTranscript(sessionId: string, transcript: string, job: StoredVoiceJob): Promise<void> {
    const deadline = Date.now() + SEND_REFUSED_RETRY_MS;
    for (;;) {
      try {
        await sendChatMessage(chatDelivery, sessionId, transcript, {
          clientMessageId: `voice-job-${job.id}`,
          keepUndelivered: true,
          skipOpenQuestions: true,
          queue: "none",
          ...(job.mode ? { mode: job.mode } : {}),
        });
        return;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (!SEND_REFUSED_FOR_NOW.test(message) || Date.now() >= deadline || shuttingDown) throw error;
        await new Promise((resolve) => setTimeout(resolve, SEND_REFUSED_POLL_MS));
      }
    }
  }

  async function createTargetSession(
    taskId?: string,
    sessionOptions?: {
      model?: string;
      reasoningEffort?: string;
      contextTier?: CopilotContextTier;
    },
  ): Promise<string> {
    if (!taskId) {
      const result = await sessionManager.createSession(sessionOptions ?? {});
      return result.sessionId;
    }

    const task = taskStore.getTask(taskId);
    if (!task) {
      throw new Error("Task not found");
    }

    const result = await sessionManager.createTaskSession(
      task.id,
      task.title,
      task.workItems,
      task.notes,
      task.cwd,
      undefined,
      sessionOptions,
    );
    taskStore.linkSession(task.id, result.sessionId);
    return result.sessionId;
  }

  async function markJobDone(id: string, transcript: string): Promise<StoredVoiceJob | undefined> {
    if (!store.getVoiceJob(id)) return undefined;
    return store.updateVoiceJob(id, {
      status: "done",
      transcript,
      error: undefined,
    });
  }

  async function markJobError(
    id: string,
    error: string,
    transcript?: string,
  ): Promise<StoredVoiceJob | undefined> {
    if (!store.getVoiceJob(id)) return undefined;
    return store.markError(id, error, transcript);
  }

  async function performMaintenance(now: number): Promise<VoiceJobMaintenanceResult> {
    const audioCutoff = now - VOICE_JOB_AUDIO_RETENTION_MS;
    const keepHeld = keepsHeldRecordings();
    for (const job of store.listTerminalVoiceJobs()) {
      const finishedAt = Date.parse(job.updatedAt);
      // A held dictation nobody has opened still needs its recording; the two days start once it is opened.
      const keepsLonger = job.status === "held" || (keepHeld && job.reviewReason);
      const cutoff = keepsLonger ? now - VOICE_JOB_TERMINAL_RETENTION_MS : audioCutoff;
      if (Number.isFinite(finishedAt) && finishedAt > cutoff) continue;
      await cleanupJobArtifacts(job);
    }

    const terminalRowsPruned = store.pruneTerminalVoiceJobs(
      new Date(now - VOICE_JOB_TERMINAL_RETENTION_MS).toISOString(),
    );
    const orphanDirectoriesRemoved = await sweepOrphanJobDirectories(now);
    return { terminalRowsPruned, orphanDirectoriesRemoved };
  }

  async function sweepOrphanJobDirectories(now: number): Promise<number> {
    const knownJobIds = new Set(store.listVoiceJobIds());
    const orphanCutoff = now - VOICE_JOB_ORPHAN_GRACE_MS;
    const entries = await readdir(voiceJobsDir, { withFileTypes: true });
    let removed = 0;

    for (const entry of entries) {
      if (!entry.isDirectory() || !VOICE_JOB_DIRECTORY_PATTERN.test(entry.name)) continue;
      if (knownJobIds.has(entry.name) || creatingJobIds.has(entry.name)) continue;

      const jobDir = join(voiceJobsDir, entry.name);
      try {
        const jobDirStat = await stat(jobDir);
        if (jobDirStat.mtimeMs > orphanCutoff) continue;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        console.warn(`[voice-jobs] Failed to inspect orphan candidate ${entry.name}:`, error);
        continue;
      }

      if (await removeJobDirectory(jobDir, entry.name)) removed++;
    }

    return removed;
  }

  async function cleanupJobArtifacts(job: Pick<StoredVoiceJob, "id" | "audioPath">): Promise<boolean> {
    const jobDir = resolve(dirname(job.audioPath));
    const relativeJobDir = relative(resolve(voiceJobsDir), jobDir);
    const isDirectChild =
      relativeJobDir.length > 0
      && relativeJobDir !== ".."
      && !relativeJobDir.startsWith(`..${sep}`)
      && !isAbsolute(relativeJobDir)
      && !relativeJobDir.includes(sep);
    if (!isDirectChild) {
      console.warn(`[voice-jobs] Refusing to remove artifacts outside the voice-jobs directory for ${job.id}`);
      return false;
    }
    return removeJobDirectory(jobDir, job.id);
  }

  async function removeJobDirectory(jobDir: string, jobId: string): Promise<boolean> {
    try {
      await rm(jobDir, { recursive: true, force: true });
      return true;
    } catch (error) {
      console.warn(`[voice-jobs] Failed to remove artifacts for ${jobId}:`, error);
      return false;
    }
  }

  return {
    acceptVoiceJob,
    getVoiceJob,
    getRecordingPath,
    findLatestRelevantForComposer,
    markRecovered,
    listOpenVoiceJobs,
    forgetHeldForChat,
    resumePendingJobs,
    runMaintenance,
    startMaintenance,
    getActiveJobCount: () => creatingJobIds.size + processingJobRuns.size,
    shutdown,
  };
}

export type VoiceJobManager = ReturnType<typeof createVoiceJobManager>;
