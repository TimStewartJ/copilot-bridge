import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeadline } from "./server/deadline.js";
import type { Deadline } from "./server/deadline.js";
import {
  PROCESS_TREE_TERMINATION_REQUEST,
  PROCESS_TREE_TERMINATION_RESULT,
  runProcessTreeTerminationFixpoint,
  terminateProcessTreeWithExternalFixpoint,
} from "./launcher-process-tree-termination.js";
import type {
  ProcessIdentity,
  ProcessTreeTerminationResult,
} from "./server/platform.js";

function identity(pid: number): ProcessIdentity {
  return { pid, startMarker: `start-${pid}` };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("process tree termination fixpoint", () => {
  it("retries captured survivors until every identity is verified gone", async () => {
    const root = identity(100);
    const child = identity(101);
    const grandchild = identity(102);
    const results: ProcessTreeTerminationResult[] = [
      {
        ok: false,
        status: "survivors",
        root,
        snapshot: { root, descendants: [child] },
        survivors: [root, child],
      },
      {
        ok: true,
        status: "already-exited",
        root,
      },
      {
        ok: false,
        status: "survivors",
        root: child,
        snapshot: { root: child, descendants: [grandchild] },
        survivors: [grandchild],
      },
      {
        ok: true,
        status: "terminated",
        root: grandchild,
        snapshot: { root: grandchild, descendants: [] },
      },
    ];
    const terminate = vi.fn(async (
      _identity: ProcessIdentity,
      _deadline: Deadline,
    ): Promise<ProcessTreeTerminationResult> => results.shift()!);
    const waitBeforeRetry = vi.fn(async () => true);

    const response = await runProcessTreeTerminationFixpoint(
      root,
      createDeadline(5_000),
      { terminateProcessTree: terminate, waitBeforeRetry },
    );

    expect(response.result).toMatchObject({
      ok: true,
      status: "terminated",
      snapshot: {
        root,
        descendants: expect.arrayContaining([child, grandchild]),
      },
    });
    expect(response.attempts).toBe(4);
    expect(terminate.mock.calls.map(([captured]) => captured)).toEqual([
      root,
      root,
      child,
      grandchild,
    ]);
  });

  it("retries unavailable snapshots and preserves a bounded deadline", async () => {
    const root = identity(200);
    const terminate = vi.fn()
      .mockResolvedValueOnce({
        ok: false,
        status: "snapshot-unavailable",
        root,
      })
      .mockResolvedValueOnce({
        ok: false,
        status: "snapshot-unavailable",
        root,
      })
      .mockResolvedValueOnce({
        ok: true,
        status: "terminated",
        root,
      });

    const response = await runProcessTreeTerminationFixpoint(
      root,
      createDeadline(5_000),
      {
        terminateProcessTree: terminate,
        waitBeforeRetry: vi.fn(async () => true),
      },
    );

    expect(response.result).toMatchObject({ ok: true, status: "terminated" });
    expect(response.attempts).toBe(3);
  });

  it("times out a snapshot operation that never settles", async () => {
    vi.useFakeTimers();
    const root = identity(300);
    const terminate = vi.fn((
      _identity: ProcessIdentity,
      _deadline: Deadline,
    ): Promise<ProcessTreeTerminationResult> => new Promise(() => {}));
    const responsePromise = runProcessTreeTerminationFixpoint(
      root,
      createDeadline(50),
      {
        terminateProcessTree: terminate,
        waitBeforeRetry: vi.fn(async () => true),
      },
    );

    await vi.advanceTimersByTimeAsync(50);

    await expect(responsePromise).resolves.toMatchObject({
      attempts: 0,
      result: { ok: false, status: "deadline-exceeded", root },
    });
  });
});

class FakeHelper extends EventEmitter {
  connected = true;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  disconnect = vi.fn(() => {
    this.connected = false;
  });
  unref = vi.fn();
  kill = vi.fn(() => true);
  send = vi.fn((message: unknown, callback?: (error: Error | null) => void) => {
    callback?.(null);
    const request = message as { root: ProcessIdentity };
    queueMicrotask(() => {
      this.emit("message", {
        type: PROCESS_TREE_TERMINATION_RESULT,
        attempts: 2,
        result: {
          ok: true,
          status: "terminated",
          root: request.root,
        },
      });
    });
    return true;
  });
}

describe("external process tree termination helper", () => {
  it("launches detached and accepts only the helper's explicit verified result", async () => {
    const root = identity(400);
    const helper = new FakeHelper();
    let spawnOptions: SpawnOptions | undefined;
    const spawn = vi.fn((_command: string, _args: readonly string[], options: SpawnOptions) => {
      spawnOptions = options;
      return helper as unknown as ChildProcess;
    });

    await expect(terminateProcessTreeWithExternalFixpoint(
      root,
      createDeadline(5_000),
      { command: process.execPath, args: ["helper.js"], cwd: process.cwd() },
      { spawn },
    )).resolves.toEqual({
      ok: true,
      status: "terminated",
      root,
    });

    expect(spawnOptions).toMatchObject({
      detached: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
      windowsHide: true,
    });
    expect(helper.send).toHaveBeenCalledWith({
      type: PROCESS_TREE_TERMINATION_REQUEST,
      root,
      deadlineUnixMs: expect.any(Number),
    }, expect.any(Function));
    expect(helper.disconnect).toHaveBeenCalledOnce();
    expect(helper.unref).toHaveBeenCalledOnce();
  });

  it("fails closed when the helper reports an invalid success status", async () => {
    const root = identity(500);
    const helper = new FakeHelper();
    helper.send.mockImplementation((message: unknown, callback?: (error: Error | null) => void) => {
      callback?.(null);
      const request = message as { root: ProcessIdentity };
      queueMicrotask(() => {
        helper.emit("message", {
          type: PROCESS_TREE_TERMINATION_RESULT,
          attempts: 1,
          result: {
            ok: true,
            status: "survivors",
            root: request.root,
          },
        });
        helper.emit("exit", 1, null);
      });
      return true;
    });

    await expect(terminateProcessTreeWithExternalFixpoint(
      root,
      createDeadline(5_000),
      { command: process.execPath, args: ["helper.js"], cwd: process.cwd() },
      { spawn: () => helper as unknown as ChildProcess },
    )).resolves.toMatchObject({
      ok: false,
      status: "snapshot-unavailable",
      root,
      error: expect.stringContaining("exited before reporting"),
    });
  });
});
