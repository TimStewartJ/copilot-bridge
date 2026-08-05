import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CopilotQuotaStatus, CopilotUsageCostEstimate, CopilotUsageSummary } from "../../api";
import { useCopilotQuotaQuery } from "../../hooks/queries/useCopilotQuota";
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

vi.mock("../../hooks/queries/useCopilotQuota", () => ({
  useCopilotQuotaQuery: vi.fn(),
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
    sessions: [],
    unpricedModels: [],
    ...overrides,
  };
}

function createQuotaStatus(overrides: Partial<CopilotQuotaStatus> = {}): CopilotQuotaStatus {
  const primary = overrides.primary ?? {
    bucket: "premium_interactions",
    unit: "ai_credits" as const,
    tokenBasedBilling: true,
    isUnlimitedEntitlement: false,
    entitlement: 10_000_000,
    used: 79_393.9,
    usedIsPrecise: true,
    remaining: 9_920_606.1,
    remainingPercentage: 99.2,
    overage: 0,
    overagePermitted: true,
    resetAt: "2026-09-01T00:00:00.000Z",
  };
  return {
    available: true,
    fetchedAt: NOW,
    identity: {
      login: "timstewart_microsoft",
      plan: "enterprise",
      sku: "copilot_enterprise_seat_quota",
      organizations: ["ms-copilot"],
    },
    primary,
    snapshots: primary ? [primary] : [],
    error: null,
    ...overrides,
  };
}

function renderSection(
  summary: CopilotUsageSummary,
  quota: CopilotQuotaStatus | null = createQuotaStatus(),
): string {
  vi.mocked(useCopilotUsageQuery).mockReturnValue({
    data: summary,
    error: null,
    isLoading: false,
    refresh: vi.fn(),
  } as any);
  vi.mocked(useCopilotQuotaQuery).mockReturnValue({
    data: quota,
    error: null,
    isLoading: false,
    refresh: vi.fn(),
  } as any);

  return renderToStaticMarkup(createElement(CopilotUsageSection));
}

beforeEach(() => {
  vi.mocked(useCopilotUsageQuery).mockReset();
  vi.mocked(useCopilotQuotaQuery).mockReset();
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

  it("renders the live quota counter with the precise used value and credit units", () => {
    const text = renderSection(createUsageSummary()).replace(/<!-- -->/g, "");

    expect(text).toContain("Live account quota");
    expect(text).toContain("Used AI credits");
    expect(text).toContain("79,393.9");
    expect(text).toContain("Exact counter");
    expect(text).toContain("9,920,606.1");
    expect(text).toContain("99.2% left");
    expect(text).toContain("timstewart_microsoft · enterprise");
  });

  it("renders the quota reset on its UTC calendar date regardless of viewer timezone", () => {
    // 2026-09-01T00:00Z is still Aug 31 anywhere west of UTC, so a local-time
    // formatter silently reports the reset a day early.
    const text = renderSection(createUsageSummary()).replace(/<!-- -->/g, "");

    expect(text).toContain("Sep 1, 2026");
    expect(text).not.toContain("Aug 31, 2026");
  });

  it("keeps the panel usable when the live quota is unavailable", () => {
    const text = renderSection(
      createUsageSummary(),
      {
        available: false,
        fetchedAt: NOW,
        identity: null,
        primary: null,
        snapshots: [],
        error: "Account quota lookup is not available in this Copilot SDK build",
      },
    ).replace(/<!-- -->/g, "");

    expect(text).toContain("Account quota lookup is not available in this Copilot SDK build");
    expect(text).toContain("Local Copilot Usage");
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
    vi.mocked(useCopilotQuotaQuery).mockReset();
    vi.mocked(useCopilotUsageQuery).mockReturnValue({
      data: createUsageSummary(),
      error: null,
      isLoading: false,
      refresh: vi.fn(),
    } as any);
    vi.mocked(useCopilotQuotaQuery).mockReturnValue({
      data: createQuotaStatus(),
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
