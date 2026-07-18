import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeadline } from "./server/deadline.js";
import {
  createServerRestartSafetyState,
  isChildProcessActive,
  resolveServerLaunchDistributionMode,
  spawnLauncherChildIfRunning,
  spawnServerIfRestartSafe,
  updateServerRestartSafetyAfterCleanup,
  waitForChildExit,
} from "./launcher-process.js";
import type { ProcessIdentity } from "./server/platform.js";

class FakeChildProcess extends EventEmitter {
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

describe("server restart safety after unverified cleanup", () => {
  const root: ProcessIdentity = { pid: 123, startMarker: "start-123" };

  it.each(["explicit restart", "auto-recovery"])(
    "does not spawn a replacement during %s after the root exits",
    () => {
      const safety = createServerRestartSafetyState();
      updateServerRestartSafetyAfterCleanup(safety, {
        ok: false,
        status: "unverified",
        root,
        error: "descendant containment unavailable",
      });
      const exitedRoot = new FakeChildProcess();
      exitedRoot.exitCode = 0;
      const spawn = vi.fn(() => ({ pid: 456 }));

      expect(spawnServerIfRestartSafe(safety, () => false, spawn)).toBeNull();
      expect(exitedRoot.exitCode).toBe(0);
      expect(spawn).not.toHaveBeenCalled();
    },
  );

  it("allows replacement only after a verified cleanup clears the latch", () => {
    const safety = createServerRestartSafetyState();
    updateServerRestartSafetyAfterCleanup(safety, {
      ok: false,
      status: "unverified",
      root,
    });
    updateServerRestartSafetyAfterCleanup(safety, {
      ok: true,
      status: "terminated",
      root,
      snapshot: { root, descendants: [] },
    });
    const replacement = { pid: 789 };

    expect(spawnServerIfRestartSafe(safety, () => false, () => replacement)).toBe(replacement);
  });

  it("does not clear the latch when only the captured root is already exited", () => {
    const safety = createServerRestartSafetyState();
    updateServerRestartSafetyAfterCleanup(safety, {
      ok: false,
      status: "unverified",
      root,
    });
    updateServerRestartSafetyAfterCleanup(safety, {
      ok: true,
      status: "already-exited",
      root,
    });
    const spawn = vi.fn(() => ({ pid: 789 }));

    expect(spawnServerIfRestartSafe(safety, () => false, spawn)).toBeNull();
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("resolveServerLaunchDistributionMode", () => {
  it("preserves development mode for source launches", () => {
    expect(resolveServerLaunchDistributionMode("development", false)).toBe("development");
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

  it("forces release mode for release-slot launches from a development launcher", () => {
    expect(resolveServerLaunchDistributionMode("development", true)).toBe("release");
  });

  it("preserves release mode for packaged release launches", () => {
    expect(resolveServerLaunchDistributionMode("release", false)).toBe("release");
    expect(resolveServerLaunchDistributionMode("release", true)).toBe("release");
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
