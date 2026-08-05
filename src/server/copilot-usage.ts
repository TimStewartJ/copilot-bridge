import { createReadStream } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";
import {
  COPILOT_TOKEN_PRICING_UNIT,
  getCopilotPricingRatesFromModelMetadata,
  resolveCopilotPricingModel,
  usdToCopilotAiCredits,
  type CopilotPricingRatesUsdPerMillionTokens,
  type CopilotModelMetadataForPricing,
  type CopilotPricingModelResolutionStatus,
} from "../shared/copilot-pricing.js";
import {
  isCopilotContextTier,
  type CopilotContextTier,
} from "../shared/copilot-context.js";
import {
  copilotUsageDayKey,
  DEFAULT_COPILOT_USAGE_RANGE,
  resolveCopilotUsageRange,
  type CopilotUsageRange,
  type CopilotUsageRangeKey,
} from "../shared/copilot-usage-range.js";
import { BRIDGE_SESSION_MODEL_STATE_FILE } from "./session-model-state-sidecar.js";

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

export type CopilotUsageReasoningPricingAssumption = "reasoning_tokens_priced_at_output_rate";

export interface CopilotUsageCostBreakdownUsd {
  input: number;
  cachedInput: number;
  cacheWrite: number;
  output: number;
  reasoning: number;
  total: number;
}

export interface CopilotUsageCostEstimate {
  estimatedCostUsd: number;
  estimatedAiCredits: number;
  costBreakdownUsd: CopilotUsageCostBreakdownUsd;
  billableOutputTokens: number;
  reasoningPricingAssumption: CopilotUsageReasoningPricingAssumption;
}

export interface CopilotUsageSummaryTotals extends CopilotUsageTotals, CopilotUsageCostEstimate {
  unpricedModelCount: number;
  unpricedTokens: CopilotUsageTotals;
}

export interface CopilotUsageModelPricingMetadata {
  pricingKey: string | null;
  pricedAs: string | null;
  pricingStatus: CopilotPricingModelResolutionStatus;
  normalizedPricingModel: string | null;
  contextTier?: CopilotContextTier;
  contextTierLabel?: string;
}

export interface CopilotUsageUnpricedModelRow extends CopilotUsageTotals, CopilotUsageModelPricingMetadata {
  model: string;
  sessions: number;
  pricingKey: null;
  pricedAs: null;
  pricingStatus: "unpriced";
}

export interface CopilotUsageModelRow extends CopilotUsageTotals, CopilotUsageCostEstimate, CopilotUsageModelPricingMetadata {
  model: string;
  sessions: number;
}

export interface CopilotUsageSessionRow extends CopilotUsageTotals, CopilotUsageCostEstimate {
  sessionId: string;
  shutdownAt: string | null;
  models: CopilotUsageModelRow[];
  unpricedModels: CopilotUsageUnpricedModelRow[];
}

/**
 * Per local-calendar-day, per-model usage slice kept in the session cache so
 * bounded time windows can be aggregated without rescanning session events.
 */
export interface CopilotUsageDailyModelRow extends CopilotUsageTotals {
  date: string;
  model: string;
  contextTier?: CopilotContextTier;
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

export type CopilotUsageIndexState = "idle" | "scanning" | "error";

export interface CopilotUsageIndexStatus {
  state: CopilotUsageIndexState;
  startedAt: string | null;
  completedAt: string | null;
  sessionsTotal: number;
  sessionsProcessed: number;
  sessionsUpdated: number;
  sessionsFailed: number;
  cachedSessions: number;
  requestedSessions?: number;
  requestedSessionsCached?: number;
  warning: string | null;
  error: string | null;
}

export interface CopilotUsageSummary {
  generatedAt: string;
  range: CopilotUsageRange;
  totals: CopilotUsageSummaryTotals;
  coverage: CopilotUsageCoverage;
  models: CopilotUsageModelRow[];
  sessions: CopilotUsageSessionRow[];
  unpricedModels: CopilotUsageUnpricedModelRow[];
  index?: CopilotUsageIndexStatus;
}

export interface ReadCopilotUsageSummaryOptions {
  copilotHome: string;
  now?: () => number;
  concurrency?: number;
  sdkModels?: readonly CopilotModelMetadataForPricing[];
  range?: CopilotUsageRangeKey;
}

export interface CopilotUsageReader {
  readSummary(options?: {
    refresh?: boolean;
    sessionIds?: readonly string[];
    range?: CopilotUsageRangeKey;
  }): Promise<CopilotUsageSummary>;
  invalidate(): void;
  startBackgroundRefresh?(): void;
  shutdown(): Promise<void>;
}

export interface CopilotUsageSessionScanResult {
  hasEvents: boolean;
  included: boolean;
  reason?: CopilotUsageSkipReason;
  includedUsageAts: string[];
  skippedAt: string | null;
  modelRows: CopilotUsageModelRow[];
  dailyRows?: CopilotUsageDailyModelRow[];
  totals: CopilotUsageTotals;
  sessionRow?: CopilotUsageSessionRow;
}

interface AssistantUsageAccumulator {
  model: string;
  contextTier?: CopilotContextTier;
  outputTokens: number;
  timestamp: string | null;
}

const DEFAULT_SCAN_CONCURRENCY = 8;
const COPILOT_USAGE_READ_ERROR_MESSAGE = "Unable to read local Copilot usage history.";
const REASONING_PRICING_ASSUMPTION = "reasoning_tokens_priced_at_output_rate" as const;
export const COPILOT_USAGE_PARSER_VERSION = 3;

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
  sdkModels,
  range = DEFAULT_COPILOT_USAGE_RANGE,
}: ReadCopilotUsageSummaryOptions): Promise<CopilotUsageSummary> {
  const sessionStateDir = join(copilotHome, "session-state");

  let sessionDirs: string[];
  try {
    const entries = await readdir(sessionStateDir, { withFileTypes: true });
    sessionDirs = entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if (getErrorCode(error) === "ENOENT") {
      return createEmptySummary(now, resolveCopilotUsageRange(range, now()));
    }
    throw new CopilotUsageReadError();
  }

  try {
    const sessionResults = await mapWithConcurrency(
      sessionDirs,
      Math.max(1, concurrency),
      (sessionId) => scanCopilotUsageSession(sessionStateDir, sessionId),
    );
    return buildCopilotUsageSummaryFromSessionResults({
      sessionResults,
      sessionsSeen: sessionDirs.length,
      now,
      sdkModels,
      range,
    });
  } catch (error) {
    if (error instanceof CopilotUsageReadError) {
      throw error;
    }
    throw new CopilotUsageReadError();
  }
}

export function buildCopilotUsageSummaryFromSessionResults({
  sessionResults,
  sessionsSeen,
  now = Date.now,
  sdkModels,
  sessionIds,
  index,
  range = DEFAULT_COPILOT_USAGE_RANGE,
}: {
  sessionResults: Iterable<CopilotUsageSessionScanResult>;
  sessionsSeen?: number;
  now?: () => number;
  sdkModels?: readonly CopilotModelMetadataForPricing[];
  sessionIds?: readonly string[];
  index?: CopilotUsageIndexStatus;
  range?: CopilotUsageRangeKey;
}): CopilotUsageSummary {
  const resolvedRange = resolveCopilotUsageRange(range, now());
  const summary = createEmptySummary(now, resolvedRange);
  const requestedSessionIds = sessionIds ? new Set(sessionIds) : null;
  const modelTotals = new Map<string, CopilotUsageModelRow>();
  const startDate = resolvedRange.startDate;
  const startAtMs = resolvedRange.startAt ? Date.parse(resolvedRange.startAt) : null;
  let resultCount = 0;

  for (const result of sessionResults) {
    resultCount += 1;

    if (startDate !== null) {
      accumulateRangedSessionResult(result, {
        summary,
        modelTotals,
        requestedSessionIds,
        startDate,
        startAtMs,
      });
      continue;
    }

    if (result.hasEvents) summary.coverage.sessionsWithEvents += 1;

    if (result.included) {
      summary.coverage.sessionsIncluded += 1;
      for (const usageAt of result.includedUsageAts) {
        updateCoverageWindow(summary.coverage, "included", usageAt);
      }
      addTotals(summary.totals, result.totals);
      if (
        result.sessionRow
        && (!requestedSessionIds || requestedSessionIds.has(result.sessionRow.sessionId))
      ) {
        summary.sessions.push(cloneSessionRow(result.sessionRow));
      }

      for (const row of result.modelRows) {
        const key = usageModelKey(row.model, row.contextTier);
        const existing = modelTotals.get(key) ?? createZeroModelRow(row.model, 0, row.contextTier);
        existing.sessions += row.sessions;
        addTotals(existing, row);
        modelTotals.set(key, existing);
      }
      continue;
    }

    summary.coverage.sessionsSkipped += 1;
    if (result.reason) {
      summary.coverage.skippedByReason[result.reason] += 1;
    }
    updateCoverageWindow(summary.coverage, "skipped", result.skippedAt);
  }

  summary.coverage.sessionsSeen = startDate === null
    ? sessionsSeen ?? resultCount
    : summary.coverage.sessionsIncluded + summary.coverage.sessionsSkipped;
  summary.models = sortUsageModelRows([...modelTotals.values()]);
  summary.sessions.sort((left, right) => (
    compareNullableTimestampsDesc(left.shutdownAt, right.shutdownAt)
    || right.totalTokens - left.totalTokens
    || left.sessionId.localeCompare(right.sessionId)
  ));
  applyCopilotUsageCostEstimates(summary, sdkModels);
  if (index) summary.index = index;
  return summary;
}

/**
 * Bounded-window aggregation. Session results carry per-day model slices, so a
 * long-lived session only contributes the usage it actually recorded inside the
 * window instead of landing entirely on its last shutdown timestamp.
 */
function accumulateRangedSessionResult(
  result: CopilotUsageSessionScanResult,
  context: {
    summary: CopilotUsageSummary;
    modelTotals: Map<string, CopilotUsageModelRow>;
    requestedSessionIds: Set<string> | null;
    startDate: string;
    startAtMs: number | null;
  },
): void {
  const { summary, modelTotals, requestedSessionIds, startDate, startAtMs } = context;

  if (!result.included) {
    if (!isAtOrAfter(result.skippedAt, startAtMs)) return;
    if (result.hasEvents) summary.coverage.sessionsWithEvents += 1;
    summary.coverage.sessionsSkipped += 1;
    if (result.reason) {
      summary.coverage.skippedByReason[result.reason] += 1;
    }
    updateCoverageWindow(summary.coverage, "skipped", result.skippedAt);
    return;
  }

  // Zero-usage rows can survive in caches written before empty deltas were
  // dropped; counting them would report sessions that did no work in-window.
  const dailyRows = (result.dailyRows ?? []).filter(
    (row) => row.date >= startDate && hasUsageTotals(row),
  );
  if (dailyRows.length === 0) return;

  summary.coverage.sessionsIncluded += 1;
  if (result.hasEvents) summary.coverage.sessionsWithEvents += 1;

  const inRangeUsageAts = result.includedUsageAts.filter((usageAt) => isAtOrAfter(usageAt, startAtMs));
  for (const usageAt of inRangeUsageAts) {
    updateCoverageWindow(summary.coverage, "included", usageAt);
  }

  const sessionTotals = createZeroTotals();
  const sessionModelRows = new Map<string, CopilotUsageModelRow>();
  for (const row of dailyRows) {
    const key = usageModelKey(row.model, row.contextTier);
    addTotals(sessionTotals, row);

    const sessionRow = sessionModelRows.get(key) ?? createZeroModelRow(row.model, 1, row.contextTier);
    addTotals(sessionRow, row);
    sessionModelRows.set(key, sessionRow);

    const summaryRow = modelTotals.get(key) ?? createZeroModelRow(row.model, 0, row.contextTier);
    addTotals(summaryRow, row);
    modelTotals.set(key, summaryRow);
  }

  for (const key of sessionModelRows.keys()) {
    const summaryRow = modelTotals.get(key);
    if (summaryRow) summaryRow.sessions += 1;
  }

  addTotals(summary.totals, sessionTotals);

  const sessionId = result.sessionRow?.sessionId;
  if (sessionId && (!requestedSessionIds || requestedSessionIds.has(sessionId))) {
    summary.sessions.push({
      sessionId,
      shutdownAt: maxTimestampFromList(inRangeUsageAts),
      models: sortUsageModelRows([...sessionModelRows.values()]),
      unpricedModels: [],
      ...sessionTotals,
      ...createZeroCostEstimate(),
    });
  }
}

function sortUsageModelRows(rows: CopilotUsageModelRow[]): CopilotUsageModelRow[] {
  return rows.sort((left, right) => (
    right.totalTokens - left.totalTokens
    || right.requests - left.requests
    || right.sessions - left.sessions
    || left.model.localeCompare(right.model)
  ));
}

function isAtOrAfter(value: string | null, startAtMs: number | null): boolean {
  if (startAtMs === null) return true;
  if (!value) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && parsed >= startAtMs;
}

/** True when a totals row carries any recorded work. */
function hasUsageTotals(totals: CopilotUsageTotals): boolean {
  return totals.requests > 0
    || totals.totalTokens > 0
    || totals.inputTokens > 0
    || totals.outputTokens > 0
    || totals.cacheReadTokens > 0
    || totals.cacheWriteTokens > 0
    || totals.reasoningTokens > 0;
}

export async function scanCopilotUsageSession(
  sessionStateDir: string,
  sessionId: string,
): Promise<CopilotUsageSessionScanResult> {
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
  let selectedContextTier: CopilotContextTier | undefined;
  const persistedState = await readPersistedUsageModelState(join(sessionStateDir, sessionId));
  if (persistedState.model) {
    selectedModel = persistedState.model;
    selectedContextTier = persistedState.contextTier;
  }
  const usableShutdowns: Array<{ shutdownAt: string | null; modelMetrics: Record<string, unknown> }> = [];
  const assistantUsageByRequest = new Map<string, AssistantUsageAccumulator>();
  let fallbackEventIndex = 0;
  const stream = createReadStream(eventsPath, { encoding: "utf-8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let linesSinceYield = 0;

  try {
    for await (const line of lines) {
      linesSinceYield += 1;
      if (linesSinceYield >= 250) {
        linesSinceYield = 0;
        await yieldToEventLoop();
      }
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
        selectedContextTier = normalizeContextTier(data?.contextTier)
          ?? (persistedState.model === selectedModel ? persistedState.contextTier : undefined);
        continue;
      }

      if (eventRecord?.type === "session.resume") {
        selectedModel = normalizeModelName(data?.selectedModel) ?? selectedModel;
        selectedContextTier = normalizeContextTier(data?.contextTier)
          ?? (persistedState.model === selectedModel ? persistedState.contextTier : selectedContextTier);
        continue;
      }

      if (eventRecord?.type === "session.model_change") {
        selectedModel = normalizeModelName(data?.newModel) ?? selectedModel;
        if ("contextTier" in (data ?? {})) {
          selectedContextTier = normalizeContextTier(data?.contextTier);
        } else if (persistedState.model === selectedModel) {
          selectedContextTier = persistedState.contextTier;
        }
        continue;
      }

      if (eventRecord?.type === "assistant.message") {
        const outputTokens = toNumber(data?.outputTokens);
        if (outputTokens > 0) {
          const requestId = typeof data?.requestId === "string" && data.requestId.trim()
            ? data.requestId.trim()
            : `event:${fallbackEventIndex++}`;
          const messageModel = normalizeModelName(data?.model) ?? selectedModel;
          const contextTier = messageModel === selectedModel ? selectedContextTier : undefined;
          const key = `${usageModelKey(messageModel, contextTier)}\u0000${requestId}`;
          const existing = assistantUsageByRequest.get(key);
          if (!existing || outputTokens > existing.outputTokens) {
            assistantUsageByRequest.set(key, {
              model: messageModel,
              ...(contextTier ? { contextTier } : {}),
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
  const previousCumulativeTotals = new Map<string, CopilotUsageTotals>();
  const dailyTotals = new Map<string, CopilotUsageDailyModelRow>();
  const undatedDeltas: Array<{
    model: string;
    contextTier: CopilotContextTier | undefined;
    delta: CopilotUsageTotals;
  }> = [];
  const includedShutdownAts: string[] = [];
  let lastDayKey: string | null = null;
  let firstDayKey: string | null = null;
  for (const usableShutdown of usableShutdowns) {
    if (usableShutdown.shutdownAt) {
      includedShutdownAts.push(usableShutdown.shutdownAt);
    }
    const dayKey = usableShutdown.shutdownAt ? copilotUsageDayKey(usableShutdown.shutdownAt) : null;
    if (dayKey) {
      lastDayKey = dayKey;
      firstDayKey ??= dayKey;
    }
    const bucketDay = dayKey ?? lastDayKey;
    for (const [modelName, metrics] of Object.entries(usableShutdown.modelMetrics)) {
      const model = modelName.trim() || "unknown";
      const contextTier = model === persistedState.model ? persistedState.contextTier : undefined;
      const key = usageModelKey(model, contextTier);
      const existing = modelTotals.get(key) ?? createZeroModelRow(model, 0, contextTier);
      if (existing.sessions === 0) {
        existing.sessions = 1;
      }
      const cumulative = extractTotals(metrics);
      const delta = diffCumulativeTotals(previousCumulativeTotals.get(key), cumulative);
      addTotals(existing, delta);
      previousCumulativeTotals.set(key, cumulative);
      modelTotals.set(key, existing);
      // Every shutdown snapshot repeats cumulative totals for every model the
      // session ever used, so idle models yield zero deltas. Bucketing those
      // would date a model's usage to a day it did no work.
      if (!hasUsageTotals(delta)) continue;
      if (bucketDay) {
        addDailyUsage(dailyTotals, bucketDay, model, contextTier, delta);
      } else {
        undatedDeltas.push({ model, contextTier, delta });
      }
    }
  }

  // Usage recorded before the first timestamped shutdown is attributed to this
  // session's earliest known day. A session where no shutdown carries a
  // timestamp keeps its all-time totals but cannot appear in bounded windows.
  if (firstDayKey) {
    for (const pending of undatedDeltas) {
      addDailyUsage(dailyTotals, firstDayKey, pending.model, pending.contextTier, pending.delta);
    }
  }

  return createIncludedResult(sessionId, {
    modelRows: [...modelTotals.values()],
    includedUsageAts: includedShutdownAts,
    dailyRows: [...dailyTotals.values()],
  });
}

function buildAssistantUsageRows(usageByRequest: Map<string, AssistantUsageAccumulator>) {
  const modelTotals = new Map<string, CopilotUsageModelRow>();
  const dailyTotals = new Map<string, CopilotUsageDailyModelRow>();
  const includedUsageAts: string[] = [];

  for (const usage of usageByRequest.values()) {
    const key = usageModelKey(usage.model, usage.contextTier);
    const existing = modelTotals.get(key) ?? createZeroModelRow(usage.model, 1, usage.contextTier);
    existing.requests += 1;
    existing.outputTokens += usage.outputTokens;
    existing.totalTokens += usage.outputTokens;
    modelTotals.set(key, existing);
    if (usage.timestamp) {
      includedUsageAts.push(usage.timestamp);
      const dayKey = copilotUsageDayKey(usage.timestamp);
      if (dayKey) {
        addDailyUsage(dailyTotals, dayKey, usage.model, usage.contextTier, {
          ...createZeroTotals(),
          requests: 1,
          outputTokens: usage.outputTokens,
          totalTokens: usage.outputTokens,
        });
      }
    }
  }

  return {
    modelRows: [...modelTotals.values()],
    includedUsageAts,
    dailyRows: [...dailyTotals.values()],
  };
}

function addDailyUsage(
  target: Map<string, CopilotUsageDailyModelRow>,
  date: string,
  model: string,
  contextTier: CopilotContextTier | undefined,
  delta: CopilotUsageTotals,
): void {
  const key = `${date}\u0000${usageModelKey(model, contextTier)}`;
  const existing = target.get(key) ?? {
    date,
    model,
    ...(contextTier ? { contextTier } : {}),
    ...createZeroTotals(),
  };
  addTotals(existing, delta);
  target.set(key, existing);
}

function createIncludedResult(
  sessionId: string,
  usage: {
    modelRows: CopilotUsageModelRow[];
    includedUsageAts: string[];
    dailyRows: CopilotUsageDailyModelRow[];
  },
): CopilotUsageSessionScanResult {
  const modelRows = usage.modelRows.sort((left, right) => (
    right.totalTokens - left.totalTokens
    || right.requests - left.requests
    || left.model.localeCompare(right.model)
  ));
  const dailyRows = usage.dailyRows.sort((left, right) => (
    left.date.localeCompare(right.date)
    || right.totalTokens - left.totalTokens
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
    dailyRows,
    totals,
    sessionRow: {
      sessionId,
      shutdownAt: maxTimestampFromList(usage.includedUsageAts),
      models: modelRows,
      unpricedModels: [],
      ...totals,
      ...createZeroCostEstimate(),
    },
  };
}

function applyCopilotUsageCostEstimates(
  summary: CopilotUsageSummary,
  sdkModels: readonly CopilotModelMetadataForPricing[] | undefined,
): void {
  const summaryCost = createZeroCostEstimate();
  const summaryUnpricedTokens = createZeroTotals();
  const summaryUnpricedModels: CopilotUsageUnpricedModelRow[] = [];

  for (const row of summary.models) {
    applyCostEstimateToModelRow(row, sdkModels);
    addCostEstimate(summaryCost, row);
    if (row.pricingStatus === "unpriced") {
      addTotals(summaryUnpricedTokens, row);
      summaryUnpricedModels.push(createUnpricedModelReportRow(row));
    }
  }

  assignCostEstimate(summary.totals, summaryCost);
  summary.totals.unpricedModelCount = summaryUnpricedModels.length;
  summary.totals.unpricedTokens = summaryUnpricedTokens;
  summary.unpricedModels = summaryUnpricedModels;

  for (const session of summary.sessions) {
    const sessionCost = createZeroCostEstimate();
    const sessionUnpricedModels: CopilotUsageUnpricedModelRow[] = [];

    for (const row of session.models) {
      applyCostEstimateToModelRow(row, sdkModels);
      addCostEstimate(sessionCost, row);
      if (row.pricingStatus === "unpriced") {
        sessionUnpricedModels.push(createUnpricedModelReportRow(row));
      }
    }

    assignCostEstimate(session, sessionCost);
    session.unpricedModels = sessionUnpricedModels;
  }
}

function applyCostEstimateToModelRow(
  row: CopilotUsageModelRow,
  sdkModels: readonly CopilotModelMetadataForPricing[] | undefined,
): void {
  const resolution = resolveCopilotPricingModel(row.model, { sdkModels });
  const rates = resolution.status === "unpriced"
    ? undefined
    : getCopilotPricingRatesFromModelMetadata(resolution.sdkModel, row.contextTier);
  const priced = rates !== undefined && resolution.status !== "unpriced";
  const pricingKey = priced ? usagePricingKey(resolution.sku, row.contextTier) : null;
  const contextTierLabel = formatUsageContextTierLabel(row.contextTier);
  Object.assign(row, {
    pricingKey,
    pricedAs: pricingKey,
    pricingStatus: priced ? resolution.status : "unpriced",
    normalizedPricingModel: resolution.normalizedModel,
    ...(row.contextTier ? { contextTier: row.contextTier } : {}),
    ...(contextTierLabel ? { contextTierLabel } : {}),
  } satisfies CopilotUsageModelPricingMetadata);

  const billableOutputTokens = Math.max(0, row.outputTokens) + Math.max(0, row.reasoningTokens);
  if (!priced || !rates) {
    assignCostEstimate(row, {
      ...createZeroCostEstimate(),
      billableOutputTokens,
    });
    return;
  }

  const costBreakdownUsd = calculateCostBreakdownUsd(rates, row);
  assignCostEstimate(row, {
    estimatedCostUsd: costBreakdownUsd.total,
    estimatedAiCredits: usdToCopilotAiCredits(costBreakdownUsd.total),
    costBreakdownUsd,
    billableOutputTokens,
    reasoningPricingAssumption: REASONING_PRICING_ASSUMPTION,
  });
}

function calculateCostBreakdownUsd(
  rates: CopilotPricingRatesUsdPerMillionTokens,
  usage: CopilotUsageTotals,
): CopilotUsageCostBreakdownUsd {
  const breakdown = {
    input: calculateTokenCostUsd(usage.inputTokens, rates.input),
    cachedInput: calculateTokenCostUsd(usage.cacheReadTokens, rates.cachedInput),
    cacheWrite: calculateTokenCostUsd(usage.cacheWriteTokens, rates.cacheWrite ?? 0),
    output: calculateTokenCostUsd(usage.outputTokens, rates.output),
    reasoning: calculateTokenCostUsd(usage.reasoningTokens, rates.output),
    total: 0,
  };
  breakdown.total = breakdown.input
    + breakdown.cachedInput
    + breakdown.cacheWrite
    + breakdown.output
    + breakdown.reasoning;
  return breakdown;
}

function calculateTokenCostUsd(tokens: number, usdPerMillionTokens: number): number {
  return (Math.max(0, tokens) / COPILOT_TOKEN_PRICING_UNIT) * usdPerMillionTokens;
}

function addCostEstimate(target: CopilotUsageCostEstimate, delta: CopilotUsageCostEstimate): void {
  target.estimatedCostUsd += delta.estimatedCostUsd;
  target.estimatedAiCredits += delta.estimatedAiCredits;
  target.billableOutputTokens += delta.billableOutputTokens;
  target.costBreakdownUsd.input += delta.costBreakdownUsd.input;
  target.costBreakdownUsd.cachedInput += delta.costBreakdownUsd.cachedInput;
  target.costBreakdownUsd.cacheWrite += delta.costBreakdownUsd.cacheWrite;
  target.costBreakdownUsd.output += delta.costBreakdownUsd.output;
  target.costBreakdownUsd.reasoning += delta.costBreakdownUsd.reasoning;
  target.costBreakdownUsd.total += delta.costBreakdownUsd.total;
}

function assignCostEstimate(target: CopilotUsageCostEstimate, source: CopilotUsageCostEstimate): void {
  target.estimatedCostUsd = source.estimatedCostUsd;
  target.estimatedAiCredits = source.estimatedAiCredits;
  target.billableOutputTokens = source.billableOutputTokens;
  target.reasoningPricingAssumption = source.reasoningPricingAssumption;
  target.costBreakdownUsd = { ...source.costBreakdownUsd };
}

function createUnpricedModelReportRow(row: CopilotUsageModelRow): CopilotUsageUnpricedModelRow {
  return {
    model: row.model,
    sessions: row.sessions,
    requests: row.requests,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    reasoningTokens: row.reasoningTokens,
    totalTokens: row.totalTokens,
    pricingKey: null,
    pricedAs: null,
    pricingStatus: "unpriced",
    normalizedPricingModel: row.normalizedPricingModel,
    ...(row.contextTier ? { contextTier: row.contextTier } : {}),
    ...(row.contextTierLabel ? { contextTierLabel: row.contextTierLabel } : {}),
  };
}

function createEmptySummary(now: () => number, range: CopilotUsageRange): CopilotUsageSummary {
  return {
    generatedAt: new Date(now()).toISOString(),
    range,
    totals: createZeroSummaryTotals(),
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
    unpricedModels: [],
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

function createZeroSummaryTotals(): CopilotUsageSummaryTotals {
  return {
    ...createZeroTotals(),
    ...createZeroCostEstimate(),
    unpricedModelCount: 0,
    unpricedTokens: createZeroTotals(),
  };
}

function createZeroCostBreakdownUsd(): CopilotUsageCostBreakdownUsd {
  return {
    input: 0,
    cachedInput: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
    total: 0,
  };
}

function createZeroCostEstimate(): CopilotUsageCostEstimate {
  return {
    estimatedCostUsd: 0,
    estimatedAiCredits: 0,
    costBreakdownUsd: createZeroCostBreakdownUsd(),
    billableOutputTokens: 0,
    reasoningPricingAssumption: REASONING_PRICING_ASSUMPTION,
  };
}

function createUnpricedPricingMetadata(normalizedPricingModel: string | null = null): CopilotUsageModelPricingMetadata {
  return {
    pricingKey: null,
    pricedAs: null,
    pricingStatus: "unpriced",
    normalizedPricingModel,
  };
}

function createZeroModelRow(
  model: string,
  sessions: number,
  contextTier?: CopilotContextTier,
): CopilotUsageModelRow {
  return {
    ...createZeroTotals(),
    ...createZeroCostEstimate(),
    ...createUnpricedPricingMetadata(null),
    model,
    sessions,
    ...(contextTier ? { contextTier } : {}),
    ...(contextTier ? { contextTierLabel: formatUsageContextTierLabel(contextTier) } : {}),
  };
}

function createSkippedResult(
  reason: CopilotUsageSkipReason,
  shutdownAt: string | null,
  hasEvents: boolean,
): CopilotUsageSessionScanResult {
  return {
    hasEvents,
    included: false,
    reason,
    includedUsageAts: [],
    skippedAt: shutdownAt,
    modelRows: [],
    dailyRows: [],
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

function addTotals(target: CopilotUsageTotals, delta: CopilotUsageTotals): void {  target.requests += delta.requests;
  target.inputTokens += delta.inputTokens;
  target.outputTokens += delta.outputTokens;
  target.cacheReadTokens += delta.cacheReadTokens;
  target.cacheWriteTokens += delta.cacheWriteTokens;
  target.reasoningTokens += delta.reasoningTokens;
  target.totalTokens += delta.totalTokens;
}

// Copilot writes a session.shutdown snapshot every time a session suspends, and each
// snapshot repeats the running totals for the whole session lifetime. Summing the raw
// snapshots multiplies usage for every resumed session, so only forward progress counts.
function diffCumulativeTotals(
  previous: CopilotUsageTotals | undefined,
  current: CopilotUsageTotals,
): CopilotUsageTotals {
  if (!previous) return current;
  const delta = {
    requests: diffCumulativeMetric(previous.requests, current.requests),
    inputTokens: diffCumulativeMetric(previous.inputTokens, current.inputTokens),
    outputTokens: diffCumulativeMetric(previous.outputTokens, current.outputTokens),
    cacheReadTokens: diffCumulativeMetric(previous.cacheReadTokens, current.cacheReadTokens),
    cacheWriteTokens: diffCumulativeMetric(previous.cacheWriteTokens, current.cacheWriteTokens),
    reasoningTokens: diffCumulativeMetric(previous.reasoningTokens, current.reasoningTokens),
    totalTokens: 0,
  };
  delta.totalTokens = delta.inputTokens
    + delta.outputTokens
    + delta.cacheReadTokens
    + delta.cacheWriteTokens
    + delta.reasoningTokens;
  return delta;
}

// A decrease means the counter restarted, so the snapshot itself is the new progress.
function diffCumulativeMetric(previous: number, current: number): number {
  return current >= previous ? current - previous : current;
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

function normalizeContextTier(value: unknown): CopilotContextTier | undefined {
  return isCopilotContextTier(value) ? value : undefined;
}

function usageModelKey(model: string, contextTier: CopilotContextTier | undefined): string {
  return `${model}\u0000${contextTier ?? ""}`;
}

function usagePricingKey(sku: string, contextTier: CopilotContextTier | undefined): string {
  return contextTier === "long_context" ? `${sku}:long_context` : sku;
}

function formatUsageContextTierLabel(contextTier: CopilotContextTier | undefined): string | undefined {
  if (!contextTier) return undefined;
  return contextTier === "long_context" ? "Long context" : "Standard context";
}

async function readPersistedUsageModelState(
  sessionStateDir: string,
): Promise<{ model?: string; contextTier?: CopilotContextTier }> {
  try {
    const raw = JSON.parse(await readFile(join(sessionStateDir, BRIDGE_SESSION_MODEL_STATE_FILE), "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
    const record = raw as Record<string, unknown>;
    const model = normalizeModelName(record.model) ?? undefined;
    const contextTier = normalizeContextTier(record.contextTier);
    return {
      ...(model ? { model } : {}),
      ...(contextTier ? { contextTier } : {}),
    };
  } catch {
    return {};
  }
}

function normalizeTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function cloneSessionRow(row: CopilotUsageSessionRow): CopilotUsageSessionRow {
  return {
    ...row,
    costBreakdownUsd: { ...row.costBreakdownUsd },
    models: row.models.map((model) => ({
      ...model,
      costBreakdownUsd: { ...model.costBreakdownUsd },
    })),
    unpricedModels: row.unpricedModels.map((model) => ({ ...model })),
  };
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

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
