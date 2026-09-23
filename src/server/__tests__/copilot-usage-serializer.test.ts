import { describe, expect, it } from "vitest";
import type { CopilotUsageSummary } from "../copilot-usage.js";
import { serializeCopilotUsageSummary } from "../copilot-usage-serializer.js";

const zeroTotals = {
  requests: 0,
  inputTokens: 0,
  uncachedInputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
  totalTokens: 0,
  meteredAiCredits: 0,
  meteredTokens: 0,
  estimatedCostUsd: 0,
  estimatedAiCredits: 0,
  costBreakdownUsd: { input: 0, cachedInput: 0, cacheWrite: 0, output: 0, reasoning: 0, total: 0 },
  billableOutputTokens: 0,
  reasoningPricingAssumption: "reasoning_tokens_included_in_output",
};

function modelRow(contextTier?: "default" | "long_context") {
  return {
    ...zeroTotals,
    model: "gpt-6-luna",
    sessions: 1,
    pricingKey: contextTier === "long_context" ? "gpt-6-luna:long_context" : "gpt-6-luna",
    pricedAs: contextTier === "long_context" ? "gpt-6-luna:long_context" : "gpt-6-luna",
    pricingStatus: "exact",
    normalizedPricingModel: "gpt-6-luna",
    ...(contextTier ? {
      contextTier,
      contextTierLabel: contextTier === "long_context" ? "Long context" : "Standard context",
    } : {}),
  };
}

function summaryWith(models: ReturnType<typeof modelRow>[]): CopilotUsageSummary {
  return {
    generatedAt: "2026-09-23T00:00:00.000Z",
    range: { key: "all", label: "All time", startAt: null, startDate: null },
    index: {
      state: "ready",
      startedAt: null,
      completedAt: null,
      sessionsTotal: 0,
      sessionsProcessed: 0,
      sessionsUpdated: 0,
      sessionsFailed: 0,
      cachedSessions: 0,
      warning: null,
      error: null,
    },
    totals: { ...zeroTotals, unpricedModelCount: 0, unpricedTokens: zeroTotals },
    deferWorkers: { ...zeroTotals, capturedRuns: 0, parentSessions: 0, retentionDays: 0 },
    coverage: {
      sessionsSeen: 0,
      sessionsWithEvents: 0,
      sessionsIncluded: 0,
      sessionsSkipped: 0,
      skippedByReason: { no_events: 0, no_shutdown: 0, empty_model_metrics: 0, parse_error: 0 },
      earliestIncludedAt: null,
      latestIncludedAt: null,
      earliestSkippedAt: null,
      latestSkippedAt: null,
    },
    models,
    days: [],
    sessions: [],
    unpricedModels: [],
  } as unknown as CopilotUsageSummary;
}

describe("serializeCopilotUsageSummary", () => {
  it("keeps the context tier so per-tier rows of one model can be told apart", () => {
    const body = serializeCopilotUsageSummary(summaryWith([modelRow("long_context"), modelRow("default")]));

    expect(body.models.map((row) => [row.model, row.contextTier, row.contextTierLabel])).toEqual([
      ["gpt-6-luna", "long_context", "Long context"],
      ["gpt-6-luna", "default", "Standard context"],
    ]);
  });

  it("omits the tier fields for rows recorded before tiers existed", () => {
    const body = serializeCopilotUsageSummary(summaryWith([modelRow()]));

    expect(body.models[0]).not.toHaveProperty("contextTier");
    expect(body.models[0]).not.toHaveProperty("contextTierLabel");
  });
});
