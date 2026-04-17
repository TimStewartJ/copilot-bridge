import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import { isChildProcessActive, waitForChildExit } from "./launcher-process.js";

class FakeChildProcess extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
}

describe("isChildProcessActive", () => {
  it("returns true only when the tracked child is still the active live process", () => {
    const child = new FakeChildProcess();

    expect(isChildProcessActive(child as any, child as any)).toBe(true);
    expect(isChildProcessActive(child as any, new FakeChildProcess() as any)).toBe(false);

    child.exitCode = 1;
    expect(isChildProcessActive(child as any, child as any)).toBe(false);
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

    setTimeout(() => {
      child.exitCode = 0;
      child.emit("exit", 0, null);
    }, 0);

    await expect(wait).resolves.toBe(true);
  });

  it("returns false when the child still has not exited by the timeout", async () => {
    const child = new FakeChildProcess();

    await expect(waitForChildExit(child as any, 10)).resolves.toBe(false);
  });
});
