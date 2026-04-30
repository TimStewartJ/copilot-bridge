import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

export type CopilotUsageSkipReason = "no_events" | "no_shutdown" | "empty_model_metrics" | "parse_error";

export interface CopilotUsageTotals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export interface CopilotUsageModelRow extends CopilotUsageTotals {
  model: string;
  sessions: number;
}

export interface CopilotUsageSessionRow extends CopilotUsageTotals {
  sessionId: string;
  shutdownAt: string | null;
  models: CopilotUsageModelRow[];
}

export interface CopilotUsageCoverage {
  sessionsSeen: number;
  sessionsWithEvents: number;
  sessionsIncluded: number;
  sessionsSkipped: number;
  skippedByReason: Record<CopilotUsageSkipReason, number>;
  earliestIncludedAt: string | null;
  latestIncludedAt: string | null;
  earliestSkippedAt: string | null;
  latestSkippedAt: string | null;
}

export interface CopilotUsageSummary {
  generatedAt: string;
  totals: CopilotUsageTotals;
  coverage: CopilotUsageCoverage;
  models: CopilotUsageModelRow[];
  sessions: CopilotUsageSessionRow[];
}

export interface ReadCopilotUsageSummaryOptions {
  copilotHome: string;
  now?: () => number;
  concurrency?: number;
}

export interface CopilotUsageReaderOptions extends ReadCopilotUsageSummaryOptions {
  ttlMs?: number;
  loadSummary?: (options: ReadCopilotUsageSummaryOptions) => Promise<CopilotUsageSummary>;
}

export interface CopilotUsageReader {
  readSummary(options?: { refresh?: boolean }): Promise<CopilotUsageSummary>;
  invalidate(): void;
}

interface SessionScanResult {
  hasEvents: boolean;
  included: boolean;
  reason?: CopilotUsageSkipReason;
  includedUsageAts: string[];
  skippedAt: string | null;
  modelRows: CopilotUsageModelRow[];
  totals: CopilotUsageTotals;
  sessionRow?: CopilotUsageSessionRow;
}

interface AssistantUsageAccumulator {
  model: string;
  outputTokens: number;
  timestamp: string | null;
}

const DEFAULT_SCAN_CONCURRENCY = 8;
const DEFAULT_CACHE_TTL_MS = 30_000;
const COPILOT_USAGE_READ_ERROR_MESSAGE = "Unable to read local Copilot usage history.";

export class CopilotUsageReadError extends Error {
  constructor(message = COPILOT_USAGE_READ_ERROR_MESSAGE) {
    super(message);
    this.name = "CopilotUsageReadError";
  }
}

export async function readCopilotUsageSummary({
  copilotHome,
  now = Date.now,
  concurrency = DEFAULT_SCAN_CONCURRENCY,
}: ReadCopilotUsageSummaryOptions): Promise<CopilotUsageSummary> {
  const summary = createEmptySummary(now);
  const sessionStateDir = join(copilotHome, "session-state");

  let sessionDirs: string[];
  try {
    const entries = await readdir(sessionStateDir, { withFileTypes: true });
    sessionDirs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return summary;
    }
    throw new CopilotUsageReadError();
  }

  try {
    summary.coverage.sessionsSeen = sessionDirs.length;

    const sessionResults = await mapWithConcurrency(
      sessionDirs,
      Math.max(1, concurrency),
      (sessionId) => scanSession(sessionStateDir, sessionId),
    );

    const modelTotals = new Map<string, CopilotUsageModelRow>();
    for (const result of sessionResults) {
      if (result.hasEvents) summary.coverage.sessionsWithEvents += 1;

      if (result.included) {
        summary.coverage.sessionsIncluded += 1;
        for (const usageAt of result.includedUsageAts) {
          updateCoverageWindow(summary.coverage, "included", usageAt);
        }
        addTotals(summary.totals, result.totals);
        if (result.sessionRow) {
          summary.sessions.push(result.sessionRow);
        }

        for (const row of result.modelRows) {
          const existing = modelTotals.get(row.model) ?? { ...createZeroTotals(), model: row.model, sessions: 0 };
          existing.sessions += row.sessions;
          addTotals(existing, row);
          modelTotals.set(row.model, existing);
        }
        continue;
      }

      summary.coverage.sessionsSkipped += 1;
      if (result.reason) {
        summary.coverage.skippedByReason[result.reason] += 1;
      }
      updateCoverageWindow(summary.coverage, "skipped", result.skippedAt);
    }

    summary.models = [...modelTotals.values()].sort((left, right) => (
      right.totalTokens - left.totalTokens
      || right.requests - left.requests
      || right.sessions - left.sessions
      || left.model.localeCompare(right.model)
    ));
    summary.sessions.sort((left, right) => (
      compareNullableTimestampsDesc(left.shutdownAt, right.shutdownAt)
      || right.totalTokens - left.totalTokens
      || left.sessionId.localeCompare(right.sessionId)
    ));

    return summary;
  } catch (error) {
    if (error instanceof CopilotUsageReadError) {
      throw error;
    }
    throw new CopilotUsageReadError();
  }
}

export function createCopilotUsageReader({
  copilotHome,
  now = Date.now,
  concurrency = DEFAULT_SCAN_CONCURRENCY,
  ttlMs = DEFAULT_CACHE_TTL_MS,
  loadSummary: loadSummaryImpl = readCopilotUsageSummary,
}: CopilotUsageReaderOptions): CopilotUsageReader {
  let cached: { summary: CopilotUsageSummary; expiresAt: number } | null = null;
  let inflight: { generation: number; promise: Promise<CopilotUsageSummary> } | null = null;
  let latestGeneration = 0;

  async function loadCachedSummary(refresh = false): Promise<CopilotUsageSummary> {
    const currentTime = now();
    if (!refresh && cached && currentTime < cached.expiresAt) {
      return cached.summary;
    }
    if (!refresh && inflight) {
      return inflight.promise;
    }

    const generation = latestGeneration + 1;
    latestGeneration = generation;
    const promise = loadSummaryImpl({ copilotHome, now, concurrency })
      .then((summary) => {
        if (generation === latestGeneration) {
          cached = { summary, expiresAt: now() + Math.max(0, ttlMs) };
        }
        return summary;
      })
      .finally(() => {
        if (inflight?.generation === generation) {
          inflight = null;
        }
      });
    inflight = { generation, promise };

    return promise;
  }

  return {
    readSummary: async (options) => loadCachedSummary(options?.refresh === true),
    invalidate: () => {
      cached = null;
    },
  };
}

async function scanSession(sessionStateDir: string, sessionId: string): Promise<SessionScanResult> {
  const eventsPath = join(sessionStateDir, sessionId, "events.jsonl");

  try {
    const eventsStat = await stat(eventsPath);
    if (!eventsStat.isFile()) {
      return createSkippedResult("no_events", null, false);
    }
  } catch (error) {
    const code = getErrorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") {
      return createSkippedResult("no_events", null, false);
    }
    return createSkippedResult("parse_error", null, false);
  }

  let sawShutdown = false;
  let latestShutdownAt: string | null = null;
  let selectedModel = "unknown";
  const usableShutdowns: Array<{ shutdownAt: string | null; modelMetrics: Record<string, unknown> }> = [];
  const assistantUsageByRequest = new Map<string, AssistantUsageAccumulator>();
  let fallbackEventIndex = 0;
  const stream = createReadStream(eventsPath, { encoding: "utf-8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of lines) {
      if (!line.trim()) continue;

      let event: unknown;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }

      const eventRecord = asRecord(event);
      const eventAt = normalizeTimestamp(eventRecord?.timestamp);
      const data = asRecord(eventRecord?.data);
      if (eventRecord?.type === "session.start") {
        selectedModel = normalizeModelName(data?.selectedModel) ?? selectedModel;
        continue;
      }

      if (eventRecord?.type === "session.resume") {
        selectedModel = normalizeModelName(data?.selectedModel) ?? selectedModel;
        continue;
      }

      if (eventRecord?.type === "session.model_change") {
        selectedModel = normalizeModelName(data?.newModel) ?? selectedModel;
        continue;
      }

      if (eventRecord?.type === "assistant.message") {
        const outputTokens = toNumber(data?.outputTokens);
        if (outputTokens > 0) {
          const requestId = typeof data?.requestId === "string" && data.requestId.trim()
            ? data.requestId.trim()
            : `event:${fallbackEventIndex++}`;
          const key = `${selectedModel}\u0000${requestId}`;
          const existing = assistantUsageByRequest.get(key);
          if (!existing || outputTokens > existing.outputTokens) {
            assistantUsageByRequest.set(key, {
              model: selectedModel,
              outputTokens,
              timestamp: eventAt,
            });
          }
        }
        continue;
      }

      if (eventRecord?.type !== "session.shutdown") {
        continue;
      }

      sawShutdown = true;
      latestShutdownAt = eventAt ?? latestShutdownAt;

      const modelMetrics = asRecord(data?.modelMetrics);
      if (modelMetrics && Object.keys(modelMetrics).length > 0) {
        usableShutdowns.push({ shutdownAt: eventAt, modelMetrics });
      }
    }
  } catch {
    return createSkippedResult("parse_error", latestShutdownAt, true);
  } finally {
    lines.close();
    stream.destroy();
  }

  if (usableShutdowns.length === 0 && assistantUsageByRequest.size > 0) {
    return createIncludedResult(sessionId, buildAssistantUsageRows(assistantUsageByRequest));
  }

  if (!sawShutdown) {
    return createSkippedResult("no_shutdown", null, true);
  }

  if (usableShutdowns.length === 0) {
    return createSkippedResult("empty_model_metrics", latestShutdownAt, true);
  }

  const modelTotals = new Map<string, CopilotUsageModelRow>();
  const includedShutdownAts: string[] = [];
  for (const usableShutdown of usableShutdowns) {
    if (usableShutdown.shutdownAt) {
      includedShutdownAts.push(usableShutdown.shutdownAt);
    }
    for (const [modelName, metrics] of Object.entries(usableShutdown.modelMetrics)) {
      const model = modelName.trim() || "unknown";
      const existing = modelTotals.get(model) ?? { ...createZeroTotals(), model, sessions: 0 };
      if (existing.sessions === 0) {
        existing.sessions = 1;
      }
      addTotals(existing, extractTotals(metrics));
      modelTotals.set(model, existing);
    }
  }

  return createIncludedResult(sessionId, {
    modelRows: [...modelTotals.values()],
    includedUsageAts: includedShutdownAts,
  });
}

function buildAssistantUsageRows(usageByRequest: Map<string, AssistantUsageAccumulator>) {
  const modelTotals = new Map<string, CopilotUsageModelRow>();
  const includedUsageAts: string[] = [];

  for (const usage of usageByRequest.values()) {
    const existing = modelTotals.get(usage.model) ?? { ...createZeroTotals(), model: usage.model, sessions: 1 };
    existing.requests += 1;
    existing.outputTokens += usage.outputTokens;
    existing.totalTokens += usage.outputTokens;
    modelTotals.set(usage.model, existing);
    if (usage.timestamp) {
      includedUsageAts.push(usage.timestamp);
    }
  }

  return {
    modelRows: [...modelTotals.values()],
    includedUsageAts,
  };
}

function createIncludedResult(
  sessionId: string,
  usage: { modelRows: CopilotUsageModelRow[]; includedUsageAts: string[] },
): SessionScanResult {
  const modelRows = usage.modelRows.sort((left, right) => (
    right.totalTokens - left.totalTokens
    || right.requests - left.requests
    || left.model.localeCompare(right.model)
  ));
  const totals = createZeroTotals();
  for (const row of modelRows) {
    addTotals(totals, row);
  }

  return {
    hasEvents: true,
    included: true,
    includedUsageAts: usage.includedUsageAts,
    skippedAt: null,
    modelRows,
    totals,
    sessionRow: {
      sessionId,
      shutdownAt: maxTimestampFromList(usage.includedUsageAts),
      models: modelRows,
      ...totals,
    },
  };
}

function createEmptySummary(now: () => number): CopilotUsageSummary {
  return {
    generatedAt: new Date(now()).toISOString(),
    totals: createZeroTotals(),
    coverage: {
      sessionsSeen: 0,
      sessionsWithEvents: 0,
      sessionsIncluded: 0,
      sessionsSkipped: 0,
      skippedByReason: {
        no_events: 0,
        no_shutdown: 0,
        empty_model_metrics: 0,
        parse_error: 0,
      },
      earliestIncludedAt: null,
      latestIncludedAt: null,
      earliestSkippedAt: null,
      latestSkippedAt: null,
    },
    models: [],
    sessions: [],
  };
}

function createZeroTotals(): CopilotUsageTotals {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
  };
}

function createSkippedResult(
  reason: CopilotUsageSkipReason,
  shutdownAt: string | null,
  hasEvents: boolean,
): SessionScanResult {
  return {
    hasEvents,
    included: false,
    reason,
    includedUsageAts: [],
    skippedAt: shutdownAt,
    modelRows: [],
    totals: createZeroTotals(),
  };
}

function extractTotals(value: unknown): CopilotUsageTotals {
  const metricRecord = asRecord(value);
  const requestRecord = asRecord(metricRecord?.requests);
  const usageRecord = asRecord(metricRecord?.usage);

  const totals = {
    requests: toNumber(requestRecord?.count),
    inputTokens: toNumber(usageRecord?.inputTokens),
    outputTokens: toNumber(usageRecord?.outputTokens),
    cacheReadTokens: toNumber(usageRecord?.cacheReadTokens),
    cacheWriteTokens: toNumber(usageRecord?.cacheWriteTokens),
    reasoningTokens: toNumber(usageRecord?.reasoningTokens),
    totalTokens: 0,
  };
  totals.totalTokens = totals.inputTokens
    + totals.outputTokens
    + totals.cacheReadTokens
    + totals.cacheWriteTokens
    + totals.reasoningTokens;
  return totals;
}

function addTotals(target: CopilotUsageTotals, delta: CopilotUsageTotals): void {
  target.requests += delta.requests;
  target.inputTokens += delta.inputTokens;
  target.outputTokens += delta.outputTokens;
  target.cacheReadTokens += delta.cacheReadTokens;
  target.cacheWriteTokens += delta.cacheWriteTokens;
  target.reasoningTokens += delta.reasoningTokens;
  target.totalTokens += delta.totalTokens;
}

function updateCoverageWindow(
  coverage: CopilotUsageCoverage,
  kind: "included" | "skipped",
  timestamp: string | null,
): void {
  if (!timestamp) return;
  if (kind === "included") {
    coverage.earliestIncludedAt = minTimestamp(coverage.earliestIncludedAt, timestamp);
    coverage.latestIncludedAt = maxTimestamp(coverage.latestIncludedAt, timestamp);
    return;
  }
  coverage.earliestSkippedAt = minTimestamp(coverage.earliestSkippedAt, timestamp);
  coverage.latestSkippedAt = maxTimestamp(coverage.latestSkippedAt, timestamp);
}

function minTimestamp(current: string | null, candidate: string): string {
  return !current || candidate < current ? candidate : current;
}

function maxTimestamp(current: string | null, candidate: string): string {
  return !current || candidate > current ? candidate : current;
}

function maxTimestampFromList(values: string[]): string | null {
  return values.reduce<string | null>((latest, value) => maxTimestamp(latest, value), null);
}

function compareNullableTimestampsDesc(left: string | null, right: string | null): number {
  if (left && right) return right.localeCompare(left);
  if (left) return -1;
  if (right) return 1;
  return 0;
}

function toNumber(value: unknown): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function normalizeModelName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function getErrorCode(error: unknown): string | undefined {
  return error && typeof error === "object" && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (nextIndex < items.length) {
        const currentIndex = nextIndex++;
        results[currentIndex] = await mapper(items[currentIndex], currentIndex);
      }
    }),
  );

  return results;
}
