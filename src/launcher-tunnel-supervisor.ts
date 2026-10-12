import { execFile, spawn, type ChildProcess } from "node:child_process";
import {
  captureProcessIdentity,
  PROCESS_TREE_TERMINATION_BUDGET_MS,
  terminateProcessTree,
  type ProcessIdentity,
  type ProcessTreeTerminationResult,
} from "./server/platform.js";
import { createDeadline, type Deadline } from "./server/deadline.js";
import type { TunnelHostAuthKind, TunnelSpec } from "./server/tunnel-config.js";
import {
  additionalTunnelRuntimeStateFileName,
  clearTunnelRuntimeState,
  readTunnelRuntimeState,
  TUNNEL_RUNTIME_STATE_FILE_NAME,
  writeTunnelRuntimeState,
  type TunnelRuntimeState,
} from "./server/tunnel-runtime-state.js";
import {
  stopLauncherChild,
  type LauncherChild,
  type LauncherChildStopOutcome,
} from "./launcher-exit.js";
import { waitForChildExit } from "./launcher-process.js";
import {
  getCliTunnelConnectCredential,
  probeTunnelHealth,
  type TunnelConnectCredential,
  type TunnelProbeResult,
} from "./launcher-tunnel-probe.js";
export { isTunnelAuthRedirect } from "./launcher-tunnel-probe.js";

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
/** Slow but valid forwarding is logged, not counted as a host failure. */
const HEALTH_SLOW_MS = 3_000;
const HOST_RECOVERY_GRACE_MS = 15_000;
const HOST_TOKEN_RENEW_MARGIN_MS = 60 * 60_000;
const IDENTITY_CAPTURE_TIMEOUT_MS = 10_000;
const CONNECT_TOKEN_RENEW_MARGIN_MS = 60_000;
const HEALTH_RESTART_COOLDOWN_MS = 5 * 60_000;

const HOST_STATUS_WAKE_RE =
  /ClientSSH: Session closed unexpectedly|Error running client SSH session|Error connecting host tunnel session/i;
type HealthObservation = {
  failed: boolean;
  durationMs: number;
  detail?: string;
};

export type TunnelHostStatus = {
  hostConnections: number | null;
  detail?: string;
};

/** A token-authenticated way to host one tunnel, independent of the devtunnel CLI login. */
export type TunnelHostCredential = {
  /** `<tunnel>.<cluster>`, the form `devtunnel host --access-token` needs. */
  hostName: string;
  accessToken: string;
  issuedAt: number;
  expiresAt: number;
};

export type TunnelHostAuth = {
  getCredential: (tunnelName: string) => Promise<TunnelHostCredential>;
  inspectHost: (credential: TunnelHostCredential, timeoutMs: number) => Promise<TunnelHostStatus>;
  getConnectCredential: (credential: TunnelHostCredential) => Promise<TunnelConnectCredential>;
};

export type TunnelSupervisorOptions = {
  dataDir: string;
  port: number;
  log: (message: string) => void;
  /**
   * Tunnel to host. `null` hosts nothing and only cleans up a tunnel host that a
   * previous launcher recorded in this supervisor's state file.
   */
  tunnelName: string | null;
  /**
   * Set for every supervisor except the primary one: gives it its own state file
   * and log label. Only the primary file feeds the server's public URL.
   */
  additionalName?: string;
  /**
   * Host with short-lived tokens from this provider instead of the devtunnel CLI
   * login. The host restarts with a fresh token before the current one expires.
   */
  hostAuth?: TunnelHostAuth;
  /** Renew a host token this long before it expires (default 1 hour). */
  hostTokenRenewMarginMs?: number;
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
  spawnTunnel: (name: string, port: number, accessToken?: string) => ChildProcess;
  captureProcessIdentity: (pid: number, deadline: Deadline) => Promise<ProcessIdentity | null>;
  terminateProcessTree: (
    identity: ProcessIdentity,
    deadline: Deadline,
  ) => Promise<ProcessTreeTerminationResult>;
  waitForChildExit: typeof waitForChildExit;
  fetch: typeof fetch;
  inspectTunnelHost: (name: string, timeoutMs: number) => Promise<TunnelHostStatus>;
  getConnectCredential: (name: string) => Promise<TunnelConnectCredential>;
  readState: (dataDir: string, fileName: string) => TunnelRuntimeState | null;
  writeState: (dataDir: string, state: TunnelRuntimeState, fileName: string) => void;
  clearState: (dataDir: string, fileName: string) => void;
};

const defaultDependencies: TunnelSupervisorDependencies = {
  spawnTunnel: (name, port, accessToken) => {
    if (accessToken === undefined) {
      return spawn("devtunnel", buildTunnelHostArgs(name, port), { stdio: ["ignore", "pipe", "pipe"] });
    }
    // The token goes over stdin so it never appears in a process command line.
    const child = spawn("devtunnel", buildTunnelHostArgs(name, port, true), { stdio: ["pipe", "pipe", "pipe"] });
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(accessToken);
    return child;
  },
  captureProcessIdentity,
  terminateProcessTree,
  waitForChildExit,
  fetch,
  inspectTunnelHost,
  getConnectCredential: getCliTunnelConnectCredential,
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

export function buildTunnelHostArgs(name: string, _port: number, readAccessTokenFromStdin = false): string[] {
  return readAccessTokenFromStdin ? ["host", name, "--access-token", "-"] : ["host", name];
}

export type TunnelSupervisorPlan = {
  tunnelName: string | null;
  additionalName?: string;
  auth?: TunnelHostAuthKind;
};

/**
 * One supervisor per configured tunnel; the first is the primary and owns
 * `tunnel-runtime.json`. The primary slot exists even with no tunnel configured, and
 * every additional tunnel that still has a state file keeps a slot after it leaves
 * the list, so a tunnel host a previous launcher left running is still cleaned up.
 */
export function planTunnelSupervisors(
  tunnels: readonly TunnelSpec[],
  staleAdditionalNames: readonly string[] = [],
): TunnelSupervisorPlan[] {
  const [primary, ...additional] = tunnels;
  const additionalNames = additional.map((tunnel) => tunnel.name);
  return [
    primary ? { tunnelName: primary.name, auth: primary.auth } : { tunnelName: null },
    ...additional.map((tunnel) => ({ tunnelName: tunnel.name, additionalName: tunnel.name, auth: tunnel.auth })),
    ...staleAdditionalNames
      .filter((name) => !additionalNames.includes(name))
      .map((name) => ({ tunnelName: null, additionalName: name })),
  ];
}

export class TunnelSupervisor {
  private readonly dataDir: string;
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
  private readonly hostAuth?: TunnelHostAuth;
  private readonly hostTokenRenewMarginMs: number;
  private readonly deps: TunnelSupervisorDependencies;
  private readonly name: string | null;
  private readonly stateFileName: string;
  private readonly childLabel: string;
  private readonly plannedStops = new WeakSet<ChildProcess>();

  private port: number;
  private desired = false;
  private orphanChecked = false;
  private child: ChildProcess | null = null;
  private identity: Promise<ProcessIdentity | null> | null = null;
  private url: string | null = null;
  private published = false;
  /** Token the current child was started with, when hosting through `hostAuth`. */
  private credential: TunnelHostCredential | null = null;
  /** A renewed token fetched before the running host was stopped, used by the next launch. */
  private pendingCredential: TunnelHostCredential | null = null;
  private renewalFailureLogged = false;
  private generation = 0;
  private retryDelayMs: number;
  /** Most recent health observations for the current child, oldest first. */
  private healthWindow: HealthObservation[] = [];
  private connectCredential: TunnelConnectCredential | null = null;
  private connectRenewAt = 0;
  private probeBlocker: string | null = null;
  private nextHealthRestartAt = 0;
  private lastHealthCheckAt = 0;
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
    this.name = options.tunnelName;
    const additionalName = options.additionalName;
    const baseLog = options.log;
    this.log = additionalName
      ? (message) => baseLog(message.replace(/^\[tunnel\]/, `[tunnel ${additionalName}]`))
      : baseLog;
    this.stateFileName = additionalName
      ? additionalTunnelRuntimeStateFileName(additionalName)
      : TUNNEL_RUNTIME_STATE_FILE_NAME;
    this.childLabel = additionalName ? `tunnel ${additionalName}` : "tunnel";
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
    this.hostAuth = options.hostAuth;
    this.hostTokenRenewMarginMs = options.hostTokenRenewMarginMs ?? HOST_TOKEN_RENEW_MARGIN_MS;
    this.retryDelayMs = this.retryBaseMs;
    this.deps = dependencies;
  }

  async start(): Promise<void> {
    if (this.desired || this.stopping) return;
    this.desired = true;
    this.requestReconcile(0);
  }

  updatePort(port: number): void {
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
      throw new Error(`Invalid tunnel port: ${port}`);
    }
    if (this.port === port) return;
    this.port = port;
    if (this.desired && this.name !== null) {
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
    if (!this.desired || this.name === null) return;

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
    this.lastHealthCheckAt = Date.now();
    if (this.credential && Date.now() >= this.renewAt(this.credential) && await this.renewHostToken(child)) {
      return;
    }
    const localUrl = `http://127.0.0.1:${this.port}/api/health`;
    const local = await probeTunnelHealth(this.deps.fetch, localUrl, this.healthTimeoutMs);
    if (local.kind !== "healthy") {
      // Do not recycle the tunnel while the server itself is unavailable.
      this.healthWindow = [];
      return;
    }

    const hostStatus = this.credential && this.hostAuth
      ? await this.hostAuth.inspectHost(this.credential, this.healthTimeoutMs)
      : await this.deps.inspectTunnelHost(this.name, this.healthTimeoutMs);
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
      if (hostStatus.hostConnections === 0) {
        await this.recycleUnhealthyChild(child, "persistent zero host connections");
        return;
      }
    }

    const publicUrl = new URL("/api/health", this.url).toString();
    const publicResult = await this.probeForwarding(child, publicUrl);
    if (!publicResult || !this.isActiveChild(child)) return;
    if (publicResult.kind === "healthy") {
      if (this.probeBlocker) this.log("[tunnel] Authenticated forwarding health recovered");
      this.probeBlocker = null;
      this.retryDelayMs = this.retryBaseMs;
      this.hostDisconnectedAt = null;
      if (publicResult.durationMs >= this.healthSlowMs) {
        this.log(`[tunnel] Forwarding health slow: ${publicResult.durationMs}ms (local ${local.durationMs}ms); not recycling`);
      }
      this.recordHealthObservation({ failed: false, durationMs: publicResult.durationMs });
      return;
    }
    if (publicResult.kind === "auth" || publicResult.kind === "network") {
      this.reportProbeBlocker(`${publicResult.kind}: ${publicResult.detail}`);
      return;
    }
    if (publicResult.kind === "timeout" || publicResult.kind === "transport") {
      // Transport failures can happen before forwarding reaches the host.
      const frontDoor = await probeTunnelHealth(this.deps.fetch, publicUrl, this.healthTimeoutMs, { frontDoor: true });
      if (!this.isActiveChild(child)) return;
      if (frontDoor.kind !== "healthy") {
        this.reportProbeBlocker(`network: forwarding failed and the public front door is not reachable (${frontDoor.detail})`);
        return;
      }
    }

    await this.recordHealthFailure(child, {
      failed: true,
      durationMs: publicResult.durationMs,
      detail: publicResult.detail,
    });
  }

  private reportProbeBlocker(detail: string): void {
    this.healthWindow = [];
    if (this.probeBlocker !== detail) {
      this.log(`[tunnel] Forwarding health unverified; keeping host running: ${detail}`);
    }
    this.probeBlocker = detail;
  }

  private async getConnectCredential(force = false): Promise<TunnelConnectCredential | null> {
    if (this.name === null) return null;
    const cached = this.connectCredential;
    if (!force && cached && Date.now() < this.connectRenewAt) return cached;
    try {
      const next = this.credential && this.hostAuth
        ? await this.hostAuth.getConnectCredential(this.credential)
        : await this.deps.getConnectCredential(this.name);
      if (!next.accessToken || !Number.isFinite(next.expiresAt) || next.expiresAt <= Date.now()) {
        throw new Error("Invalid connect credential");
      }
      const lifetime = next.expiresAt - Date.now();
      this.connectCredential = next;
      this.connectRenewAt = Date.now() + Math.max(lifetime - CONNECT_TOKEN_RENEW_MARGIN_MS, lifetime / 2);
      return next;
    } catch (error) {
      this.reportProbeBlocker(`connect-token acquisition failed (${error instanceof Error ? error.name : "unknown"}); retrying automatically`);
      if (!force && cached && cached.expiresAt > Date.now()) return cached;
      return null;
    }
  }

  private async probeForwarding(child: ChildProcess, url: string): Promise<TunnelProbeResult | null> {
    let credential = await this.getConnectCredential();
    if (!credential || !this.isActiveChild(child)) return null;
    let result = await probeTunnelHealth(this.deps.fetch, url, this.healthTimeoutMs, credential);
    if (result.kind === "auth" && this.isActiveChild(child)) {
      this.connectCredential = null;
      credential = await this.getConnectCredential(true);
      if (!credential || !this.isActiveChild(child)) return null;
      result = await probeTunnelHealth(this.deps.fetch, url, this.healthTimeoutMs, credential);
    }
    return result;
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

    await this.recycleUnhealthyChild(child, "failed authenticated forwarding checks");
  }

  private async recycleUnhealthyChild(child: ChildProcess, reason: string): Promise<void> {
    if (Date.now() < this.nextHealthRestartAt) {
      this.log(`[tunnel] Recovery deferred until ${new Date(this.nextHealthRestartAt).toISOString()}: ${reason}`);
      return;
    }
    const local = await probeTunnelHealth(this.deps.fetch, `http://127.0.0.1:${this.port}/api/health`, this.healthTimeoutMs);
    if (!this.isActiveChild(child) || local.kind !== "healthy") {
      this.healthWindow = [];
      return;
    }
    this.log(`[tunnel] Recycling host PID ${child.pid ?? "unknown"}: ${reason}`);
    const stopped = await this.stopChild(child, reason);
    if (!stopped) throw new Error("Unable to recycle unhealthy tunnel");
    this.nextHealthRestartAt = Date.now() + HEALTH_RESTART_COOLDOWN_MS;
    this.healthWindow = [];
    this.scheduleRetry();
  }

  private async cleanupOrphan(): Promise<void> {
    if (this.orphanChecked) return;
    this.orphanChecked = true;
    const state = this.deps.readState(this.dataDir, this.stateFileName);
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

  private renewAt(credential: TunnelHostCredential): number {
    const lifetime = credential.expiresAt - credential.issuedAt;
    return credential.issuedAt + Math.max(lifetime - this.hostTokenRenewMarginMs, lifetime / 2);
  }

  /**
   * Fetch the next token while the current host keeps serving, then restart the host
   * with it. Returns false when the fetch failed: the host keeps running, health checks
   * continue, and renewal is retried on the next check.
   */
  private async renewHostToken(child: ChildProcess): Promise<boolean> {
    if (!this.hostAuth || this.name === null) return false;
    let next: TunnelHostCredential;
    try {
      next = await this.hostAuth.getCredential(this.name);
    } catch (error) {
      if (!this.renewalFailureLogged) {
        this.renewalFailureLogged = true;
        this.log(
          `[tunnel] Host token renewal failed; retrying until the current token expires at ${
            new Date(this.credential?.expiresAt ?? Date.now()).toISOString()
          }: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      return false;
    }
    this.renewalFailureLogged = false;
    this.pendingCredential = next;
    if (!this.isActiveChild(child)) return true;
    const stopped = await this.stopChild(child, "host token renewal");
    if (!stopped) throw new Error("Unable to stop tunnel for host token renewal");
    this.log("[tunnel] Restarting host with a renewed token");
    this.requestReconcile(0);
    return true;
  }

  private async launch(): Promise<void> {
    const name = this.name;
    if (!this.desired || name === null) return;
    let credential: TunnelHostCredential | null = null;
    if (this.hostAuth) {
      credential = this.pendingCredential ?? await this.hostAuth.getCredential(name);
      this.pendingCredential = null;
      if (!this.desired || this.child) return;
    }
    const generation = ++this.generation;
    const child = credential
      ? this.deps.spawnTunnel(credential.hostName, this.port, credential.accessToken)
      : this.deps.spawnTunnel(name, this.port);
    this.credential = credential;
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
        }, this.stateFileName);
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
    }, this.stateFileName);
    this.published = true;
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
        this.requestReconcile(Math.max(0, this.lastHealthCheckAt + this.healthIntervalMs - Date.now()));
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
      label: this.childLabel,
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
      this.deps.clearState(this.dataDir, this.stateFileName);
    } catch (error) {
      this.log(`[tunnel] Unable to clear runtime state: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
