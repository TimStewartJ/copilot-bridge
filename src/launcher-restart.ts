export type RestartOutcome =
  | "restarted"
  | "recovered-via-rollback"
  | "failed"
  | "invalid-release-candidate";

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
