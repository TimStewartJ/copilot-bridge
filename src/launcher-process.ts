import type { ChildProcess } from "node:child_process";
import type { BridgeDistributionMode } from "./server/distribution-mode.js";
import { remainingMs, type Deadline } from "./server/deadline.js";
import type { ProcessTreeTerminationResult } from "./server/platform.js";

type ExitAwareChildProcess = Pick<ChildProcess, "exitCode" | "signalCode" | "once" | "off">;

export function isChildProcessActive(
  proc: Pick<ChildProcess, "exitCode" | "signalCode"> | null,
  activeProc: Pick<ChildProcess, "exitCode" | "signalCode"> | null,
): boolean {
  return proc !== null && proc === activeProc && proc.exitCode === null && proc.signalCode === null;
}

export function spawnLauncherChildIfRunning<T>(
  isShuttingDown: () => boolean,
  spawnChild: () => T,
): T | null {
  return isShuttingDown() ? null : spawnChild();
}

export type ServerRestartSafetyState = {
  unsafeReason: string | null;
};

export function createServerRestartSafetyState(): ServerRestartSafetyState {
  return { unsafeReason: null };
}

export function updateServerRestartSafetyAfterCleanup(
  state: ServerRestartSafetyState,
  result: ProcessTreeTerminationResult,
): void {
  state.unsafeReason = result.ok && result.status === "terminated" && result.snapshot
    ? null
    : `${result.status}${!result.ok && result.error ? `: ${result.error}` : ""}`;
}

export function spawnServerIfRestartSafe<T>(
  state: ServerRestartSafetyState,
  isShuttingDown: () => boolean,
  spawnServer: () => T,
): T | null {
  return state.unsafeReason !== null || isShuttingDown() ? null : spawnServer();
}

export function resolveServerLaunchDistributionMode(
  launcherMode: BridgeDistributionMode,
  isReleaseSlot: boolean,
): BridgeDistributionMode {
  return isReleaseSlot ? "release" : launcherMode;
}

export async function waitForChildExit(proc: ExitAwareChildProcess | null, deadline: Deadline): Promise<boolean> {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
    return true;
  }

  const timeoutMs = remainingMs(deadline);
  if (timeoutMs <= 0) return false;
  return await new Promise<boolean>((resolve) => {
    const onExit = () => {
      clearTimeout(timeout);
      proc.off("exit", onExit);
      resolve(true);
    };
    const timeout = setTimeout(() => {
      proc.off("exit", onExit);
      resolve(proc.exitCode !== null || proc.signalCode !== null);
    }, timeoutMs);
    proc.once("exit", onExit);
  });
}
