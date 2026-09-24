import type { ManagementJob } from "./management-job-store.js";
import type { BridgeToolInvocation } from "./agent-tools-mcp/adapter.js";
import { isDisposableDeferWorkerSessionId } from "./defer-ids.js";
import { bridgeToolResult } from "./tool-results.js";

export const MANAGEMENT_JOB_DEFER_GUIDANCE =
  "Use a same-session defer for later status follow-up if useful.";

export const MANAGEMENT_JOB_RESULT_DELIVERY_GUIDANCE =
  "Bridge sends this job's final result to this session as a new message when it finishes, "
  + "so end your turn (or continue independent work) instead of polling or creating a defer.";

/** Guidance for a caller waiting on a job: the session that queued it is told the result. */
export function managementJobWaitGuidance(job: ManagementJob, sessionId?: string): string {
  return job.originSessionId && (sessionId === undefined || sessionId === job.originSessionId)
    ? MANAGEMENT_JOB_RESULT_DELIVERY_GUIDANCE
    : MANAGEMENT_JOB_DEFER_GUIDANCE;
}

/**
 * The session that should hear a queued job's result. A disposable defer worker is deleted when
 * its check ends, so it has nobody to tell.
 */
export function managementJobOriginSessionId(invocation?: Pick<BridgeToolInvocation, "sessionId">): string | undefined {
  const sessionId = invocation?.sessionId?.trim();
  if (!sessionId || isDisposableDeferWorkerSessionId(sessionId)) return undefined;
  return sessionId;
}

export function queuedManagementJobResult(job: ManagementJob, action: string) {
  const batchNote = job.type === "staging_deploy"
    ? " Deploys that finish before the Bridge is next idle share one restart, which blocks nothing while it waits."
    : "";
  return bridgeToolResult({
    success: true,
    jobId: job.id,
    status: job.status,
    terminal: false,
    toolNextAction: "proceed" as const,
    retryable: false,
    summary:
      `${action} queued as management job ${job.id}. ` +
      `The launcher-supervised runner will process it in the background.${batchNote} ${managementJobWaitGuidance(job)}`,
  });
}
