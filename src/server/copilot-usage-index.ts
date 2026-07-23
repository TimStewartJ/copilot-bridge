import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { CopilotModelMetadataForPricing } from "../shared/copilot-pricing.js";
import type { CopilotModelPriceLoader } from "./copilot-model-price-loader.js";
import { BRIDGE_SESSION_MODEL_STATE_FILE } from "./session-model-state-sidecar.js";
import {
  buildCopilotUsageSummaryFromSessionResults,
  COPILOT_USAGE_PARSER_VERSION,
  scanCopilotUsageSession,
  type CopilotUsageIndexStatus,
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
  modelPriceLoader?: CopilotModelPriceLoader;
  scanSession?: (sessionStateDir: string, sessionId: string) => Promise<CopilotUsageSessionScanResult>;
}

const DEFAULT_REFRESH_INTERVAL_MS = 5 * 60_000;
const DEFAULT_SCAN_CONCURRENCY = 2;
const DEFAULT_BATCH_SIZE = 16;
const INDEX_ERROR_MESSAGE = "Local Copilot usage indexing failed. Cached results are still available.";

interface CopilotUsageSessionScanFailure {
  kind: "failed";
  sessionId: string;
  error: unknown;
}

type CopilotUsageSessionInspectionOutcome =
  | { kind: "unchanged"; sessionId: string }
  | { kind: "updated"; entry: CopilotUsageCacheEntry }
  | CopilotUsageSessionScanFailure;

export function createIncrementalCopilotUsageReader({
  copilotHome,
  store,
  now = Date.now,
  refreshIntervalMs = DEFAULT_REFRESH_INTERVAL_MS,
  concurrency = DEFAULT_SCAN_CONCURRENCY,
  batchSize = DEFAULT_BATCH_SIZE,
  sdkModels: staticSdkModels,
  modelPriceLoader,
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

  let inflight: Promise<void> | null = null;
  let rerunRequested = false;
  let stopped = false;
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
    sessionsFailed: 0,
    cachedSessions: cacheEntries.size,
    warning: null,
    error: null,
  };

  function readSummary(options?: { refresh?: boolean; sessionIds?: readonly string[] }) {
    const currentTime = now();
    requestModelPriceRefresh(options?.refresh === true);
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
    const modelSnapshot = modelPriceLoader?.getSnapshot();
    const indexState = status.state === "scanning" || modelSnapshot?.refreshState === "refreshing"
      ? "scanning"
      : status.state;
    return Promise.resolve(buildCopilotUsageSummaryFromSessionResults({
      sessionResults: [...cacheEntries.values()].map((entry) => entry.result),
      sessionsSeen: status.sessionsTotal,
      now,
      sdkModels: modelSnapshot?.models ?? staticSdkModels,
      sessionIds: options?.sessionIds,
      index: {
        ...status,
        state: indexState,
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
    if (stopped) return false;
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
    status.sessionsFailed = 0;
    status.warning = null;
    status.error = null;

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

  function requestModelPriceRefresh(force: boolean): void {
    if (!modelPriceLoader) return;
    void modelPriceLoader.refresh({ force });
  }

  async function runRefresh(): Promise<void> {
    const sessionIds = await listSessionDirectories(sessionStateDir);
    const seenSessionIds = new Set(sessionIds);
    const processedSessionIds = new Set<string>();
    const checkedRequestedSessionIds = new Set<string>();
    const failedSessions: CopilotUsageSessionScanFailure[] = [];
    const failedSessionIds = new Set<string>();
    status.sessionsTotal = sessionIds.length;
    status.cachedSessions = cacheEntries.size;

    const processRefreshBatch = async (batch: readonly string[]): Promise<void> => {
      const failures = await processBatch(batch, processedSessionIds);
      for (const failure of failures) {
        failedSessions.push(failure);
        failedSessionIds.add(failure.sessionId);
      }
    };

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
        await processRefreshBatch(newlyPrioritized);
      }

      const batch = orderedSessionIds
        .slice(offset, offset + Math.max(1, batchSize))
        .filter((sessionId) => !processedSessionIds.has(sessionId));
      await processRefreshBatch(batch);
      await yieldToEventLoop();
    }

    const finalPriorityIds = takePrioritySessions(
      seenSessionIds,
      processedSessionIds,
      checkedRequestedSessionIds,
    );
    if (finalPriorityIds.length > 0) {
      await processRefreshBatch(finalPriorityIds);
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
      if (seenSessionIds.has(sessionId) && !failedSessionIds.has(sessionId)) {
        missingRequestedCheckedAt.delete(sessionId);
      } else {
        missingRequestedCheckedAt.set(sessionId, completedAtMs);
      }
    }
    if (failedSessions.length > 0) {
      console.warn(
        `[copilot-usage] ${formatSessionScanWarning(failedSessions.length)} First failed session: ${failedSessions[0].sessionId}.`,
        failedSessions[0].error,
      );
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
  ): Promise<CopilotUsageSessionScanFailure[]> {
    if (sessionIds.length === 0) return [];
    const outcomes = await mapWithConcurrency(
      [...sessionIds],
      Math.max(1, concurrency),
      inspectSession,
    );
    const changedEntries = outcomes.flatMap((outcome) => (
      outcome.kind === "updated" ? [outcome.entry] : []
    ));
    const failures = outcomes.filter(
      (outcome): outcome is CopilotUsageSessionScanFailure => outcome.kind === "failed",
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
    status.sessionsFailed += failures.length;
    status.warning = formatSessionScanWarning(status.sessionsFailed);
    for (const sessionId of sessionIds) {
      processedSessionIds.add(sessionId);
    }
    status.sessionsProcessed = Math.min(
      status.sessionsTotal,
      status.sessionsProcessed + sessionIds.length,
    );
    return failures;
  }

  async function inspectSession(sessionId: string): Promise<CopilotUsageSessionInspectionOutcome> {
    const fingerprint = await readSessionFingerprint(sessionStateDir, sessionId);
    const cached = cacheEntries.get(sessionId);
    if (
      cached
      && cached.parserVersion === COPILOT_USAGE_PARSER_VERSION
      && fingerprintsEqual(cached.fingerprint, fingerprint)
    ) {
      return { kind: "unchanged", sessionId };
    }

    try {
      const result = await scanSession(sessionStateDir, sessionId);
      return {
        kind: "updated",
        entry: {
          sessionId,
          parserVersion: COPILOT_USAGE_PARSER_VERSION,
          fingerprint,
          result,
        },
      };
    } catch (error) {
      return { kind: "failed", sessionId, error };
    }
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
    invalidate: () => {
      requestModelPriceRefresh(true);
      scheduleRefresh(true);
    },
    startBackgroundRefresh: () => {
      requestModelPriceRefresh(false);
      scheduleRefresh(false);
    },
    shutdown: async () => {
      stopped = true;
      rerunRequested = false;
      await inflight;
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

function formatSessionScanWarning(failedSessions: number): string | null {
  if (failedSessions === 0) return null;
  const sessionLabel = failedSessions === 1 ? "session" : "sessions";
  return `${failedSessions} local Copilot usage ${sessionLabel} failed to index. Cached results were retained when available.`;
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
