import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildTunnelHostArgs,
  resolveTunnelName,
  TunnelSupervisor,
  type TunnelSupervisorDependencies,
} from "./launcher-tunnel-supervisor.js";
import type { ProcessIdentity, ProcessTreeTerminationResult } from "./server/platform.js";
import type { TunnelRuntimeState } from "./server/tunnel-runtime-state.js";

class FakeChild extends EventEmitter {
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid: number;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;

  constructor(pid: number) {
    super();
    this.pid = pid;
  }

  exit(code: number): void {
    this.exitCode = code;
    this.emit("exit", code, null);
  }
}

function asChild(child: FakeChild): ChildProcess {
  return child as unknown as ChildProcess;
}

function identity(pid: number): ProcessIdentity {
  return { pid, startMarker: `started-${pid}` };
}

function stopped(process: ProcessIdentity): ProcessTreeTerminationResult {
  return { ok: true, status: "terminated", root: process };
}

async function flushAsync(): Promise<void> {
  for (let index = 0; index < 8; index++) {
    await Promise.resolve();
  }
}

function createHarness(options: {
  children?: FakeChild[];
  fetchResponses?: Response[];
  state?: TunnelRuntimeState | null;
  env?: NodeJS.ProcessEnv;
  onReady?: (url: string) => void | Promise<void>;
} = {}) {
  const children = options.children ?? [new FakeChild(101)];
  const fetchResponses = [...(options.fetchResponses ?? [])];
  const writtenStates: TunnelRuntimeState[] = [];
  const logs: string[] = [];
  const readyUrls: string[] = [];
  const spawnTunnel = vi.fn(() => asChild(children.shift() ?? new FakeChild(999)));
  const terminateProcessTree = vi.fn(async (process: ProcessIdentity) => stopped(process));
  const fetchMock = vi.fn(async () => fetchResponses.shift() ?? new Response(null, { status: 200 }));
  const captureProcessIdentity = vi.fn(async (pid: number): Promise<ProcessIdentity | null> => identity(pid));
  const writeState = vi.fn((_dataDir: string, state: TunnelRuntimeState) => writtenStates.push(state));
  const clearState = vi.fn();
  const deps: TunnelSupervisorDependencies = {
    spawnTunnel,
    captureProcessIdentity,
    terminateProcessTree,
    waitForChildExit: vi.fn(async () => true),
    fetch: fetchMock as typeof fetch,
    readState: vi.fn(() => options.state ?? null),
    writeState,
    clearState,
  };
  const supervisor = new TunnelSupervisor({
    dataDir: "bridge-data",
    port: 3333,
    env: options.env ?? {},
    log: (message) => logs.push(message),
    onReady: options.onReady ?? ((url) => {
      readyUrls.push(url);
    }),
    retryBaseMs: 10,
    retryCapMs: 40,
    startupTimeoutMs: 100,
    healthIntervalMs: 50,
    healthTimeoutMs: 25,
    healthFailureThreshold: 2,
  }, deps);
  return {
    supervisor,
    deps,
    children,
    spawnTunnel,
    terminateProcessTree,
    fetchMock,
    captureProcessIdentity,
    writeState,
    clearState,
    writtenStates,
    logs,
    readyUrls,
  };
}

async function startAndPublish(
  harness: ReturnType<typeof createHarness>,
  child: FakeChild,
  url = "https://bridge.example.devtunnels.ms",
): Promise<void> {
  void harness.supervisor.start();
  vi.runOnlyPendingTimers();
  await flushAsync();
  child.stdout.write(`Connect via browser: ${url}\n`);
  await flushAsync();
}

afterEach(() => {
  vi.useRealTimers();
});

describe("TunnelSupervisor", () => {
  it("uses one stable default name and explicit host arguments", () => {
    expect(resolveTunnelName({})).toBe("copilot-bridge");
    expect(resolveTunnelName({ BRIDGE_TUNNEL_NAME: "Tim-Bridge" })).toBe("tim-bridge");
    expect(buildTunnelHostArgs("tim-bridge", 3333)).toEqual([
      "host",
      "tim-bridge",
      "--port-number",
      "3333",
    ]);
    expect(() => resolveTunnelName({ BRIDGE_TUNNEL_NAME: "bad.name" })).toThrow(
      "Invalid BRIDGE_TUNNEL_NAME",
    );
  });

  it("publishes one runtime state after the direct child reports its URL", async () => {
    vi.useFakeTimers();
    const child = new FakeChild(101);
    const harness = createHarness({ children: [child] });

    await startAndPublish(harness, child);

    expect(harness.spawnTunnel).toHaveBeenCalledWith("copilot-bridge", 3333);
    expect(harness.writtenStates).toEqual([{
      url: null,
      port: 3333,
      process: identity(101),
      updatedAt: expect.any(String),
    }, {
      url: "https://bridge.example.devtunnels.ms",
      port: 3333,
      process: identity(101),
      updatedAt: expect.any(String),
    }]);
    expect(harness.readyUrls).toEqual(["https://bridge.example.devtunnels.ms"]);
    expect(harness.supervisor.getUrl()).toBe("https://bridge.example.devtunnels.ms");
  });

  it("keeps the tunnel when the local server is unavailable", async () => {
    vi.useFakeTimers();
    const child = new FakeChild(101);
    const harness = createHarness({
      children: [child],
      fetchResponses: [new Response(null, { status: 503 })],
    });
    await startAndPublish(harness, child);

    await vi.advanceTimersByTimeAsync(50);

    expect(harness.fetchMock).toHaveBeenCalledTimes(1);
    expect(harness.terminateProcessTree).not.toHaveBeenCalled();
    expect(harness.supervisor.getUrl()).toBe("https://bridge.example.devtunnels.ms");
  });

  it("recycles only after repeated public failures while local health stays green", async () => {
    vi.useFakeTimers();
    const first = new FakeChild(101);
    const second = new FakeChild(102);
    const harness = createHarness({
      children: [first, second],
      fetchResponses: [
        new Response(null, { status: 200 }),
        new Response(null, { status: 503 }),
        new Response(null, { status: 200 }),
        new Response(null, { status: 503 }),
      ],
    });
    await startAndPublish(harness, first);

    await vi.advanceTimersByTimeAsync(50);
    expect(harness.terminateProcessTree).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(50);
    expect(harness.terminateProcessTree).toHaveBeenCalledWith(
      identity(101),
      expect.any(Object),
    );

    vi.runOnlyPendingTimers();
    await flushAsync();
    second.stdout.write("Connect via browser: https://bridge.example.devtunnels.ms\n");
    await flushAsync();
    expect(harness.spawnTunnel).toHaveBeenCalledTimes(2);
  });

  it("retries after unexpected exits without exhausting a fixed attempt budget", async () => {
    vi.useFakeTimers();
    const first = new FakeChild(101);
    const second = new FakeChild(102);
    const harness = createHarness({ children: [first, second] });
    await startAndPublish(harness, first);

    first.exit(1);
    vi.advanceTimersByTime(10);
    await flushAsync();

    expect(harness.spawnTunnel).toHaveBeenCalledTimes(2);
    second.stdout.write("Connect via browser: https://bridge.example.devtunnels.ms\n");
    await flushAsync();
    expect(harness.supervisor.getUrl()).toBe("https://bridge.example.devtunnels.ms");
  });

  it("retries after a CLI spawn error without retaining a phantom child", async () => {
    vi.useFakeTimers();
    const first = new FakeChild(101);
    const second = new FakeChild(102);
    const harness = createHarness({ children: [first, second] });
    harness.supervisor.start();
    vi.runOnlyPendingTimers();
    await flushAsync();

    first.emit("error", new Error("spawn ENOENT"));
    await flushAsync();
    vi.advanceTimersByTime(10);
    await flushAsync();
    second.stdout.write("Connect via browser: https://bridge.example.devtunnels.ms\n");
    await flushAsync();

    expect(harness.spawnTunnel).toHaveBeenCalledTimes(2);
    expect(harness.supervisor.getUrl()).toBe("https://bridge.example.devtunnels.ms");
  });

  it("does not restart a healthy tunnel when the server port is unchanged", async () => {
    vi.useFakeTimers();
    const child = new FakeChild(101);
    const harness = createHarness({ children: [child] });
    await startAndPublish(harness, child);

    harness.supervisor.updatePort(3333);
    await flushAsync();

    expect(harness.spawnTunnel).toHaveBeenCalledTimes(1);
    expect(harness.terminateProcessTree).not.toHaveBeenCalled();
  });

  it("retries replacement state publication without exposing an unpublished URL", async () => {
    vi.useFakeTimers();
    const first = new FakeChild(101);
    const second = new FakeChild(102);
    const harness = createHarness({ children: [first, second] });
    await startAndPublish(harness, first);

    harness.supervisor.updatePort(4444);
    vi.runOnlyPendingTimers();
    await flushAsync();
    await flushAsync();
    expect(harness.writeState).toHaveBeenCalledTimes(3);
    harness.writeState.mockImplementationOnce(() => {
      throw new Error("replacement state write failed");
    });
    second.stdout.write("Connect via browser: https://replacement.example.devtunnels.ms\n");
    await flushAsync();

    expect(harness.supervisor.getUrl()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(10);

    expect(harness.spawnTunnel).toHaveBeenCalledTimes(2);
    expect(harness.supervisor.getUrl()).toBe("https://replacement.example.devtunnels.ms");
  });

  it("does not announce readiness until exact state publication succeeds", async () => {
    vi.useFakeTimers();
    const child = new FakeChild(101);
    const harness = createHarness({ children: [child] });
    harness.writeState
      .mockImplementationOnce((_dataDir, state) => harness.writtenStates.push(state))
      .mockImplementationOnce(() => {
        throw new Error("state write failed");
      });

    await startAndPublish(harness, child);
    expect(harness.supervisor.getUrl()).toBeUndefined();
    expect(harness.readyUrls).toEqual([]);

    vi.advanceTimersByTime(10);
    await flushAsync();

    expect(harness.spawnTunnel).toHaveBeenCalledTimes(1);
    expect(harness.writeState).toHaveBeenCalledTimes(3);
    expect(harness.supervisor.getUrl()).toBe("https://bridge.example.devtunnels.ms");
    expect(harness.readyUrls).toEqual(["https://bridge.example.devtunnels.ms"]);
  });

  it("recaptures a missing process identity before publishing readiness", async () => {
    vi.useFakeTimers();
    const child = new FakeChild(101);
    const harness = createHarness({ children: [child] });
    harness.captureProcessIdentity
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(identity(101));

    await startAndPublish(harness, child);

    expect(harness.captureProcessIdentity).toHaveBeenCalledTimes(2);
    expect(harness.supervisor.getUrl()).toBe("https://bridge.example.devtunnels.ms");
    expect(harness.writtenStates.at(-1)?.process).toEqual(identity(101));
  });

  it("preserves the exact identity state until terminal cleanup succeeds", async () => {
    vi.useFakeTimers();
    const child = new FakeChild(101);
    const harness = createHarness({ children: [child] });
    await startAndPublish(harness, child);
    const clearsBeforeShutdown = harness.clearState.mock.calls.length;

    harness.supervisor.prepareForShutdown();
    expect(harness.clearState).toHaveBeenCalledTimes(clearsBeforeShutdown);

    harness.supervisor.finishShutdown(true);
    expect(harness.clearState).toHaveBeenCalledTimes(clearsBeforeShutdown + 1);
  });

  it("does not publish readiness when the child exits during identity capture", async () => {
    vi.useFakeTimers();
    const child = new FakeChild(101);
    let resolveIdentity: ((value: ProcessIdentity | null) => void) | undefined;
    const identityPromise = new Promise<ProcessIdentity | null>((resolve) => {
      resolveIdentity = resolve;
    });
    const harness = createHarness({ children: [child] });
    harness.captureProcessIdentity.mockImplementationOnce(() => identityPromise);
    void harness.supervisor.start();
    vi.runOnlyPendingTimers();
    await flushAsync();
    child.stdout.write("Connect via browser: https://bridge.example.devtunnels.ms\n");
    await flushAsync();

    child.exit(1);
    resolveIdentity?.(identity(101));
    await flushAsync();

    expect(harness.writeState).not.toHaveBeenCalled();
    expect(harness.readyUrls).toEqual([]);
    expect(harness.supervisor.getUrl()).toBeUndefined();
  });

  it("does not let a hung ready notification block process recovery", async () => {
    vi.useFakeTimers();
    const first = new FakeChild(101);
    const second = new FakeChild(102);
    const harness = createHarness({
      children: [first, second],
      onReady: () => new Promise<void>(() => {}),
    });
    await startAndPublish(harness, first);

    first.exit(1);
    vi.advanceTimersByTime(10);
    await flushAsync();

    expect(harness.spawnTunnel).toHaveBeenCalledTimes(2);
  });

  it("retries exact orphan cleanup before honoring disabled tunnel configuration", async () => {
    vi.useFakeTimers();
    const orphan = identity(77);
    const harness = createHarness({
      env: { BRIDGE_ENABLE_TUNNEL: "false" },
      state: {
        url: "https://old.example.devtunnels.ms",
        port: 3333,
        process: orphan,
        updatedAt: "2026-07-20T00:00:00.000Z",
      },
    });
    harness.terminateProcessTree
      .mockResolvedValueOnce({
        ok: false,
        status: "snapshot-unavailable",
        root: orphan,
      })
      .mockResolvedValueOnce(stopped(orphan));

    const start = harness.supervisor.start();
    await flushAsync();
    expect(harness.terminateProcessTree).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(10);
    await flushAsync();
    await start;

    expect(harness.terminateProcessTree).toHaveBeenCalledTimes(2);
    expect(harness.spawnTunnel).not.toHaveBeenCalled();
  });

  it("fences late startup output after timeout and retries cleanly", async () => {
    vi.useFakeTimers();
    const first = new FakeChild(101);
    const second = new FakeChild(102);
    const harness = createHarness({ children: [first, second] });
    harness.supervisor.start();
    vi.advanceTimersByTime(0);
    await flushAsync();

    vi.advanceTimersByTime(100);
    await flushAsync();
    first.stdout.write("Connect via browser: https://late.example.devtunnels.ms\n");
    await flushAsync();

    expect(harness.writtenStates).toEqual([{
      url: null,
      port: 3333,
      process: identity(101),
      updatedAt: expect.any(String),
    }]);
    expect(harness.writtenStates.some(({ url }) => url !== null)).toBe(false);
    expect(harness.terminateProcessTree).toHaveBeenCalledWith(
      identity(101),
      expect.any(Object),
    );

    vi.advanceTimersByTime(10);
    await flushAsync();
    second.stdout.write("Connect via browser: https://fresh.example.devtunnels.ms\n");
    await flushAsync();
    expect(harness.supervisor.getUrl()).toBe("https://fresh.example.devtunnels.ms");
  });

  it("cleans an exact orphan identity before starting a replacement", async () => {
    vi.useFakeTimers();
    const child = new FakeChild(102);
    const orphan = identity(77);
    const harness = createHarness({
      children: [child],
      state: {
        url: "https://old.example.devtunnels.ms",
        port: 3333,
        process: orphan,
        updatedAt: "2026-07-20T00:00:00.000Z",
      },
    });

    harness.supervisor.start();
    vi.advanceTimersByTime(0);
    await flushAsync();
    child.stdout.write("Connect via browser: https://fresh.example.devtunnels.ms\n");
    await flushAsync();

    expect(harness.terminateProcessTree).toHaveBeenCalledWith(orphan, expect.any(Object));
    expect(harness.spawnTunnel).toHaveBeenCalledTimes(1);
  });
});
