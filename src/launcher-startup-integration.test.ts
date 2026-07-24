import { afterEach, describe, expect, it, vi } from "vitest";
import {
  TunnelSupervisor,
  type TunnelSupervisorDependencies,
} from "./launcher-tunnel-supervisor.js";
import type { ProcessIdentity } from "./server/platform.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("launcher tunnel startup integration", () => {
  it("does not gate server startup on disabled tunnel cleanup", async () => {
    vi.useFakeTimers();
    const orphan: ProcessIdentity = { pid: 77, startMarker: "started-77" };
    const spawnTunnel = vi.fn(() => {
      throw new Error("disabled tunnel must not spawn");
    });
    const terminateProcessTree = vi.fn(async (process: ProcessIdentity) => ({
      ok: false as const,
      status: "snapshot-unavailable" as const,
      root: process,
    }));
    const dependencies: TunnelSupervisorDependencies = {
      spawnTunnel,
      captureProcessIdentity: vi.fn(async () => null),
      terminateProcessTree,
      waitForChildExit: vi.fn(async () => true),
      fetch: vi.fn(async () => new Response(null, { status: 200 })) as typeof fetch,
      readState: vi.fn(() => ({
        url: "https://old.example.devtunnels.ms",
        port: 3333,
        process: orphan,
        updatedAt: "2026-07-20T00:00:00.000Z",
      })),
      writeState: vi.fn(),
      clearState: vi.fn(),
    };
    const supervisor = new TunnelSupervisor({
      dataDir: "bridge-data",
      port: 3333,
      env: { BRIDGE_ENABLE_TUNNEL: "false" },
      log: vi.fn(),
      retryBaseMs: 10,
      retryCapMs: 40,
    }, dependencies);
    const startServer = vi.fn();

    await (async () => {
      await supervisor.start();
      startServer();
    })();

    expect(startServer).toHaveBeenCalledOnce();
    expect(terminateProcessTree).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(0);

    expect(terminateProcessTree).toHaveBeenCalledTimes(1);
    expect(spawnTunnel).not.toHaveBeenCalled();
    supervisor.prepareForShutdown();
  });
});
