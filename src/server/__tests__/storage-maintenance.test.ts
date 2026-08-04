import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createStorageMaintenance } from "../storage-maintenance.js";
import { setupTestDb } from "./helpers.js";
import { createTelemetryStore } from "../telemetry-store.js";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("storage maintenance", () => {
  it("keeps sweeping on the interval rather than only at startup", async () => {
    const pruneTelemetrySpans = vi.fn();
    const pruneLogArtifacts = vi.fn(async () => {});
    const maintenance = createStorageMaintenance({
      pruneTelemetrySpans,
      pruneLogArtifacts,
      intervalMs: 1000,
    });

    await maintenance.runOnce();
    expect(pruneTelemetrySpans).toHaveBeenCalledTimes(1);
    expect(pruneLogArtifacts).toHaveBeenCalledTimes(1);

    maintenance.start();
    await vi.advanceTimersByTimeAsync(3000);
    expect(pruneTelemetrySpans).toHaveBeenCalledTimes(4);
    expect(pruneLogArtifacts).toHaveBeenCalledTimes(4);

    maintenance.stop();
    await vi.advanceTimersByTimeAsync(3000);
    expect(pruneTelemetrySpans).toHaveBeenCalledTimes(4);
  });

  it("unrefs its timer so it cannot hold the process open", () => {
    const unref = vi.fn();
    const fakeTimer = { unref } as unknown as ReturnType<typeof setInterval>;
    const setIntervalFn = vi.fn(() => fakeTimer) as unknown as typeof setInterval;
    const maintenance = createStorageMaintenance({
      pruneTelemetrySpans: () => {},
      pruneLogArtifacts: async () => {},
      intervalMs: 1000,
      setIntervalFn,
      clearIntervalFn: vi.fn() as unknown as typeof clearInterval,
    });

    maintenance.start();
    expect(unref).toHaveBeenCalledTimes(1);
    // start() is idempotent — a second call must not leak another timer.
    maintenance.start();
    expect(setIntervalFn).toHaveBeenCalledTimes(1);
  });

  it("keeps sweeping after a failing prune", async () => {
    const pruneTelemetrySpans = vi.fn(() => { throw new Error("telemetry boom"); });
    const pruneLogArtifacts = vi.fn(async () => { throw new Error("logs boom"); });
    vi.spyOn(console, "error").mockImplementation(() => {});
    const maintenance = createStorageMaintenance({
      pruneTelemetrySpans,
      pruneLogArtifacts,
      intervalMs: 1000,
    });

    await expect(maintenance.runOnce()).resolves.toBeUndefined();
    maintenance.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(pruneTelemetrySpans).toHaveBeenCalledTimes(3);
    expect(pruneLogArtifacts).toHaveBeenCalledTimes(3);
    maintenance.stop();
  });

  it("does not stack sweeps when one is still running", async () => {
    let resolveSweep: (() => void) | undefined;
    const pruneLogArtifacts = vi.fn(() => new Promise<void>((resolve) => { resolveSweep = resolve; }));
    const maintenance = createStorageMaintenance({
      pruneTelemetrySpans: () => {},
      pruneLogArtifacts,
      intervalMs: 1000,
    });

    maintenance.start();
    await vi.advanceTimersByTimeAsync(3000);
    expect(pruneLogArtifacts).toHaveBeenCalledTimes(1);

    resolveSweep!();
    await vi.advanceTimersByTimeAsync(1000);
    expect(pruneLogArtifacts).toHaveBeenCalledTimes(2);
    maintenance.stop();
  });

  it("actually bounds telemetry spans when wired to the store", async () => {
    const db = setupTestDb();
    const telemetryStore = createTelemetryStore(db);
    const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    telemetryStore.recordSpan({ name: "fresh", duration: 1, source: "server" });
    db.prepare("UPDATE telemetry_spans SET createdAt = ?").run(old);
    telemetryStore.recordSpan({ name: "fresh-2", duration: 1, source: "server" });

    const maintenance = createStorageMaintenance({
      pruneTelemetrySpans: () => { telemetryStore.pruneOldSpans(7); },
      pruneLogArtifacts: async () => {},
      intervalMs: 1000,
    });
    await maintenance.runOnce();

    expect(telemetryStore.querySpans({}).map((span) => span.name)).toEqual(["fresh-2"]);
    db.close();
  });
});
