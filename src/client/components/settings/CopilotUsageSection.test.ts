import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CopilotUsageCostEstimate, CopilotUsageSummary } from "../../api";
import { COPILOT_USAGE_UNATTRIBUTED_MODEL } from "../../../shared/copilot-usage";
import { useCopilotUsageQuery } from "../../hooks/queries/useCopilotUsage";
import {
  createReactDomHarness,
  findAllByTag,
  getReactProps,
  type ReactDomHarness,
} from "../../test-react-harness";
import { CopilotUsageSection } from "./CopilotUsageSection";

vi.mock("../../hooks/queries/useCopilotUsage", () => ({
  useCopilotUsageQuery: vi.fn(),
}));

const NOW = "2026-05-01T12:00:00.000Z";

function createUsageTotals(overrides: Partial<CopilotUsageSummary["totals"]["unpricedTokens"]> = {}) {
  return {
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
    range: {
      key: "all",
      label: "All time",
      startAt: null,
      startDate: null,
    },
    index: {
      state: "idle",
      startedAt: NOW,
      completedAt: NOW,
      sessionsTotal: 0,
      sessionsProcessed: 0,
      sessionsUpdated: 0,
      sessionsFailed: 0,
      cachedSessions: 0,
      warning: null,
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
    days: [],
    sessions: [],
    unpricedModels: [],
    deferWorkers: {
      capturedRuns: 0,
      parentSessions: 0,
      retentionDays: 90,
      ...createUsageTotals(),
    },
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
        sessionsFailed: 0,
        cachedSessions: 20,
        warning: null,
        error: null,
      },
    }));

    expect(html).toContain("Indexing local usage in the background");
    expect(html).toContain("Checked 25 of 100 sessions");
    expect(vi.mocked(useCopilotUsageQuery)).toHaveBeenCalledWith({ includeSessions: false, range: "all" });
  });

  it("shows a partial indexing warning while keeping cached usage visible", () => {
    const warning = "1 local Copilot usage session failed to index. Cached results were retained when available.";
    const html = renderSection(createUsageSummary({
      index: {
        state: "idle",
        startedAt: NOW,
        completedAt: NOW,
        sessionsTotal: 3,
        sessionsProcessed: 3,
        sessionsUpdated: 2,
        sessionsFailed: 1,
        cachedSessions: 2,
        warning,
        error: null,
      },
    }));

    expect(html).toContain(warning);
    expect(html).toContain("Total tokens");
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
          normalizedPricingModel: "unknown-model",
        },
      ],
    }));

    const text = html.replace(/<!-- -->/g, "");

    expect(text).toContain("Estimated cost");
    expect(text).toContain("32.75");
    expect(text).toContain("3,275");
    expect(text).toContain("Metered cost");
    expect(text).toContain("No GitHub metering in this range");
    expect(text).toContain("Unknown pricing excluded from cost totals");
    expect(text).toContain("GitHub public pricing did not include 1 observed model");
    expect(text).toContain("Unpriced tokens");
    expect(text).toContain("unknown-model");
    expect(text).toContain("Exact public price");
    expect(text).toContain("Unpriced");
  });

  it("shows retained deferred-worker metering separately", () => {
    const html = renderSection(createUsageSummary({
      deferWorkers: {
        capturedRuns: 4,
        parentSessions: 2,
        retentionDays: 90,
        ...createUsageTotals({
          requests: 4,
          inputTokens: 1_000,
          outputTokens: 100,
          totalTokens: 1_100,
          meteredAiCredits: 12.5,
          meteredTokens: 1_100,
        }),
      },
    })).replace(/<!-- -->/g, "");

    expect(html).toContain("Deferred workers");
    expect(html).toContain("Captured at worker shutdown");
    expect(html).toContain("retained for 90 days");
    expect(html).toContain("Captured runs");
    expect(html).toContain("Parent sessions");
    expect(html).toContain("12.5");
    expect(html).toContain("$0.13");
    expect(html).toContain("1,100");
  });

  it("shows unattributed GitHub metering separately from estimated model credits", () => {
    const html = renderSection(createUsageSummary({
      totals: {
        ...createUsageTotals({
          inputTokens: 100,
          totalTokens: 100,
          meteredAiCredits: 223.45,
          meteredTokens: 100,
        }),
        ...createCostEstimate(),
        unpricedModelCount: 0,
        unpricedTokens: createUsageTotals(),
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
          ...createUsageTotals({
            inputTokens: 100,
            totalTokens: 100,
            meteredAiCredits: 100,
            meteredTokens: 100,
          }),
          ...createCostEstimate(),
          pricingKey: "gpt-5.4",
          pricedAs: "gpt-5.4",
          pricingStatus: "exact",
          normalizedPricingModel: "gpt-5.4",
        },
        {
          model: COPILOT_USAGE_UNATTRIBUTED_MODEL,
          sessions: 1,
          ...createUsageTotals({ meteredAiCredits: 123.45 }),
          ...createCostEstimate(),
          pricingKey: null,
          pricedAs: null,
          pricingStatus: "unpriced",
          normalizedPricingModel: "unattributed",
        },
      ],
    }));
    const text = html.replace(/<!-- -->/g, "");

    expect(text).toContain("Metered credits");
    expect(text).toContain(COPILOT_USAGE_UNATTRIBUTED_MODEL);
    expect(text).toContain("123.45");
    expect(text).toContain("Not model-attributed");
    expect(text).toContain("metered total only");
    expect(text).not.toContain("Unknown pricing excluded from cost totals");
  });

  it("renders every range button with all time selected by default", () => {
    const html = renderSection(createUsageSummary());

    for (const label of ["7 days", "28 days", "MTD", "YTD", "All time"]) {
      expect(html).toContain(`>${label}</button>`);
    }
    expect(html).toContain("All local history");
  });

  it("labels the active window when a bounded range is returned", () => {
    const html = renderSection(createUsageSummary({
      range: {
        key: "28d",
        label: "28 days",
        startAt: "2026-04-04T00:00:00.000Z",
        startDate: "2026-04-04",
      },
      coverage: {
        sessionsSeen: 2,
        sessionsWithEvents: 2,
        sessionsIncluded: 2,
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
    }));

    expect(html).toContain("Since ");
    expect(html.replace(/<!-- -->/g, "")).toContain("Counts are limited to sessions with recorded usage inside the selected window.");
  });

  it("keeps the live account quota out of local usage settings", () => {
    const text = renderSection(createUsageSummary()).replace(/<!-- -->/g, "");

    expect(text).toContain("Local Copilot Usage");
    expect(text).not.toContain("Live account quota");
  });
});

describe("CopilotUsageSection range buttons", () => {
  let harness: ReactDomHarness | null = null;

  function getHarness() {
    if (!harness) throw new Error("CopilotUsageSection harness not initialized");
    return harness;
  }

  beforeEach(async () => {
    vi.mocked(useCopilotUsageQuery).mockReset();
    vi.mocked(useCopilotUsageQuery).mockReturnValue({
      data: createUsageSummary(),
      error: null,
      isLoading: false,
      refresh: vi.fn(),
    } as any);
    harness = await createReactDomHarness();
  });

  afterEach(async () => {
    await harness?.cleanup();
    harness = null;
  });

  it("requeries usage for the picked window", async () => {
    await getHarness().render(createElement(CopilotUsageSection));
    expect(vi.mocked(useCopilotUsageQuery).mock.calls.at(-1)?.[0]).toEqual({
      includeSessions: false,
      range: "all",
    });

    const button = findAllByTag(harness?.dom.container, "BUTTON")
      .find((candidate: any) => candidate.textContent === "28 days");
    expect(button).toBeTruthy();

    await getHarness().act(async () => {
      getReactProps(button)?.onClick?.({});
    });

    expect(vi.mocked(useCopilotUsageQuery).mock.calls.at(-1)?.[0]).toEqual({
      includeSessions: false,
      range: "28d",
    });
    expect(button.getAttribute("aria-pressed")).toBe("true");
  });
});
