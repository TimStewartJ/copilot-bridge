import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_SAFE_TIMEOUT_DELAY_MS, safeSetTimeout } from "../long-timeout.js";

beforeEach(() => {
  vi.useFakeTimers({ now: new Date("2026-06-06T00:00:00.000Z") });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("safeSetTimeout", () => {
  it("does not fire a delay beyond Node's max before its real deadline and fires once at it", async () => {
    const callback = vi.fn();
    const delay = MAX_SAFE_TIMEOUT_DELAY_MS + 60_000; // > 24.8 days
    const handle = safeSetTimeout(callback, delay);

    // Advancing exactly to the first chunk boundary must not fire the callback.
    // A raw setTimeout(callback, delay) would have fired ~immediately here.
    await vi.advanceTimersByTimeAsync(MAX_SAFE_TIMEOUT_DELAY_MS);
    expect(callback).not.toHaveBeenCalled();

    // Advancing the remaining time across the chunk boundary fires exactly once.
    await vi.advanceTimersByTimeAsync(60_000);
    expect(callback).toHaveBeenCalledTimes(1);

    // It does not re-fire afterwards.
    await vi.advanceTimersByTimeAsync(MAX_SAFE_TIMEOUT_DELAY_MS);
    expect(callback).toHaveBeenCalledTimes(1);
    handle.cancel();
  });

  it("fires at exactly the Node max boundary in a single chunk", async () => {
    const callback = vi.fn();
    safeSetTimeout(callback, MAX_SAFE_TIMEOUT_DELAY_MS);

    await vi.advanceTimersByTimeAsync(MAX_SAFE_TIMEOUT_DELAY_MS - 1);
    expect(callback).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("re-arms across three chunks for very long delays and fires once", async () => {
    const callback = vi.fn();
    const delay = MAX_SAFE_TIMEOUT_DELAY_MS * 2 + 123;
    safeSetTimeout(callback, delay);

    await vi.advanceTimersByTimeAsync(MAX_SAFE_TIMEOUT_DELAY_MS);
    expect(callback).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(MAX_SAFE_TIMEOUT_DELAY_MS);
    expect(callback).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(123);
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

  it("fires a non-finite delay on the next tick instead of never or looping", async () => {
    const callback = vi.fn();
    safeSetTimeout(callback, Number.POSITIVE_INFINITY);

    await vi.advanceTimersByTimeAsync(0);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("fires a zero/negative delay asynchronously on the next tick, not synchronously", async () => {
    const callback = vi.fn();
    safeSetTimeout(callback, -5_000);
    expect(callback).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(0);
    expect(callback).toHaveBeenCalledTimes(1);
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
