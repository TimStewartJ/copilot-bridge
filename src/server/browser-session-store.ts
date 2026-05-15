import { randomUUID } from "node:crypto";
import type { TelemetryStore } from "./telemetry-store.js";
import type { BrowserLaunchConfig, BrowserTarget } from "./agent-browser.js";
import { createPersistentCloneBrowserTarget, destroyPersistentCloneBrowserTarget, getBridgeBrowserTarget, safeRecordBrowserSpan } from "./agent-browser.js";
import { err, ok, type ErrorResult, type OkResult } from "./tool-results.js";

export type BrowserSessionMode = "persistent" | "isolated";

export interface BrowserSessionRecord {
  id: string;
  mode: BrowserSessionMode;
  ownerSessionId: string;
  purpose?: string;
  browserTarget: BrowserTarget;
  createdAt: number;
  lastUsedAt: number;
  activeCount: number;
  cloneId?: string;
}

interface BrowserSessionStoreOptions {
  copilotHome?: string;
  telemetryStore?: TelemetryStore;
  idleTimeoutMs?: number;
  getBrowserLaunchConfig?: () => BrowserLaunchConfig;
}

type BrowserSessionUseResult<T> = (OkResult<T> & { record: BrowserSessionRecord }) | ErrorResult;

export class BrowserSessionStore {
  private readonly copilotHome?: string;
  private readonly telemetryStore?: TelemetryStore;
  private readonly idleTimeoutMs: number;
  private readonly getBrowserLaunchConfig?: () => BrowserLaunchConfig;
  private readonly sessions = new Map<string, BrowserSessionRecord>();
  private readonly sweepHandle: NodeJS.Timeout;

  constructor(options: BrowserSessionStoreOptions = {}) {
    this.copilotHome = options.copilotHome;
    this.telemetryStore = options.telemetryStore;
    this.idleTimeoutMs = options.idleTimeoutMs ?? (30 * 60_000);
    this.getBrowserLaunchConfig = options.getBrowserLaunchConfig;
    this.sweepHandle = setInterval(() => {
      void this.sweepIdleSessions();
    }, Math.min(this.idleTimeoutMs, 60_000));
    this.sweepHandle.unref?.();
  }

  async createSession(ownerSessionId: string, mode: BrowserSessionMode, purpose?: string): Promise<BrowserSessionRecord> {
    const createdAt = Date.now();
    const id = `bs_${randomUUID().slice(0, 8)}`;
    const metadata = {
      browserSessionId: id,
      browserSessionMode: mode,
      ownerSessionId,
      purpose,
    };
    const launchConfig = this.getBrowserLaunchConfig?.() ?? {};

    let browserTarget: BrowserTarget;
    let cloneId: string | undefined;
    if (mode === "isolated") {
      const clone = await createPersistentCloneBrowserTarget(this.copilotHome, this.telemetryStore, metadata, launchConfig);
      browserTarget = clone.browserTarget;
      cloneId = clone.cloneId;
    } else {
      browserTarget = getBridgeBrowserTarget(this.copilotHome, launchConfig);
    }

    const record: BrowserSessionRecord = {
      id,
      mode,
      ownerSessionId,
      purpose,
      browserTarget,
      createdAt,
      lastUsedAt: createdAt,
      activeCount: 0,
      cloneId,
    };
    this.sessions.set(id, record);
    safeRecordBrowserSpan(this.telemetryStore, "browser.session.start", 0, {
      ...metadata,
      browserSession: browserTarget.sessionName,
      cloneId,
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
      if (current.activeCount > 0) continue;
      if ((now - current.lastUsedAt) < this.idleTimeoutMs) continue;
      if (await this.disposeRecord(current, "idle_timeout")) expired += 1;
    }
    return expired;
  }

  private async disposeRecord(record: BrowserSessionRecord, reason: "explicit" | "idle_timeout" | "shutdown" = "explicit"): Promise<boolean> {
    const current = this.sessions.get(record.id);
    if (!current) return false;
    if (reason === "idle_timeout" && current.activeCount > 0) return false;
    this.sessions.delete(record.id);
    if (current.mode === "isolated") {
      await destroyPersistentCloneBrowserTarget(current.browserTarget, this.telemetryStore, {
        browserSessionId: current.id,
        browserSessionMode: current.mode,
        ownerSessionId: current.ownerSessionId,
        reason,
        cloneId: current.cloneId,
      });
    }
    safeRecordBrowserSpan(this.telemetryStore, "browser.session.close", 0, {
      browserSessionId: current.id,
      browserSessionMode: current.mode,
      browserSession: current.browserTarget.sessionName,
      ownerSessionId: current.ownerSessionId,
      reason,
      cloneId: current.cloneId,
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
