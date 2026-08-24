import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AGENT_RPC_TIMEOUTS_MS,
  AgentRpcTimeoutError,
  boundRpc,
  isAgentRpcTimeoutError,
} from "../rpc-timeouts.js";

describe("boundRpc", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolves with the operation result before the timeout", async () => {
    await expect(boundRpc("session.abort", async () => "ok")).resolves.toBe("ok");
  });

  it("rejects with AgentRpcTimeoutError and reports the timeout when the RPC never answers", async () => {
    vi.useFakeTimers();
    const onTimeout = vi.fn();
    const onError = vi.fn();
    const pending = boundRpc("session.send", () => new Promise<never>(() => {}), { onTimeout, onError });
    const rejection = expect(pending).rejects.toMatchObject({
      name: "AgentRpcTimeoutError",
      code: "AGENT_RPC_TIMEOUT",
      rpc: "session.send",
      timeoutMs: AGENT_RPC_TIMEOUTS_MS["session.send"],
    });
    await vi.advanceTimersByTimeAsync(AGENT_RPC_TIMEOUTS_MS["session.send"]);
    await rejection;
    expect(onTimeout).toHaveBeenCalledWith("session.send", AGENT_RPC_TIMEOUTS_MS["session.send"]);
    expect(onError).not.toHaveBeenCalled();
  });

  it("honours an explicit timeout and observes a late rejection without an unhandled error", async () => {
    vi.useFakeTimers();
    let rejectLate!: (error: Error) => void;
    const pending = boundRpc(
      "backend.ping",
      () => new Promise<never>((_, reject) => { rejectLate = reject; }),
      {},
      250,
    );
    const rejection = expect(pending).rejects.toBeInstanceOf(AgentRpcTimeoutError);
    await vi.advanceTimersByTimeAsync(250);
    await rejection;
    rejectLate(new Error("late"));
    await vi.advanceTimersByTimeAsync(0);
  });

  it("passes through ordinary rejections and reports them via onError", async () => {
    const onTimeout = vi.fn();
    const onError = vi.fn();
    await expect(boundRpc("session.abort", async () => { throw new Error("boom"); }, { onTimeout, onError }))
      .rejects.toThrow("boom");
    expect(onError).toHaveBeenCalledWith("session.abort", expect.any(Error));
    expect(onTimeout).not.toHaveBeenCalled();
  });

  it("recognises timeout errors by class or code", () => {
    expect(isAgentRpcTimeoutError(new AgentRpcTimeoutError("session.send", 1))).toBe(true);
    expect(isAgentRpcTimeoutError({ code: "AGENT_RPC_TIMEOUT" })).toBe(true);
    expect(isAgentRpcTimeoutError(new Error("timed out"))).toBe(false);
  });
});
