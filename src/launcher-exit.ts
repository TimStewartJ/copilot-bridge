import type { ChildProcess } from "node:child_process";
import type { ProcessIdentity, ProcessTreeKillResult } from "./server/platform.js";

export const LAUNCHER_TERMINAL_EXIT_CODE = 64;
export const LAUNCHER_CLEANUP_FAILURE_EXIT_CODE = 70;

export type LauncherChild = {
  label: string;
  process: ChildProcess | null;
  identity: ProcessIdentity | null;
};

export type LauncherChildShutdownDependencies = {
  killProcessTree: (
    process: ChildProcess,
    identity: ProcessIdentity,
  ) => ProcessTreeKillResult | null;
  waitForProcessTreeExit: (result: ProcessTreeKillResult, timeoutMs: number) => Promise<boolean>;
  isProcessIdentityCurrent: (identity: ProcessIdentity) => boolean;
  timeoutMs: number;
  maxAttempts: number;
  log: (message: string) => void;
};

export type LauncherShutdownOutcome = {
  ok: boolean;
  attempts: number;
  remaining: string[];
};

function activeChildren(
  children: LauncherChild[],
  isProcessIdentityCurrent: (identity: ProcessIdentity) => boolean,
): LauncherChild[] {
  const seen = new Set<number>();
  return children.filter(({ process, identity }) => {
    if (!process) return false;
    if (!identity) return true;
    if (seen.has(identity.pid)) return false;
    seen.add(identity.pid);
    return isProcessIdentityCurrent(identity);
  });
}

function mergeChildren(...groups: LauncherChild[][]): LauncherChild[] {
  const seen = new Set<ChildProcess>();
  const merged: LauncherChild[] = [];
  for (const child of groups.flat()) {
    if (!child.process || seen.has(child.process)) continue;
    seen.add(child.process);
    merged.push(child);
  }
  return merged;
}

async function stopLauncherChildren(
  children: LauncherChild[],
  dependencies: LauncherChildShutdownDependencies,
): Promise<LauncherChild[]> {
  const outcomes = await Promise.all(children.map(async (child) => {
    const { label, process, identity } = child;
    if (!process) return null;
    if (!identity) {
      dependencies.log(`Unable to stop ${label}: child creation identity was not captured`);
      return child;
    }
    if (!dependencies.isProcessIdentityCurrent(identity)) {
      return null;
    }
    const result = dependencies.killProcessTree(process, identity);
    if (!result) {
      return dependencies.isProcessIdentityCurrent(identity) ? child : null;
    }
    const exited = await dependencies.waitForProcessTreeExit(result, dependencies.timeoutMs);
    if (!exited) {
      if (!dependencies.isProcessIdentityCurrent(identity)) {
        return null;
      }
      dependencies.log(`${label} process tree did not exit within ${dependencies.timeoutMs}ms`);
      return child;
    }
    return null;
  }));
  return outcomes.filter((child): child is LauncherChild => child !== null);
}

export async function drainLauncherChildren(
  getChildren: () => LauncherChild[],
  dependencies: LauncherChildShutdownDependencies,
): Promise<LauncherShutdownOutcome> {
  const maxAttempts = Math.max(1, dependencies.maxAttempts);
  let pending: LauncherChild[] = [];
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const children = mergeChildren(
      pending,
      activeChildren(getChildren(), dependencies.isProcessIdentityCurrent),
    );
    if (children.length === 0) {
      await Promise.resolve();
      if (activeChildren(getChildren(), dependencies.isProcessIdentityCurrent).length === 0) {
        return { ok: true, attempts: attempt - 1, remaining: [] };
      }
      continue;
    }

    pending = await stopLauncherChildren(children, dependencies);
    const remaining = activeChildren(getChildren(), dependencies.isProcessIdentityCurrent);
    if (pending.length === 0 && remaining.length === 0) {
      await Promise.resolve();
      if (activeChildren(getChildren(), dependencies.isProcessIdentityCurrent).length === 0) {
        return { ok: true, attempts: attempt, remaining: [] };
      }
    }
    if (attempt < maxAttempts) {
      const retrying = mergeChildren(pending, remaining);
      dependencies.log(
        `Launcher child cleanup attempt ${attempt}/${maxAttempts} left ${retrying.map(({ label }) => label).join(", ")}; retrying`,
      );
    }
  }

  const remaining = mergeChildren(
    pending,
    activeChildren(getChildren(), dependencies.isProcessIdentityCurrent),
  )
    .map(({ label }) => label);
  dependencies.log(
    `Launcher child cleanup failed after ${maxAttempts} attempts; remaining: ${remaining.join(", ") || "unknown"}`,
  );
  return { ok: false, attempts: maxAttempts, remaining };
}

export async function resolveLauncherShutdownExitCode(
  requestedExitCode: number,
  getChildren: () => LauncherChild[],
  dependencies: LauncherChildShutdownDependencies,
): Promise<{ exitCode: number; outcome: LauncherShutdownOutcome }> {
  const outcome = await drainLauncherChildren(getChildren, dependencies);
  return {
    exitCode: outcome.ok ? requestedExitCode : LAUNCHER_CLEANUP_FAILURE_EXIT_CODE,
    outcome,
  };
}
