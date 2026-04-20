export type RestartOutcome = "restarted" | "recovered-via-rollback" | "failed";

export function didRestartRecover(outcome: RestartOutcome): boolean {
  return outcome !== "failed";
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
