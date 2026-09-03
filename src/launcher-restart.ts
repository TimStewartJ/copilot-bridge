import { isRecord } from "./shared/is-record.js";
import type { ManagementJob } from "./server/management-job-store.js";
import type {
  RestartSignal,
  RestartSignalConsumption,
} from "./server/restart-signal.js";

export type RestartOutcome =
  | "restarted"
  | "recovered-via-rollback"
  | "failed"
  | "invalid-release-candidate";

export type VerifiedReplacement<T> =
  | { stopped: false; replacement: null }
  | { stopped: true; replacement: T };

export type RestartSignalAction = "none" | "retry" | "reject" | "restart";

export function resolveRestartSignalAction(result: RestartSignalConsumption): RestartSignalAction {
  switch (result.status) {
    case "none":
      return "none";
    case "retryable-error":
      return "retry";
    case "invalid":
      return "reject";
    case "claimed":
      return "restart";
  }
}

export function isDeployRestartUpdatePending(
  job: ManagementJob,
  includeQueued = false,
): boolean {
  return job.type === "staging_deploy" && (
    job.status === "running"
    || (includeQueued && job.status === "queued")
    || (
      job.status === "succeeded"
      && isRecord(job.result)
      && job.result.restartDeferred === true
    )
  );
}

export function resolveRestartSignalUpdate(
  current: RestartSignal,
  result: RestartSignalConsumption,
): RestartSignal {
  if (result.status === "none") return current;
  if (result.status === "retryable-error") {
    throw new Error(`Failed to read the latest restart candidate: ${String(result.error)}`);
  }
  if (result.status === "invalid") {
    throw new Error(`The latest restart candidate is invalid: ${result.error.message}`);
  }
  if (
    current.requestId !== result.signal.requestId
    || current.validationMode !== result.signal.validationMode
  ) {
    throw new Error("The pending restart candidate update did not match the active restart request");
  }
  return result.signal;
}

/**
 * The only legal path from one managed server to another: replacement creation
 * is not invoked until the previous process tree has a verified stop result.
 */
export async function startAfterVerifiedStop<T>(
  stop: () => Promise<boolean>,
  startReplacement: () => T,
): Promise<VerifiedReplacement<T>> {
  if (!(await stop())) return { stopped: false, replacement: null };
  return { stopped: true, replacement: startReplacement() };
}

export function didRestartRecover(outcome: RestartOutcome): boolean {
  return outcome === "restarted" || outcome === "recovered-via-rollback";
}

export function shouldPersistReleaseFailureState(options: {
  outcome: RestartOutcome;
  hasPendingReleaseFailure: boolean;
}): boolean {
  return options.outcome === "failed" && options.hasPendingReleaseFailure;
}

export function resolveReleaseCandidateRestartOutcome(options: {
  releaseCandidateRequested: boolean;
  releaseCandidateResolved: boolean;
}): RestartOutcome | null {
  if (options.releaseCandidateRequested && !options.releaseCandidateResolved) {
    return "invalid-release-candidate";
  }
  return null;
}

export function rollbackRecoveryRequiresServerStart(options: {
  hadRunningServerAtStart: boolean;
}): boolean {
  return !options.hadRunningServerAtStart;
}

export function resolveRollbackRecoveryOutcome(options: {
  rollbackSucceeded: boolean;
  hadRunningServerAtStart: boolean;
  rolledBackServerHealthy?: boolean;
}): RestartOutcome {
  const { rollbackSucceeded, hadRunningServerAtStart, rolledBackServerHealthy = false } = options;
  if (!rollbackSucceeded) {
    return "failed";
  }
  if (hadRunningServerAtStart) {
    return "recovered-via-rollback";
  }
  return rolledBackServerHealthy ? "recovered-via-rollback" : "failed";
}
