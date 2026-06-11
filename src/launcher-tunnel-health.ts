export type TunnelHealthDecision = {
  nextFailures: number;
  logMessage?: string;
  recycle: boolean;
};

export function evaluateTunnelHealthPoll(options: {
  healthy: boolean;
  consecutiveFailures: number;
  failureThreshold: number;
  failureDetail?: string;
}): TunnelHealthDecision {
  const { healthy, consecutiveFailures, failureThreshold, failureDetail } = options;
  if (healthy) {
    return { nextFailures: 0, recycle: false };
  }

  const nextFailures = Math.min(consecutiveFailures + 1, failureThreshold);
  return {
    nextFailures,
    logMessage: `Public tunnel health check failed (${nextFailures}/${failureThreshold})${
      failureDetail ? `: ${failureDetail}` : ""
    }`,
    recycle: nextFailures >= failureThreshold,
  };
}
