import { randomUUID } from "node:crypto";
import type { BrowserHandoffView } from "../shared/browser-live.js";
import type { TelemetryStore } from "./telemetry-store.js";
import type { BrowserTarget } from "./agent-browser.js";
import { safeRecordBrowserSpan } from "./agent-browser.js";
import {
  BROWSER_SESSION_IDLE_TIMEOUT_MS,
  type BrowserBroker,
  type BrowserBrokerLease,
  type BrowserContext,
} from "./browser-broker.js";
import { err, ok, type ErrorResult, type OkResult } from "./tool-results.js";

export interface BrowserSessionRecord {
  id: string;
  context: BrowserContext;
  ownerSessionId: string;
  purpose?: string;
  browserTarget: BrowserTarget;
  createdAt: number;
  lastUsedAt: number;
  activeCount: number;
  publicSlot?: number;
}

interface BrowserSessionStoreOptions {
  browserBroker: BrowserBroker;
  telemetryStore?: TelemetryStore;
  idleTimeoutMs?: number;
}

/** The broker's view of a session's browser. */
export function sessionLease(record: BrowserSessionRecord): BrowserBrokerLease {
  return { context: record.context, browserTarget: record.browserTarget, publicSlot: record.publicSlot };
}

type BrowserSessionUseResult<T> = (OkResult<T> & { record: BrowserSessionRecord }) | ErrorResult;

/** A request, still open, for the user to act in a browser session. */
export interface BrowserHandoff {
  /**
   * Name of the single field of the form that asks the user. It is unique to the request, which
   * is how the form is recognised when the runtime reports it.
   */
  fieldName: string;
  /** Call when the user has answered or the request is gone. */
  end(): void;
}

export class BrowserSessionStore {
  private readonly telemetryStore?: TelemetryStore;
  private readonly idleTimeoutMs: number;
  private readonly browserBroker: BrowserBroker;
  private readonly sessions = new Map<string, BrowserSessionRecord>();
  private readonly disposalRuns = new Map<string, Promise<boolean>>();
  private readonly closeListeners = new Set<(browserSessionId: string) => void>();
  private readonly handoffs = new Map<string, BrowserHandoffView & { chatSessionId: string }>();
  private readonly sweepHandle: NodeJS.Timeout;

  constructor(options: BrowserSessionStoreOptions) {
    this.telemetryStore = options.telemetryStore;
    this.idleTimeoutMs = options.idleTimeoutMs ?? BROWSER_SESSION_IDLE_TIMEOUT_MS;
    this.browserBroker = options.browserBroker;
    this.sweepHandle = setInterval(() => {
      void this.sweepIdleSessions().catch((error) => {
        console.error("[browser-session] Idle session sweep failed:", error);
      });
    }, Math.min(this.idleTimeoutMs, 60_000));
    this.sweepHandle.unref?.();
  }

  async createSession(ownerSessionId: string, context: BrowserContext, purpose?: string): Promise<BrowserSessionRecord> {
    const createdAt = Date.now();
    const id = `bs_${randomUUID().slice(0, 8)}`;
    const lease = await this.browserBroker.createSessionTarget(context);

    const record: BrowserSessionRecord = {
      id,
      context,
      ownerSessionId,
      purpose,
      browserTarget: lease.browserTarget,
      createdAt,
      lastUsedAt: createdAt,
      activeCount: 0,
      publicSlot: lease.publicSlot,
    };
    this.sessions.set(id, record);
    safeRecordBrowserSpan(this.telemetryStore, "browser.session.start", 0, {
      browserSessionId: id,
      browserContext: context,
      ownerSessionId,
      purpose,
      browserSession: lease.browserTarget.sessionName,
      publicSlot: lease.publicSlot,
    });
    return { ...record };
  }

  getSession(id: string): BrowserSessionRecord | undefined {
    const record = this.sessions.get(id);
    return record ? { ...record } : undefined;
  }

  /** Counts as a use: a person acting in the browser keeps the session from expiring as idle. */
  touch(id: string): void {
    const record = this.sessions.get(id);
    if (record) record.lastUsedAt = Date.now();
  }

  /**
   * Calls the listener with the id of a session whose browser is about to be closed, however that
   * came about, so that whatever else uses the browser stops before it goes.
   */
  onSessionClosing(listener: (browserSessionId: string) => void): () => void {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  /** Registers that a chat is about to ask its user to act in one of its browser sessions. */
  beginHandoff(chatSessionId: string, browserSessionId: string, reason: string): BrowserHandoff {
    const fieldName = `handoff_${randomUUID().slice(0, 8)}`;
    this.handoffs.set(fieldName, { chatSessionId, browserSessionId, reason });
    return { fieldName, end: () => { this.handoffs.delete(fieldName); } };
  }

  /** The handoff a chat's pending form belongs to, going by the form's field names. */
  matchHandoff(chatSessionId: string, fieldNames: readonly string[]): BrowserHandoffView | undefined {
    for (const fieldName of fieldNames) {
      const handoff = this.handoffs.get(fieldName);
      if (handoff?.chatSessionId === chatSessionId) {
        return { browserSessionId: handoff.browserSessionId, reason: handoff.reason };
      }
    }
    return undefined;
  }

  /**
   * Runs something that needs the session's browser but is not one of the owning chat's tool
   * calls, such as showing it to the user. The session is not closed while it runs.
   */
  async holdSession<T>(id: string, fn: (record: BrowserSessionRecord) => Promise<T>): Promise<BrowserSessionUseResult<T>> {
    const record = this.sessions.get(id);
    if (!record || this.disposalRuns.has(id)) return err(`Browser session not found: ${id}`);
    return this.runWithRecord(record, fn);
  }

  async useSession<T>(
    id: string,
    ownerSessionId: string,
    fn: (record: BrowserSessionRecord) => Promise<T>,
  ): Promise<BrowserSessionUseResult<T>> {
    const record = this.sessions.get(id);
    if (!record) return err(`Browser session not found: ${id}`);
    if (this.disposalRuns.has(id)) return err("Browser session is closing");
    if (record.ownerSessionId !== ownerSessionId) {
      return err("Browser session belongs to a different Copilot session");
    }
    return this.runWithRecord(record, fn);
  }

  private async runWithRecord<T>(
    record: BrowserSessionRecord,
    fn: (record: BrowserSessionRecord) => Promise<T>,
  ): Promise<BrowserSessionUseResult<T>> {
    record.activeCount += 1;
    record.lastUsedAt = Date.now();
    try {
      const value = await fn({ ...record });
      record.lastUsedAt = Date.now();
      return { ...ok(value), record: { ...record } };
    } finally {
      record.activeCount = Math.max(0, record.activeCount - 1);
      record.lastUsedAt = Date.now();
    }
  }

  async closeSession(id: string, ownerSessionId: string, force = false): Promise<{ ok: true } | ErrorResult> {
    const record = this.sessions.get(id);
    if (!record) return err(`Browser session not found: ${id}`);
    if (this.disposalRuns.has(id)) return err("Browser session is already closing");
    if (record.ownerSessionId !== ownerSessionId) {
      return err("Browser session belongs to a different Copilot session");
    }
    if (record.activeCount > 0 && !force) {
      return err("Browser session is busy");
    }
    await this.disposeRecord(record);
    return { ok: true };
  }

  async closeAll(): Promise<void> {
    clearInterval(this.sweepHandle);
    await Promise.allSettled([...this.disposalRuns.values()]);
    const records = [...this.sessions.values()];
    for (const record of records) {
      await this.disposeRecord(record, "shutdown");
    }
  }

  async sweepIdleSessions(now = Date.now()): Promise<number> {
    const idleRecords = [...this.sessions.values()].filter((record) =>
      record.activeCount === 0 && (now - record.lastUsedAt) >= this.idleTimeoutMs,
    );
    let expired = 0;
    for (const record of idleRecords) {
      const current = this.sessions.get(record.id);
      if (!current) continue;
      if (this.disposalRuns.has(current.id)) continue;
      if (current.activeCount > 0) continue;
      if ((now - current.lastUsedAt) < this.idleTimeoutMs) continue;
      if (await this.disposeRecord(current, "idle_timeout")) expired += 1;
    }
    return expired;
  }

  private async disposeRecord(record: BrowserSessionRecord, reason: "explicit" | "idle_timeout" | "shutdown" = "explicit"): Promise<boolean> {
    if (this.disposalRuns.has(record.id)) return false;
    const run = this.performDisposeRecord(record, reason);
    this.disposalRuns.set(record.id, run);
    try {
      return await run;
    } finally {
      if (this.disposalRuns.get(record.id) === run) {
        this.disposalRuns.delete(record.id);
      }
    }
  }

  private async performDisposeRecord(
    record: BrowserSessionRecord,
    reason: "explicit" | "idle_timeout" | "shutdown",
  ): Promise<boolean> {
    const current = this.sessions.get(record.id);
    if (!current) return false;
    if (reason === "idle_timeout" && current.activeCount > 0) return false;
    for (const listener of this.closeListeners) {
      try {
        listener(current.id);
      } catch (error) {
        console.error("[browser-session] Close listener failed:", error);
      }
    }
    if (current.context === "public") {
      await this.browserBroker.disposeSessionTarget(sessionLease(current), {
        toolName: "browser_session_close",
        browserOpId: current.id,
        metadata: {
          browserSessionId: current.id,
          browserContext: current.context,
          ownerSessionId: current.ownerSessionId,
          reason,
          publicSlot: current.publicSlot,
        },
      });
    }
    if (this.sessions.get(current.id) !== current) return false;
    this.sessions.delete(current.id);
    safeRecordBrowserSpan(this.telemetryStore, "browser.session.close", 0, {
      browserSessionId: current.id,
      browserContext: current.context,
      browserSession: current.browserTarget.sessionName,
      ownerSessionId: current.ownerSessionId,
      reason,
      publicSlot: current.publicSlot,
    });
    return true;
  }
}
