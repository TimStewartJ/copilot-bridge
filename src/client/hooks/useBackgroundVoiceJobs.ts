import { useCallback, useEffect, useRef, useState } from "react";
import {
  createVoiceJob,
  fetchLatestVoiceJob,
  fetchVoiceJob,
  markVoiceJobRecovered,
  transcribeAudio,
  type Attachment,
  type CreateSessionOptions,
  type VoiceJobStatusResponse,
} from "../api";
import { getTaskIdFromDraftComposerKey, isDraftComposerKey } from "../lib/composer-key";
import { resolveBackgroundVoiceSubmitMode } from "../lib/background-voice-delivery";
import { clearOwnedVoiceJobs, replaceVoiceJob, shouldHandleDraftVoiceTarget } from "../lib/voice-job-map";
import { mergeTranscript } from "../lib/voice-transcript";
import {
  createVoiceRecordingId,
  deletePendingVoiceRecording,
  getPendingVoiceRecording,
  migratePendingVoiceRecording,
  patchPendingVoiceRecording,
  pendingVoiceRecordingToBlob,
  savePendingVoiceRecording,
  type VoicePersistResult,
} from "../lib/voice-recording-store";
import type { VoiceSubmitMode } from "../lib/voice-submit-mode";
import type { Draft } from "../useDrafts";

export type VoiceBackgroundJobStatus = "uploading" | "accepted" | "transcribing" | "sending" | "error";
type VoiceServerActivityStatus = Extract<VoiceJobStatusResponse["status"], "accepted" | "transcribing" | "sending">;
export type VoiceSessionActivityStatus = "uploading" | VoiceServerActivityStatus;
export type VoiceSessionSettledStatus = "done" | "recovered" | "error";

export interface VoiceSessionActivity {
  sessionId: string;
  taskId?: string;
  status: VoiceSessionActivityStatus;
  statusChanged?: boolean;
}

export interface VoiceSessionSettled {
  sessionId: string;
  taskId?: string;
  status: VoiceSessionSettledStatus;
}

export interface VoiceBackgroundJob {
  composerKey: string;
  status: VoiceBackgroundJobStatus;
  submitMode: VoiceSubmitMode;
  error?: string;
  retryable?: boolean;
  serverOwned?: boolean;
  serverJobId?: string;
  originComposerKey?: string;
  targetSessionId?: string;
  safeToLeave?: boolean;
  /** True when the job was rebuilt from a recording persisted before an app restart. */
  restored?: boolean;
  /** Set when the audio could not be written to durable client storage. */
  persistWarning?: string;
  /** Session configuration captured when a draft autosend recording started. */
  sessionOptions?: CreateSessionOptions;
}

/** A voice job that is still in flight, narrowed away from the terminal `error` status. */
export type ActiveVoiceBackgroundJob = VoiceBackgroundJob & {
  status: Exclude<VoiceBackgroundJobStatus, "error">;
};

export function isActiveVoiceBackgroundJob(
  job: VoiceBackgroundJob | null | undefined,
): job is ActiveVoiceBackgroundJob {
  return !!job && job.status !== "error";
}

export interface StartBackgroundVoiceJobOptions {
  composerKey: string;
  audio: Blob;
  submitMode: VoiceSubmitMode;
  sessionOptions?: CreateSessionOptions;
}

interface UseBackgroundVoiceJobsOptions {
  activeComposerKey: string | null;
  getDraft: (composerKey: string) => Draft | null;
  setDraft: (composerKey: string, text: string, attachments?: Attachment[]) => void;
  setDraftImmediate: (composerKey: string, text: string, attachments?: Attachment[]) => void;
  clearDraft: (composerKey: string) => void;
  rememberDraftSession: (draftComposerKey: string, sessionId: string) => void;
  clearDraftSession: (draftComposerKey: string) => void;
  materializeSession: (taskId?: string) => Promise<string>;
  isSessionBusy: (sessionId: string) => boolean;
  navigateToSession: (sessionId: string, taskId?: string, replace?: boolean) => void;
  refreshSessions: () => void;
  refreshTasks: () => void;
  onVoiceSessionActivity?: (activity: VoiceSessionActivity) => void;
  onVoiceSessionSettled?: (activity: VoiceSessionSettled) => void;
}

export interface UseBackgroundVoiceJobsResult {
  getJobForComposer: (composerKey: string) => VoiceBackgroundJob | null;
  startBackgroundVoiceJob: (options: StartBackgroundVoiceJobOptions) => Promise<void>;
  retryVoiceJobUpload: (composerKey: string) => void;
  reviewInstead: (composerKey: string) => void;
  clearVoiceJobError: (composerKey: string) => void;
  discardVoiceRecording: (composerKey: string) => void;
  migrateVoiceRecording: (fromComposerKey: string, toComposerKey: string) => void;
}

const SERVER_POLL_DELAY_MS = 1_200;
const RESTORED_RECORDING_MESSAGE = "Unsent voice recording saved from earlier.";
const NON_DURABLE_STORAGE_MESSAGE = "Recording could not be saved on this device — keep the app open until it sends.";

function describePersistResult(result: VoicePersistResult): string | undefined {
  if (result.durable) return undefined;
  if (result.reason === "conflict") return undefined;
  return NON_DURABLE_STORAGE_MESSAGE;
}

function isVoiceServerActivityStatus(status: VoiceJobStatusResponse["status"]): status is VoiceServerActivityStatus {
  return status === "accepted" || status === "transcribing" || status === "sending";
}

export function useBackgroundVoiceJobs({
  activeComposerKey,
  getDraft,
  setDraft,
  setDraftImmediate,
  clearDraft,
  rememberDraftSession,
  clearDraftSession,
  isSessionBusy,
  navigateToSession,
  refreshSessions,
  refreshTasks,
  onVoiceSessionActivity,
  onVoiceSessionSettled,
}: UseBackgroundVoiceJobsOptions): UseBackgroundVoiceJobsResult {
  const [jobs, setJobs] = useState<Record<string, VoiceBackgroundJob>>({});
  const jobsRef = useRef(jobs);
  const uploadControllersRef = useRef<Record<string, AbortController>>({});
  const uploadAudioRef = useRef<Record<string, Blob>>({});
  const pendingRecordingIdsRef = useRef<Record<string, string>>({});
  const persistWarningsRef = useRef<Record<string, string>>({});
  const hydratedComposerKeysRef = useRef<Set<string>>(new Set());
  const retryingComposerKeysRef = useRef<Set<string>>(new Set());
  const pollTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const claimedOriginServerJobIdsRef = useRef<Record<string, string>>({});
  const lastNotifiedActivityStatusRef = useRef<Record<string, VoiceSessionActivityStatus>>({});
  const optionsRef = useRef({
    activeComposerKey,
    getDraft,
    setDraft,
    setDraftImmediate,
    clearDraft,
    rememberDraftSession,
    clearDraftSession,
    isSessionBusy,
    navigateToSession,
    refreshSessions,
    refreshTasks,
    onVoiceSessionActivity,
    onVoiceSessionSettled,
  });

  useEffect(() => {
    jobsRef.current = jobs;
  }, [jobs]);

  optionsRef.current = {
    activeComposerKey,
    getDraft,
    setDraft,
    setDraftImmediate,
    clearDraft,
    rememberDraftSession,
    clearDraftSession,
    isSessionBusy,
    navigateToSession,
    refreshSessions,
    refreshTasks,
    onVoiceSessionActivity,
    onVoiceSessionSettled,
  };

  const setJobsState = useCallback((updater: (prev: Record<string, VoiceBackgroundJob>) => Record<string, VoiceBackgroundJob>) => {
    setJobs((prev) => {
      const next = updater(prev);
      jobsRef.current = next;
      return next;
    });
  }, []);

  const setJob = useCallback((composerKey: string, job: VoiceBackgroundJob) => {
    setJobsState((prev) => ({ ...prev, [composerKey]: job }));
  }, [setJobsState]);

  const clearJob = useCallback((composerKey: string) => {
    setJobsState((prev) => {
      if (!(composerKey in prev)) return prev;
      const next = { ...prev };
      delete next[composerKey];
      return next;
    });
  }, [setJobsState]);

  const getJobForComposer = useCallback((composerKey: string) => jobs[composerKey] ?? null, [jobs]);

  const clearUploadTracking = useCallback((composerKey: string, expectedController?: AbortController) => {
    if (expectedController && uploadControllersRef.current[composerKey] !== expectedController) return;
    delete uploadControllersRef.current[composerKey];
    delete uploadAudioRef.current[composerKey];
  }, []);

  const clearUploadController = useCallback((composerKey: string, expectedController: AbortController) => {
    if (uploadControllersRef.current[composerKey] === expectedController) {
      delete uploadControllersRef.current[composerKey];
    }
  }, []);

  const forgetPendingRecording = useCallback(async (composerKey: string, recordingId?: string) => {
    const owned = recordingId ?? pendingRecordingIdsRef.current[composerKey];
    if (!owned) return;
    if (recordingId && pendingRecordingIdsRef.current[composerKey] === recordingId) {
      delete pendingRecordingIdsRef.current[composerKey];
    } else if (!recordingId) {
      delete pendingRecordingIdsRef.current[composerKey];
    }
    hydratedComposerKeysRef.current.delete(composerKey);
    await deletePendingVoiceRecording(composerKey, owned).catch(() => {});
  }, []);

  /**
   * Deletes the stored recording only when it belongs to the server job that just settled. A stale
   * recovery response must never destroy a recording made after that job started.
   */
  const forgetRecordingForServerJob = useCallback(async (composerKey: string, serverJobId: string) => {
    const record = await getPendingVoiceRecording(composerKey).catch(() => null);
    if (!record) return;
    if (record.serverJobId && record.serverJobId !== serverJobId) return;
    await forgetPendingRecording(composerKey, record.recordingId);
  }, [forgetPendingRecording]);

  const notePendingRecordingFailure = useCallback(async (composerKey: string, message: string) => {
    const recordingId = pendingRecordingIdsRef.current[composerKey];
    if (!recordingId) return;
    await patchPendingVoiceRecording(composerKey, recordingId, { lastError: message }).catch(() => {});
  }, []);

  /** Keeps a persisted recording attached to its conversation when a draft becomes a real session. */
  const moveRecordingOwnership = useCallback(async (fromComposerKey: string, toComposerKey: string) => {
    if (fromComposerKey === toComposerKey) return;

    const moved = await migratePendingVoiceRecording(fromComposerKey, toComposerKey).catch(() => null);
    if (!moved) return;

    pendingRecordingIdsRef.current[toComposerKey] = moved.recordingId;
    delete pendingRecordingIdsRef.current[fromComposerKey];

    const audio = uploadAudioRef.current[fromComposerKey];
    if (audio) {
      uploadAudioRef.current[toComposerKey] = audio;
      delete uploadAudioRef.current[fromComposerKey];
    }

    const warning = persistWarningsRef.current[fromComposerKey];
    if (warning) {
      persistWarningsRef.current[toComposerKey] = warning;
      delete persistWarningsRef.current[fromComposerKey];
    }

    hydratedComposerKeysRef.current.delete(fromComposerKey);
    hydratedComposerKeysRef.current.add(toComposerKey);
  }, []);

  const clearVoiceJobError = useCallback((composerKey: string) => {
    const existing = jobsRef.current[composerKey];
    if (existing?.status !== "error") return;
    // Never silently drop audio that has not been delivered yet — that needs an explicit discard.
    if (existing.retryable === true) return;
    clearUploadTracking(composerKey);
    retryingComposerKeysRef.current.delete(composerKey);
    setJobsState((prev) => {
      const current = prev[composerKey];
      if (!current || current.status !== "error" || current.retryable === true) return prev;
      const next = { ...prev };
      delete next[composerKey];
      return next;
    });
  }, [clearUploadTracking, setJobsState]);

  const discardVoiceRecording = useCallback((composerKey: string) => {
    clearUploadTracking(composerKey);
    retryingComposerKeysRef.current.delete(composerKey);
    delete pendingRecordingIdsRef.current[composerKey];
    delete persistWarningsRef.current[composerKey];
    hydratedComposerKeysRef.current.delete(composerKey);
    // Delete unconditionally: an explicit discard must clear the slot even if this tab never
    // owned the recording (for example after a restart rebuilt the job from storage).
    void deletePendingVoiceRecording(composerKey).catch(() => {});
    setJobsState((prev) => {
      if (!(composerKey in prev)) return prev;
      const next = { ...prev };
      delete next[composerKey];
      return next;
    });
  }, [clearUploadTracking, setJobsState]);

  const stopPolling = useCallback((jobId: string) => {
    const timer = pollTimersRef.current[jobId];
    if (!timer) return;
    clearTimeout(timer);
    delete pollTimersRef.current[jobId];
  }, []);

  const insertTranscriptIntoDraft = useCallback((composerKey: string, transcript: string, persistImmediately = false) => {
    const draft = optionsRef.current.getDraft(composerKey);
    const nextText = mergeTranscript(draft?.text ?? "", transcript);
    if (persistImmediately) {
      optionsRef.current.setDraftImmediate(composerKey, nextText, draft?.attachments);
    } else {
      optionsRef.current.setDraft(composerKey, nextText, draft?.attachments);
    }
  }, []);

  const draftHasContent = useCallback((draft: Draft | null) => (
    !!draft && (draft.text.trim().length > 0 || (draft.attachments?.length ?? 0) > 0)
  ), []);

  const moveDraftContent = useCallback((sourceComposerKey: string, targetComposerKey: string) => {
    const sourceDraft = optionsRef.current.getDraft(sourceComposerKey);
    if (!draftHasContent(sourceDraft)) {
      optionsRef.current.clearDraft(sourceComposerKey);
      return;
    }

    const targetDraft = optionsRef.current.getDraft(targetComposerKey);
    const nextText = mergeTranscript(targetDraft?.text ?? "", sourceDraft?.text ?? "");
    const nextAttachments = [
      ...(targetDraft?.attachments ?? []),
      ...(sourceDraft?.attachments ?? []),
    ];

    optionsRef.current.setDraft(
      targetComposerKey,
      nextText,
      nextAttachments.length > 0 ? nextAttachments : undefined,
    );
    optionsRef.current.clearDraft(sourceComposerKey);
  }, [draftHasContent]);

  const findDisplayKeyForServerJob = useCallback((jobId: string): string | null => {
    for (const [composerKey, job] of Object.entries(jobsRef.current)) {
      if (job.serverJobId === jobId) {
        return composerKey;
      }
    }
    return null;
  }, []);

  const notifyVoiceSessionActivity = useCallback((jobId: string, activity: VoiceSessionActivity) => {
    const statusChanged = lastNotifiedActivityStatusRef.current[jobId] !== activity.status;
    lastNotifiedActivityStatusRef.current[jobId] = activity.status;
    optionsRef.current.onVoiceSessionActivity?.({
      ...activity,
      statusChanged,
    });
  }, []);

  const notifyVoiceSessionSettled = useCallback((jobId: string, settled: VoiceSessionSettled) => {
    delete lastNotifiedActivityStatusRef.current[jobId];
    optionsRef.current.onVoiceSessionSettled?.(settled);
  }, []);

  const notifySnapshotVoiceSessionActivity = useCallback((snapshot: VoiceJobStatusResponse) => {
    if (!snapshot.targetSessionId) return;
    if (!isVoiceServerActivityStatus(snapshot.status)) return;

    notifyVoiceSessionActivity(snapshot.id, {
      sessionId: snapshot.targetSessionId,
      taskId: snapshot.taskId,
      status: snapshot.status,
    });
  }, [notifyVoiceSessionActivity]);

  const markError = useCallback((
    composerKey: string,
    message: string,
    extras?: Partial<Pick<VoiceBackgroundJob, "submitMode" | "retryable" | "serverOwned" | "serverJobId" | "originComposerKey" | "targetSessionId" | "safeToLeave" | "restored" | "persistWarning" | "sessionOptions">>,
  ) => {
    const nextJob: VoiceBackgroundJob = {
      composerKey,
      status: "error",
      submitMode: "insert",
      error: message,
    };
    if (extras) {
      Object.assign(nextJob, extras);
    }
    // Retry needs recoverable audio: either still in memory, or persisted on this device.
    nextJob.retryable = extras?.retryable === true
      && (!!uploadAudioRef.current[composerKey] || !!pendingRecordingIdsRef.current[composerKey])
      ? true
      : undefined;
    nextJob.persistWarning = extras?.persistWarning ?? persistWarningsRef.current[composerKey];
    setJob(composerKey, nextJob);
    if (nextJob.retryable) {
      void notePendingRecordingFailure(composerKey, message);
    }
  }, [notePendingRecordingFailure, setJob]);
  const startLocalInsertJob = useCallback((composerKey: string, audio: Blob, recordingId?: string) => {
    clearUploadTracking(composerKey);
    uploadAudioRef.current[composerKey] = audio;
    if (recordingId) {
      pendingRecordingIdsRef.current[composerKey] = recordingId;
    }
    const ownedRecordingId = pendingRecordingIdsRef.current[composerKey];
    setJob(composerKey, {
      composerKey,
      status: "transcribing",
      submitMode: "insert",
      persistWarning: persistWarningsRef.current[composerKey],
    });

    const runJob = async () => {
      try {
        const result = await transcribeAudio(audio);
        const transcript = result.text.trim();
        if (!transcript) {
          throw new Error("No transcript returned");
        }

        // Persist the transcript before dropping the audio so a reload cannot lose both.
        insertTranscriptIntoDraft(composerKey, transcript, true);
        await forgetPendingRecording(composerKey, ownedRecordingId);
        clearUploadTracking(composerKey);
        clearJob(composerKey);
      } catch (err) {
        markError(composerKey, err instanceof Error ? err.message : String(err), {
          submitMode: "insert",
          retryable: true,
        });
      } finally {
        retryingComposerKeysRef.current.delete(composerKey);
      }
    };

    void runJob();
  }, [clearJob, clearUploadTracking, forgetPendingRecording, insertTranscriptIntoDraft, markError, setJob]);

  const applyServerSnapshot = useCallback(async (
    snapshot: VoiceJobStatusResponse,
    originComposerKey: string,
    options: { allowDraftRecovery?: boolean } = {},
  ): Promise<boolean> => {
    const displayKey = snapshot.targetSessionId ?? originComposerKey;
    const taskId = snapshot.taskId ?? getTaskIdFromDraftComposerKey(originComposerKey);
    const claimedOriginServerJobId = claimedOriginServerJobIdsRef.current[originComposerKey] ?? null;
    notifySnapshotVoiceSessionActivity(snapshot);
    const canHandleDraftTarget =
      !!snapshot.targetSessionId
      && isDraftComposerKey(originComposerKey)
      && shouldHandleDraftVoiceTarget(
        jobsRef.current[originComposerKey],
        snapshot.id,
        claimedOriginServerJobId,
        options.allowDraftRecovery === true,
        draftHasContent(optionsRef.current.getDraft(originComposerKey)),
      );
    const navigateTargetSessionId =
      canHandleDraftTarget
      && optionsRef.current.activeComposerKey === originComposerKey
        ? snapshot.targetSessionId
        : null;
    const knownTargetSessionId =
      jobsRef.current[displayKey]?.targetSessionId
      ?? jobsRef.current[originComposerKey]?.targetSessionId;

    if (snapshot.targetSessionId && isDraftComposerKey(originComposerKey) && canHandleDraftTarget) {
      optionsRef.current.rememberDraftSession(originComposerKey, snapshot.targetSessionId);
      if (knownTargetSessionId !== snapshot.targetSessionId) {
        optionsRef.current.refreshSessions();
        if (taskId) {
          optionsRef.current.refreshTasks();
        }
      }
      moveDraftContent(originComposerKey, snapshot.targetSessionId);
      await moveRecordingOwnership(originComposerKey, snapshot.targetSessionId);
    }

    if (snapshot.status === "done" || snapshot.status === "recovered") {
      if (snapshot.status === "done" && snapshot.targetSessionId) {
        notifyVoiceSessionActivity(snapshot.id, {
          sessionId: snapshot.targetSessionId,
          taskId,
          status: "sending",
        });
      }
      setJobsState((prev) => clearOwnedVoiceJobs(
        prev,
        { composerKey: originComposerKey, serverJobId: snapshot.id, claimedServerJobId: claimedOriginServerJobId },
        { composerKey: displayKey, serverJobId: snapshot.id },
      ));
      stopPolling(snapshot.id);
      if (claimedOriginServerJobIdsRef.current[originComposerKey] === snapshot.id) {
        delete claimedOriginServerJobIdsRef.current[originComposerKey];
      }
      if (isDraftComposerKey(originComposerKey) && snapshot.targetSessionId) {
        optionsRef.current.clearDraftSession(originComposerKey);
      }
      // The message landed (or its transcript was recovered) — the local copy is finally safe to drop.
      await forgetRecordingForServerJob(displayKey, snapshot.id);
      await forgetRecordingForServerJob(originComposerKey, snapshot.id);
      if (snapshot.targetSessionId) {
        notifyVoiceSessionSettled(snapshot.id, {
          sessionId: snapshot.targetSessionId,
          taskId,
          status: snapshot.status,
        });
      }
      if (navigateTargetSessionId) {
        optionsRef.current.navigateToSession(navigateTargetSessionId, taskId, true);
      }
      return false;
    }

    if (snapshot.status === "error") {
      stopPolling(snapshot.id);
        const canRecoverNow =
          optionsRef.current.activeComposerKey === displayKey
          || optionsRef.current.activeComposerKey === originComposerKey;

      let transcriptRecovered = false;
      if (canRecoverNow) {
        if (snapshot.transcript) {
          insertTranscriptIntoDraft(displayKey, snapshot.transcript, true);
          await markVoiceJobRecovered(snapshot.id).catch(() => {});
          transcriptRecovered = true;
          if (isDraftComposerKey(originComposerKey) && snapshot.targetSessionId) {
            optionsRef.current.clearDraftSession(originComposerKey);
          }
        }
      }

      // The server discards its audio copy on failure, so keep ours unless a transcript survived.
      if (transcriptRecovered) {
        await forgetRecordingForServerJob(displayKey, snapshot.id);
        await forgetRecordingForServerJob(originComposerKey, snapshot.id);
      }
      const retryableFromLocalCopy = !transcriptRecovered && !!pendingRecordingIdsRef.current[displayKey];

      setJobsState((prev) => replaceVoiceJob(prev, snapshot.id, originComposerKey, {
        composerKey: displayKey,
        status: "error",
        submitMode: "insert",
        error: snapshot.error ?? "Auto-send failed.",
        retryable: retryableFromLocalCopy ? true : undefined,
        serverOwned: true,
        serverJobId: snapshot.id,
        originComposerKey,
        targetSessionId: snapshot.targetSessionId,
        safeToLeave: snapshot.safeToLeave,
        persistWarning: persistWarningsRef.current[displayKey],
      }, claimedOriginServerJobId));
      if (claimedOriginServerJobIdsRef.current[originComposerKey] === snapshot.id) {
        delete claimedOriginServerJobIdsRef.current[originComposerKey];
      }
      if (snapshot.targetSessionId) {
        notifyVoiceSessionSettled(snapshot.id, {
          sessionId: snapshot.targetSessionId,
          taskId,
          status: "error",
        });
      }
      if (navigateTargetSessionId) {
        optionsRef.current.navigateToSession(navigateTargetSessionId, taskId, true);
      }
      return false;
    }

    const activeStatus = snapshot.status;
    if (!isVoiceServerActivityStatus(activeStatus)) return false;

    setJobsState((prev) => replaceVoiceJob(prev, snapshot.id, originComposerKey, {
      composerKey: displayKey,
      status: activeStatus,
      submitMode: "autosend",
      serverOwned: true,
      serverJobId: snapshot.id,
      originComposerKey,
      targetSessionId: snapshot.targetSessionId,
      safeToLeave: snapshot.safeToLeave,
    }, claimedOriginServerJobId));
    if (claimedOriginServerJobIdsRef.current[originComposerKey] === snapshot.id) {
      delete claimedOriginServerJobIdsRef.current[originComposerKey];
    }
    if (navigateTargetSessionId) {
      optionsRef.current.navigateToSession(navigateTargetSessionId, taskId, true);
    }
    return true;
  }, [draftHasContent, forgetRecordingForServerJob, insertTranscriptIntoDraft, moveDraftContent, moveRecordingOwnership, notifySnapshotVoiceSessionActivity, notifyVoiceSessionSettled, setJobsState, stopPolling]);

  const pollServerJob = useCallback((jobId: string, originComposerKey: string) => {
    stopPolling(jobId);

    const tick = async () => {
      try {
        const snapshot = await fetchVoiceJob(jobId);
        if (!snapshot) {
          const displayKey = findDisplayKeyForServerJob(jobId);
          if (displayKey) clearJob(displayKey);
          stopPolling(jobId);
          return;
        }

        const keepPolling = await applyServerSnapshot(snapshot, originComposerKey);
        if (!keepPolling) {
          stopPolling(jobId);
          return;
        }
      } catch {
        // Keep the last known UI state and try again shortly.
      }

      pollTimersRef.current[jobId] = setTimeout(() => {
        void tick();
      }, SERVER_POLL_DELAY_MS);
    };

    pollTimersRef.current[jobId] = setTimeout(() => {
      void tick();
    }, SERVER_POLL_DELAY_MS);
  }, [applyServerSnapshot, clearJob, findDisplayKeyForServerJob, stopPolling]);

  const startServerAutoSendJob = useCallback((
    composerKey: string,
    audio: Blob,
    recordingId?: string,
    sessionOptions?: CreateSessionOptions,
  ) => {
    clearUploadTracking(composerKey);
    const controller = new AbortController();
    const existingSessionComposer = !isDraftComposerKey(composerKey);
    uploadControllersRef.current[composerKey] = controller;
    uploadAudioRef.current[composerKey] = audio;
    if (recordingId) {
      pendingRecordingIdsRef.current[composerKey] = recordingId;
    }
    const ownedRecordingId = pendingRecordingIdsRef.current[composerKey];
    delete claimedOriginServerJobIdsRef.current[composerKey];
    setJob(composerKey, {
      composerKey,
      status: "uploading",
      submitMode: "autosend",
      serverOwned: true,
      originComposerKey: composerKey,
      persistWarning: persistWarningsRef.current[composerKey],
      ...(sessionOptions ? { sessionOptions } : {}),
    });
    if (existingSessionComposer) {
      optionsRef.current.onVoiceSessionActivity?.({
        sessionId: composerKey,
        status: "uploading",
        statusChanged: true,
      });
    }

    const runJob = async () => {
      try {
        const snapshot = await createVoiceJob(
          {
            composerKey,
            sessionId: isDraftComposerKey(composerKey) ? undefined : composerKey,
            taskId: getTaskIdFromDraftComposerKey(composerKey),
            ...(isDraftComposerKey(composerKey) && sessionOptions ? { sessionOptions } : {}),
          },
          audio,
          { signal: controller.signal },
        );
        clearUploadTracking(composerKey, controller);
        retryingComposerKeysRef.current.delete(composerKey);
        claimedOriginServerJobIdsRef.current[composerKey] = snapshot.id;
        // Remember which server job owns this audio so a retry after a restart can resume instead
        // of re-uploading (and duplicating) a message the server already accepted.
        if (ownedRecordingId) {
          await patchPendingVoiceRecording(composerKey, ownedRecordingId, { serverJobId: snapshot.id })
            .catch(() => {});
        }
        const keepPolling = await applyServerSnapshot(snapshot, composerKey);
        if (keepPolling) {
          pollServerJob(snapshot.id, composerKey);
        }
      } catch (err) {
        retryingComposerKeysRef.current.delete(composerKey);
        if (controller.signal.aborted) return;
        clearUploadController(composerKey, controller);
        if (existingSessionComposer) {
          optionsRef.current.onVoiceSessionSettled?.({
            sessionId: composerKey,
            status: "error",
          });
        }
        markError(composerKey, err instanceof Error ? err.message : String(err), {
          submitMode: "autosend",
          retryable: true,
          serverOwned: true,
          originComposerKey: composerKey,
          ...(sessionOptions ? { sessionOptions } : {}),
        });
      }
    };

    void runJob();
  }, [applyServerSnapshot, clearUploadController, clearUploadTracking, markError, pollServerJob, setJob]);

  const reviewInstead = useCallback((_composerKey: string) => {
    // Server-owned autosend commits once upload begins; insert/review mode remains local-only.
  }, []);

  const startBackgroundVoiceJob = useCallback(async ({
    composerKey,
    audio,
    submitMode,
    sessionOptions,
  }: StartBackgroundVoiceJobOptions) => {
    const effectiveSubmitMode = resolveBackgroundVoiceSubmitMode({
      submitMode,
      hasDraftContent: draftHasContent(optionsRef.current.getDraft(composerKey)),
      targetBusy: !isDraftComposerKey(composerKey) && optionsRef.current.isSessionBusy(composerKey),
    });

    // Save the audio before touching the network so a crash, reload, or failed upload can never
    // destroy the only copy of the recording.
    const recordingId = createVoiceRecordingId();
    let persistResult: VoicePersistResult = { durable: false, reason: "unavailable" };
    try {
      persistResult = await savePendingVoiceRecording({
        composerKey,
        recordingId,
        submitMode: effectiveSubmitMode,
        audio: await audio.arrayBuffer(),
        mimeType: audio.type || "audio/wav",
        ...(sessionOptions ? { sessionOptions } : {}),
      });
    } catch {
      persistResult = { durable: false, reason: "unavailable" };
    }

    if (persistResult.reason === "conflict") {
      // An earlier recording for this composer is still unsent; refuse rather than overwrite it.
      markError(composerKey, "Kept the earlier unsent recording — retry or discard it before recording again.", {
        submitMode: effectiveSubmitMode,
        retryable: true,
      });
      return;
    }

    pendingRecordingIdsRef.current[composerKey] = recordingId;
    const warning = describePersistResult(persistResult);
    if (warning) {
      persistWarningsRef.current[composerKey] = warning;
    } else {
      delete persistWarningsRef.current[composerKey];
    }

    if (effectiveSubmitMode === "insert") {
      startLocalInsertJob(composerKey, audio, recordingId);
    } else {
      startServerAutoSendJob(composerKey, audio, recordingId, sessionOptions);
    }
  }, [draftHasContent, markError, startLocalInsertJob, startServerAutoSendJob]);

  const retryVoiceJobUpload = useCallback((composerKey: string) => {
    const existing = jobsRef.current[composerKey];
    if (
      !existing
      || existing.status !== "error"
      || existing.retryable !== true
      || retryingComposerKeysRef.current.has(composerKey)
    ) {
      return;
    }

    retryingComposerKeysRef.current.add(composerKey);

    // Discard removes the composer from this set, which cancels a retry already in flight.
    const stillRetrying = () => retryingComposerKeysRef.current.has(composerKey);

    const runRetry = async () => {
      const record = await getPendingVoiceRecording(composerKey).catch(() => null);
      if (!stillRetrying()) return;

      const retainedAudio = uploadAudioRef.current[composerKey]
        ?? (record ? pendingVoiceRecordingToBlob(record) : null);

      if (!retainedAudio) {
        retryingComposerKeysRef.current.delete(composerKey);
        markError(composerKey, "The recording is no longer available on this device.", {
          submitMode: existing.submitMode,
        });
        return;
      }

      const recordingId = record?.recordingId ?? pendingRecordingIdsRef.current[composerKey];
      if (recordingId) {
        pendingRecordingIdsRef.current[composerKey] = recordingId;
      }

      // If the server already accepted this audio, resume that job instead of sending it twice.
      const knownServerJobId = record?.serverJobId ?? existing.serverJobId;
      if (knownServerJobId) {
        let snapshot: VoiceJobStatusResponse | null = null;
        let statusKnown = true;
        try {
          snapshot = await fetchVoiceJob(knownServerJobId);
        } catch {
          statusKnown = false;
        }
        if (!stillRetrying()) return;

        if (!statusKnown) {
          // An inconclusive status check must not become a second copy of the same message.
          retryingComposerKeysRef.current.delete(composerKey);
          markError(composerKey, "Could not reach the server to check the earlier send. Try again.", {
            submitMode: record?.submitMode ?? existing.submitMode,
            retryable: true,
            serverOwned: existing.serverOwned,
            serverJobId: knownServerJobId,
            ...((record?.sessionOptions ?? existing.sessionOptions)
              ? { sessionOptions: record?.sessionOptions ?? existing.sessionOptions }
              : {}),
          });
          return;
        }

        if (snapshot && snapshot.status !== "error") {
          retryingComposerKeysRef.current.delete(composerKey);
          const originComposerKey = snapshot.composerKey;
          const keepPolling = await applyServerSnapshot(snapshot, originComposerKey);
          if (keepPolling) {
            pollServerJob(snapshot.id, originComposerKey);
          }
          return;
        }
      }

      if (!stillRetrying()) return;

      const retrySubmitMode = record?.submitMode ?? existing.submitMode;
      if (retrySubmitMode === "autosend") {
        startServerAutoSendJob(
          composerKey,
          retainedAudio,
          recordingId,
          record?.sessionOptions ?? existing.sessionOptions,
        );
      } else {
        startLocalInsertJob(composerKey, retainedAudio, recordingId);
      }
    };

    void runRetry();
  }, [applyServerSnapshot, markError, pollServerJob, startLocalInsertJob, startServerAutoSendJob]);

  const migrateVoiceRecording = useCallback((fromComposerKey: string, toComposerKey: string) => {
    if (fromComposerKey === toComposerKey) return;
    void (async () => {
      await moveRecordingOwnership(fromComposerKey, toComposerKey);
      setJobsState((prev) => {
        const existing = prev[fromComposerKey];
        if (!existing || existing.retryable !== true || prev[toComposerKey]) return prev;
        const next = { ...prev };
        delete next[fromComposerKey];
        next[toComposerKey] = { ...existing, composerKey: toComposerKey };
        return next;
      });
    })();
  }, [moveRecordingOwnership, setJobsState]);

  // Rebuild pending recordings for whichever composer the user is looking at. Lazy by design: the
  // audio for other composers stays on disk instead of being pulled into memory.
  useEffect(() => {
    if (!activeComposerKey) return;
    let cancelled = false;
    const composerKey = activeComposerKey;

    const hydrateAndRecover = async () => {
      if (!hydratedComposerKeysRef.current.has(composerKey)) {
        const record = await getPendingVoiceRecording(composerKey).catch(() => null);
        if (cancelled) return;

        if (record) {
          pendingRecordingIdsRef.current[composerKey] = record.recordingId;

          if (record.serverJobId) {
            const snapshot = await fetchVoiceJob(record.serverJobId).catch(() => null);
            // Bail without marking hydrated so returning to this composer tries again.
            if (cancelled) return;
            if (snapshot) {
              hydratedComposerKeysRef.current.add(composerKey);
              const keepPolling = await applyServerSnapshot(snapshot, snapshot.composerKey, {
                allowDraftRecovery: true,
              });
              if (cancelled) return;
              if (keepPolling) pollServerJob(snapshot.id, snapshot.composerKey);
              return;
            }
          }

          hydratedComposerKeysRef.current.add(composerKey);
          // Never commit over a job that is already in flight for this composer.
          if (!jobsRef.current[composerKey]) {
            uploadAudioRef.current[composerKey] = pendingVoiceRecordingToBlob(record);
            setJob(composerKey, {
              composerKey,
              status: "error",
              submitMode: record.submitMode,
              error: record.lastError
                ? `${RESTORED_RECORDING_MESSAGE} (${record.lastError})`
                : RESTORED_RECORDING_MESSAGE,
              retryable: true,
              restored: true,
              ...(record.sessionOptions ? { sessionOptions: record.sessionOptions } : {}),
            });
          }
          return;
        }

        hydratedComposerKeysRef.current.add(composerKey);
      }

      try {
        const snapshot = await fetchLatestVoiceJob(composerKey);
        if (cancelled || !snapshot) return;

        const originComposerKey = snapshot.composerKey;
        const keepPolling = await applyServerSnapshot(snapshot, originComposerKey, { allowDraftRecovery: true });
        if (cancelled) return;
        if (keepPolling) {
          pollServerJob(snapshot.id, originComposerKey);
        }
      } catch {
        // Ignore recovery fetch failures; the active page can keep working locally.
      }
    };

    void hydrateAndRecover();
    return () => {
      cancelled = true;
    };
  }, [activeComposerKey, applyServerSnapshot, pollServerJob, setJob]);

  useEffect(() => {
    return () => {
      for (const controller of Object.values(uploadControllersRef.current)) {
        controller.abort();
      }
      uploadControllersRef.current = {};
      uploadAudioRef.current = {};
      hydratedComposerKeysRef.current.clear();
      pendingRecordingIdsRef.current = {};
      persistWarningsRef.current = {};
      retryingComposerKeysRef.current.clear();
      for (const timer of Object.values(pollTimersRef.current)) {
        clearTimeout(timer);
      }
      pollTimersRef.current = {};
      lastNotifiedActivityStatusRef.current = {};
    };
  }, []);

  return {
    getJobForComposer,
    startBackgroundVoiceJob,
    retryVoiceJobUpload,
    reviewInstead,
    clearVoiceJobError,
    discardVoiceRecording,
    migrateVoiceRecording,
  };
}
