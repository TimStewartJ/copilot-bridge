import { execFile, spawn, type ChildProcess } from "node:child_process";
import {
  captureProcessIdentity,
  PROCESS_TREE_TERMINATION_BUDGET_MS,
  terminateProcessTree,
  type ProcessIdentity,
  type ProcessTreeTerminationResult,
} from "./server/platform.js";
import { createDeadline, type Deadline } from "./server/deadline.js";
import {
  clearTunnelRuntimeState,
  readTunnelRuntimeState,
  writeTunnelRuntimeState,
  type TunnelRuntimeState,
} from "./server/tunnel-runtime-state.js";
import {
  stopLauncherChild,
  type LauncherChild,
  type LauncherChildStopOutcome,
} from "./launcher-exit.js";
import { waitForChildExit } from "./launcher-process.js";

const DEFAULT_TUNNEL_NAME = "copilot-bridge";
const TUNNEL_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{1,58}[a-z0-9])$/;
const RETRY_BASE_MS = 5_000;
const RETRY_CAP_MS = 60_000;
const STARTUP_TIMEOUT_MS = 60_000;
const HEALTH_INTERVAL_MS = 60_000;
const HEALTH_TIMEOUT_MS = 10_000;
const HEALTH_FAILURE_THRESHOLD = 3;
/**
 * Failures are counted over the most recent probes, not only consecutively. A
 * degraded relay session tends to alternate slow/failed and passing probes, so a
 * strictly consecutive count can sit at 1/3 or 2/3 for hours without recycling.
 */
const HEALTH_FAILURE_WINDOW = 5;
/**
 * A public probe that succeeds but takes this long while the local server answers
 * promptly is the leading indicator of a bad relay session and counts as a failure.
 */
const HEALTH_SLOW_MS = 3_000;
const HOST_RECOVERY_GRACE_MS = 15_000;
const IDENTITY_CAPTURE_TIMEOUT_MS = 10_000;

const HOST_STATUS_WAKE_RE =
  /ClientSSH: Session closed unexpectedly|Error running client SSH session|Error connecting host tunnel session/i;
/**
 * An access-controlled tunnel answers unauthenticated requests with a redirect to the
 * Dev Tunnels sign-in page even when the host connection is unavailable. The redirect
 * only proves the authentication front door is reachable; host connectivity is checked
 * separately through `devtunnel show`.
 */
const TUNNEL_AUTH_REDIRECT_HOST_RE = /(?:^|\.)rel\.tunnels\.api\.visualstudio\.com$/i;
const TUNNEL_AUTH_REDIRECT_PATH_RE = /^\/auth(?:\/|$)/i;

type ProbeResult = {
  healthy: boolean;
  durationMs: number;
  detail?: string;
};

type HealthObservation = {
  failed: boolean;
  durationMs: number;
  detail?: string;
};

export type TunnelHostStatus = {
  hostConnections: number | null;
  detail?: string;
};

export function isTunnelAuthRedirect(status: number, location: string | null | undefined): boolean {
  if (status !== 301 && status !== 302 && status !== 303 && status !== 307 && status !== 308) return false;
  if (!location) return false;
  try {
    const target = new URL(location);
    return target.protocol === "https:"
      && TUNNEL_AUTH_REDIRECT_HOST_RE.test(target.hostname)
      && TUNNEL_AUTH_REDIRECT_PATH_RE.test(target.pathname);
  } catch {
    return false;
  }
}

export type TunnelSupervisorOptions = {
  dataDir: string;
  port: number;
  env?: NodeJS.ProcessEnv;
  log: (message: string) => void;
  onReady?: (url: string) => void | Promise<void>;
  retryBaseMs?: number;
  retryCapMs?: number;
  startupTimeoutMs?: number;
  healthIntervalMs?: number;
  healthTimeoutMs?: number;
  healthFailureThreshold?: number;
  healthFailureWindow?: number;
  healthSlowMs?: number;
  hostRecoveryGraceMs?: number;
};

export type TunnelSupervisorDependencies = {
  spawnTunnel: (name: string, port: number) => ChildProcess;
  captureProcessIdentity: (pid: number, deadline: Deadline) => Promise<ProcessIdentity | null>;
  terminateProcessTree: (
    identity: ProcessIdentity,
    deadline: Deadline,
  ) => Promise<ProcessTreeTerminationResult>;
  waitForChildExit: typeof waitForChildExit;
  fetch: typeof fetch;
  inspectTunnelHost: (name: string, timeoutMs: number) => Promise<TunnelHostStatus>;
  readState: (dataDir: string) => TunnelRuntimeState | null;
  writeState: (dataDir: string, state: TunnelRuntimeState) => void;
  clearState: (dataDir: string) => void;
};

const defaultDependencies: TunnelSupervisorDependencies = {
  spawnTunnel: (name, port) => spawn(
    "devtunnel",
    buildTunnelHostArgs(name, port),
    { stdio: ["ignore", "pipe", "pipe"] },
  ),
  captureProcessIdentity,
  terminateProcessTree,
  waitForChildExit,
  fetch,
  inspectTunnelHost,
  readState: readTunnelRuntimeState,
  writeState: writeTunnelRuntimeState,
  clearState: clearTunnelRuntimeState,
};

function inspectTunnelHost(name: string, timeoutMs: number): Promise<TunnelHostStatus> {
  return new Promise((resolve) => {
    execFile(
      "devtunnel",
      ["show", name, "--json"],
      { encoding: "utf8", timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          resolve({ hostConnections: null, detail: stderr.trim() || error.message });
          return;
        }
        try {
          resolve({ hostConnections: parseTunnelHostConnections(stdout) });
        } catch (parseError) {
          resolve({
            hostConnections: null,
            detail: `invalid devtunnel show JSON: ${
              parseError instanceof Error ? parseError.message : String(parseError)
            }`,
          });
        }
      },
    );
  });
}

export function parseTunnelHostConnections(stdout: string): number {
  const parsed = JSON.parse(stdout) as { tunnel?: { hostConnections?: unknown } };
  const hostConnections = parsed.tunnel?.hostConnections;
  if (typeof hostConnections !== "number" || !Number.isInteger(hostConnections) || hostConnections < 0) {
    throw new Error("missing or invalid tunnel.hostConnections");
  }
  return hostConnections;
}

function enabled(env: NodeJS.ProcessEnv): boolean {
  return !/^(0|false|no|off)$/i.test(env.BRIDGE_ENABLE_TUNNEL || "");
}

export function buildTunnelHostArgs(name: string, _port: number): string[] {
  return ["host", name];
}

export function resolveTunnelName(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.BRIDGE_TUNNEL_NAME?.trim();
  if (!configured) return DEFAULT_TUNNEL_NAME;
  const normalized = configured.toLowerCase();
  if (!TUNNEL_NAME_RE.test(normalized)) {
    throw new Error(
      `Invalid BRIDGE_TUNNEL_NAME "${configured}". Use 3-60 letters, numbers, and hyphens, starting and ending with a letter or number.`,
    );
  }
  return normalized;
}

async function probe(
  fetchFn: typeof fetch,
  url: string,
  timeoutMs: number,
  options: { acceptAuthRedirect?: boolean } = {},
): Promise<ProbeResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const startedAt = Date.now();
  try {
    // Never follow redirects: a relay sign-in bounce must be judged here, not turned
    // into a slow round trip through the identity provider.
    const response = await fetchFn(url, { signal: controller.signal, redirect: "manual" });
    const durationMs = Date.now() - startedAt;
    if (response.ok) return { healthy: true, durationMs };
    if (options.acceptAuthRedirect && isTunnelAuthRedirect(response.status, response.headers.get("location"))) {
      return { healthy: true, durationMs, detail: "auth-gated" };
    }
    return { healthy: false, durationMs, detail: `HTTP ${response.status}` };
  } catch (error) {
    return {
      healthy: false,
      durationMs: Date.now() - startedAt,
      detail: error instanceof Error && error.name === "AbortError"
        ? `timed out after ${timeoutMs}ms`
        : error instanceof Error ? error.message : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export class TunnelSupervisor {
  private readonly dataDir: string;
  private readonly env: NodeJS.ProcessEnv;
  private readonly log: (message: string) => void;
  private readonly onReady?: (url: string) => void | Promise<void>;
  private readonly retryBaseMs: number;
  private readonly retryCapMs: number;
  private readonly startupTimeoutMs: number;
  private readonly healthIntervalMs: number;
  private readonly healthTimeoutMs: number;
  private readonly healthFailureThreshold: number;
  private readonly healthFailureWindow: number;
  private readonly healthSlowMs: number;
  private readonly hostRecoveryGraceMs: number;
  private readonly deps: TunnelSupervisorDependencies;
  private readonly tunnelEnabled: boolean;
  private readonly name: string;
  private readonly plannedStops = new WeakSet<ChildProcess>();

  private port: number;
  private desired = false;
  private orphanChecked = false;
  private child: ChildProcess | null = null;
  private identity: Promise<ProcessIdentity | null> | null = null;
  private url: string | null = null;
  private published = false;
  private generation = 0;
  private retryDelayMs: number;
  /** Most recent health observations for the current child, oldest first. */
  private healthWindow: HealthObservation[] = [];
  private authGateLogged = false;
  private hostDisconnectedAt: number | null = null;
  private hostStatusFailureLogged = false;
  private timer: NodeJS.Timeout | null = null;
  private reconciling = false;
  private pendingDelayMs: number | null = null;
  private restartRequested: string | null = null;
  private stopping = false;

  constructor(
    options: TunnelSupervisorOptions,
    dependencies: TunnelSupervisorDependencies = defaultDependencies,
  ) {
    this.dataDir = options.dataDir;
    this.port = options.port;
    this.env = options.env ?? process.env;
    this.log = options.log;
    this.onReady = options.onReady;
    this.retryBaseMs = options.retryBaseMs ?? RETRY_BASE_MS;
    this.retryCapMs = options.retryCapMs ?? RETRY_CAP_MS;
    this.startupTimeoutMs = options.startupTimeoutMs ?? STARTUP_TIMEOUT_MS;
    this.healthIntervalMs = options.healthIntervalMs ?? HEALTH_INTERVAL_MS;
    this.healthTimeoutMs = options.healthTimeoutMs ?? HEALTH_TIMEOUT_MS;
    this.healthFailureThreshold = options.healthFailureThreshold ?? HEALTH_FAILURE_THRESHOLD;
    this.healthFailureWindow = Math.max(
      this.healthFailureThreshold,
      options.healthFailureWindow ?? HEALTH_FAILURE_WINDOW,
    );
    this.healthSlowMs = options.healthSlowMs ?? HEALTH_SLOW_MS;
    this.hostRecoveryGraceMs = options.hostRecoveryGraceMs ?? HOST_RECOVERY_GRACE_MS;
    this.retryDelayMs = this.retryBaseMs;
    this.deps = dependencies;
    this.tunnelEnabled = enabled(this.env);
    this.name = this.tunnelEnabled ? resolveTunnelName(this.env) : DEFAULT_TUNNEL_NAME;
  }

  async start(): Promise<void> {
    if (this.desired || this.stopping) return;
    if (!this.tunnelEnabled) {
      this.log("[tunnel] Disabled by BRIDGE_ENABLE_TUNNEL");
    }
    this.desired = true;
    this.requestReconcile(0);
  }

  updatePort(port: number): void {
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
      throw new Error(`Invalid tunnel port: ${port}`);
    }
    if (this.port === port) return;
    this.port = port;
    if (this.desired && this.tunnelEnabled) {
      this.restartRequested = "port change";
      this.requestReconcile(0);
    }
  }

  getUrl(): string | undefined {
    return this.published ? this.url ?? undefined : undefined;
  }

  prepareForShutdown(): LauncherChild {
    this.stopping = true;
    this.desired = false;
    this.generation++;
    this.pendingDelayMs = null;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.resetHostConnectionState();
    return this.asLauncherChild(this.child);
  }

  finishShutdown(terminated: boolean): void {
    if (!terminated) return;
    this.child = null;
    this.identity = null;
    this.url = null;
    this.published = false;
    this.clearState();
  }

  private requestReconcile(delayMs: number): void {
    if (!this.desired) return;
    if (this.reconciling) {
      this.pendingDelayMs = this.pendingDelayMs === null
        ? delayMs
        : Math.min(this.pendingDelayMs, delayMs);
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.runReconcile();
    }, delayMs);
  }

  private async runReconcile(): Promise<void> {
    if (!this.desired || this.reconciling) return;
    this.reconciling = true;
    this.pendingDelayMs = null;
    try {
      await this.reconcile();
    } catch (error) {
      this.log(`[tunnel] ${error instanceof Error ? error.message : String(error)}`);
      this.scheduleRetry();
    } finally {
      this.reconciling = false;
      if (!this.desired) return;
      if (this.pendingDelayMs !== null) {
        const delay = this.pendingDelayMs;
        this.pendingDelayMs = null;
        this.requestReconcile(delay);
      } else if (this.child && this.url) {
        this.requestReconcile(this.healthIntervalMs);
      }
    }
  }

  private async reconcile(): Promise<void> {
    await this.cleanupOrphan();
    if (!this.desired || !this.tunnelEnabled) return;

    if (this.restartRequested && this.child) {
      const reason = this.restartRequested;
      this.restartRequested = null;
      const stopped = await this.stopChild(this.child, reason);
      if (!stopped) throw new Error(`Unable to stop tunnel after ${reason}`);
    } else {
      this.restartRequested = null;
    }

    if (!this.child) {
      if (!this.desired) return;
      await this.launch();
      return;
    }
    if (!this.url) {
      const stopped = await this.stopChild(this.child, "incomplete startup");
      if (!stopped) throw new Error("Tunnel is running without a published URL and could not be stopped");
      throw new Error("Tunnel did not publish a URL");
    }
    if (!this.published) {
      await this.publishReady(this.child);
      return;
    }

    const child = this.child;
    const localUrl = `http://127.0.0.1:${this.port}/api/health`;
    const local = await probe(this.deps.fetch, localUrl, this.healthTimeoutMs);
    if (!local.healthy) {
      // Do not recycle the tunnel while the server itself is unavailable.
      this.healthWindow = [];
      return;
    }

    const hostStatus = await this.deps.inspectTunnelHost(this.name, this.healthTimeoutMs);
    if (!this.isActiveChild(child)) return;
    if (hostStatus.hostConnections === null) {
      if (!this.hostStatusFailureLogged) {
        this.hostStatusFailureLogged = true;
        this.log(`[tunnel] Unable to verify relay host connections: ${hostStatus.detail ?? "unknown error"}`);
      }
    } else if (hostStatus.hostConnections > 0) {
      if (this.hostDisconnectedAt !== null) {
        this.log("[tunnel] Relay host connection recovered during the grace period");
      }
      this.resetHostConnectionState();
    } else if (this.hostDisconnectedAt === null) {
      this.hostStatusFailureLogged = false;
      this.healthWindow = [];
      this.hostDisconnectedAt = Date.now();
      this.log(
        `[tunnel] Dev Tunnel reports zero host connections; checking again in ${this.hostRecoveryGraceMs}ms`,
      );
    }
    if (this.hostDisconnectedAt !== null) {
      const remainingGraceMs = this.hostRecoveryGraceMs - (Date.now() - this.hostDisconnectedAt);
      if (remainingGraceMs > 0) {
        this.requestReconcile(remainingGraceMs);
        return;
      }
      const stopReason = hostStatus.hostConnections === null
        ? "host connection recovery could not be confirmed"
        : "persistent zero host connections";
      const stopped = await this.stopChild(child, stopReason);
      if (!stopped) throw new Error("Unable to recycle disconnected tunnel");
      this.requestReconcile(0);
      return;
    }

    const publicUrl = new URL("/api/health", this.url).toString();
    const publicResult = await probe(this.deps.fetch, publicUrl, this.healthTimeoutMs, { acceptAuthRedirect: true });
    if (this.child !== child || !this.published) return;
    if (publicResult.detail === "auth-gated" && !this.authGateLogged) {
      this.authGateLogged = true;
      this.log("[tunnel] Public endpoint is access-controlled; verifying host connectivity separately");
    }
    const slow = publicResult.healthy && publicResult.durationMs >= this.healthSlowMs;
    if (publicResult.healthy && !slow) {
      this.recordHealthObservation({ failed: false, durationMs: publicResult.durationMs });
      return;
    }

    await this.recordHealthFailure(child, {
      failed: true,
      durationMs: publicResult.durationMs,
      detail: slow
        ? `slow: ${publicResult.durationMs}ms (local ${local.durationMs}ms)`
        : publicResult.detail,
    });
  }

  private recordHealthObservation(observation: HealthObservation): void {
    this.healthWindow.push(observation);
    if (this.healthWindow.length > this.healthFailureWindow) {
      this.healthWindow.splice(0, this.healthWindow.length - this.healthFailureWindow);
    }
  }

  private countHealthFailures(): number {
    return this.healthWindow.filter((observation) => observation.failed).length;
  }

  private logHealthFailure(observation: HealthObservation): number {
    const failures = this.countHealthFailures();
    this.log(
      `[tunnel] Public health check failed (${failures}/${this.healthFailureThreshold}`
      + ` in last ${this.healthWindow.length})`
      + `${observation.detail ? `: ${observation.detail}` : ""}`,
    );
    return failures;
  }

  /**
   * Count a failure toward the sliding window and recycle the tunnel once the window
   * holds `healthFailureThreshold` failures.
   */
  private async recordHealthFailure(child: ChildProcess, observation: HealthObservation): Promise<void> {
    this.recordHealthObservation(observation);
    if (this.logHealthFailure(observation) < this.healthFailureThreshold) return;

    this.healthWindow = [];
    const stopped = await this.stopChild(child, "failed public health checks");
    if (!stopped) throw new Error("Unable to recycle unhealthy tunnel");
    this.requestReconcile(0);
  }

  private async cleanupOrphan(): Promise<void> {
    if (this.orphanChecked) return;
    this.orphanChecked = true;
    const state = this.deps.readState(this.dataDir);
    if (!state?.process) {
      this.clearState();
      return;
    }

    this.log(`[tunnel] Cleaning up previous tunnel PID ${state.process.pid}`);
    const result = await this.deps.terminateProcessTree(
      state.process,
      createDeadline(PROCESS_TREE_TERMINATION_BUDGET_MS),
    );
    if (!result.ok) {
      this.orphanChecked = false;
      throw new Error(`Previous tunnel cleanup failed: ${result.status}`);
    }
    this.clearState();
  }

  private async launch(): Promise<void> {
    if (!this.desired) return;
    const generation = ++this.generation;
    const child = this.deps.spawnTunnel(this.name, this.port);
    this.resetHostConnectionState();
    this.child = child;
    this.identity = child.pid
      ? this.deps.captureProcessIdentity(
          child.pid,
          createDeadline(IDENTITY_CAPTURE_TIMEOUT_MS),
        )
      : Promise.resolve(null);

    const urlPromise = this.waitForUrl(child, generation);
    // The CLI can exit before process identity capture completes. Mark the
    // rejection handled immediately; the awaited promise still drives retries.
    void urlPromise.catch(() => undefined);
    const startingIdentity = await this.identity;
    if (
      startingIdentity
      && this.desired
      && this.child === child
      && this.generation === generation
    ) {
      try {
        this.deps.writeState(this.dataDir, {
          url: null,
          port: this.port,
          process: startingIdentity,
          updatedAt: new Date().toISOString(),
        });
      } catch (error) {
        void urlPromise.catch(() => undefined);
        await this.stopChild(child, "runtime state publication failure");
        throw error;
      }
    }

    const url = await urlPromise;
    if (!this.desired || this.child !== child || this.generation !== generation) return;

    this.url = url;
    await this.publishReady(child);
  }

  private async publishReady(child: ChildProcess): Promise<void> {
    if (!this.desired || this.child !== child || !this.url) return;
    const generation = this.generation;
    const url = this.url;
    const port = this.port;
    let identity = await this.identity;
    if (!identity && child.pid) {
      this.identity = this.deps.captureProcessIdentity(
        child.pid,
        createDeadline(IDENTITY_CAPTURE_TIMEOUT_MS),
      );
      identity = await this.identity;
    }
    if (
      !this.desired
      || this.child !== child
      || this.generation !== generation
      || this.url !== url
      || this.port !== port
    ) {
      return;
    }
    if (!identity) {
      throw new Error(`Unable to capture exact identity for tunnel PID ${child.pid ?? "unknown"}`);
    }

    this.deps.writeState(this.dataDir, {
      url,
      port,
      process: identity,
      updatedAt: new Date().toISOString(),
    });
    this.published = true;
    this.retryDelayMs = this.retryBaseMs;
    this.healthWindow = [];
    this.log(`[tunnel] Ready at ${url}`);
    try {
      const notification = this.onReady?.(url);
      if (notification) {
        void Promise.resolve(notification).catch((error) => {
          this.log(`[tunnel] Ready notification failed: ${error instanceof Error ? error.message : String(error)}`);
        });
      }
    } catch (error) {
      this.log(`[tunnel] Ready notification failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private waitForUrl(child: ChildProcess, generation: number): Promise<string> {
    return new Promise((resolve, reject) => {
      let output = "";
      let settled = false;

      const cleanup = () => {
        clearTimeout(timeout);
        child.stdout?.off("data", onData);
        child.off("error", onError);
        child.off("exit", onStartupExit);
      };
      const rejectOnce = (error: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        reject(error);
      };
      const onData = (data: Buffer) => {
        if (settled || generation !== this.generation) return;
        output += data.toString();
        const match = output.match(/Connect via browser:\s+(https:\/\/\S+)/)
          ?? output.match(/Hosting port \d+ at\s+(https:\/\/\S+)/);
        if (!match) return;
        settled = true;
        cleanup();
        resolve(match[1].replace(/\/+$/, ""));
      };
      const onError = (error: Error) => {
        if (this.child === child) {
          this.child = null;
          this.identity = null;
          this.url = null;
          this.published = false;
          this.clearState();
        }
        rejectOnce(new Error(`Failed to start devtunnel: ${error.message}`));
      };
      const onStartupExit = (code: number | null) => {
        rejectOnce(new Error(`Devtunnel exited with code ${code} before publishing a URL`));
      };
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        void this.stopChild(child, "startup timeout").finally(() => {
          reject(new Error(`Devtunnel did not publish a URL within ${this.startupTimeoutMs}ms`));
        });
      }, this.startupTimeoutMs);

      child.stdout?.on("data", onData);
      let stderrTail = "";
      child.stderr?.on("data", (data: Buffer) => {
        const chunk = data.toString();
        if (chunk.trim()) this.log(`[tunnel] ${chunk.trim()}`);
        if (!this.isActiveChild(child)) return;
        stderrTail = `${stderrTail}${chunk}`.slice(-1024);
        if (!HOST_STATUS_WAKE_RE.test(stderrTail)) return;
        stderrTail = "";
        this.requestReconcile(0);
      });
      child.once("error", onError);
      child.once("exit", onStartupExit);
      child.on("exit", (code, signal) => {
        if (this.child !== child) return;
        const planned = this.plannedStops.has(child);
        this.child = null;
        this.identity = null;
        this.url = null;
        this.published = false;
        this.resetHostConnectionState();
        this.clearState();
        this.log(`[tunnel] Exited with code ${code}${signal ? ` (signal ${signal})` : ""}`);
        if (!this.desired || planned) return;
        if (this.reconciling) {
          this.requestReconcile(this.retryDelayMs);
        } else {
          this.scheduleRetry();
        }
      });
    });
  }

  private scheduleRetry(): void {
    const delay = this.retryDelayMs;
    this.retryDelayMs = Math.min(this.retryDelayMs * 2, this.retryCapMs);
    this.log(`[tunnel] Retrying in ${delay / 1000}s`);
    this.requestReconcile(delay);
  }

  private async stopChild(child: ChildProcess, reason: string): Promise<boolean> {
    this.plannedStops.add(child);
    const outcome: LauncherChildStopOutcome = await stopLauncherChild(
      this.asLauncherChild(child),
      {
        terminateProcessTree: this.deps.terminateProcessTree,
        waitForChildExit: this.deps.waitForChildExit,
        log: this.log,
      },
      { deadline: createDeadline(PROCESS_TREE_TERMINATION_BUDGET_MS) },
    );
    if (!outcome.ok) {
      this.plannedStops.delete(child);
      this.log(`[tunnel] Stop failed during ${reason}: ${outcome.reason}`);
      return false;
    }
    if (this.child === child) {
      this.child = null;
      this.identity = null;
      this.url = null;
      this.published = false;
      this.resetHostConnectionState();
      this.clearState();
    }
    return true;
  }

  private asLauncherChild(child: ChildProcess | null): LauncherChild {
    return {
      label: "tunnel",
      process: child,
      identity: child === this.child ? this.identity : null,
    };
  }

  private resetHostConnectionState(): void {
    this.hostDisconnectedAt = null;
    this.hostStatusFailureLogged = false;
  }

  private isActiveChild(child: ChildProcess): boolean {
    return this.child === child
      && this.published
      && this.desired
      && !this.plannedStops.has(child);
  }

  private clearState(): void {
    try {
      this.deps.clearState(this.dataDir);
    } catch (error) {
      this.log(`[tunnel] Unable to clear runtime state: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
