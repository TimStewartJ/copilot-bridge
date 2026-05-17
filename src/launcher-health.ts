export type HealthRecoveryDecision = {
  nextFailures: number;
  logMessage?: string;
  recover?: {
    reason: string;
    killExisting: boolean;
  };
};

export type ExitRecoveryDecision = {
  reason: string;
  options: {
    killExisting?: boolean;
    delayMs?: number;
  };
};

export function shouldIgnoreHealthPollResult(options: {
  pollTargetChanged: boolean;
  restarting: boolean;
  shuttingDown: boolean;
  recoveringServer: boolean;
}): boolean {
  const { pollTargetChanged, restarting, shuttingDown, recoveringServer } = options;
  return pollTargetChanged || restarting || shuttingDown || recoveringServer;
}

export function evaluateHealthPoll(options: {
  healthy: boolean;
  hasServerProcess: boolean;
  consecutiveFailures: number;
  failureThreshold: number;
  failureDetail?: string;
}): HealthRecoveryDecision {
  const { healthy, hasServerProcess, consecutiveFailures, failureThreshold, failureDetail } = options;

  if (healthy) {
    return { nextFailures: 0 };
  }

  if (!hasServerProcess) {
    return {
      nextFailures: 0,
      logMessage: "Server process missing (restarting immediately)",
      recover: {
        reason: "missing server process",
        killExisting: false,
      },
    };
  }

  const nextFailures = Math.min(consecutiveFailures + 1, failureThreshold);
  const logMessage = `Health check failed (${nextFailures}/${failureThreshold})${
    failureDetail ? `: ${failureDetail}` : ""
  }`;

  if (nextFailures < failureThreshold) {
    return { nextFailures, logMessage };
  }

  return {
    nextFailures,
    logMessage,
    recover: {
      reason: `${failureThreshold} consecutive health check failures`,
      killExisting: true,
    },
  };
}

export function evaluateUnexpectedExit(options: {
  code: number | null;
  signal: NodeJS.Signals | null;
  restarting: boolean;
  shuttingDown: boolean;
  recoveringServer: boolean;
  crashRestartDelay: number;
}): ExitRecoveryDecision | null {
  const { code, signal, restarting, shuttingDown, recoveringServer, crashRestartDelay } = options;

  if (restarting || shuttingDown || recoveringServer) {
    return null;
  }

  if (code !== 0 && code !== null) {
    return {
      reason: `crash (exit code ${code})`,
      options: { delayMs: crashRestartDelay },
    };
  }

  return {
    reason: signal ? `missing server process (signal ${signal})` : "missing server process",
    options: { killExisting: false },
  };
}

export function evaluatePostRecoveryState(options: {
  hasServerProcess: boolean;
  restarting: boolean;
  recoveringServer: boolean;
  shuttingDown: boolean;
}): ExitRecoveryDecision | null {
  const { hasServerProcess, restarting, recoveringServer, shuttingDown } = options;

  if (hasServerProcess || restarting || recoveringServer || shuttingDown) {
    return null;
  }

  return {
    reason: "missing server process",
    options: { killExisting: false },
  };
}
