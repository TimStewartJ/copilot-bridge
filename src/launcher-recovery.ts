export type RecoveryExecution =
  | { type: "restart" }
  | { type: "recover" }
  | { type: "skip"; logMessage: string };

export type LauncherStartupDecision =
  | { startServer: true; clearRestartSignal: true }
  | { startServer: false; clearRestartSignal: false; logMessage: string };

export function decideRecoveryExecution(options: {
  restartSignalPresent: boolean;
  autoRecoverySuppressed: boolean;
}): RecoveryExecution {
  const { restartSignalPresent, autoRecoverySuppressed } = options;
  if (restartSignalPresent) {
    return { type: "restart" };
  }
  if (autoRecoverySuppressed) {
    return {
      type: "skip",
      logMessage: "Auto-recovery suppressed — waiting for an explicit restart signal",
    };
  }
  return { type: "recover" };
}

export function shouldCheckFollowUpRecovery(options: {
  autoRecoverySuppressed: boolean;
}): boolean {
  return !options.autoRecoverySuppressed;
}

export function shouldClearRollbackCheckpointAfterHealthyState(options: {
  restartSignalPresent: boolean;
  autoRecoverySuppressed: boolean;
}): boolean {
  return !options.restartSignalPresent && !options.autoRecoverySuppressed;
}

export function decideLauncherStartup(options: {
  restartSignalPresent: boolean;
  autoRecoverySuppressed: boolean;
}): LauncherStartupDecision {
  if (options.restartSignalPresent) {
    return {
      startServer: false,
      clearRestartSignal: false,
      logMessage: options.autoRecoverySuppressed
        ? "Queued restart detected — honoring explicit recovery while rollback recovery remains required"
        : "Queued restart detected — honoring pending restart before normal startup",
    };
  }
  if (options.autoRecoverySuppressed) {
    return {
      startServer: false,
      clearRestartSignal: false,
      logMessage: "Rollback recovery required — staying stopped until an explicit restart succeeds",
    };
  }
  return {
    startServer: true,
    clearRestartSignal: true,
  };
}
