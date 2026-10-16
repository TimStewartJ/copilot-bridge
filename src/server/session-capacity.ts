import type { AgentSession } from "./agent-backend/index.js";
import { isLocalMcpServerConfig, type McpServerConfig } from "./mcp-config.js";

const CAPACITY_WAIT_POLL_MS = 500;

export interface SessionCapacityReservation {
  capacityUnits: number;
  localMcpInstances: number;
}

export type SessionCapacityReason =
  | "cleanup-failed"
  | "cleanup-demand"
  | "context-limit"
  | "weighted-capacity"
  | "retained-capacity";

export interface SessionCapacitySnapshot {
  contexts: number;
  contextLimit: number;
  localMcpInstances: number;
  capacityUnits: number;
  capacityLimit: number;
}

export interface SessionCapacityRuntimeStatus {
  contexts: { used: number; retained: number; limit: number };
  weightedUnits: { used: number; retained: number; limit: number };
  localMcpSlots: { used: number; retained: number };
  cache: { readyParents: number; protectedParents: number; limit: number };
  cleanup: { pending: number; failed: number; limit: number };
  waitingRequests: number;
  localMcpWeight: number;
  waitTimeoutSeconds: number;
}

export interface SessionCleanupCapacity extends SessionCapacityReservation {
  phase: "release-pending" | "quarantined" | "backend-recycling" | "operator-blocked";
  contextWeight: number;
}

export interface SessionCacheState {
  ready: number;
  retained: number;
  readyParents: number;
  retainedParents: number;
  trackedAgents: number;
  readyContextWeight: number;
  retainedContextWeight: number;
  readyLocalMcpInstances: number;
  retainedLocalMcpInstances: number;
  readyCapacityUnits: number;
  retainedCapacityUnits: number;
  reservedContexts: number;
  reservedLocalMcpInstances: number;
  reservedCapacityUnits: number;
  pendingCleanup: number;
  failedCleanup: number;
  waitingForCapacity: number;
}

interface SessionCapacityLimits {
  parents: number;
  contexts: number;
  cleanup: number;
  units: number;
  localMcpWeight: number;
  waitTimeoutMs: number;
}

interface SessionCapacityDeps {
  getLimits(): SessionCapacityLimits;
  getSessions(): ReadonlyMap<string, AgentSession>;
  getCleanupRecords(): Iterable<SessionCleanupCapacity>;
  getProtectedSessionIds(): ReadonlySet<string>;
  getTrackedAgentCount(sessionId: string): number;
  reapFinishedSyncTasks(sessionId: string): Promise<number>;
  recordSpan(name: string, duration: number, metadata: Record<string, unknown>): void;
}

export interface CapacityAdmissionOptions {
  isCancelled?: () => boolean;
  reserve(reservation: SessionCapacityReservation): void;
  waitTimeoutMs?: number;
}

export function formatCapacityUnits(value: number): string {
  return Number.isInteger(value) ? String(value) : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

export class SessionCapacityError extends Error {
  readonly code = "session_capacity";
  readonly retryAfterSeconds = 2;

  constructor(readonly reason: SessionCapacityReason, readonly snapshot: SessionCapacitySnapshot) {
    const message = reason === "cleanup-failed"
      ? "Bridge could not release one or more previous Copilot sessions. Wait for automatic cleanup, or restart Bridge if this persists."
      : reason === "cleanup-demand" || reason === "retained-capacity"
        ? "Copilot session cleanup is still catching up. Wait a few seconds for another chat to finish closing, then try again."
        : reason === "context-limit"
          ? `All ${snapshot.contextLimit} live Copilot contexts are currently in use. Wait for one to finish, or stop a running chat or agent, then try again.`
          : `Live Copilot capacity is full at ${formatCapacityUnits(snapshot.capacityUnits)}/${formatCapacityUnits(snapshot.capacityLimit)} units across ${snapshot.contexts} context${snapshot.contexts === 1 ? "" : "s"} and ${snapshot.localMcpInstances} estimated local MCP slot${snapshot.localMcpInstances === 1 ? "" : "s"}. Wait for work to finish, or stop a running chat or agent, then try again.`;
    super(message);
    this.name = "SessionCapacityError";
  }
}

/** Owns admission accounting; the session manager retains ownership of runtime handles and cleanup. */
export class SessionCapacityController {
  private readonly profiles = new WeakMap<AgentSession, { localMcpCount: number }>();
  private readonly resumes = new Map<symbol, SessionCapacityReservation>();
  private creating = 0;
  private creatingUnits = 0;
  private creatingLocalMcp = 0;
  private readonly waiters = new Set<() => void>();
  private syncTaskReap?: Promise<number>;

  constructor(private readonly deps: SessionCapacityDeps) {}

  private getProfile(config: { mcpServers?: Record<string, McpServerConfig> }): { localMcpCount: number } {
    return { localMcpCount: Object.values(config.mcpServers ?? {}).filter(isLocalMcpServerConfig).length };
  }

  trackSession(
    session: AgentSession,
    config?: { mcpServers?: Record<string, McpServerConfig> },
    previous?: AgentSession,
  ): void {
    const profile = config ? this.getProfile(config) : previous ? this.profiles.get(previous) : undefined;
    this.profiles.set(session, profile ?? { localMcpCount: 0 });
  }

  forgetSession(session: AgentSession): void {
    this.profiles.delete(session);
  }

  getLocalMcpCount(session: AgentSession): number {
    return this.profiles.get(session)?.localMcpCount ?? 0;
  }

  getReservation(config: { mcpServers?: Record<string, McpServerConfig> }): SessionCapacityReservation {
    const localMcpInstances = this.getProfile(config).localMcpCount;
    return { localMcpInstances, capacityUnits: 1 + localMcpInstances * this.deps.getLimits().localMcpWeight };
  }

  getTreeCapacity(sessionId: string): SessionCapacityReservation {
    const session = this.deps.getSessions().get(sessionId);
    const contexts = 1 + this.deps.getTrackedAgentCount(sessionId);
    const localMcpInstances = contexts * (session ? this.getLocalMcpCount(session) : 0);
    return {
      localMcpInstances,
      capacityUnits: contexts + localMcpInstances * this.deps.getLimits().localMcpWeight,
    };
  }

  getCacheState(): SessionCacheState {
    let pendingCleanup = 0;
    let failedCleanup = 0;
    let cleanupContextWeight = 0;
    let cleanupLocalMcpInstances = 0;
    let cleanupCapacityUnits = 0;
    for (const record of this.deps.getCleanupRecords()) {
      if (record.phase === "release-pending") pendingCleanup++;
      else failedCleanup++;
      cleanupContextWeight += record.contextWeight;
      cleanupLocalMcpInstances += record.localMcpInstances;
      cleanupCapacityUnits += record.capacityUnits;
    }
    const sessions = this.deps.getSessions();
    const readyParents = sessions.size;
    let trackedAgents = 0;
    let readyLocalMcpInstances = 0;
    let readyCapacityUnits = 0;
    for (const sessionId of sessions.keys()) {
      trackedAgents += this.deps.getTrackedAgentCount(sessionId);
      const capacity = this.getTreeCapacity(sessionId);
      readyLocalMcpInstances += capacity.localMcpInstances;
      readyCapacityUnits += capacity.capacityUnits;
    }
    const readyContextWeight = readyParents + trackedAgents;
    const resumeReservations = [...this.resumes.values()];
    return {
      ready: readyParents,
      retained: readyParents + pendingCleanup + failedCleanup,
      readyParents,
      retainedParents: readyParents + pendingCleanup + failedCleanup,
      trackedAgents,
      readyContextWeight,
      retainedContextWeight: readyContextWeight + cleanupContextWeight,
      readyLocalMcpInstances,
      retainedLocalMcpInstances: readyLocalMcpInstances + cleanupLocalMcpInstances,
      readyCapacityUnits,
      retainedCapacityUnits: readyCapacityUnits + cleanupCapacityUnits,
      reservedContexts: this.creating + resumeReservations.length,
      reservedLocalMcpInstances: this.creatingLocalMcp
        + resumeReservations.reduce((total, reservation) => total + reservation.localMcpInstances, 0),
      reservedCapacityUnits: this.creatingUnits
        + resumeReservations.reduce((total, reservation) => total + reservation.capacityUnits, 0),
      pendingCleanup,
      failedCleanup,
      waitingForCapacity: this.waiters.size,
    };
  }

  private getPressure() {
    const state = this.getCacheState();
    let protectedReadySessionCount = 0;
    let protectedReadyContextWeight = 0;
    let protectedReadyLocalMcpInstances = 0;
    let protectedReadyCapacityUnits = 0;
    for (const sessionId of this.deps.getProtectedSessionIds()) {
      if (!this.deps.getSessions().has(sessionId)) continue;
      protectedReadySessionCount++;
      protectedReadyContextWeight += 1 + this.deps.getTrackedAgentCount(sessionId);
      const capacity = this.getTreeCapacity(sessionId);
      protectedReadyLocalMcpInstances += capacity.localMcpInstances;
      protectedReadyCapacityUnits += capacity.capacityUnits;
    }
    return {
      state,
      protectedReadySessionCount,
      contexts: state.retainedContextWeight - state.readyContextWeight
        + protectedReadyContextWeight + state.reservedContexts,
      localMcpInstances: state.retainedLocalMcpInstances - state.readyLocalMcpInstances
        + protectedReadyLocalMcpInstances + state.reservedLocalMcpInstances,
      capacityUnits: state.retainedCapacityUnits - state.readyCapacityUnits
        + protectedReadyCapacityUnits + state.reservedCapacityUnits,
    };
  }

  getRuntimeStatus(): SessionCapacityRuntimeStatus {
    const pressure = this.getPressure();
    const { state } = pressure;
    const limits = this.deps.getLimits();
    return {
      contexts: {
        used: pressure.contexts,
        retained: state.retainedContextWeight + state.reservedContexts,
        limit: limits.contexts,
      },
      weightedUnits: {
        used: pressure.capacityUnits,
        retained: state.retainedCapacityUnits + state.reservedCapacityUnits,
        limit: limits.units,
      },
      localMcpSlots: {
        used: pressure.localMcpInstances,
        retained: state.retainedLocalMcpInstances + state.reservedLocalMcpInstances,
      },
      cache: { readyParents: state.readyParents, protectedParents: pressure.protectedReadySessionCount, limit: limits.parents },
      cleanup: { pending: state.pendingCleanup, failed: state.failedCleanup, limit: limits.cleanup },
      waitingRequests: state.waitingForCapacity,
      localMcpWeight: limits.localMcpWeight,
      waitTimeoutSeconds: limits.waitTimeoutMs / 1_000,
    };
  }

  private snapshot(contexts: number, localMcpInstances: number, capacityUnits: number): SessionCapacitySnapshot {
    const limits = this.deps.getLimits();
    return { contexts, contextLimit: limits.contexts, localMcpInstances, capacityUnits, capacityLimit: limits.units };
  }

  assertAvailable(request: SessionCapacityReservation): void {
    const pressure = this.getPressure();
    const { state } = pressure;
    const limits = this.deps.getLimits();
    if (state.failedCleanup > 0) {
      throw new SessionCapacityError("cleanup-failed", this.snapshot(
        state.retainedContextWeight + state.reservedContexts,
        state.retainedLocalMcpInstances + state.reservedLocalMcpInstances,
        state.retainedCapacityUnits + state.reservedCapacityUnits,
      ));
    }
    const projectedCleanupDemand = state.pendingCleanup + pressure.protectedReadySessionCount + state.reservedContexts + 1;
    const contexts = pressure.contexts + 1;
    const localMcp = pressure.localMcpInstances + request.localMcpInstances;
    const units = pressure.capacityUnits + request.capacityUnits;
    if (contexts > limits.contexts) {
      throw new SessionCapacityError("context-limit", this.snapshot(contexts, localMcp, units));
    }
    if (units > limits.units) {
      throw new SessionCapacityError("weighted-capacity", this.snapshot(contexts, localMcp, units));
    }
    const retainedContexts = state.retainedContextWeight + state.reservedContexts + 1;
    const retainedLocalMcp = state.retainedLocalMcpInstances + state.reservedLocalMcpInstances + request.localMcpInstances;
    const retainedUnits = state.retainedCapacityUnits + state.reservedCapacityUnits + request.capacityUnits;
    if (projectedCleanupDemand > limits.cleanup) {
      throw new SessionCapacityError("cleanup-demand", this.snapshot(retainedContexts, retainedLocalMcp, retainedUnits));
    }
    if (state.pendingCleanup > 0 && (retainedContexts > limits.contexts || retainedUnits > limits.units)) {
      throw new SessionCapacityError("retained-capacity", this.snapshot(retainedContexts, retainedLocalMcp, retainedUnits));
    }
  }

  reserveResume(token: symbol, reservation: SessionCapacityReservation): void {
    this.resumes.set(token, reservation);
  }

  hasResume(token: symbol): boolean {
    return this.resumes.has(token);
  }

  releaseResume(token: symbol): void {
    this.resumes.delete(token);
  }

  notifyChanged(): void {
    const waiters = [...this.waiters];
    this.waiters.clear();
    for (const resolve of waiters) resolve();
  }

  private waitForChange(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = () => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        this.waiters.delete(finish);
        resolve();
      };
      this.waiters.add(finish);
      timer = setTimeout(finish, timeoutMs);
      timer.unref?.();
    });
  }

  private reapSyncTasks(): Promise<number> {
    if (this.syncTaskReap) return this.syncTaskReap;
    const reap = Promise.all([...this.deps.getSessions().keys()].map((id) => this.deps.reapFinishedSyncTasks(id)))
      .then((counts) => counts.reduce((total, count) => total + count, 0))
      .finally(() => {
        if (this.syncTaskReap === reap) this.syncTaskReap = undefined;
      });
    this.syncTaskReap = reap;
    return reap;
  }

  async admit(
    config: { mcpServers?: Record<string, McpServerConfig> },
    options: CapacityAdmissionOptions,
  ): Promise<SessionCapacityReservation | null> {
    const startedAt = Date.now();
    const waitTimeoutMs = options.waitTimeoutMs ?? this.deps.getLimits().waitTimeoutMs;
    const deadline = startedAt + waitTimeoutMs;
    const request = this.getReservation(config);
    let lastError: SessionCapacityError | undefined;
    let waitingLogged = false;
    let reaped = false;
    while (!options.isCancelled?.()) {
      try {
        this.assertAvailable(request);
        options.reserve(request);
        if (waitingLogged) {
          this.deps.recordSpan("session.capacity.wait", Date.now() - startedAt, {
            outcome: "admitted", reason: lastError?.reason, ...lastError?.snapshot,
          });
        }
        return request;
      } catch (error) {
        if (!(error instanceof SessionCapacityError)) throw error;
        lastError = error;
      }
      if (!reaped && ["context-limit", "weighted-capacity", "retained-capacity"].includes(lastError.reason)) {
        reaped = true;
        const count = await this.reapSyncTasks();
        if (count > 0) console.warn(`[sdk] Reaped ${count} finished sync agent task${count === 1 ? "" : "s"} while relieving session capacity`);
        continue;
      }
      const remaining = deadline - Date.now();
      if (waitTimeoutMs <= 0 || remaining <= 0) {
        if (waitTimeoutMs > 0) {
          this.deps.recordSpan("session.capacity.wait", Date.now() - startedAt, {
            outcome: "timed-out", reason: lastError.reason, ...lastError.snapshot,
          });
        }
        throw lastError;
      }
      if (!waitingLogged) {
        waitingLogged = true;
        console.warn(
          `[sdk] Session capacity is full (${formatCapacityUnits(lastError.snapshot.capacityUnits)}/${formatCapacityUnits(lastError.snapshot.capacityLimit)} units, ${lastError.snapshot.contexts}/${lastError.snapshot.contextLimit} contexts); waiting up to ${Math.ceil(waitTimeoutMs / 1_000)}s`,
        );
      }
      await this.waitForChange(Math.min(CAPACITY_WAIT_POLL_MS, remaining));
    }
    return null;
  }

  async beginCreation(
    config: { mcpServers?: Record<string, McpServerConfig> },
    options: { waitTimeoutMs?: number } = {},
  ): Promise<SessionCapacityReservation> {
    const reservation = await this.admit(config, {
      ...options,
      reserve: (value) => {
        this.creating++;
        this.creatingUnits += value.capacityUnits;
        this.creatingLocalMcp += value.localMcpInstances;
      },
    });
    if (!reservation) throw new Error("Session creation was cancelled before capacity was reserved");
    return reservation;
  }

  endCreation(reservation: SessionCapacityReservation): void {
    this.creating = Math.max(0, this.creating - 1);
    this.creatingUnits = Math.max(0, this.creatingUnits - reservation.capacityUnits);
    this.creatingLocalMcp = Math.max(0, this.creatingLocalMcp - reservation.localMcpInstances);
    this.notifyChanged();
  }
}
