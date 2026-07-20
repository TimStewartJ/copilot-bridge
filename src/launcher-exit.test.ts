import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { createDeadline } from "./server/deadline.js";
import {
  drainLauncherChildren,
  LAUNCHER_CLEANUP_FAILURE_EXIT_CODE,
  LAUNCHER_TERMINAL_EXIT_CODE,
  resolveLauncherShutdownExitCode,
  stopLauncherChild,
  type LauncherChild,
  type LauncherChildShutdownDependencies,
} from "./launcher-exit.js";
import type {
  ProcessIdentity,
  ProcessTreeTerminationResult,
} from "./server/platform.js";

function child(pid: number): ChildProcess {
  return {
    pid,
    exitCode: null,
    signalCode: null,
  } as ChildProcess;
}

function identity(pid: number): ProcessIdentity {
  return { pid, startMarker: `start-${pid}` };
}

function managed(label: string, pid: number): LauncherChild {
  return { label, process: child(pid), identity: Promise.resolve(identity(pid)) };
}

function stopped(root: ProcessIdentity): ProcessTreeTerminationResult {
  return { ok: true, status: "terminated", root };
}

function dependencies(
  overrides: Partial<LauncherChildShutdownDependencies> = {},
): LauncherChildShutdownDependencies {
  return {
    terminateProcessTree: vi.fn(async (root) => stopped(root)),
    waitForChildExit: vi.fn(async () => false),
    log: vi.fn(),
    ...overrides,
  };
}

describe("launcher managed-child shutdown", () => {
  it("uses graceful exit without a force action", async () => {
    const server = managed("server", 100);
    const terminateProcessTree = vi.fn();
    const deps = dependencies({
      terminateProcessTree,
      waitForChildExit: vi.fn(async () => true),
    });

    const outcome = await stopLauncherChild(server, deps, {
      deadline: createDeadline(5_000),
      gracefulDeadline: createDeadline(1_000),
      requestGraceful: vi.fn(async () => undefined),
    });

    expect(outcome).toEqual({ ok: true, mode: "graceful" });
    expect(terminateProcessTree).not.toHaveBeenCalled();
  });

  it("performs exactly one force action when graceful shutdown hangs", async () => {
    const server = managed("server", 200);
    const terminateProcessTree = vi.fn(async (root: ProcessIdentity) => stopped(root));
    const deps = dependencies({ terminateProcessTree });
    const options = {
      deadline: createDeadline(5_000),
      gracefulDeadline: createDeadline(1_000),
      requestGraceful: vi.fn(() => new Promise<void>(() => {})),
    };

    const [first, second] = await Promise.all([
      stopLauncherChild(server, deps, options),
      stopLauncherChild(server, deps, options),
    ]);

    expect(first).toEqual({ ok: true, mode: "forced" });
    expect(second).toEqual(first);
    expect(terminateProcessTree).toHaveBeenCalledTimes(1);
  });

  it("fails closed when forced stop cannot be verified", async () => {
    const server = managed("server", 300);
    const root = identity(300);
    const deps = dependencies({
      terminateProcessTree: vi.fn(async () => ({
        ok: false as const,
        status: "survivors" as const,
        root,
        survivors: [root],
      })),
    });

    await expect(stopLauncherChild(server, deps, {
      deadline: createDeadline(5_000),
    })).resolves.toEqual({ ok: false, reason: "survivors" });
  });

  it("refuses destructive work when child identity was not captured", async () => {
    const server: LauncherChild = {
      label: "server",
      process: child(400),
      identity: Promise.resolve(null),
    };
    const terminateProcessTree = vi.fn();
    const deps = dependencies({ terminateProcessTree });

    await expect(stopLauncherChild(server, deps, {
      deadline: createDeadline(5_000),
    })).resolves.toEqual({ ok: false, reason: "identity-unavailable" });
    expect(terminateProcessTree).not.toHaveBeenCalled();
  });

  it("drains each terminal child once under one deadline", async () => {
    const terminateProcessTree = vi.fn(async (root: ProcessIdentity) => stopped(root));
    const deps = dependencies({ terminateProcessTree });
    const children = [managed("server", 500), managed("tunnel", 600)];

    const outcome = await drainLauncherChildren(
      () => children,
      deps,
      createDeadline(5_000),
    );

    expect(outcome).toEqual({ ok: true, attempts: 1, remaining: [] });
    expect(terminateProcessTree).toHaveBeenCalledTimes(2);
  });

  it("returns the cleanup failure exit code instead of retrying an unverifiable stop", async () => {
    const tunnel = managed("tunnel", 700);
    const root = identity(700);
    const terminateProcessTree = vi.fn(async () => ({
      ok: false as const,
      status: "snapshot-unavailable" as const,
      root,
    }));
    const result = await resolveLauncherShutdownExitCode(
      LAUNCHER_TERMINAL_EXIT_CODE,
      () => [tunnel],
      dependencies({ terminateProcessTree }),
      createDeadline(5_000),
    );

    expect(result).toEqual({
      exitCode: LAUNCHER_CLEANUP_FAILURE_EXIT_CODE,
      outcome: { ok: false, attempts: 1, remaining: ["tunnel"] },
    });
    expect(terminateProcessTree).toHaveBeenCalledTimes(1);
  });

  it("evicts failed stop operations so a later reconciliation can retry", async () => {
    const tunnel = managed("tunnel", 700);
    const root = identity(700);
    const terminateProcessTree = vi.fn()
      .mockResolvedValueOnce({
        ok: false as const,
        status: "snapshot-unavailable" as const,
        root,
      })
      .mockResolvedValueOnce(stopped(root));
    const deps = dependencies({ terminateProcessTree });

    await expect(stopLauncherChild(
      tunnel,
      deps,
      { deadline: createDeadline(5_000) },
    )).resolves.toEqual({ ok: false, reason: "snapshot-unavailable" });
    await expect(stopLauncherChild(
      tunnel,
      deps,
      { deadline: createDeadline(5_000) },
    )).resolves.toEqual({ ok: true, mode: "forced" });

    expect(terminateProcessTree).toHaveBeenCalledTimes(2);
  });
});
