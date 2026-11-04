import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionToolReadiness } from "../session-tool-readiness.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

afterEach(() => vi.useRealTimers());

describe("session tool readiness", () => {
  it("shares initialization and reports slow discovery without rejecting either waiter", async () => {
    vi.useFakeTimers();
    const readiness = new SessionToolReadiness();
    const session = {};
    const gate = deferred();
    const initialize = vi.fn(() => gate.promise);
    const onSlow = vi.fn();
    const first = readiness.wait(session, initialize, { onSlow });
    const second = readiness.wait(session, initialize, { onSlow });
    await vi.advanceTimersByTimeAsync(35_000);
    expect(initialize).toHaveBeenCalledOnce();
    expect(onSlow).toHaveBeenCalledOnce();
    expect(readiness.getSnapshot(session)?.state).toBe("initializing");
    gate.resolve();
    expect(await first).toEqual({ status: "fulfilled", value: undefined });
    expect(await second).toEqual({ status: "fulfilled", value: undefined });
    expect(readiness.getSnapshot(session)?.state).toBe("ready");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("observes late settlement after a bounded wait without initializing twice", async () => {
    vi.useFakeTimers();
    const readiness = new SessionToolReadiness();
    const session = {};
    const gate = deferred();
    const initialize = vi.fn(() => gate.promise);
    const wait = readiness.wait(session, initialize, { timeoutMs: 100 });
    await vi.advanceTimersByTimeAsync(100);
    expect(await wait).toEqual({ status: "timed-out" });
    expect(readiness.getSnapshot(session)?.state).toBe("initializing");
    gate.resolve();
    expect(await readiness.wait(session, initialize)).toEqual({ status: "fulfilled", value: undefined });
    expect(initialize).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
