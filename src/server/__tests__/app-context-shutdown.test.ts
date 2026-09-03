import { describe, expect, it, vi } from "vitest";
import type { AppContext } from "../app-context.js";
import { createDeadline, type Deadline } from "../deadline.js";
import {
  SERVER_SHUTDOWN_BUDGET_MS,
  shutdownAppContextServices,
} from "../app-context-shutdown.js";

function createShutdownSpies() {
  return {
    setGlobalPause: vi.fn(),
    schedulerShutdown: vi.fn(),
    overlayStop: vi.fn(),
    deferredPromptShutdown: vi.fn(),
    deferLoopShutdown: vi.fn(),
    usageReaderShutdown: vi.fn(async () => {}),
    sessionManagerShutdown: vi.fn(async (_deadline?: Deadline) => {}),
    voiceShutdown: vi.fn(async () => {}),
  };
}

function createFakeContext(spies: ReturnType<typeof createShutdownSpies>): AppContext {
  return {
    scheduler: { setGlobalPause: spies.setGlobalPause, shutdown: spies.schedulerShutdown },
    sessionOverlayMaintenance: { stop: spies.overlayStop },
    deferredPromptRunner: { shutdown: spies.deferredPromptShutdown },
    deferLoopRunner: { shutdown: spies.deferLoopShutdown },
    copilotUsageReader: { shutdown: spies.usageReaderShutdown },
    sessionManager: { gracefulShutdown: spies.sessionManagerShutdown },
    voiceJobManager: { shutdown: spies.voiceShutdown },
  } as unknown as AppContext;
}

describe("shutdownAppContextServices", () => {
  it("shuts every context-owned service down once", async () => {
    const spies = createShutdownSpies();
    const ctx = createFakeContext(spies);
    const deadline = createDeadline(1_000);

    await shutdownAppContextServices(ctx, deadline);

    expect(spies.setGlobalPause).toHaveBeenCalledWith(true);
    expect(spies.overlayStop).toHaveBeenCalledTimes(1);
    expect(spies.deferredPromptShutdown).toHaveBeenCalledTimes(1);
    expect(spies.deferLoopShutdown).toHaveBeenCalledTimes(1);
    expect(spies.usageReaderShutdown).toHaveBeenCalledTimes(1);
    expect(spies.sessionManagerShutdown).toHaveBeenCalledWith(deadline);
    expect(spies.voiceShutdown).toHaveBeenCalledTimes(1);
    expect(spies.schedulerShutdown).toHaveBeenCalledTimes(1);
  });

  it("defaults to the server shutdown budget when no deadline is supplied", async () => {
    const spies = createShutdownSpies();
    const before = Date.now();

    await shutdownAppContextServices(createFakeContext(spies));

    const deadline = spies.sessionManagerShutdown.mock.calls[0]?.[0];
    expect(deadline).toBeDefined();
    expect(deadline!.expiresAtUnixMs).toBeGreaterThanOrEqual(before + SERVER_SHUTDOWN_BUDGET_MS - 50);
    expect(deadline!.expiresAtUnixMs).toBeLessThanOrEqual(Date.now() + SERVER_SHUTDOWN_BUDGET_MS);
  });

  it("is idempotent per context and reuses the in-flight operation", async () => {
    const spies = createShutdownSpies();
    const ctx = createFakeContext(spies);

    const first = shutdownAppContextServices(ctx, createDeadline(1_000));
    const second = shutdownAppContextServices(ctx, createDeadline(1_000));
    expect(second).toBe(first);

    await first;
    await shutdownAppContextServices(ctx, createDeadline(1_000));

    expect(spies.sessionManagerShutdown).toHaveBeenCalledTimes(1);
    expect(spies.voiceShutdown).toHaveBeenCalledTimes(1);
    expect(spies.schedulerShutdown).toHaveBeenCalledTimes(1);
  });

  it("keeps shutting services down when one of them rejects", async () => {
    const spies = createShutdownSpies();
    spies.usageReaderShutdown.mockRejectedValueOnce(new Error("usage reader boom"));
    spies.sessionManagerShutdown.mockRejectedValueOnce(new Error("session manager boom"));
    spies.voiceShutdown.mockRejectedValueOnce(new Error("voice boom"));
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    const ctx = createFakeContext(spies);

    await expect(shutdownAppContextServices(ctx, createDeadline(1_000))).resolves.toBeUndefined();

    expect(spies.voiceShutdown).toHaveBeenCalledTimes(1);
    expect(spies.schedulerShutdown).toHaveBeenCalledTimes(1);
    consoleError.mockRestore();
  });

  it("tracks shutdown state per context, not globally", async () => {
    const firstSpies = createShutdownSpies();
    const secondSpies = createShutdownSpies();

    await shutdownAppContextServices(createFakeContext(firstSpies), createDeadline(1_000));
    await shutdownAppContextServices(createFakeContext(secondSpies), createDeadline(1_000));

    expect(firstSpies.schedulerShutdown).toHaveBeenCalledTimes(1);
    expect(secondSpies.schedulerShutdown).toHaveBeenCalledTimes(1);
  });

  it("exposes the server shutdown budget", () => {
    expect(SERVER_SHUTDOWN_BUDGET_MS).toBe(13_000);
  });
});
