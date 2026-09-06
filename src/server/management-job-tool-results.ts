import type { ManagementJob } from "./management-job-store.js";
import { bridgeToolResult } from "./tool-results.js";

export const MANAGEMENT_JOB_DEFER_GUIDANCE =
  "Use a same-session defer for later status follow-up if useful.";

export function queuedManagementJobResult(job: ManagementJob, action: string) {
  const batchNote = job.type === "staging_deploy"
    ? " The runner combines up to 10 queued deploys into one restart."
    : "";
  return bridgeToolResult({
    success: true,
    jobId: job.id,
    status: job.status,
    terminal: true,
    toolNextAction: "respond_or_defer" as const,
    retryable: false,
    summary:
      `${action} queued as management job ${job.id}. ` +
      `The launcher-supervised runner will process it in the background.${batchNote} ${MANAGEMENT_JOB_DEFER_GUIDANCE}`,
  });
}
