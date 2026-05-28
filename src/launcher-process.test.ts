import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { isChildProcessActive, resolveServerLaunchDistributionMode, waitForChildExit } from "./launcher-process.js";

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

describe("resolveServerLaunchDistributionMode", () => {
  it("preserves development mode for source launches", () => {
    expect(resolveServerLaunchDistributionMode("development", false)).toBe("development");
  });

  it("forces release mode for release-slot launches from a development launcher", () => {
    expect(resolveServerLaunchDistributionMode("development", true)).toBe("release");
  });
});

describe("waitForChildExit", () => {
  it("returns immediately when the child is already exited", async () => {
    const child = new FakeChildProcess();
    child.exitCode = 0;

    await expect(waitForChildExit(child as any, 10)).resolves.toBe(true);
  });

  it("waits for the exit event before resolving", async () => {
    const child = new FakeChildProcess();
    const wait = waitForChildExit(child as any, 100);

    child.exitCode = 0;
    child.emit("exit", 0, null);

    await expect(wait).resolves.toBe(true);
  });

  it("returns false when the child still has not exited by the timeout", async () => {
    vi.useFakeTimers();
    const child = new FakeChildProcess();
    const wait = waitForChildExit(child as any, 10);

    await vi.advanceTimersByTimeAsync(10);

    await expect(wait).resolves.toBe(false);
  });
});
