import type { CopilotUsageSummary } from "./copilot-usage.js";

export function serializeCopilotUsageSummary(summary: CopilotUsageSummary) {
  type TokenTotalsLike = Pick<
    CopilotUsageSummary["totals"],
    "requests" | "inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "reasoningTokens" | "totalTokens"
  >;
  type CostBreakdownLike = CopilotUsageSummary["totals"]["costBreakdownUsd"];
  type CostEstimateLike = Pick<
    CopilotUsageSummary["totals"],
    "estimatedCostUsd" | "estimatedAiCredits" | "costBreakdownUsd" | "billableOutputTokens" | "reasoningPricingAssumption"
  >;
  type PricingMetadataLike = Pick<
    CopilotUsageSummary["models"][number],
    "pricingKey" | "pricedAs" | "pricingStatus" | "pricingSource" | "normalizedPricingModel"
  >;
  const serializeTokenTotals = (row: TokenTotalsLike) => ({
    requests: row.requests,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheReadTokens: row.cacheReadTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    reasoningTokens: row.reasoningTokens,
    totalTokens: row.totalTokens,
  });
  const serializeCostBreakdown = (row: CostBreakdownLike) => ({
    input: row.input,
    cachedInput: row.cachedInput,
    cacheWrite: row.cacheWrite,
    output: row.output,
    reasoning: row.reasoning,
    total: row.total,
  });
  const serializeCostEstimate = (row: CostEstimateLike) => ({
    estimatedCostUsd: row.estimatedCostUsd,
    estimatedAiCredits: row.estimatedAiCredits,
    costBreakdownUsd: serializeCostBreakdown(row.costBreakdownUsd),
    billableOutputTokens: row.billableOutputTokens,
    reasoningPricingAssumption: row.reasoningPricingAssumption,
  });
  const serializePricingMetadata = (row: PricingMetadataLike) => ({
    pricingKey: row.pricingKey,
    pricedAs: row.pricedAs,
    pricingStatus: row.pricingStatus,
    pricingSource: row.pricingSource,
    normalizedPricingModel: row.normalizedPricingModel,
  });
  const serializeUnpricedModelRow = (row: CopilotUsageSummary["unpricedModels"][number]) => ({
    model: row.model,
    sessions: row.sessions,
    ...serializeTokenTotals(row),
    ...serializePricingMetadata(row),
  });
  const serializeModelRow = (row: CopilotUsageSummary["models"][number]) => ({
    model: row.model,
    sessions: row.sessions,
    ...serializeTokenTotals(row),
    ...serializeCostEstimate(row),
    ...serializePricingMetadata(row),
  });
  const index = summary.index ?? {
    state: "idle" as const,
    startedAt: summary.generatedAt,
    completedAt: summary.generatedAt,
    sessionsTotal: summary.coverage.sessionsSeen,
    sessionsProcessed: summary.coverage.sessionsSeen,
    sessionsUpdated: summary.coverage.sessionsSeen,
    cachedSessions: summary.coverage.sessionsSeen,
    error: null,
  };

  return {
    generatedAt: summary.generatedAt,
    index: {
      state: index.state,
      startedAt: index.startedAt,
      completedAt: index.completedAt,
      sessionsTotal: index.sessionsTotal,
      sessionsProcessed: index.sessionsProcessed,
      sessionsUpdated: index.sessionsUpdated,
      cachedSessions: index.cachedSessions,
      ...(index.requestedSessions !== undefined ? { requestedSessions: index.requestedSessions } : {}),
      ...(index.requestedSessionsCached !== undefined ? { requestedSessionsCached: index.requestedSessionsCached } : {}),
      error: index.error,
    },
    totals: {
      ...serializeTokenTotals(summary.totals),
      ...serializeCostEstimate(summary.totals),
      unpricedModelCount: summary.totals.unpricedModelCount,
      unpricedTokens: serializeTokenTotals(summary.totals.unpricedTokens),
    },
    coverage: {
      sessionsSeen: summary.coverage.sessionsSeen,
      sessionsWithEvents: summary.coverage.sessionsWithEvents,
      sessionsIncluded: summary.coverage.sessionsIncluded,
      sessionsSkipped: summary.coverage.sessionsSkipped,
      skippedByReason: {
        no_events: summary.coverage.skippedByReason.no_events,
        no_shutdown: summary.coverage.skippedByReason.no_shutdown,
        empty_model_metrics: summary.coverage.skippedByReason.empty_model_metrics,
        parse_error: summary.coverage.skippedByReason.parse_error,
      },
      earliestIncludedAt: summary.coverage.earliestIncludedAt,
      latestIncludedAt: summary.coverage.latestIncludedAt,
      earliestSkippedAt: summary.coverage.earliestSkippedAt,
      latestSkippedAt: summary.coverage.latestSkippedAt,
    },
    models: (summary.models ?? []).map(serializeModelRow),
    sessions: (summary.sessions ?? []).map((row) => ({
      sessionId: row.sessionId,
      shutdownAt: row.shutdownAt,
      ...serializeTokenTotals(row),
      ...serializeCostEstimate(row),
      models: (row.models ?? []).map(serializeModelRow),
      unpricedModels: (row.unpricedModels ?? []).map(serializeUnpricedModelRow),
    })),
    unpricedModels: (summary.unpricedModels ?? []).map(serializeUnpricedModelRow),
  };
}
