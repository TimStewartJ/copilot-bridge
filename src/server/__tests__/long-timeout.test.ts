import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_SAFE_TIMEOUT_DELAY_MS, safeSetTimeout } from "../long-timeout.js";

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-06-06T00:00:00.000Z") });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("safeSetTimeout", () => {
  it("does not fire a delay beyond Node's max before its real deadline and re-arms across multiple chunks", async () => {
    // Single extra chunk: must not fire at the Node max, fires after
    const callback1 = vi.fn();
    const delay1 = MAX_SAFE_TIMEOUT_DELAY_MS + 60_000;
    const handle = safeSetTimeout(callback1, delay1);

    await vi.advanceTimersByTimeAsync(MAX_SAFE_TIMEOUT_DELAY_MS);
    expect(callback1, "not yet (1-chunk)").not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(callback1, "fired once (1-chunk)").toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(MAX_SAFE_TIMEOUT_DELAY_MS);
    expect(callback1, "no re-fire").toHaveBeenCalledTimes(1);
    handle.cancel();

    // Three chunks: fires exactly once at the end
    const callback2 = vi.fn();
    safeSetTimeout(callback2, MAX_SAFE_TIMEOUT_DELAY_MS * 2 + 123);

    await vi.advanceTimersByTimeAsync(MAX_SAFE_TIMEOUT_DELAY_MS);
    expect(callback2, "not yet (chunk 1)").not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(MAX_SAFE_TIMEOUT_DELAY_MS);
    expect(callback2, "not yet (chunk 2)").not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(123);
    expect(callback2, "fired once (3 chunks)").toHaveBeenCalledTimes(1);
  });

  it("fires at exactly the Node max boundary in a single chunk", async () => {
    const callback = vi.fn();
    safeSetTimeout(callback, MAX_SAFE_TIMEOUT_DELAY_MS);

    await vi.advanceTimersByTimeAsync(MAX_SAFE_TIMEOUT_DELAY_MS - 1);
    expect(callback).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("fires a near-future delay exactly once", async () => {
    const callback = vi.fn();
    safeSetTimeout(callback, 60_000);

    expect(callback).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(callback).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(callback).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("fires non-finite and zero/negative delays asynchronously on the next tick", async () => {
    // Non-finite delay fires on the next tick instead of never or looping
    const callback1 = vi.fn();
    safeSetTimeout(callback1, Number.POSITIVE_INFINITY);
    await vi.advanceTimersByTimeAsync(0);
    expect(callback1, "non-finite").toHaveBeenCalledTimes(1);

    // Zero/negative delay fires asynchronously (not synchronously)
    const callback2 = vi.fn();
    safeSetTimeout(callback2, -5_000);
    expect(callback2, "negative (sync check)").not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(callback2, "negative (async tick)").toHaveBeenCalledTimes(1);
  });

  it("cancel stops a chunked long timer before it fires", async () => {
    const callback = vi.fn();
    const handle = safeSetTimeout(callback, MAX_SAFE_TIMEOUT_DELAY_MS * 2 + 5_000);

    // Cross the first chunk so the timer has re-armed at least once.
    await vi.advanceTimersByTimeAsync(MAX_SAFE_TIMEOUT_DELAY_MS);
    expect(callback).not.toHaveBeenCalled();

    handle.cancel();

    // Advancing well past the original deadline must never fire the callback.
    await vi.advanceTimersByTimeAsync(MAX_SAFE_TIMEOUT_DELAY_MS * 2);
    expect(callback).not.toHaveBeenCalled();
  });

  it("keeps firing correctly after the handle is unref'd across chunks", async () => {
    const callback = vi.fn();
    const handle = safeSetTimeout(callback, MAX_SAFE_TIMEOUT_DELAY_MS + 10_000);
    handle.unref();

    await vi.advanceTimersByTimeAsync(MAX_SAFE_TIMEOUT_DELAY_MS);
    expect(callback).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(10_000);
    expect(callback).toHaveBeenCalledTimes(1);
  });
});
