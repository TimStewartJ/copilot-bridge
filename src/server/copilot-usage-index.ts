import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { CopilotModelMetadataForPricing } from "../shared/copilot-pricing.js";
import { BRIDGE_SESSION_MODEL_STATE_FILE } from "./session-model-state-sidecar.js";
import {
  buildCopilotUsageSummaryFromSessionResults,
  COPILOT_USAGE_PARSER_VERSION,
  scanCopilotUsageSession,
  type CopilotUsageIndexStatus,
  type CopilotUsageModelMetadataProvider,
  type CopilotUsageReader,
  type CopilotUsageSessionScanResult,
} from "./copilot-usage.js";
import type {
  CopilotUsageCacheEntry,
  CopilotUsageFileFingerprint,
  CopilotUsageSessionFingerprint,
  CopilotUsageStore,
} from "./copilot-usage-store.js";

export interface IncrementalCopilotUsageReaderOptions {
  copilotHome: string;
  store: CopilotUsageStore;
  now?: () => number;
  refreshIntervalMs?: number;
  concurrency?: number;
  batchSize?: number;
  sdkModels?: readonly CopilotModelMetadataForPricing[];
  modelMetadataProvider?: CopilotUsageModelMetadataProvider;
  scanSession?: (sessionStateDir: string, sessionId: string) => Promise<CopilotUsageSessionScanResult>;
}

const DEFAULT_REFRESH_INTERVAL_MS = 5 * 60_000;
const DEFAULT_SCAN_CONCURRENCY = 2;
const DEFAULT_BATCH_SIZE = 16;
const INDEX_ERROR_MESSAGE = "Local Copilot usage indexing failed. Cached results are still available.";

export function createIncrementalCopilotUsageReader({
  copilotHome,
  store,
  now = Date.now,
  refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS,
  concurrency = DEFAULT_SCAN_CONCURRENCY,
  batchSize = DEFAULT_BATCH_SIZE,
  sdkModels: staticSdkModels,
  modelMetadataProvider,
  scanSession = scanCopilotUsageSession,
}: IncrementalCopilotUsageReaderOptions): CopilotUsageReader {
  const sessionStateDir = join(copilotHome, "session-state");
  const persistedSessionIds = new Set(store.listSessionIds());
  const cacheEntries = new Map<string, CopilotUsageCacheEntry>();
  for (const entry of store.listEntries()) {
    if (entry.parserVersion === COPILOT_USAGE_PARSER_VERSION) {
      cacheEntries.set(entry.sessionId, entry);
    }
  }

  let sdkModels = staticSdkModels;
  let inflight: Promise<void> | null = null;
  let rerunRequested = false;
  let lastAttemptAt = cacheEntries.size > 0 && cacheEntries.size === persistedSessionIds.size
    ? parseTimestamp(store.getLastCompletedAt()) ?? 0
    : 0;
  const prioritySessionIds = new Set<string>();
  const missingRequestedCheckedAt = new Map<string, number>();
  const status: CopilotUsageIndexStatus = {
    state: "idle",
    startedAt: null,
    completedAt: store.getLastCompletedAt(),
    sessionsTotal: cacheEntries.size,
    sessionsProcessed: cacheEntries.size,
    sessionsUpdated: 0,
    cachedSessions: cacheEntries.size,
    error: null,
  };

  function readSummary(options?: { refresh?: boolean; sessionIds?: readonly string[] }) {
    const currentTime = now();
    const uncachedRequestedSessionIds = options?.sessionIds?.filter((sessionId) => {
      if (cacheEntries.has(sessionId)) return false;
      const checkedAt = missingRequestedCheckedAt.get(sessionId);
      return checkedAt === undefined
        || currentTime - checkedAt >= Math.max(0, refreshIntervalMs);
    });
    queuePrioritySessions(uncachedRequestedSessionIds);
    const hasUncachedRequestedSession = (uncachedRequestedSessionIds?.length ?? 0) > 0;
    if (inflight) {
      if (options?.refresh === true) scheduleRefresh(true);
    } else {
      scheduleRefresh(options?.refresh === true || hasUncachedRequestedSession);
    }
    const requestedSessions = options?.sessionIds?.length;
    const requestedSessionsCached = options?.sessionIds?.filter((sessionId) => cacheEntries.has(sessionId)).length;
    return Promise.resolve(buildCopilotUsageSummaryFromSessionResults({
      sessionResults: [...cacheEntries.values()].map((entry) => entry.result),
      sessionsSeen: status.sessionsTotal,
      now,
      sdkModels,
      sessionIds: options?.sessionIds,
      index: {
        ...status,
        ...(requestedSessions !== undefined ? { requestedSessions } : {}),
        ...(requestedSessionsCached !== undefined ? { requestedSessionsCached } : {}),
      },
    }));
  }

  function queuePrioritySessions(sessionIds: readonly string[] | undefined): void {
    if (!sessionIds) return;
    for (const sessionId of sessionIds) {
      if (sessionId) prioritySessionIds.add(sessionId);
    }
  }

  function scheduleRefresh(force: boolean): boolean {
    if (inflight) {
      rerunRequested ||= force;
      return false;
    }

    const currentTime = now();
    if (!force && lastAttemptAt > 0 && currentTime - lastAttemptAt < Math.max(0, refreshIntervalMs)) {
      return false;
    }

    lastAttemptAt = currentTime;
    status.state = "scanning";
    status.startedAt = new Date(currentTime).toISOString();
    status.sessionsProcessed = 0;
    status.sessionsUpdated = 0;
    status.error = null;
    refreshModelMetadata();

    inflight = runRefresh()
      .catch((error) => {
        status.state = "error";
        status.error = INDEX_ERROR_MESSAGE;
        console.error("[copilot-usage] Incremental usage indexing failed.", error);
      })
      .finally(() => {
        inflight = null;
        if (rerunRequested) {
          rerunRequested = false;
          scheduleRefresh(true);
        }
      });
    return true;
  }

  function refreshModelMetadata(): void {
    if (!modelMetadataProvider) return;
    Promise.resolve()
      .then(() => modelMetadataProvider())
      .then((models) => {
        sdkModels = models;
      })
      .catch((error) => {
        console.warn("[copilot-usage] Failed to refresh Copilot model metadata; cached pricing remains in use.", error);
      });
  }

  async function runRefresh(): Promise<void> {
    const sessionIds = await listSessionDirectories(sessionStateDir);
    const seenSessionIds = new Set(sessionIds);
    const processedSessionIds = new Set<string>();
    const checkedRequestedSessionIds = new Set<string>();
    status.sessionsTotal = sessionIds.length;
    status.cachedSessions = cacheEntries.size;

    const initialPriorityIds = takePrioritySessions(
      seenSessionIds,
      processedSessionIds,
      checkedRequestedSessionIds,
    );
    const orderedSessionIds = [
      ...initialPriorityIds,
      ...sessionIds.filter((sessionId) => !initialPriorityIds.includes(sessionId)),
    ];

    for (let offset = 0; offset < orderedSessionIds.length; offset += Math.max(1, batchSize)) {
      const newlyPrioritized = takePrioritySessions(
        seenSessionIds,
        processedSessionIds,
        checkedRequestedSessionIds,
      );
      if (newlyPrioritized.length > 0) {
        await processBatch(newlyPrioritized, processedSessionIds);
      }

      const batch = orderedSessionIds
        .slice(offset, offset + Math.max(1, batchSize))
        .filter((sessionId) => !processedSessionIds.has(sessionId));
      await processBatch(batch, processedSessionIds);
      await yieldToEventLoop();
    }

    const finalPriorityIds = takePrioritySessions(
      seenSessionIds,
      processedSessionIds,
      checkedRequestedSessionIds,
    );
    if (finalPriorityIds.length > 0) {
      await processBatch(finalPriorityIds, processedSessionIds);
    }

    const deletedSessionIds = [...persistedSessionIds]
      .filter((sessionId) => !seenSessionIds.has(sessionId));
    if (deletedSessionIds.length > 0) {
      store.deleteEntries(deletedSessionIds);
      for (const sessionId of deletedSessionIds) {
        cacheEntries.delete(sessionId);
        persistedSessionIds.delete(sessionId);
      }
    }

    const completedAt = new Date(now()).toISOString();
    store.setLastCompletedAt(completedAt);
    const completedAtMs = parseTimestamp(completedAt) ?? now();
    for (const sessionId of checkedRequestedSessionIds) {
      if (seenSessionIds.has(sessionId)) {
        missingRequestedCheckedAt.delete(sessionId);
      } else {
        missingRequestedCheckedAt.set(sessionId, completedAtMs);
      }
    }
    status.state = "idle";
    status.completedAt = completedAt;
    status.sessionsProcessed = sessionIds.length;
    status.cachedSessions = cacheEntries.size;
    status.error = null;
  }

  async function processBatch(
    sessionIds: readonly string[],
    processedSessionIds: Set<string>,
  ): Promise<void> {
    if (sessionIds.length === 0) return;
    const outcomes = await mapWithConcurrency(
      [...sessionIds],
      Math.max(1, concurrency),
      inspectSession,
    );
    const changedEntries = outcomes.filter(
      (entry): entry is CopilotUsageCacheEntry => entry !== null,
    );
    if (changedEntries.length > 0) {
      store.upsertEntries(changedEntries);
      for (const entry of changedEntries) {
        cacheEntries.set(entry.sessionId, entry);
        persistedSessionIds.add(entry.sessionId);
        missingRequestedCheckedAt.delete(entry.sessionId);
      }
      status.sessionsUpdated += changedEntries.length;
      status.cachedSessions = cacheEntries.size;
    }
    for (const sessionId of sessionIds) {
      processedSessionIds.add(sessionId);
    }
    status.sessionsProcessed = Math.min(
      status.sessionsTotal,
      status.sessionsProcessed + sessionIds.length,
    );
  }

  async function inspectSession(sessionId: string): Promise<CopilotUsageCacheEntry | null> {
    const fingerprint = await readSessionFingerprint(sessionStateDir, sessionId);
    const cached = cacheEntries.get(sessionId);
    if (
      cached
      && cached.parserVersion === COPILOT_USAGE_PARSER_VERSION
      && fingerprintsEqual(cached.fingerprint, fingerprint)
    ) {
      return null;
    }

    const result = await scanSession(sessionStateDir, sessionId);
    return {
      sessionId,
      parserVersion: COPILOT_USAGE_PARSER_VERSION,
      fingerprint,
      result,
    };
  }

  function takePrioritySessions(
    seenSessionIds: ReadonlySet<string>,
    processedSessionIds: ReadonlySet<string>,
    checkedRequestedSessionIds: Set<string>,
  ): string[] {
    const pending: string[] = [];
    for (const sessionId of prioritySessionIds) {
      prioritySessionIds.delete(sessionId);
      checkedRequestedSessionIds.add(sessionId);
      if (seenSessionIds.has(sessionId) && !processedSessionIds.has(sessionId)) {
        pending.push(sessionId);
      }
    }
    return pending;
  }

  return {
    readSummary,
    invalidate: () => scheduleRefresh(true),
    startBackgroundRefresh: () => {
      if (!scheduleRefresh(false)) {
        refreshModelMetadata();
      }
    },
  };
}

async function listSessionDirectories(sessionStateDir: string): Promise<string[]> {
  try {
    const entries = await readdir(sessionStateDir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") return [];
    throw error;
  }
}

async function readSessionFingerprint(
  sessionStateDir: string,
  sessionId: string,
): Promise<CopilotUsageSessionFingerprint> {
  const sessionDir = join(sessionStateDir, sessionId);
  const [events, modelState] = await Promise.all([
    readFileFingerprint(join(sessionDir, "events.jsonl")),
    readFileFingerprint(join(sessionDir, BRIDGE_SESSION_MODEL_STATE_FILE)),
  ]);
  return { events, modelState };
}

async function readFileFingerprint(path: string): Promise<CopilotUsageFileFingerprint> {
  try {
    const fileStat = await stat(path);
    if (!fileStat.isFile()) return { state: "missing" };
    return {
      state: "file",
      size: fileStat.size,
      mtimeMs: fileStat.mtimeMs,
    };
  } catch (error) {
    const code = getErrorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return { state: "missing" };
    return { state: "error" };
  }
}

function fingerprintsEqual(
  left: CopilotUsageSessionFingerprint,
  right: CopilotUsageSessionFingerprint,
): boolean {
  return fileFingerprintsEqual(left.events, right.events)
    && fileFingerprintsEqual(left.modelState, right.modelState);
}

function fileFingerprintsEqual(
  left: CopilotUsageFileFingerprint,
  right: CopilotUsageFileFingerprint,
): boolean {
  if (left.state === "error" || right.state === "error" || left.state !== right.state) return false;
  if (left.state === "missing" || right.state === "missing") return true;
  return left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function parseTimestamp(value: string | null): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function getErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex++;
        results[index] = await mapper(items[index]);
      }
    }),
  );
  return results;
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
