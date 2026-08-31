import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildTunnelHostArgs,
  isTunnelAuthRedirect,
  parseTunnelHostConnections,
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
  healthTimeoutMs?: number;
  healthSlowMs?: number;
  hostConnections?: Array<number | null>;
  hostRecoveryGraceMs?: number;
  terminateDelayMs?: number;
} = {}) {
  const children = options.children ?? [new FakeChild(101)];
  const fetchResponses = [...(options.fetchResponses ?? [])];
  const hostConnections = [...(options.hostConnections ?? [])];
  const writtenStates: TunnelRuntimeState[] = [];
  const logs: string[] = [];
  const readyUrls: string[] = [];
  const spawnTunnel = vi.fn(() => asChild(children.shift() ?? new FakeChild(999)));
  const terminateProcessTree = vi.fn(async (process: ProcessIdentity) => {
    if (options.terminateDelayMs) {
      await new Promise((resolve) => setTimeout(resolve, options.terminateDelayMs));
    }
    return stopped(process);
  });
  const fetchMock = vi.fn(async () => fetchResponses.shift() ?? new Response(null, { status: 200 }));
  const inspectTunnelHost = vi.fn(async () => {
    const next = hostConnections.length > 0 ? hostConnections.shift() : 1;
    return next === null
      ? { hostConnections: null, detail: "status unavailable" }
      : { hostConnections: next ?? 1 };
  });
  const captureProcessIdentity = vi.fn(async (pid: number): Promise<ProcessIdentity | null> => identity(pid));
  const writeState = vi.fn((_dataDir: string, state: TunnelRuntimeState) => writtenStates.push(state));
  const clearState = vi.fn();
  const deps: TunnelSupervisorDependencies = {
    spawnTunnel,
    captureProcessIdentity,
    terminateProcessTree,
    waitForChildExit: vi.fn(async () => true),
    fetch: fetchMock as typeof fetch,
    inspectTunnelHost,
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
    healthTimeoutMs: options.healthTimeoutMs ?? 25,
    healthFailureThreshold: 2,
    hostRecoveryGraceMs: options.hostRecoveryGraceMs ?? 20,
    ...(options.healthSlowMs !== undefined ? { healthSlowMs: options.healthSlowMs } : {}),
  }, deps);
  return {
    supervisor,
    deps,
    children,
    spawnTunnel,
    terminateProcessTree,
    fetchMock,
    inspectTunnelHost,
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
  it("uses one stable default name without mutating persistent tunnel ports", () => {
    expect(resolveTunnelName({})).toBe("copilot-bridge");
    expect(resolveTunnelName({ BRIDGE_TUNNEL_NAME: "Tim-Bridge" })).toBe("tim-bridge");
    expect(buildTunnelHostArgs("tim-bridge", 3333)).toEqual([
      "host",
      "tim-bridge",
    ]);
    expect(() => resolveTunnelName({ BRIDGE_TUNNEL_NAME: "bad.name" })).toThrow(
      "Invalid BRIDGE_TUNNEL_NAME",
    );
  });

  it("recognizes only the Dev Tunnels relay sign-in redirect", () => {
    const signIn = "https://global.rel.tunnels.api.visualstudio.com/auth/aad?pb=https%3A%2F%2Fx-3333.usw3.devtunnels.ms%2Fauth%2Fpostback%2Faad%3Frd%3D%252Fapi%252Fhealth";
    expect(isTunnelAuthRedirect(302, signIn)).toBe(true);
    expect(isTunnelAuthRedirect(307, "https://usw3.rel.tunnels.api.visualstudio.com/auth/github")).toBe(true);
    expect(isTunnelAuthRedirect(200, signIn)).toBe(false);
    expect(isTunnelAuthRedirect(302, null)).toBe(false);
    expect(isTunnelAuthRedirect(302, "not a url")).toBe(false);
    expect(isTunnelAuthRedirect(302, "http://global.rel.tunnels.api.visualstudio.com/auth/aad")).toBe(false);
    expect(isTunnelAuthRedirect(302, "https://evil.example.com/auth/aad")).toBe(false);
    expect(isTunnelAuthRedirect(302, "https://rel.tunnels.api.visualstudio.com.evil.example/auth/aad")).toBe(false);
    expect(isTunnelAuthRedirect(302, "https://global.rel.tunnels.api.visualstudio.com/somewhere")).toBe(false);
  });

  it("parses the authoritative host connection count from Dev Tunnel JSON", () => {
    expect(parseTunnelHostConnections('{"tunnel":{"hostConnections":1}}')).toBe(1);
    expect(parseTunnelHostConnections('{"tunnel":{"hostConnections":0}}')).toBe(0);
    expect(() => parseTunnelHostConnections('{"tunnel":{}}')).toThrow(
      "missing or invalid tunnel.hostConnections",
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

  it("recycles when failures alternate with passing probes inside the sliding window", async () => {
    vi.useFakeTimers();
    const first = new FakeChild(101);
    const second = new FakeChild(102);
    // Each probe cycle is local then public. Public: fail, pass, fail. A strictly
    // consecutive counter would reset on the pass and never recycle.
    const harness = createHarness({
      children: [first, second],
      fetchResponses: [
        new Response(null, { status: 200 }),
        new Response(null, { status: 503 }),
        new Response(null, { status: 200 }),
        new Response(null, { status: 200 }),
        new Response(null, { status: 200 }),
        new Response(null, { status: 503 }),
      ],
    });
    await startAndPublish(harness, first);

    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(50);
    expect(harness.terminateProcessTree).not.toHaveBeenCalled();
    expect(harness.logs).toContain(
      "[tunnel] Public health check failed (1/2 in last 1): HTTP 503",
    );

    await vi.advanceTimersByTimeAsync(50);
    expect(harness.terminateProcessTree).toHaveBeenCalledWith(identity(101), expect.any(Object));
    expect(harness.logs).toContain(
      "[tunnel] Public health check failed (2/2 in last 3): HTTP 503",
    );
  });

  it("does not recycle when old failures have aged out of the window", async () => {
    vi.useFakeTimers();
    const first = new FakeChild(101);
    // Window is max(threshold=2, 5) = 5 observations. fail, pass x5, fail => the
    // first failure has aged out, so only 1/2 failures are in the window.
    const responses: Response[] = [
      new Response(null, { status: 200 }),
      new Response(null, { status: 503 }),
    ];
    for (let index = 0; index < 5; index++) {
      responses.push(new Response(null, { status: 200 }), new Response(null, { status: 200 }));
    }
    responses.push(new Response(null, { status: 200 }), new Response(null, { status: 503 }));
    const harness = createHarness({ children: [first], fetchResponses: responses });
    await startAndPublish(harness, first);

    for (let index = 0; index < 7; index++) {
      await vi.advanceTimersByTimeAsync(50);
    }

    expect(harness.terminateProcessTree).not.toHaveBeenCalled();
    expect(harness.logs).toContain(
      "[tunnel] Public health check failed (1/2 in last 5): HTTP 503",
    );
  });

  it("treats a slow public probe as a failure while the local server answers promptly", async () => {
    vi.useFakeTimers();
    const first = new FakeChild(101);
    const second = new FakeChild(102);
    const harness = createHarness({ children: [first, second], healthTimeoutMs: 10_000, healthSlowMs: 3_000 });
    // Public probes succeed but take longer than healthSlowMs; local is instant.
    harness.deps.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("http://127.0.0.1:")) return new Response(null, { status: 200 });
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      return new Response(null, { status: 200 });
    }) as typeof fetch;
    await startAndPublish(harness, first);

    await vi.advanceTimersByTimeAsync(50 + 4_000);
    expect(harness.terminateProcessTree).not.toHaveBeenCalled();
    expect(harness.logs.some((line) => /failed \(1\/2 in last 1\): slow: 4000ms \(local 0ms\)/.test(line))).toBe(true);

    await vi.advanceTimersByTimeAsync(50 + 4_000);
    expect(harness.terminateProcessTree).toHaveBeenCalledWith(identity(101), expect.any(Object));
  });

  it("treats the relay sign-in redirect of an access-controlled tunnel as healthy", async () => {
    vi.useFakeTimers();
    const first = new FakeChild(101);
    const harness = createHarness({ children: [first] });
    const authRedirect = () => new Response(null, {
      status: 302,
      headers: {
        location: "https://global.rel.tunnels.api.visualstudio.com/auth/aad?pb=https%3A%2F%2Fbridge.example.devtunnels.ms%2Fauth%2Fpostback%2Faad",
      },
    });
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith("http://127.0.0.1:")) return new Response(null, { status: 200 });
      expect(init?.redirect).toBe("manual");
      return authRedirect();
    });
    harness.deps.fetch = fetchMock as typeof fetch;
    await startAndPublish(harness, first);

    for (let index = 0; index < 4; index++) {
      await vi.advanceTimersByTimeAsync(50);
    }

    expect(fetchMock.mock.calls.filter(([input]) => String(input).startsWith("https://")).length).toBeGreaterThanOrEqual(3);
    expect(harness.inspectTunnelHost).toHaveBeenCalledWith("copilot-bridge", 25);
    expect(harness.terminateProcessTree).not.toHaveBeenCalled();
    expect(harness.logs.some((line) => line.includes("Public health check failed"))).toBe(false);
    expect(harness.logs.filter((line) => line.includes("access-controlled"))).toHaveLength(1);
  });

  it("still counts a slow sign-in redirect and other redirects as failures", async () => {
    vi.useFakeTimers();
    const first = new FakeChild(101);
    const second = new FakeChild(102);
    const harness = createHarness({ children: [first, second], healthTimeoutMs: 10_000, healthSlowMs: 3_000 });
    let publicCalls = 0;
    harness.deps.fetch = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.startsWith("http://127.0.0.1:")) return new Response(null, { status: 200 });
      publicCalls += 1;
      if (publicCalls === 1) {
        // Redirect somewhere that is not the relay sign-in page: not a health signal.
        return new Response(null, { status: 302, headers: { location: "https://example.com/elsewhere" } });
      }
      await new Promise((resolve) => setTimeout(resolve, 4_000));
      return new Response(null, { status: 302, headers: { location: "https://global.rel.tunnels.api.visualstudio.com/auth/aad" } });
    }) as typeof fetch;
    await startAndPublish(harness, first);

    await vi.advanceTimersByTimeAsync(50);
    expect(harness.logs).toContain("[tunnel] Public health check failed (1/2 in last 1): HTTP 302");

    await vi.advanceTimersByTimeAsync(50 + 4_000);
    expect(harness.logs.some((line) => /failed \(2\/2 in last 2\): slow: 4000ms \(local 0ms\)/.test(line))).toBe(true);
    expect(harness.terminateProcessTree).toHaveBeenCalledWith(identity(101), expect.any(Object));
  });

  it("recycles when zero host connections persist through the recovery grace period", async () => {
    vi.useFakeTimers();
    const first = new FakeChild(101);
    const second = new FakeChild(102);
    const harness = createHarness({
      children: [first, second],
      hostConnections: [0, 0],
      hostRecoveryGraceMs: 20,
    });
    await startAndPublish(harness, first);

    await vi.advanceTimersByTimeAsync(50);
    expect(harness.terminateProcessTree).not.toHaveBeenCalled();
    expect(harness.logs).toContain(
      "[tunnel] Dev Tunnel reports zero host connections; checking again in 20ms",
    );

    await vi.advanceTimersByTimeAsync(20);
    await flushAsync();
    expect(harness.terminateProcessTree).toHaveBeenCalledWith(identity(101), expect.any(Object));
    await vi.runOnlyPendingTimersAsync();
    await flushAsync();
    expect(harness.spawnTunnel).toHaveBeenCalledTimes(2);

    second.stdout.write("Connect via browser: https://bridge.example.devtunnels.ms\n");
    await flushAsync();
    expect(harness.supervisor.getUrl()).toBe("https://bridge.example.devtunnels.ms");
  });

  it("keeps the current host when its connection recovers during the grace period", async () => {
    vi.useFakeTimers();
    const child = new FakeChild(101);
    const harness = createHarness({
      children: [child],
      hostConnections: [0, 1],
      hostRecoveryGraceMs: 20,
    });
    await startAndPublish(harness, child);

    await vi.advanceTimersByTimeAsync(50);
    expect(harness.terminateProcessTree).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(20);
    await flushAsync();

    expect(harness.terminateProcessTree).not.toHaveBeenCalled();
    expect(harness.spawnTunnel).toHaveBeenCalledTimes(1);
    expect(harness.logs).toContain("[tunnel] Relay host connection recovered during the grace period");
  });

  it("preserves the disconnect grace period across a local health failure", async () => {
    vi.useFakeTimers();
    const first = new FakeChild(101);
    const second = new FakeChild(102);
    const harness = createHarness({
      children: [first, second],
      hostConnections: [0, 0],
      hostRecoveryGraceMs: 20,
      fetchResponses: [
        new Response(null, { status: 200 }),
        new Response(null, { status: 503 }),
        new Response(null, { status: 200 }),
      ],
    });
    await startAndPublish(harness, first);

    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(20);
    expect(harness.terminateProcessTree).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(50);
    await flushAsync();

    expect(harness.terminateProcessTree).toHaveBeenCalledWith(identity(101), expect.any(Object));
  });

  it("recycles after the grace period when host recovery cannot be confirmed", async () => {
    vi.useFakeTimers();
    const first = new FakeChild(101);
    const second = new FakeChild(102);
    const harness = createHarness({
      children: [first, second],
      hostConnections: [0, null],
      hostRecoveryGraceMs: 20,
    });
    await startAndPublish(harness, first);

    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(20);
    await flushAsync();

    expect(harness.inspectTunnelHost).toHaveBeenCalledTimes(2);
    expect(harness.fetchMock).toHaveBeenCalledTimes(2);
    expect(harness.terminateProcessTree).toHaveBeenCalledWith(identity(101), expect.any(Object));
  });

  it("uses split CLI error output only to wake an authoritative host status check", async () => {
    vi.useFakeTimers();
    const first = new FakeChild(101);
    const second = new FakeChild(102);
    const harness = createHarness({
      children: [first, second],
      hostConnections: [0, 0],
      hostRecoveryGraceMs: 20,
    });
    await startAndPublish(harness, first);

    first.stderr.write("Error connecting host tunnel ses");
    first.stderr.write("sion: Refreshed tunnel access token is not valid.\n");
    await flushAsync();
    await vi.advanceTimersByTimeAsync(0);
    await flushAsync();

    expect(harness.inspectTunnelHost).toHaveBeenCalledTimes(1);
    expect(harness.terminateProcessTree).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(20);
    await flushAsync();

    expect(harness.inspectTunnelHost).toHaveBeenCalledTimes(2);
    expect(harness.terminateProcessTree).toHaveBeenCalledWith(identity(101), expect.any(Object));
  });

  it("does not let status hints from a stopping child affect its replacement", async () => {
    vi.useFakeTimers();
    const first = new FakeChild(101);
    const second = new FakeChild(102);
    const harness = createHarness({
      children: [first, second],
      hostConnections: [0, 0],
      hostRecoveryGraceMs: 20,
      terminateDelayMs: 30,
    });
    await startAndPublish(harness, first);

    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(20);
    expect(harness.terminateProcessTree).toHaveBeenCalledTimes(1);

    first.stderr.write(
      "Error connecting host tunnel session: Refreshed tunnel access token is not valid.\n",
    );
    await flushAsync();
    await vi.advanceTimersByTimeAsync(30);
    await flushAsync();
    await vi.runOnlyPendingTimersAsync();
    await flushAsync();

    second.stdout.write("Connect via browser: https://bridge.example.devtunnels.ms\n");
    await flushAsync();

    expect(harness.terminateProcessTree).toHaveBeenCalledTimes(1);
    expect(harness.spawnTunnel).toHaveBeenCalledTimes(2);
    expect(harness.supervisor.getUrl()).toBe("https://bridge.example.devtunnels.ms");
  });

  it("falls back to the public probe when host status cannot be inspected", async () => {
    vi.useFakeTimers();
    const child = new FakeChild(101);
    const harness = createHarness({
      children: [child],
      hostConnections: [null, null],
    });
    await startAndPublish(harness, child);

    await vi.advanceTimersByTimeAsync(50);
    await vi.advanceTimersByTimeAsync(50);

    expect(harness.fetchMock).toHaveBeenCalledTimes(4);
    expect(harness.terminateProcessTree).not.toHaveBeenCalled();
    expect(harness.logs.filter((line) => line.includes("Unable to verify relay host connections"))).toHaveLength(1);
  });

  it("ignores status hints from a child that is no longer current", async () => {
    vi.useFakeTimers();
    const first = new FakeChild(101);
    const second = new FakeChild(102);
    const harness = createHarness({ children: [first, second] });
    await startAndPublish(harness, first);
    first.exit(1);
    await flushAsync();

    first.stderr.write("ClientSSH: Session closed unexpectedly due to ProtocolError\n");
    await flushAsync();

    expect(harness.inspectTunnelHost).not.toHaveBeenCalled();
    expect(harness.terminateProcessTree).not.toHaveBeenCalled();
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

  it("resolves disabled startup before persistent exact orphan cleanup retries", async () => {
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
    harness.terminateProcessTree.mockResolvedValue({
      ok: false,
      status: "snapshot-unavailable",
      root: orphan,
    });

    const start = harness.supervisor.start();
    await expect(start).resolves.toBeUndefined();

    expect(harness.terminateProcessTree).not.toHaveBeenCalled();
    expect(harness.spawnTunnel).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(0);
    expect(harness.terminateProcessTree).toHaveBeenCalledTimes(1);
    expect(harness.logs).toContain("[tunnel] Disabled by BRIDGE_ENABLE_TUNNEL");
    expect(harness.logs).toContain("[tunnel] Previous tunnel cleanup failed: snapshot-unavailable");
    expect(harness.logs).toContain("[tunnel] Retrying in 0.01s");

    await vi.advanceTimersByTimeAsync(10);
    expect(harness.terminateProcessTree).toHaveBeenCalledTimes(2);

    const cleanupAttempts = harness.terminateProcessTree.mock.calls.length;
    harness.supervisor.prepareForShutdown();
    await vi.advanceTimersByTimeAsync(100);

    expect(harness.terminateProcessTree).toHaveBeenCalledTimes(cleanupAttempts);
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
