import type { ManagementJob } from "./management-job-store.js";
import { bridgeToolResult } from "./tool-results.js";
import { DEFER_MIN_INTERVAL_SECONDS } from "./tools/defer-tools.js";

export const MANAGEMENT_JOB_DEFER_INTERVAL_SECONDS = DEFER_MIN_INTERVAL_SECONDS;
const MANAGEMENT_JOB_DEFER_MAX_RUNS = 24;
type ManagementJobDeferGuidanceMode = "queued" | "status";

export function formatManagementJobDeferGuidance(
  jobId: string,
  mode: ManagementJobDeferGuidanceMode = "queued",
): string {
  const scheduleGuidance = "schedule one same-session defer with " +
    `defer_create (intervalSeconds ${MANAGEMENT_JOB_DEFER_INTERVAL_SECONDS}, maxRuns ${MANAGEMENT_JOB_DEFER_MAX_RUNS}) ` +
    `whose prompt calls management_job_status for job ${jobId} and cancels itself when the job is terminal`;

  if (mode === "status") {
    return `To follow completion without staying active, ${scheduleGuidance}. ` +
      "If this status check already came from a recurring defer, do not create another defer; stop so the existing defer can run again. " +
      "Do not call management_job_status synchronously just to poll.";
  }

  return `If you need to follow completion, ${scheduleGuidance}, then respond/end your turn; otherwise respond now. ` +
    "Do not call management_job_status synchronously just to poll.";
}

export function queuedManagementJobResult(job: ManagementJob, action: string) {
  const restartNote = job.type === "self_update" || job.type === "staging_deploy"
    ? " For deploy/update jobs, the defer is only a scheduled follow-up; after creating it, end your turn so restart cutover is not blocked."
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
      `The launcher-supervised runner will process it in the background. ${formatManagementJobDeferGuidance(job.id)}${restartNote}`,
  });
}
