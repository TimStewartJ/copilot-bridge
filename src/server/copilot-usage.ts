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
  pricingSource: CopilotPricingModelResolutionStatus;
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
  pricingSource: "unpriced";
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
  totals: CopilotUsageSummaryTotals;
  coverage: CopilotUsageCoverage;
  models: CopilotUsageModelRow[];
  sessions: CopilotUsageSessionRow[];
  unpricedModels: CopilotUsageUnpricedModelRow[];
}

export interface ReadCopilotUsageSummaryOptions {
  copilotHome: string;
  now?: () => number;
  concurrency?: number;
  sdkModels?: readonly CopilotModelMetadataForPricing[];
}

export type CopilotUsageModelMetadataProvider = () => Promise<readonly CopilotModelMetadataForPricing[]>;

export interface CopilotUsageReaderOptions extends ReadCopilotUsageSummaryOptions {
  ttlMs?: number;
  loadSummary?: (options: ReadCopilotUsageSummaryOptions) => Promise<CopilotUsageSummary>;
  modelMetadataProvider?: CopilotUsageModelMetadataProvider;
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
  contextTier?: CopilotContextTier;
  outputTokens: number;
  timestamp: string | null;
}

const DEFAULT_SCAN_CONCURRENCY = 8;
const DEFAULT_CACHE_TTL_MS = 30_000;
const COPILOT_USAGE_READ_ERROR_MESSAGE = "Unable to read local Copilot usage history.";
const REASONING_PRICING_ASSUMPTION = "reasoning_tokens_priced_at_output_rate" as const;

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
    applyCopilotUsageCostEstimates(summary, sdkModels);

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
  sdkModels: staticSdkModels,
  ttlMs = DEFAULT_CACHE_TTL_MS,
  loadSummary: loadSummaryImpl = readCopilotUsageSummary,
  modelMetadataProvider,
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
    const createLoadOptions = (
      sdkModels: readonly CopilotModelMetadataForPricing[] | undefined,
    ): ReadCopilotUsageSummaryOptions => ({
      copilotHome,
      now,
      concurrency,
      ...(sdkModels ? { sdkModels } : {}),
    });
    const sdkModelsResult = loadModelMetadataForPricing(modelMetadataProvider, staticSdkModels);
    const loadPromise = isPromiseLike(sdkModelsResult)
      ? sdkModelsResult.then((sdkModels) => loadSummaryImpl(createLoadOptions(sdkModels)))
      : loadSummaryImpl(createLoadOptions(sdkModelsResult));
    const promise = loadPromise
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

function loadModelMetadataForPricing(
  provider: CopilotUsageModelMetadataProvider | undefined,
  fallback: readonly CopilotModelMetadataForPricing[] | undefined,
): readonly CopilotModelMetadataForPricing[] | undefined | Promise<readonly CopilotModelMetadataForPricing[] | undefined> {
  if (!provider) return fallback;
  try {
    return Promise.resolve(provider()).catch((error) => {
      console.warn("[copilot-usage] Failed to load Copilot model metadata; pricing may be incomplete.", error);
      return fallback;
    });
  } catch (error) {
    console.warn("[copilot-usage] Failed to load Copilot model metadata; pricing may be incomplete.", error);
    return fallback;
  }
}

function isPromiseLike<T>(value: T | Promise<T>): value is Promise<T> {
  return typeof value === "object"
    && value !== null
    && "then" in value
    && typeof (value as { then?: unknown }).then === "function";
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
  const includedShutdownAts: string[] = [];
  for (const usableShutdown of usableShutdowns) {
    if (usableShutdown.shutdownAt) {
      includedShutdownAts.push(usableShutdown.shutdownAt);
    }
    for (const [modelName, metrics] of Object.entries(usableShutdown.modelMetrics)) {
      const model = modelName.trim() || "unknown";
      const contextTier = model === persistedState.model ? persistedState.contextTier : undefined;
      const key = usageModelKey(model, contextTier);
      const existing = modelTotals.get(key) ?? createZeroModelRow(model, 0, contextTier);
      if (existing.sessions === 0) {
        existing.sessions = 1;
      }
      addTotals(existing, extractTotals(metrics));
      modelTotals.set(key, existing);
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
    const key = usageModelKey(usage.model, usage.contextTier);
    const existing = modelTotals.get(key) ?? createZeroModelRow(usage.model, 1, usage.contextTier);
    existing.requests += 1;
    existing.outputTokens += usage.outputTokens;
    existing.totalTokens += usage.outputTokens;
    modelTotals.set(key, existing);
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
  const sdkModelId = "sdkModelId" in resolution ? resolution.sdkModelId : undefined;
  const sdkModel = sdkModels?.find((model) => model.id === row.model || model.id === sdkModelId);
  const contextTierLabel = formatUsageContextTierLabel(row.contextTier);
  Object.assign(row, {
    pricingKey: resolution.sku ? usagePricingKey(resolution.sku, row.contextTier) : null,
    pricedAs: resolution.sku ? usagePricingKey(resolution.sku, row.contextTier) : null,
    pricingStatus: resolution.status,
    pricingSource: resolution.source,
    normalizedPricingModel: resolution.normalizedModel,
    ...(row.contextTier ? { contextTier: row.contextTier } : {}),
    ...(contextTierLabel ? { contextTierLabel } : {}),
  } satisfies CopilotUsageModelPricingMetadata);

  const billableOutputTokens = Math.max(0, row.outputTokens) + Math.max(0, row.reasoningTokens);
  if (!resolution.entry) {
    assignCostEstimate(row, {
      ...createZeroCostEstimate(),
      billableOutputTokens,
    });
    return;
  }

  const rates = getCopilotPricingRatesFromModelMetadata(sdkModel, row.contextTier)
    ?? resolution.entry.rates;
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
    pricingSource: "unpriced",
    normalizedPricingModel: row.normalizedPricingModel,
    ...(row.contextTier ? { contextTier: row.contextTier } : {}),
    ...(row.contextTierLabel ? { contextTierLabel: row.contextTierLabel } : {}),
  };
}

function createEmptySummary(now: () => number): CopilotUsageSummary {
  return {
    generatedAt: new Date(now()).toISOString(),
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
    pricingSource: "unpriced",
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
