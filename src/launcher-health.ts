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

/** Reads `agentBackend.recoveryBlockedAt` from a /api/health body without trusting its shape. */
export function readRecoveryBlockedAt(healthBody: unknown): string | null {
  if (!healthBody || typeof healthBody !== "object") return null;
  const agentBackend = (healthBody as { agentBackend?: unknown }).agentBackend;
  if (!agentBackend || typeof agentBackend !== "object") return null;
  const blockedAt = (agentBackend as { recoveryBlockedAt?: unknown }).recoveryBlockedAt;
  return typeof blockedAt === "string" && Number.isFinite(Date.parse(blockedAt)) ? blockedAt : null;
}

export type BlockedBackendRecoveryObservation =
  | "not-blocked"
  | "waiting"
  | "restarting"
  | "suppressed"
  | "budget-exhausted";

export type BlockedBackendRecoveryMonitorOptions = {
  graceMs: number;
  maxRestarts: number;
  windowMs: number;
  log: (message: string) => void;
  /** Fire-and-forget. A slow or hung notification must never stall the health poll. */
  notify: (message: string) => void;
  restart: (reason: string) => void;
  isAutoRecoverySuppressed: () => boolean;
};

/**
 * A healthy HTTP server whose agent backend recovery is blocked cannot recover
 * on its own. Restart it once the block has persisted past a grace period, but
 * cap how often that can happen so a recurring block cannot loop forever, and
 * never restart while automatic recovery is suppressed.
 */
export function createBlockedBackendRecoveryMonitor(options: BlockedBackendRecoveryMonitorOptions) {
  let restartTimesMs: number[] = [];
  let interventionReported = false;

  const reportIntervention = (logMessage: string, notifyMessage: string) => {
    if (interventionReported) return;
    interventionReported = true;
    options.log(logMessage);
    options.notify(notifyMessage);
  };

  return {
    observe(recoveryBlockedAt: string | null, nowMs: number): BlockedBackendRecoveryObservation {
      restartTimesMs = restartTimesMs.filter((startedAtMs) => nowMs - startedAtMs < options.windowMs);
      const blockedAtMs = recoveryBlockedAt === null ? Number.NaN : Date.parse(recoveryBlockedAt);
      if (!Number.isFinite(blockedAtMs)) {
        interventionReported = false;
        return "not-blocked";
      }

      const blockedForMs = Math.max(0, nowMs - blockedAtMs);
      if (blockedForMs < options.graceMs) return "waiting";
      const blockedForSeconds = Math.round(blockedForMs / 1_000);

      if (options.isAutoRecoverySuppressed()) {
        reportIntervention(
          `❌ Agent backend recovery has been blocked for ${blockedForSeconds}s, but automatic recovery is `
            + "suppressed until an explicit restart. Manual intervention needed.",
          "❌ Copilot Bridge agent backend recovery is blocked and automatic recovery is suppressed. "
            + "Manual intervention needed.",
        );
        return "suppressed";
      }

      if (restartTimesMs.length >= options.maxRestarts) {
        const windowMinutes = Math.round(options.windowMs / 60_000);
        reportIntervention(
          `❌ Agent backend recovery has been blocked for ${blockedForSeconds}s, but ${options.maxRestarts} automatic `
            + `restart(s) already ran in the last ${windowMinutes} minutes. Manual intervention needed.`,
          `❌ Copilot Bridge agent backend recovery is blocked and ${options.maxRestarts} automatic restart(s) `
            + `already ran in the last ${windowMinutes} minutes. Manual intervention needed.`,
        );
        return "budget-exhausted";
      }

      restartTimesMs = [...restartTimesMs, nowMs];
      interventionReported = false;
      options.log(
        `Agent backend recovery has been blocked for ${blockedForSeconds}s; restarting the server `
          + `(automatic restart ${restartTimesMs.length}/${options.maxRestarts} this window)`,
      );
      options.restart(`agent backend recovery blocked for ${blockedForSeconds}s`);
      return "restarting";
    },
  };
}
