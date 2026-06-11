import type { ChildProcess } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  drainLauncherChildren,
  LAUNCHER_CLEANUP_FAILURE_EXIT_CODE,
  LAUNCHER_TERMINAL_EXIT_CODE,
  resolveLauncherShutdownExitCode,
} from "./launcher-exit.js";
import type { ProcessIdentity, ProcessTreeKillResult } from "./server/platform.js";

function child(pid?: number): ChildProcess {
  return { pid } as ChildProcess;
}

function identity(pid: number, startMarker = `start-${pid}`): ProcessIdentity {
  return { pid, startMarker };
}

function killResult(pid: number): ProcessTreeKillResult {
  return {
    rootPid: pid,
    descendantPids: [pid + 1],
    trackedPids: [pid, pid + 1],
    killRequested: true,
  };
}

describe("launcher terminal shutdown", () => {
  it("drains every managed child and children discovered after the first snapshot", async () => {
    const server = child(100);
    const runner = child(200);
    const alive = new Set([100, 200]);
    let snapshots = 0;
    const getChildren = () => {
      snapshots++;
      return snapshots < 3
        ? [{ label: "server", process: server, identity: identity(100) }]
        : [
            { label: "server", process: server, identity: identity(100) },
            { label: "management job runner", process: runner, identity: identity(200) },
          ];
    };
    const killProcessTree = vi.fn((process: ChildProcess) => killResult(process.pid!));
    const waitForProcessTreeExit = vi.fn(async (result: ProcessTreeKillResult) => {
      alive.delete(result.rootPid);
      return true;
    });

    const outcome = await drainLauncherChildren(getChildren, {
      killProcessTree,
      waitForProcessTreeExit,
      isProcessIdentityCurrent: ({ pid }) => alive.has(pid),
      timeoutMs: 5_000,
      maxAttempts: 3,
      log: vi.fn(),
    });

    expect(outcome).toEqual({ ok: true, attempts: 2, remaining: [] });
    expect(killProcessTree.mock.calls.map(([process]) => process.pid)).toEqual([100, 200]);
  });

  it("retries failed cleanup and returns an explicit caller-level failure exit", async () => {
    const tunnel = child(300);
    const log = vi.fn();
    const killProcessTree = vi.fn(() => killResult(300));
    const waitForProcessTreeExit = vi.fn(async () => false);
    let snapshots = 0;

    const result = await resolveLauncherShutdownExitCode(
      LAUNCHER_TERMINAL_EXIT_CODE,
      () => (++snapshots === 1
        ? [{ label: "tunnel", process: tunnel, identity: identity(300) }]
        : []),
      {
        killProcessTree,
        waitForProcessTreeExit,
        isProcessIdentityCurrent: () => true,
        timeoutMs: 250,
        maxAttempts: 3,
        log,
      },
    );

    expect(result).toEqual({
      exitCode: LAUNCHER_CLEANUP_FAILURE_EXIT_CODE,
      outcome: { ok: false, attempts: 3, remaining: ["tunnel"] },
    });
    expect(killProcessTree).toHaveBeenCalledTimes(3);
    expect(waitForProcessTreeExit).toHaveBeenCalledTimes(3);
    expect(log).toHaveBeenCalledWith(
      "Launcher child cleanup failed after 3 attempts; remaining: tunnel",
    );
  });

  it("preserves the requested terminal code only after cleanup succeeds", async () => {
    const result = await resolveLauncherShutdownExitCode(
      LAUNCHER_TERMINAL_EXIT_CODE,
      () => [],
      {
        killProcessTree: vi.fn(),
        waitForProcessTreeExit: vi.fn(),
        isProcessIdentityCurrent: vi.fn(),
        timeoutMs: 100,
        maxAttempts: 3,
        log: vi.fn(),
      },
    );

    expect(result.exitCode).toBe(LAUNCHER_TERMINAL_EXIT_CODE);
    expect(result.outcome.ok).toBe(true);
  });

  it("drops a stale child identity and never kills a process that reused its PID", async () => {
    const original = child(400);
    const originalIdentity = identity(400, "original-start");
    const killProcessTree = vi.fn();
    const identityChecks = vi.fn()
      .mockReturnValueOnce(true)
      .mockReturnValue(false);

    const outcome = await drainLauncherChildren(
      () => [{ label: "server", process: original, identity: originalIdentity }],
      {
        killProcessTree,
        waitForProcessTreeExit: vi.fn(),
        isProcessIdentityCurrent: identityChecks,
        timeoutMs: 100,
        maxAttempts: 2,
        log: vi.fn(),
      },
    );

    expect(outcome).toEqual({ ok: true, attempts: 1, remaining: [] });
    expect(killProcessTree).not.toHaveBeenCalled();
  });
});
