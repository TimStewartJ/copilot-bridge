import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTelemetryBatcher } from "./telemetry-batcher.js";

describe("telemetry-batcher", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("flushes when the batch size threshold is reached", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true });
    const batcher = createTelemetryBatcher({
      apiBase: "",
      fetchFn,
      maxBatchSize: 2,
      flushIntervalMs: 10_000,
      document: { addEventListener() {}, removeEventListener() {} },
      window: { addEventListener() {}, removeEventListener() {} },
    });

    batcher.enqueue({ name: "one", duration: 1 });
    batcher.enqueue({ name: "two", duration: 2 });
    await vi.runAllTimersAsync();

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchFn.mock.calls[0][1].body as string)).toEqual({
      spans: [
        expect.objectContaining({ name: "one", duration: 1, id: expect.any(String) }),
        expect.objectContaining({ name: "two", duration: 2, id: expect.any(String) }),
      ],
    });
  });

  it("flushes on the timer when the threshold is not reached", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true });
    const batcher = createTelemetryBatcher({
      apiBase: "",
      fetchFn,
      maxBatchSize: 5,
      flushIntervalMs: 100,
      document: { addEventListener() {}, removeEventListener() {} },
      window: { addEventListener() {}, removeEventListener() {} },
    });

    batcher.enqueue({ name: "slow", duration: 5 });
    await vi.advanceTimersByTimeAsync(100);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(batcher.getPendingCount()).toBe(0);
  });

  it("uses sendBeacon on pagehide-style flushes", () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true });
    const sendBeacon = vi.fn().mockReturnValue(true);
    const batcher = createTelemetryBatcher({
      apiBase: "/base",
      fetchFn,
      navigator: { sendBeacon },
      document: { addEventListener() {}, removeEventListener() {}, visibilityState: "visible" },
      window: { addEventListener() {}, removeEventListener() {} },
    });

    batcher.enqueue({ name: "hidden", duration: 7 });
    batcher.flushSync();

    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(fetchFn).not.toHaveBeenCalled();
    expect(batcher.getPendingCount()).toBe(0);
  });

  it("drains multiple batches with sendBeacon during unload", () => {
    const sendBeacon = vi.fn().mockReturnValue(true);
    const batcher = createTelemetryBatcher({
      apiBase: "/base",
      fetchFn: vi.fn().mockResolvedValue({ ok: true }),
      navigator: { sendBeacon },
      maxBatchSize: 2,
      document: { addEventListener() {}, removeEventListener() {}, visibilityState: "visible" },
      window: { addEventListener() {}, removeEventListener() {} },
    });

    batcher.enqueue({ name: "one", duration: 1 });
    batcher.enqueue({ name: "two", duration: 2 });
    batcher.enqueue({ name: "three", duration: 3 });
    batcher.enqueue({ name: "four", duration: 4 });
    batcher.enqueue({ name: "five", duration: 5 });
    batcher.flushSync();

    expect(sendBeacon).toHaveBeenCalledTimes(3);
    expect(batcher.getPendingCount()).toBe(0);
  });

  it("drains multiple batches with keepalive when sendBeacon is unavailable", () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: true });
    const batcher = createTelemetryBatcher({
      apiBase: "/base",
      fetchFn,
      maxBatchSize: 2,
      document: { addEventListener() {}, removeEventListener() {}, visibilityState: "visible" },
      window: { addEventListener() {}, removeEventListener() {} },
    });

    batcher.enqueue({ name: "one", duration: 1 });
    batcher.enqueue({ name: "two", duration: 2 });
    batcher.enqueue({ name: "three", duration: 3 });
    batcher.enqueue({ name: "four", duration: 4 });
    batcher.enqueue({ name: "five", duration: 5 });
    batcher.flushSync();

    expect(fetchFn).toHaveBeenCalledTimes(4);
    expect(fetchFn).toHaveBeenNthCalledWith(
      2,
      "/base/api/telemetry/batch",
      expect.objectContaining({ keepalive: true }),
    );
    expect(fetchFn).toHaveBeenNthCalledWith(
      3,
      "/base/api/telemetry/batch",
      expect.objectContaining({ keepalive: true }),
    );
    expect(fetchFn).toHaveBeenNthCalledWith(
      4,
      "/base/api/telemetry/batch",
      expect.objectContaining({ keepalive: true }),
    );
    expect(batcher.getPendingCount()).toBe(0);
  });

  it("requeues batches when flush fails", async () => {
    const fetchFn = vi.fn().mockRejectedValue(new Error("offline"));
    const batcher = createTelemetryBatcher({
      apiBase: "",
      fetchFn,
      maxBatchSize: 2,
      flushIntervalMs: 100,
      document: { addEventListener() {}, removeEventListener() {} },
      window: { addEventListener() {}, removeEventListener() {} },
    });

    batcher.enqueue({ name: "retry", duration: 3 });
    await vi.advanceTimersByTimeAsync(100);

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(batcher.getPendingCount()).toBe(1);
  });

  it("rescues an in-flight batch during unload", () => {
    const fetchFn = vi.fn(() => new Promise<{ ok: boolean }>(() => {}));
    const sendBeacon = vi.fn().mockReturnValue(true);
    const batcher = createTelemetryBatcher({
      apiBase: "/base",
      fetchFn,
      navigator: { sendBeacon },
      maxBatchSize: 2,
      flushTimeoutMs: 10_000,
      document: { addEventListener() {}, removeEventListener() {}, visibilityState: "visible" },
      window: { addEventListener() {}, removeEventListener() {} },
    });

    batcher.enqueue({ name: "one", duration: 1 });
    batcher.enqueue({ name: "two", duration: 2 });
    batcher.flushSync();

    expect(fetchFn).toHaveBeenCalledTimes(1);
    expect(sendBeacon).toHaveBeenCalledTimes(1);
    expect(batcher.getPendingCount()).toBe(0);
  });

  it("times out hung flushes and retries later queued spans", async () => {
    let firstSignal: AbortSignal | undefined;
    const fetchFn = vi
      .fn()
      .mockImplementationOnce((_, init?: RequestInit) => {
        firstSignal = init?.signal ?? undefined;
        return new Promise<{ ok: boolean }>(() => {});
      })
      .mockResolvedValue({ ok: true });
    const batcher = createTelemetryBatcher({
      apiBase: "",
      fetchFn,
      maxBatchSize: 2,
      flushIntervalMs: 50,
      flushTimeoutMs: 25,
      document: { addEventListener() {}, removeEventListener() {} },
      window: { addEventListener() {}, removeEventListener() {} },
    });

    batcher.enqueue({ name: "one", duration: 1 });
    batcher.enqueue({ name: "two", duration: 2 });
    await vi.advanceTimersByTimeAsync(25);
    await vi.advanceTimersByTimeAsync(50);

    expect(firstSignal?.aborted).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(batcher.getPendingCount()).toBe(0);
  });
});
