import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeadline } from "./server/deadline.js";
import {
  attachLauncherChildErrorHandler,
  isChildProcessActive,
  LAUNCHER_STARTUP_GIT_PULL_ENV,
  resolveServerLaunchDistributionMode,
  shouldPullOnLauncherStartup,
  spawnLauncherChildIfRunning,
  waitForChildExit,
} from "./launcher-process.js";

class FakeChildProcess extends EventEmitter {
  pid: number | undefined = 123;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("isChildProcessActive", () => {
  it("returns true only when the tracked child is still the active live process", () => {
    const child = new FakeChildProcess();

    expect(isChildProcessActive(child as any, child as any)).toBe(true);
    expect(isChildProcessActive(child as any, new FakeChildProcess() as any)).toBe(false);

    child.exitCode = 1;
    expect(isChildProcessActive(child as any, child as any)).toBe(false);
  });
});

describe("resolveServerLaunchDistributionMode", () => {
  it("preserves source mode and forces release for release-slot launches", () => {
    expect(resolveServerLaunchDistributionMode("development", false), "dev source").toBe("development");
    expect(resolveServerLaunchDistributionMode("development", true), "dev + release slot").toBe("release");
    expect(resolveServerLaunchDistributionMode("release", false), "release source").toBe("release");
    expect(resolveServerLaunchDistributionMode("release", true), "release + release slot").toBe("release");
  });

  describe("shouldPullOnLauncherStartup", () => {
    it("is default-off and accepts explicit truthy values", () => {
      expect(shouldPullOnLauncherStartup({})).toBe(false);
      expect(shouldPullOnLauncherStartup({ [LAUNCHER_STARTUP_GIT_PULL_ENV]: "false" })).toBe(false);
      expect(shouldPullOnLauncherStartup({ [LAUNCHER_STARTUP_GIT_PULL_ENV]: "true" })).toBe(true);
      expect(shouldPullOnLauncherStartup({ [LAUNCHER_STARTUP_GIT_PULL_ENV]: "1" })).toBe(true);
    });
  });

  describe("spawnLauncherChildIfRunning", () => {
    it.each(["startup", "recovery"])("blocks a child spawn when shutdown begins during %s", () => {
      const spawn = vi.fn(() => ({ pid: 123 }));

      expect(spawnLauncherChildIfRunning(() => true, spawn)).toBeNull();
      expect(spawn).not.toHaveBeenCalled();
    });

    it("spawns while the launcher remains active", () => {
      const child = { pid: 123 };
      expect(spawnLauncherChildIfRunning(() => false, () => child)).toBe(child);
    });
  });

});

describe("attachLauncherChildErrorHandler", () => {
  it("handles spawn failures without leaving an unhandled error event", () => {
    const child = new FakeChildProcess();
    child.pid = undefined;
    const log = vi.fn();
    const onSpawnFailure = vi.fn();
    attachLauncherChildErrorHandler(child as any, {
      label: "Server",
      log,
      onSpawnFailure,
    });
    const error = Object.assign(new Error("spawn node ENOENT"), { code: "ENOENT" });

    expect(() => child.emit("error", error)).not.toThrow();
    expect(log).toHaveBeenCalledWith("Server process error: spawn node ENOENT");
    expect(onSpawnFailure).toHaveBeenCalledWith(error);
  });

  it("logs non-spawn child errors without starting a second recovery", () => {
    const child = new FakeChildProcess();
    const onSpawnFailure = vi.fn();
    attachLauncherChildErrorHandler(child as any, {
      label: "Server",
      log: vi.fn(),
      onSpawnFailure,
    });

    child.emit("error", new Error("kill failed"));

    expect(onSpawnFailure).not.toHaveBeenCalled();
  });
});


describe("waitForChildExit", () => {
  it("returns immediately when the child is already exited", async () => {
    const child = new FakeChildProcess();
    child.exitCode = 0;

    await expect(waitForChildExit(child as any, createDeadline(10))).resolves.toBe(true);
  });

  it("waits for the exit event before resolving", async () => {
    const child = new FakeChildProcess();
    const wait = waitForChildExit(child as any, createDeadline(100));

    child.exitCode = 0;
    child.emit("exit", 0, null);

    await expect(wait).resolves.toBe(true);
  });

  it("returns false when the child still has not exited by the timeout", async () => {
    vi.useFakeTimers();
    const child = new FakeChildProcess();
    const wait = waitForChildExit(child as any, createDeadline(10));

    await vi.advanceTimersByTimeAsync(10);

    await expect(wait).resolves.toBe(false);
  });
});
