import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CopilotUsageCostEstimate, CopilotUsageSummary } from "../../api";
import { useCopilotUsageQuery } from "../../hooks/queries/useCopilotUsage";
import { CopilotUsageSection } from "./CopilotUsageSection";

vi.mock("../../hooks/queries/useCopilotUsage", () => ({
  useCopilotUsageQuery: vi.fn(),
}));

const NOW = "2026-05-01T12:00:00.000Z";

function createUsageTotals(overrides: Partial<CopilotUsageSummary["totals"]["unpricedTokens"]> = {}) {
  return {
    requests: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    ...overrides,
  };
}

function createCostEstimate(overrides: Partial<CopilotUsageCostEstimate> = {}): CopilotUsageCostEstimate {
  const costBreakdownUsd = {
    input: 0,
    cachedInput: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
    total: overrides.estimatedCostUsd ?? 0,
    ...overrides.costBreakdownUsd,
  };

  return {
    estimatedCostUsd: costBreakdownUsd.total,
    estimatedAiCredits: costBreakdownUsd.total / 0.01,
    costBreakdownUsd,
    billableOutputTokens: 0,
    reasoningPricingAssumption: "reasoning_tokens_priced_at_output_rate",
    ...overrides,
  };
}

function createUsageSummary(overrides: Partial<CopilotUsageSummary> = {}): CopilotUsageSummary {
  return {
    generatedAt: NOW,
    index: {
      state: "idle",
      startedAt: NOW,
      completedAt: NOW,
      sessionsTotal: 0,
      sessionsProcessed: 0,
      sessionsUpdated: 0,
      cachedSessions: 0,
      error: null,
    },
    totals: {
      ...createUsageTotals(),
      ...createCostEstimate(),
      unpricedModelCount: 0,
      unpricedTokens: createUsageTotals(),
    },
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
    ...overrides,
  };
}

function renderSection(summary: CopilotUsageSummary): string {
  vi.mocked(useCopilotUsageQuery).mockReturnValue({
    data: summary,
    error: null,
    isLoading: false,
    refresh: vi.fn(),
  } as any);

  return renderToStaticMarkup(createElement(CopilotUsageSection));
}

beforeEach(() => {
  vi.mocked(useCopilotUsageQuery).mockReset();
});

describe("CopilotUsageSection", () => {
  it("shows background indexing progress and requests aggregate-only usage", () => {
    const html = renderSection(createUsageSummary({
      index: {
        state: "scanning",
        startedAt: NOW,
        completedAt: null,
        sessionsTotal: 100,
        sessionsProcessed: 25,
        sessionsUpdated: 20,
        cachedSessions: 20,
        error: null,
      },
    }));

    expect(html).toContain("Indexing local usage in the background");
    expect(html).toContain("Checked 25 of 100 sessions");
    expect(vi.mocked(useCopilotUsageQuery)).toHaveBeenCalledWith({ includeSessions: false });
  });

  it("renders estimated cost and unpriced model diagnostics", () => {
    const pricedTotals = createUsageTotals({
      requests: 3,
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      cacheReadTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
      reasoningTokens: 1_000_000,
      totalTokens: 5_000_000,
    });
    const unpricedTotals = createUsageTotals({
      requests: 1,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 5,
      cacheWriteTokens: 10,
      reasoningTokens: 25,
      totalTokens: 190,
    });
    const pricedCost = createCostEstimate({
      estimatedCostUsd: 32.75,
      estimatedAiCredits: 3_275,
      billableOutputTokens: 2_000_000,
      costBreakdownUsd: {
        input: 2.5,
        cachedInput: 0.25,
        cacheWrite: 0,
        output: 15,
        reasoning: 15,
        total: 32.75,
      },
    });

    const html = renderSection(createUsageSummary({
      totals: {
        ...createUsageTotals({
          requests: 4,
          inputTokens: 1_000_100,
          outputTokens: 1_000_050,
          cacheReadTokens: 1_000_005,
          cacheWriteTokens: 1_000_010,
          reasoningTokens: 1_000_025,
          totalTokens: 5_000_190,
        }),
        ...createCostEstimate({
          estimatedCostUsd: 32.75,
          estimatedAiCredits: 3_275,
          billableOutputTokens: 2_000_075,
          costBreakdownUsd: pricedCost.costBreakdownUsd,
        }),
        unpricedModelCount: 1,
        unpricedTokens: unpricedTotals,
      },
      coverage: {
        sessionsSeen: 1,
        sessionsWithEvents: 1,
        sessionsIncluded: 1,
        sessionsSkipped: 0,
        skippedByReason: {
          no_events: 0,
          no_shutdown: 0,
          empty_model_metrics: 0,
          parse_error: 0,
        },
        earliestIncludedAt: NOW,
        latestIncludedAt: NOW,
        earliestSkippedAt: null,
        latestSkippedAt: null,
      },
      models: [
        {
          model: "gpt-5.4",
          sessions: 1,
          ...pricedTotals,
          ...pricedCost,
          pricingKey: "gpt-5.4",
          pricedAs: "gpt-5.4",
          pricingStatus: "exact",
          pricingSource: "exact",
          normalizedPricingModel: "gpt-5.4",
        },
        {
          model: "unknown-model",
          sessions: 1,
          ...unpricedTotals,
          ...createCostEstimate({ billableOutputTokens: 75 }),
          pricingKey: null,
          pricedAs: null,
          pricingStatus: "unpriced",
          pricingSource: "unpriced",
          normalizedPricingModel: "unknown-model",
        },
      ],
      unpricedModels: [
        {
          model: "unknown-model",
          sessions: 1,
          ...unpricedTotals,
          pricingKey: null,
          pricedAs: null,
          pricingStatus: "unpriced",
          pricingSource: "unpriced",
          normalizedPricingModel: "unknown-model",
        },
      ],
    }));

    const text = html.replace(/<!-- -->/g, "");

    expect(text).toContain("Estimated cost");
    expect(text).toContain("32.75");
    expect(text).toContain("Estimated AI credits");
    expect(text).toContain("3,275");
    expect(text).toContain("Unknown pricing excluded from cost totals");
    expect(text).toContain("GitHub public pricing did not include 1 observed model");
    expect(text).toContain("Unpriced tokens");
    expect(text).toContain("unknown-model");
    expect(text).toContain("Exact public price");
    expect(text).toContain("Unpriced");
  });
});
