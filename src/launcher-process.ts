import type { ChildProcess } from "node:child_process";
import type { BridgeDistributionMode } from "./server/distribution-mode.js";
import { remainingMs, type Deadline } from "./server/deadline.js";

type ExitAwareChildProcess = Pick<ChildProcess, "exitCode" | "signalCode" | "once" | "off">;
type ErrorAwareChildProcess = Pick<ChildProcess, "on" | "pid">;

export const LAUNCHER_STARTUP_GIT_PULL_ENV = "BRIDGE_GIT_PULL_ON_STARTUP";

export function shouldPullOnLauncherStartup(env: NodeJS.ProcessEnv): boolean {
  return /^(1|true|yes|on)$/i.test(env[LAUNCHER_STARTUP_GIT_PULL_ENV]?.trim() ?? "");
}

export function attachLauncherChildErrorHandler(
  child: ErrorAwareChildProcess,
  options: {
    label: string;
    log: (message: string) => void;
    onSpawnFailure: (error: Error) => void;
  },
): void {
  child.on("error", (error) => {
    const normalized = error instanceof Error ? error : new Error(String(error));
    options.log(`${options.label} process error: ${normalized.message}`);
    if (child.pid === undefined) {
      options.onSpawnFailure(normalized);
    }
  });
}

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
