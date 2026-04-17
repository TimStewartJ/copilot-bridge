import type { ChildProcess } from "node:child_process";

type ExitAwareChildProcess = Pick<ChildProcess, "exitCode" | "signalCode" | "once" | "off">;

export function isChildProcessActive(
  proc: Pick<ChildProcess, "exitCode" | "signalCode"> | null,
  activeProc: Pick<ChildProcess, "exitCode" | "signalCode"> | null,
): boolean {
  return proc !== null && proc === activeProc && proc.exitCode === null && proc.signalCode === null;
}

export async function waitForChildExit(proc: ExitAwareChildProcess | null, timeoutMs: number): Promise<boolean> {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) {
    return true;
  }

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
