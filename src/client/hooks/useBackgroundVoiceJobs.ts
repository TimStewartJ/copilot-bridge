import { useCallback, useEffect, useRef, useState } from "react";
import {
  createVoiceJob,
  fetchLatestVoiceJob,
  fetchVoiceJob,
  markVoiceJobRecovered,
  transcribeAudio,
  type Attachment,
  type VoiceJobStatusResponse,
} from "../api";
import { getTaskIdFromDraftComposerKey, isDraftComposerKey } from "../lib/composer-key";
import { resolveBackgroundVoiceSubmitMode } from "../lib/background-voice-delivery";
import { mergeTranscript } from "../lib/voice-transcript";
import type { VoiceSubmitMode } from "../lib/voice-submit-mode";
import type { Draft } from "../useDrafts";

type VoiceBackgroundJobStatus = "uploading" | "accepted" | "transcribing" | "sending" | "error";

export interface VoiceBackgroundJob {
  composerKey: string;
  status: VoiceBackgroundJobStatus;
  submitMode: VoiceSubmitMode;
  error?: string;
  serverOwned?: boolean;
  serverJobId?: string;
  originComposerKey?: string;
  targetSessionId?: string;
  safeToLeave?: boolean;
}

export interface StartBackgroundVoiceJobOptions {
  composerKey: string;
  audio: Blob;
  submitMode: VoiceSubmitMode;
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
}

export interface UseBackgroundVoiceJobsResult {
  getJobForComposer: (composerKey: string) => VoiceBackgroundJob | null;
  startBackgroundVoiceJob: (options: StartBackgroundVoiceJobOptions) => Promise<void>;
  reviewInstead: (composerKey: string) => void;
  clearVoiceJobError: (composerKey: string) => void;
}

const SERVER_POLL_DELAY_MS = 1_200;

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
}: UseBackgroundVoiceJobsOptions): UseBackgroundVoiceJobsResult {
  const [jobs, setJobs] = useState<Record<string, VoiceBackgroundJob>>({});
  const jobsRef = useRef(jobs);
  const uploadControllersRef = useRef<Record<string, AbortController>>({});
  const uploadAudioRef = useRef<Record<string, Blob>>({});
  const pollTimersRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
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

  const clearVoiceJobError = useCallback((composerKey: string) => {
    setJobsState((prev) => {
      const existing = prev[composerKey];
      if (!existing || existing.status !== "error") return prev;
      const next = { ...prev };
      delete next[composerKey];
      return next;
    });
  }, [setJobsState]);

  const clearUploadTracking = useCallback((composerKey: string) => {
    delete uploadControllersRef.current[composerKey];
    delete uploadAudioRef.current[composerKey];
  }, []);

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

  const markError = useCallback((
    composerKey: string,
    message: string,
    extras?: Partial<Pick<VoiceBackgroundJob, "serverOwned" | "serverJobId" | "originComposerKey" | "targetSessionId" | "safeToLeave">>,
  ) => {
    setJob(composerKey, {
      composerKey,
      status: "error",
      submitMode: "insert",
      error: message,
      ...extras,
    });
  }, [setJob]);

  const startLocalInsertJob = useCallback((composerKey: string, audio: Blob) => {
    clearVoiceJobError(composerKey);
    setJob(composerKey, {
      composerKey,
      status: "transcribing",
      submitMode: "insert",
    });

    const runJob = async () => {
      try {
        const result = await transcribeAudio(audio);
        const transcript = result.text.trim();
        if (!transcript) {
          throw new Error("No transcript returned");
        }

        insertTranscriptIntoDraft(composerKey, transcript);
        clearJob(composerKey);
      } catch (err) {
        markError(composerKey, err instanceof Error ? err.message : String(err));
      }
    };

    void runJob();
  }, [clearJob, clearVoiceJobError, insertTranscriptIntoDraft, markError, setJob]);

  const applyServerSnapshot = useCallback(async (
    snapshot: VoiceJobStatusResponse,
    originComposerKey: string,
  ): Promise<boolean> => {
    const displayKey = snapshot.targetSessionId ?? originComposerKey;
    const taskId = snapshot.taskId ?? getTaskIdFromDraftComposerKey(originComposerKey);
    const knownTargetSessionId =
      jobsRef.current[displayKey]?.targetSessionId
      ?? jobsRef.current[originComposerKey]?.targetSessionId;

    if (snapshot.targetSessionId && isDraftComposerKey(originComposerKey)) {
      optionsRef.current.rememberDraftSession(originComposerKey, snapshot.targetSessionId);
      if (knownTargetSessionId !== snapshot.targetSessionId) {
        optionsRef.current.refreshSessions();
        if (taskId) {
          optionsRef.current.refreshTasks();
        }
      }
      moveDraftContent(originComposerKey, snapshot.targetSessionId);
      if (optionsRef.current.activeComposerKey === originComposerKey) {
        optionsRef.current.navigateToSession(snapshot.targetSessionId, taskId, true);
      }
    }

    if (snapshot.status === "done" || snapshot.status === "recovered") {
      clearJob(displayKey);
      stopPolling(snapshot.id);
      if (isDraftComposerKey(originComposerKey) && snapshot.targetSessionId) {
        optionsRef.current.clearDraftSession(originComposerKey);
      }
      return false;
    }

    if (snapshot.status === "error") {
      stopPolling(snapshot.id);
        const canRecoverNow =
          optionsRef.current.activeComposerKey === displayKey
          || optionsRef.current.activeComposerKey === originComposerKey;

      if (canRecoverNow) {
        if (snapshot.transcript) {
          insertTranscriptIntoDraft(displayKey, snapshot.transcript, true);
          await markVoiceJobRecovered(snapshot.id).catch(() => {});
          if (isDraftComposerKey(originComposerKey) && snapshot.targetSessionId) {
            optionsRef.current.clearDraftSession(originComposerKey);
          }
        }
      }
      if (displayKey !== originComposerKey) {
        clearJob(originComposerKey);
      }
      markError(displayKey, snapshot.error ?? "Auto-send failed.", {
        serverOwned: true,
        serverJobId: snapshot.id,
        originComposerKey,
        targetSessionId: snapshot.targetSessionId,
        safeToLeave: snapshot.safeToLeave,
      });
      return false;
    }

    if (displayKey !== originComposerKey) {
      clearJob(originComposerKey);
    }
    setJob(displayKey, {
      composerKey: displayKey,
      status: snapshot.status,
      submitMode: "autosend",
      serverOwned: true,
      serverJobId: snapshot.id,
      originComposerKey,
      targetSessionId: snapshot.targetSessionId,
      safeToLeave: snapshot.safeToLeave,
    });
    return snapshot.status === "accepted" || snapshot.status === "transcribing" || snapshot.status === "sending";
  }, [clearJob, insertTranscriptIntoDraft, markError, moveDraftContent, setJob, stopPolling]);

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

  const startServerAutoSendJob = useCallback((composerKey: string, audio: Blob) => {
    const controller = new AbortController();
    uploadControllersRef.current[composerKey] = controller;
    uploadAudioRef.current[composerKey] = audio;
    clearVoiceJobError(composerKey);
    setJob(composerKey, {
      composerKey,
      status: "uploading",
      submitMode: "autosend",
      serverOwned: true,
      originComposerKey: composerKey,
    });

    const runJob = async () => {
      try {
        const snapshot = await createVoiceJob(
          {
            composerKey,
            sessionId: isDraftComposerKey(composerKey) ? undefined : composerKey,
            taskId: getTaskIdFromDraftComposerKey(composerKey),
          },
          audio,
          { signal: controller.signal },
        );
        clearUploadTracking(composerKey);
        const keepPolling = await applyServerSnapshot(snapshot, composerKey);
        if (keepPolling) {
          pollServerJob(snapshot.id, composerKey);
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        clearUploadTracking(composerKey);
        markError(composerKey, err instanceof Error ? err.message : String(err), {
          serverOwned: true,
          originComposerKey: composerKey,
        });
      }
    };

    void runJob();
  }, [applyServerSnapshot, clearUploadTracking, clearVoiceJobError, markError, pollServerJob, setJob]);

  const reviewInstead = useCallback((_composerKey: string) => {
    // Server-owned autosend commits once upload begins; insert/review mode remains local-only.
  }, []);

  const startBackgroundVoiceJob = useCallback(({
    composerKey,
    audio,
    submitMode,
  }: StartBackgroundVoiceJobOptions) => {
    const effectiveSubmitMode = resolveBackgroundVoiceSubmitMode({
      submitMode,
      hasDraftContent: draftHasContent(optionsRef.current.getDraft(composerKey)),
      targetBusy: !isDraftComposerKey(composerKey) && optionsRef.current.isSessionBusy(composerKey),
    });

    if (effectiveSubmitMode === "insert") {
      startLocalInsertJob(composerKey, audio);
    } else {
      startServerAutoSendJob(composerKey, audio);
    }
    return Promise.resolve();
  }, [draftHasContent, startLocalInsertJob, startServerAutoSendJob]);

  useEffect(() => {
    if (!activeComposerKey) return;
    let cancelled = false;

    const recover = async () => {
      try {
        const snapshot = await fetchLatestVoiceJob(activeComposerKey);
        if (cancelled || !snapshot) return;

        const originComposerKey = snapshot.composerKey;
        const keepPolling = await applyServerSnapshot(snapshot, originComposerKey);
        if (keepPolling) {
          pollServerJob(snapshot.id, originComposerKey);
        }
      } catch {
        // Ignore recovery fetch failures; the active page can keep working locally.
      }
    };

    void recover();
    return () => {
      cancelled = true;
    };
  }, [activeComposerKey, applyServerSnapshot, pollServerJob]);

  useEffect(() => {
    return () => {
      for (const controller of Object.values(uploadControllersRef.current)) {
        controller.abort();
      }
      uploadControllersRef.current = {};
      uploadAudioRef.current = {};
      for (const timer of Object.values(pollTimersRef.current)) {
        clearTimeout(timer);
      }
      pollTimersRef.current = {};
    };
  }, []);

  return {
    getJobForComposer,
    startBackgroundVoiceJob,
    reviewInstead,
    clearVoiceJobError,
  };
}
