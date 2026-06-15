import type { ChildProcess } from "node:child_process";
import {
  settleByDeadline,
  type Deadline,
} from "./server/deadline.js";
import type {
  ProcessIdentity,
  ProcessTreeTerminationResult,
} from "./server/platform.js";

export const LAUNCHER_TERMINAL_EXIT_CODE = 64;
export const LAUNCHER_CLEANUP_FAILURE_EXIT_CODE = 70;

export type LauncherChild = {
  label: string;
  process: ChildProcess | null;
  identity: ProcessIdentity | Promise<ProcessIdentity | null> | null;
};

export type LauncherChildShutdownDependencies = {
  terminateProcessTree: (
    identity: ProcessIdentity,
    deadline: Deadline,
  ) => Promise<ProcessTreeTerminationResult>;
  waitForChildExit: (process: ChildProcess, deadline: Deadline) => Promise<boolean>;
  log: (message: string) => void;
};

export type LauncherChildStopOutcome =
  | { ok: true; mode: "already-exited" | "graceful" | "forced" }
  | { ok: false; reason: "identity-unavailable" | "deadline-exceeded" | string };

export type LauncherShutdownOutcome = {
  ok: boolean;
  attempts: number;
  remaining: string[];
};

export type LauncherChildStopOptions = {
  deadline: Deadline;
  gracefulDeadline?: Deadline;
  requestGraceful?: (deadline: Deadline) => Promise<void>;
};

const childStopOperations = new WeakMap<ChildProcess, Promise<LauncherChildStopOutcome>>();

function childExited(process: ChildProcess): boolean {
  return process.exitCode !== null || process.signalCode !== null;
}

async function resolveIdentity(
  child: LauncherChild,
  deadline: Deadline,
): Promise<ProcessIdentity | null> {
  if (!child.identity) return null;
  const settlement = await settleByDeadline(
    () => Promise.resolve(child.identity),
    deadline,
  );
  return settlement.status === "fulfilled" ? settlement.value : null;
}

async function runStopStateMachine(
  child: LauncherChild,
  dependencies: LauncherChildShutdownDependencies,
  options: LauncherChildStopOptions,
): Promise<LauncherChildStopOutcome> {
  const process = child.process;
  if (!process || childExited(process)) return { ok: true, mode: "already-exited" };

  const identity = await resolveIdentity(child, options.deadline);
  if (!identity) {
    dependencies.log(`Unable to stop ${child.label}: child creation identity was not captured`);
    return { ok: false, reason: "identity-unavailable" };
  }

  if (options.requestGraceful && options.gracefulDeadline) {
    const gracefulRequest = await settleByDeadline(
      () => options.requestGraceful!(options.gracefulDeadline!),
      options.gracefulDeadline,
    );
    if (gracefulRequest.status === "rejected") {
      dependencies.log(
        `${child.label} graceful shutdown request failed: ${
          gracefulRequest.error instanceof Error
            ? gracefulRequest.error.message
            : String(gracefulRequest.error)
        }`,
      );
    }
    if (await dependencies.waitForChildExit(process, options.gracefulDeadline)) {
      return { ok: true, mode: "graceful" };
    }
  }

  const result = await dependencies.terminateProcessTree(identity, options.deadline);
  if (result.ok) return { ok: true, mode: "forced" };

  const survivorDetail = result.survivors?.length
    ? `; survivors=${result.survivors.map(({ pid }) => pid).join(",")}`
    : "";
  dependencies.log(
    `${child.label} process tree stop failed: ${result.status}${survivorDetail}`,
  );
  return { ok: false, reason: result.status };
}

/**
 * Stop a managed child exactly once. Concurrent and later callers share the
 * same state-machine result, preventing duplicate force actions.
 */
export function stopLauncherChild(
  child: LauncherChild,
  dependencies: LauncherChildShutdownDependencies,
  options: LauncherChildStopOptions,
): Promise<LauncherChildStopOutcome> {
  if (!child.process) return Promise.resolve({ ok: true, mode: "already-exited" });
  const existing = childStopOperations.get(child.process);
  if (existing) return existing;
  const operation = runStopStateMachine(child, dependencies, options);
  childStopOperations.set(child.process, operation);
  return operation;
}

function uniqueChildren(children: LauncherChild[]): LauncherChild[] {
  const seen = new Set<ChildProcess>();
  return children.filter(({ process }) => {
    if (!process || seen.has(process)) return false;
    seen.add(process);
    return true;
  });
}

export async function drainLauncherChildren(
  getChildren: () => LauncherChild[],
  dependencies: LauncherChildShutdownDependencies,
  deadline: Deadline,
): Promise<LauncherShutdownOutcome> {
  // Shutting-down state is set before this function is entered, so launcher
  // spawn gates prevent new children. One microtask lets already-entered spawn
  // callbacks publish their child before the terminal snapshot.
  await Promise.resolve();
  const children = uniqueChildren(getChildren());
  const outcomes = await Promise.all(
    children.map((child) => stopLauncherChild(child, dependencies, { deadline })),
  );
  const remaining = children
    .filter((_child, index) => !outcomes[index]?.ok)
    .map(({ label }) => label);
  if (remaining.length > 0) {
    dependencies.log(`Launcher child cleanup failed; remaining: ${remaining.join(", ")}`);
  }
  return { ok: remaining.length === 0, attempts: children.length > 0 ? 1 : 0, remaining };
}

export async function resolveLauncherShutdownExitCode(
  requestedExitCode: number,
  getChildren: () => LauncherChild[],
  dependencies: LauncherChildShutdownDependencies,
  deadline: Deadline,
): Promise<{ exitCode: number; outcome: LauncherShutdownOutcome }> {
  const outcome = await drainLauncherChildren(getChildren, dependencies, deadline);
  return {
    exitCode: outcome.ok ? requestedExitCode : LAUNCHER_CLEANUP_FAILURE_EXIT_CODE,
    outcome,
  };
}
