import { AGENT_RPC_TIMEOUTS_MS } from "./agent-backend/rpc-timeouts.js";
import { createDeadline, settleByDeadline } from "./deadline.js";

// Readiness spans two sequential RPCs. A shorter caller deadline must not turn
// normal MCP discovery into a failed prompt while those RPCs are still healthy.
export const SESSION_TOOL_READINESS_TIMEOUT_MS =
  AGENT_RPC_TIMEOUTS_MS["session.initializeTools"]
  + AGENT_RPC_TIMEOUTS_MS["session.getCurrentToolMetadata"]
  + 5_000;
export const SESSION_TOOL_READINESS_SLOW_MS = 30_000;

export interface SessionToolReadinessSnapshot {
  state: "initializing" | "ready" | "failed";
  startedAt: string;
  completedAt?: string;
  error?: string;
}

interface ReadinessRecord {
  snapshot: SessionToolReadinessSnapshot;
  promise: Promise<void>;
}

export class SessionToolReadiness {
  private readonly records = new WeakMap<object, ReadinessRecord>();

  getSnapshot(session: object): SessionToolReadinessSnapshot | undefined {
    const snapshot = this.records.get(session)?.snapshot;
    return snapshot ? { ...snapshot } : undefined;
  }

  private ensure(session: object, initialize: () => Promise<void>, onSlow?: () => void): Promise<void> {
    const existing = this.records.get(session);
    if (existing) return existing.promise;
    const record: ReadinessRecord = {
      snapshot: { state: "initializing", startedAt: new Date().toISOString() },
      promise: Promise.resolve(),
    };
    this.records.set(session, record);
    const slowTimer = setTimeout(() => onSlow?.(), SESSION_TOOL_READINESS_SLOW_MS);
    slowTimer.unref?.();
    record.promise = Promise.resolve().then(initialize).then(() => {
      record.snapshot = { ...record.snapshot, state: "ready", completedAt: new Date().toISOString() };
    }, (error: unknown) => {
      record.snapshot = {
        ...record.snapshot,
        state: "failed",
        completedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      };
      throw error;
    }).finally(() => clearTimeout(slowTimer));
    return record.promise;
  }

  async wait(
    session: object,
    initialize: () => Promise<void>,
    options: { timeoutMs?: number; onSlow?: () => void } = {},
  ) {
    return settleByDeadline(
      () => this.ensure(session, initialize, options.onSlow),
      createDeadline(options.timeoutMs ?? SESSION_TOOL_READINESS_TIMEOUT_MS),
    );
  }
}
