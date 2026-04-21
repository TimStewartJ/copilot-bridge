import type { VoiceBackgroundJob } from "../hooks/useBackgroundVoiceJobs";

interface VoiceJobSlotOwnership {
  composerKey: string;
  serverJobId: string;
  claimedServerJobId?: string | null;
}

function isOwnedByVoiceJob(
  job: VoiceBackgroundJob | undefined,
  serverJobId: string,
  claimedServerJobId?: string | null,
): boolean {
  return !!job && (
    job.serverJobId === serverJobId
    || (!job.serverJobId && claimedServerJobId === serverJobId)
  );
}

export function shouldHandleDraftVoiceTarget(
  currentDraftJob: VoiceBackgroundJob | undefined,
  serverJobId: string,
  claimedServerJobId: string | null | undefined,
  allowRecovery: boolean,
  hasDraftContent: boolean,
): boolean {
  return isOwnedByVoiceJob(currentDraftJob, serverJobId, claimedServerJobId)
    || (allowRecovery && !currentDraftJob && !claimedServerJobId && !hasDraftContent);
}

export function clearOwnedVoiceJobs(
  jobs: Record<string, VoiceBackgroundJob>,
  ...slots: VoiceJobSlotOwnership[]
): Record<string, VoiceBackgroundJob> {
  let next = jobs;
  let changed = false;

  for (const slot of slots) {
    if (!isOwnedByVoiceJob(next[slot.composerKey], slot.serverJobId, slot.claimedServerJobId)) {
      continue;
    }
    if (!changed) {
      next = { ...next };
      changed = true;
    }
    delete next[slot.composerKey];
  }

  return next;
}

export function replaceVoiceJob(
  jobs: Record<string, VoiceBackgroundJob>,
  serverJobId: string,
  originComposerKey: string,
  nextJob: VoiceBackgroundJob,
  claimedOriginServerJobId?: string | null,
): Record<string, VoiceBackgroundJob> {
  const next = {
    ...clearOwnedVoiceJobs(
      jobs,
      { composerKey: originComposerKey, serverJobId, claimedServerJobId: claimedOriginServerJobId },
      { composerKey: nextJob.composerKey, serverJobId },
    ),
    [nextJob.composerKey]: nextJob,
  };
  return next;
}
