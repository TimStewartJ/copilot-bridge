import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_RPC_TIMEOUTS_MS } from "../agent-backend/rpc-timeouts.js";
import { SessionToolReadiness, SESSION_TOOL_READINESS_TIMEOUT_MS } from "../session-tool-readiness.js";

function deferred() {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

afterEach(() => vi.useRealTimers());

describe("session tool readiness", () => {
  it("uses a budget covering both sequential backend RPCs", () => {
    expect(SESSION_TOOL_READINESS_TIMEOUT_MS).toBeGreaterThan(
      AGENT_RPC_TIMEOUTS_MS["session.initializeTools"] + AGENT_RPC_TIMEOUTS_MS["session.getCurrentToolMetadata"],
    );
  });

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

  it("retains a failed result and never advertises failed initialization as ready", async () => {
    const readiness = new SessionToolReadiness();
    const session = {};
    const error = new Error("MCP discovery failed");
    const initialize = vi.fn(async () => { throw error; });
    expect(await readiness.wait(session, initialize)).toEqual({ status: "rejected", error });
    expect(await readiness.wait(session, initialize)).toEqual({ status: "rejected", error });
    expect(initialize).toHaveBeenCalledOnce();
    expect(readiness.getSnapshot(session)).toMatchObject({ state: "failed", error: error.message });
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

  it("isolates readiness by runtime handle, not reused session ID", async () => {
    const readiness = new SessionToolReadiness();
    const initialize = vi.fn(async () => undefined);
    await readiness.wait({}, initialize);
    await readiness.wait({}, initialize);
    expect(initialize).toHaveBeenCalledTimes(2);
  });
});
