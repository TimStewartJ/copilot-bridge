import { isDraftComposerKey } from "./composer-key";

export type AcceptedFlashJobStatus = "uploading" | "accepted" | "transcribing" | "sending";

export interface AcceptedFlashJobState {
  composerKey: string;
  status: AcceptedFlashJobStatus;
  serverOwned?: boolean;
  serverJobId?: string;
  originComposerKey?: string;
}

export interface AcceptedFlashHandoff {
  originComposerKey: string;
  targetComposerKey: string;
}

export function shouldFlashAcceptedStatus(
  previousJob: AcceptedFlashJobState | null,
  currentJob: AcceptedFlashJobState | null,
): boolean {
  return !!currentJob?.serverOwned
    && currentJob.status === "accepted"
    && !!currentJob.serverJobId
    && !!previousJob?.serverOwned
    && previousJob.status === "uploading"
    && previousJob.composerKey === currentJob.originComposerKey;
}

export function updateAcceptedFlashHandoff(
  previousComposerKey: string | null,
  currentComposerKey: string,
  pendingHandoff: AcceptedFlashHandoff | null,
): AcceptedFlashHandoff | null {
  if (!previousComposerKey || previousComposerKey === currentComposerKey) {
    return pendingHandoff;
  }
  return isDraftComposerKey(previousComposerKey) && !isDraftComposerKey(currentComposerKey)
    ? { originComposerKey: previousComposerKey, targetComposerKey: currentComposerKey }
    : null;
}

export function shouldFlashAcceptedHandoff(
  handoffOriginComposerKey: string | null,
  currentComposerKey: string,
  currentJob: AcceptedFlashJobState | null,
): boolean {
  return !!handoffOriginComposerKey
    && !isDraftComposerKey(currentComposerKey)
    && !!currentJob?.serverOwned
    && !!currentJob.serverJobId
    && currentJob.composerKey === currentComposerKey
    && currentJob.originComposerKey === handoffOriginComposerKey
    && (currentJob.status === "accepted" || currentJob.status === "transcribing" || currentJob.status === "sending");
}

export function shouldClearAcceptedFlashHandoff(
  pendingHandoff: AcceptedFlashHandoff | null,
  currentComposerKey: string,
  currentJob: AcceptedFlashJobState | null,
): boolean {
  return !!pendingHandoff && (
    pendingHandoff.targetComposerKey !== currentComposerKey
    || !!currentJob?.composerKey
  );
}

export function shouldKeepAcceptedFlash(
  flashJobId: string | null,
  currentJob: AcceptedFlashJobState | null,
): boolean {
  return !!flashJobId
    && !!currentJob?.serverOwned
    && currentJob.serverJobId === flashJobId;
}
