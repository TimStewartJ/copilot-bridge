import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { copyFile, readdir, rm, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { SessionManager } from "./session-manager.js";
import {
  isRestartCutoverInProgress,
  isRestartPendingError,
  RESTART_PENDING_MESSAGE,
  refreshRestartState,
} from "./session-manager.js";
import type { TaskGroupStore } from "./task-group-store.js";
import type { TaskStore } from "./task-store.js";
import type { TranscriptionService } from "./transcription-service.js";
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
}

interface CreateVoiceJobManagerOptions {
  dataDir: string;
  store: VoiceJobStore;
  transcriptionService: TranscriptionService;
  sessionManager: SessionManager;
  taskStore: TaskStore;
  taskGroupStore: TaskGroupStore;
}

const DAY_MS = 24 * 60 * 60 * 1_000;
const VOICE_JOB_MAINTENANCE_INTERVAL_MS = DAY_MS;
const VOICE_JOB_DIRECTORY_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Terminal rows remain visible for recovery and diagnostics for 30 days. */
export const VOICE_JOB_TERMINAL_RETENTION_MS = 30 * DAY_MS;
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
  taskGroupStore,
}: CreateVoiceJobManagerOptions) {
  const voiceJobsDir = join(dataDir, "voice-jobs");
  mkdirSync(voiceJobsDir, { recursive: true });

  const processingJobRuns = new Map<string, Promise<void>>();
  const retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const creatingJobIds = new Set<string>();
  const SEND_ACCEPTANCE_TIMEOUT_MS = 15_000;
  const SEND_ACCEPTANCE_POLL_MS = 250;
  const RESTART_RETRY_DELAY_MS = 30_000;
  let maintenanceRun: Promise<VoiceJobMaintenanceResult> | undefined;
  let maintenanceTimer: ReturnType<typeof setInterval> | undefined;
  let shuttingDown = false;

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
  }: AcceptVoiceJobInput): Promise<VoiceJobSnapshot> {
    if (isRestartCutoverInProgress(await refreshRestartState())) {
      throw new Error(RESTART_PENDING_MESSAGE);
    }
    const id = randomUUID();
    const jobDir = join(voiceJobsDir, id);
    creatingJobIds.add(id);

    try {
      mkdirSync(jobDir, { recursive: true });
      const safeFilename = basename(originalFilename ?? "voice-input.wav").replace(/\.\./g, "_") || "voice-input.wav";
      const audioPath = join(jobDir, safeFilename);
      await copyFile(sourceFilePath, audioPath);

      const resolvedTargetSessionId = targetSessionId ?? await createTargetSession(taskId);
      const job = store.createVoiceJob({
        id,
        composerKey,
        taskId,
        targetSessionId: resolvedTargetSessionId,
        audioPath,
      });

      void processVoiceJob(id);
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

  function findLatestRelevantForComposer(composerKey: string): VoiceJobSnapshot | undefined {
    return toSnapshot(store.findLatestRelevantForComposer(composerKey));
  }

  async function markRecovered(id: string): Promise<VoiceJobSnapshot | undefined> {
    const job = store.getVoiceJob(id);
    if (!job) return undefined;
    await cleanupJobArtifacts(job);
    return toSnapshot(store.markRecovered(id));
  }

  function resumePendingJobs(): void {
    for (const job of store.listPendingVoiceJobs()) {
      void processVoiceJob(job.id);
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
        if (isRestartCutoverInProgress(await refreshRestartState())) {
          scheduleRetry(job.id);
          return;
        }
        await transcribeAndSend(job, job.transcript);
      } finally {
        processingJobRuns.delete(jobId);
      }
    })();

    processingJobRuns.set(jobId, run);
    await run;
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

    if (!transcript) {
      store.updateVoiceJob(job.id, {
        status: "transcribing",
        error: undefined,
      });

      try {
        const result = await transcriptionService.transcribe({
          filePath: job.audioPath,
          workingDir: dirname(job.audioPath),
        });
        transcript = result.text.trim();
        if (!transcript) {
          throw new Error("No transcript returned");
        }
      } catch (error) {
        await markJobError(job.id, error instanceof Error ? error.message : String(error));
        return;
      }

      store.updateVoiceJob(job.id, {
        transcript,
        error: undefined,
      });
    }

    await cleanupJobArtifacts(job);

    const targetSessionId = job.targetSessionId;
    if (!targetSessionId) {
      await markJobError(job.id, "Voice job target session is missing.", transcript);
      return;
    }

    if (isRestartCutoverInProgress(await refreshRestartState())) {
      scheduleRetry(job.id);
      return;
    }

    const isResumingSend = job.status === "sending";
    if (isResumingSend && await sessionHasAcceptedTranscript(targetSessionId, transcript, job.updatedAt)) {
      await markJobDone(job.id, transcript);
      return;
    }

    if (sessionManager.isSessionBusy(targetSessionId)) {
      if (isResumingSend) {
        try {
          await waitForTranscriptAcceptance(targetSessionId, transcript, job.updatedAt);
          await markJobDone(job.id, transcript);
        } catch (error) {
          await markJobError(
            job.id,
            `Auto-send failed. Transcript was saved to the composer instead. (${error instanceof Error ? error.message : String(error)})`,
            transcript,
          );
        }
        return;
      }

      await markJobError(
        job.id,
        "Auto-send failed. Transcript was saved to the composer instead. (Session is busy, please wait)",
        transcript,
      );
      return;
    }

    const sendingJob = isResumingSend
      ? job
      : (store.updateVoiceJob(job.id, {
          status: "sending",
          transcript,
          error: undefined,
        }) ?? job);

    try {
      sessionManager.startWork(targetSessionId, transcript);
      await waitForTranscriptAcceptance(targetSessionId, transcript, sendingJob.updatedAt);
      await markJobDone(job.id, transcript);
    } catch (error) {
      if (isRestartPendingError(error)) {
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
      void processVoiceJob(jobId);
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

  async function waitForTranscriptAcceptance(
    sessionId: string,
    transcript: string,
    notBefore: string,
  ): Promise<void> {
    const deadline = Date.now() + SEND_ACCEPTANCE_TIMEOUT_MS;

    while (Date.now() < deadline) {
      if (await sessionHasAcceptedTranscript(sessionId, transcript, notBefore)) {
        return;
      }
      if (!sessionManager.isSessionBusy(sessionId)) {
        throw new Error("Message was not accepted by the session.");
      }
      await new Promise((resolve) => setTimeout(resolve, SEND_ACCEPTANCE_POLL_MS));
    }

    throw new Error("Timed out waiting for the session to accept the message.");
  }

  async function createTargetSession(taskId?: string): Promise<string> {
    if (!taskId) {
      const result = await sessionManager.createSession();
      return result.sessionId;
    }

    const task = taskStore.getTask(taskId);
    if (!task) {
      throw new Error("Task not found");
    }

    const prDescriptions = task.pullRequests.map(
      (pr) => `${pr.repoName || pr.repoId} PR #${pr.prId}`,
    );
    const group = task.groupId ? taskGroupStore.getGroup(task.groupId) : undefined;
    const groupNotes = group?.notes?.trim() ? { groupName: group.name, notes: group.notes } : null;
    const result = await sessionManager.createTaskSession(
      task.id,
      task.title,
      task.workItems,
      prDescriptions,
      task.notes,
      task.cwd,
      undefined,
      groupNotes,
    );
    taskStore.linkSession(task.id, result.sessionId);
    return result.sessionId;
  }

  async function markJobDone(id: string, transcript: string): Promise<StoredVoiceJob | undefined> {
    const job = store.getVoiceJob(id);
    if (!job) return undefined;
    await cleanupJobArtifacts(job);
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
    const job = store.getVoiceJob(id);
    if (!job) return undefined;
    await cleanupJobArtifacts(job);
    return store.markError(id, error, transcript);
  }

  async function performMaintenance(now: number): Promise<VoiceJobMaintenanceResult> {
    for (const job of store.listTerminalVoiceJobs()) {
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
    findLatestRelevantForComposer,
    markRecovered,
    resumePendingJobs,
    runMaintenance,
    startMaintenance,
    shutdown,
  };
}

export type VoiceJobManager = ReturnType<typeof createVoiceJobManager>;
