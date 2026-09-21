import type { ManagementJob } from "./management-job-store.js";
import { bridgeToolResult } from "./tool-results.js";

export const MANAGEMENT_JOB_DEFER_GUIDANCE =
  "Use a same-session defer for later status follow-up if useful.";

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
      `The launcher-supervised runner will process it in the background.${batchNote} ${MANAGEMENT_JOB_DEFER_GUIDANCE}`,
  });
}
