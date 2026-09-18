import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppContext } from "../app-context.js";
import { createDeadline, type Deadline } from "../deadline.js";
import {
  SERVER_SHUTDOWN_BUDGET_MS,
  shutdownAppContextServices,
} from "../app-context-shutdown.js";
import { getProcessHost, type HostChild } from "../process-host.js";
import { captureProcessIdentity, terminateProcessTree } from "../platform.js";
import {
  __testing,
  getStagingRouter,
  hasActiveStagingBackend,
  startStagingBackendProcess,
  stopAllStagingBackends,
  type ActiveStagingBackend,
} from "../staging-backend-manager.js";
import { testPath } from "./test-paths.js";

vi.mock("../platform.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../platform.js")>(),
  captureProcessIdentity: vi.fn(),
  terminateProcessTree: vi.fn(),
}));

function createBackend(pid: number): ActiveStagingBackend {
  const child: HostChild = Object.assign(new EventEmitter(), {
    pid, exitCode: null, signalCode: null, connected: true, killed: false,
    stdin: null, stdout: null, stderr: null,
    send: vi.fn(() => true), kill: vi.fn(() => true),
    disconnect: vi.fn(), ref: vi.fn(), unref: vi.fn(),
  });
  return {
    child,
    identity: Promise.resolve({ pid, startMarker: `start-${pid}` }),
    baseUrl: "http://127.0.0.1:4000", port: 4000,
    output: { output: "", truncatedChars: 0 },
    stopping: false, cleanup: vi.fn(async () => {}),
    stagingDir: testPath("staging"),
    runtimePaths: { dataDir: testPath("data"), docsDir: testPath("docs"), env: {} },
    lastAccessAt: Date.now(), inflightRequests: 0,
  };
}

beforeEach(() => {
  __testing.resetBackendState();
  vi.mocked(terminateProcessTree).mockReset();
  vi.mocked(captureProcessIdentity).mockReset();
});

afterEach(() => {
  __testing.resetBackendState();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function createShutdownSpies() {
  return {
    setGlobalPause: vi.fn(),
    schedulerShutdown: vi.fn(),
    overlayStop: vi.fn(),
    deferredPromptShutdown: vi.fn(),
    deferLoopShutdown: vi.fn(),
    usageReaderShutdown: vi.fn(async () => {}),
    searchShutdown: vi.fn(async () => {}),
    sessionManagerShutdown: vi.fn(async (_deadline?: Deadline) => {}),
    voiceShutdown: vi.fn(async () => {}),
    pushUnsubscribe: vi.fn(async () => {}),
    focusDispose: vi.fn(async () => {}),
    launchStop: vi.fn(),
    launchDrain: vi.fn(async () => {}),
    protectionStop: vi.fn(),
  };
}

function createFakeContext(spies: ReturnType<typeof createShutdownSpies>): AppContext {
  return {
    scheduler: { setGlobalPause: spies.setGlobalPause, shutdown: spies.schedulerShutdown },
    sessionOverlayMaintenance: { stop: spies.overlayStop },
    deferredPromptRunner: { shutdown: spies.deferredPromptShutdown },
    deferLoopRunner: { shutdown: spies.deferLoopShutdown },
    copilotUsageReader: { shutdown: spies.usageReaderShutdown },
    searchIndex: { shutdown: spies.searchShutdown },
    sessionManager: { gracefulShutdown: spies.sessionManagerShutdown },
    voiceJobManager: { shutdown: spies.voiceShutdown },
    stopPushEventNotifications: spies.pushUnsubscribe,
    focusNotifications: { dispose: spies.focusDispose },
    focusSessionLaunchService: { stop: spies.launchStop, drain: spies.launchDrain },
    focusProtectionStore: { stop: spies.protectionStop },
  } as unknown as AppContext;
}

describe("shutdownAppContextServices", () => {
  it("terminates all previews by captured identity before returning, preserving preview data", async () => {
    const backends = [createBackend(41001), createBackend(41002)];
    for (const backend of backends) {
      const prefix = String(backend.child.pid);
      __testing.seedActiveBackend(prefix, backend);
      __testing.seedPreviewDataDir(prefix, backend.runtimePaths.dataDir);
    }
    vi.mocked(terminateProcessTree).mockImplementation(async (root) => {
      const backend = backends.find(({ child }) => child.pid === root.pid)!;
      Object.assign(backend.child, { exitCode: 0, connected: false });
      return { ok: true, status: "terminated", root };
    });
    const deadline = createDeadline(SERVER_SHUTDOWN_BUDGET_MS);
    const ctx = createFakeContext(createShutdownSpies());
    await shutdownAppContextServices(ctx, deadline);
    await shutdownAppContextServices(ctx, deadline);

    expect(terminateProcessTree).toHaveBeenCalledTimes(2);
    for (const backend of backends) {
      expect(terminateProcessTree).toHaveBeenCalledWith(await backend.identity, deadline);
      expect(backend.child.exitCode).toBe(0);
      expect(backend.child.kill).not.toHaveBeenCalled();
      expect(hasActiveStagingBackend(String(backend.child.pid))).toBe(false);
      expect(getStagingRouter(String(backend.child.pid))).toBeUndefined();
      expect(__testing.hasPreviewDataDir(String(backend.child.pid))).toBe(true);
    }
  });

  it("owns an in-flight worker spawn and rejects new starts during shutdown", async () => {
    const backend = createBackend(41003);
    let releaseSpawn!: (child: HostChild) => void;
    const spawn = vi.spyOn(getProcessHost(), "spawn").mockReturnValue(
      new Promise<HostChild>((resolve) => { releaseSpawn = resolve; }),
    );
    vi.mocked(captureProcessIdentity).mockResolvedValue(await backend.identity);
    vi.mocked(terminateProcessTree).mockImplementation(async (root) => {
      Object.assign(backend.child, { exitCode: 0, connected: false });
      backend.child.emit("close", 0, null);
      return { ok: true, status: "terminated", root };
    });
    const start = () => startStagingBackendProcess(
      "pending", backend.stagingDir, backend.runtimePaths, "/staging/pending/api",
      { tsxLoader: "unused-mocked-loader" },
    );
    const starting = expect(start()).rejects.toThrow("Server is shutting down");
    const deadline = createDeadline(SERVER_SHUTDOWN_BUDGET_MS);
    const shutdown = shutdownAppContextServices(createFakeContext(createShutdownSpies()), deadline);
    await expect(start()).rejects.toThrow("Server is shutting down");
    releaseSpawn(backend.child);
    await Promise.all([starting, shutdown]);
    expect(spawn).toHaveBeenCalledOnce();
    expect(terminateProcessTree).toHaveBeenCalledExactlyOnceWith(await backend.identity, deadline);
    expect(backend.child.exitCode).toBe(0);
  });

  it("bounds stalled identity capture by the shared shutdown budget without a bare-PID kill", async () => {
    vi.useFakeTimers();
    const backend = createBackend(41004);
    let releaseIdentity!: (identity: null) => void;
    backend.identity = new Promise((resolve) => { releaseIdentity = resolve; });
    __testing.seedActiveBackend("stalled", backend);
    vi.mocked(captureProcessIdentity).mockResolvedValue(null);
    const shutdown = shutdownAppContextServices(createFakeContext(createShutdownSpies()));
    await vi.advanceTimersByTimeAsync(SERVER_SHUTDOWN_BUDGET_MS);
    await shutdown;
    releaseIdentity(null);
    await vi.runAllTimersAsync();
    expect(terminateProcessTree).not.toHaveBeenCalled();
    expect(backend.child.kill).not.toHaveBeenCalled();
  });

  it("bounds stalled termination by the shared shutdown deadline", async () => {
    vi.useFakeTimers();
    const backend = createBackend(41005);
    __testing.seedActiveBackend("stalled-stop", backend);
    let releaseStop!: () => void;
    vi.mocked(terminateProcessTree).mockImplementation(async (root) => {
      await new Promise<void>((resolve) => { releaseStop = resolve; });
      Object.assign(backend.child, { exitCode: 0, connected: false });
      return { ok: true, status: "terminated", root };
    });
    const deadline = createDeadline(SERVER_SHUTDOWN_BUDGET_MS);
    const shutdown = stopAllStagingBackends(deadline);
    await vi.advanceTimersByTimeAsync(SERVER_SHUTDOWN_BUDGET_MS);
    await shutdown;
    expect(terminateProcessTree).toHaveBeenCalledExactlyOnceWith(await backend.identity, deadline);
    releaseStop();
    await vi.runAllTimersAsync();
  });

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
    expect(spies.searchShutdown).toHaveBeenCalledTimes(1);
    expect(spies.sessionManagerShutdown).toHaveBeenCalledWith(deadline);
    expect(spies.voiceShutdown).toHaveBeenCalledTimes(1);
    expect(spies.schedulerShutdown).toHaveBeenCalledTimes(1);
    expect(spies.pushUnsubscribe).toHaveBeenCalledTimes(1);
    expect(spies.focusDispose).toHaveBeenCalledTimes(1);
    expect(spies.launchStop).toHaveBeenCalledTimes(1);
    expect(spies.protectionStop).toHaveBeenCalledTimes(1);
    expect(spies.protectionStop.mock.invocationCallOrder[0]).toBeLessThan(spies.sessionManagerShutdown.mock.invocationCallOrder[0]!);
    expect(spies.launchDrain).toHaveBeenCalledTimes(1);
    expect(spies.launchStop.mock.invocationCallOrder[0]).toBeLessThan(spies.sessionManagerShutdown.mock.invocationCallOrder[0]!);
    expect(spies.launchDrain.mock.invocationCallOrder[0]).toBeGreaterThan(spies.sessionManagerShutdown.mock.invocationCallOrder[0]!);
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
    spies.searchShutdown.mockRejectedValueOnce(new Error("search index boom"));
    spies.sessionManagerShutdown.mockRejectedValueOnce(new Error("session manager boom"));
    spies.voiceShutdown.mockRejectedValueOnce(new Error("voice boom"));
    spies.focusDispose.mockRejectedValueOnce(new Error("focus dispose boom"));
    spies.launchDrain.mockRejectedValueOnce(new Error("launch drain boom"));
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
