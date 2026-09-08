import { randomUUID } from "node:crypto";
import type { TelemetryStore } from "./telemetry-store.js";
import type { BrowserLaunchConfig, BrowserTarget } from "./agent-browser.js";
import { safeRecordBrowserSpan } from "./agent-browser.js";
import {
  BrowserBroker,
  type BrowserBrokerLease,
  type BrowserContext,
} from "./browser-broker.js";
import { err, ok, type ErrorResult, type OkResult } from "./tool-results.js";

/** Legacy input retained during the browser-context migration. */
export type BrowserSessionMode = "persistent" | "isolated";

export interface BrowserSessionRecord {
  id: string;
  context: BrowserContext;
  mode: BrowserSessionMode;
  ownerSessionId: string;
  purpose?: string;
  browserTarget: BrowserTarget;
  createdAt: number;
  lastUsedAt: number;
  activeCount: number;
  publicTargetId?: string;
}

interface BrowserSessionStoreOptions {
  copilotHome?: string;
  telemetryStore?: TelemetryStore;
  idleTimeoutMs?: number;
  getBrowserLaunchConfig?: () => BrowserLaunchConfig;
  browserBroker?: BrowserBroker;
}

type BrowserSessionUseResult<T> = (OkResult<T> & { record: BrowserSessionRecord }) | ErrorResult;

export class BrowserSessionStore {
  private readonly telemetryStore?: TelemetryStore;
  private readonly idleTimeoutMs: number;
  private readonly browserBroker: BrowserBroker;
  private readonly sessions = new Map<string, BrowserSessionRecord>();
  private readonly disposalRuns = new Map<string, Promise<boolean>>();
  private readonly sweepHandle: NodeJS.Timeout;

  constructor(options: BrowserSessionStoreOptions = {}) {
    this.telemetryStore = options.telemetryStore;
    this.idleTimeoutMs = options.idleTimeoutMs ?? (30 * 60_000);
    this.browserBroker = options.browserBroker ?? new BrowserBroker({
      copilotHome: options.copilotHome,
      telemetryStore: options.telemetryStore,
      getBrowserLaunchConfig: options.getBrowserLaunchConfig,
    });
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
    const mode: BrowserSessionMode = context === "authenticated" ? "persistent" : "isolated";
    const metadata = {
      browserSessionId: id,
      browserContext: context,
      browserSessionMode: mode,
      ownerSessionId,
      purpose,
    };
    const lease = await this.browserBroker.createSessionTarget(context);

    const record: BrowserSessionRecord = {
      id,
      context,
      mode,
      ownerSessionId,
      purpose,
      browserTarget: lease.browserTarget,
      createdAt,
      lastUsedAt: createdAt,
      activeCount: 0,
      publicTargetId: lease.publicTargetId,
    };
    this.sessions.set(id, record);
    safeRecordBrowserSpan(this.telemetryStore, "browser.session.start", 0, {
      ...metadata,
      browserSession: lease.browserTarget.sessionName,
      publicTargetId: lease.publicTargetId,
    });
    return { ...record };
  }

  getSession(id: string): BrowserSessionRecord | undefined {
    const record = this.sessions.get(id);
    return record ? { ...record } : undefined;
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
    if (current.context === "public") {
      const lease: BrowserBrokerLease = {
        context: current.context,
        browserTarget: current.browserTarget,
        publicTargetId: current.publicTargetId,
      };
      await this.browserBroker.disposeSessionTarget(lease, {
        toolName: "browser_session_close",
        browserOpId: current.id,
        metadata: {
          browserSessionId: current.id,
          browserContext: current.context,
          browserSessionMode: current.mode,
          ownerSessionId: current.ownerSessionId,
          reason,
          publicTargetId: current.publicTargetId,
        },
      });
    }
    if (this.sessions.get(current.id) !== current) return false;
    this.sessions.delete(current.id);
    safeRecordBrowserSpan(this.telemetryStore, "browser.session.close", 0, {
      browserSessionId: current.id,
      browserContext: current.context,
      browserSessionMode: current.mode,
      browserSession: current.browserTarget.sessionName,
      ownerSessionId: current.ownerSessionId,
      reason,
      publicTargetId: current.publicTargetId,
    });
    return true;
  }
}

const sessionStores = new WeakMap<object, BrowserSessionStore>();

export function getOrCreateBrowserSessionStore(
  key: object,
  options: BrowserSessionStoreOptions = {},
): BrowserSessionStore {
  const existing = sessionStores.get(key);
  if (existing) return existing;
  const store = new BrowserSessionStore(options);
  sessionStores.set(key, store);
  return store;
}
