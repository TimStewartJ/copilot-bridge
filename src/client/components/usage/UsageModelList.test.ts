import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { createReactDomHarness, findAllByTag, getReactProps, type ReactDomHarness } from "../../test-react-harness";
import { COPILOT_USAGE_UNATTRIBUTED_MODEL } from "../../../shared/copilot-usage";
import UsageModelList, { type UsageModelDisplayRow } from "./UsageModelList";
import TokenBreakdown from "./TokenBreakdown";

function row(overrides: Partial<UsageModelDisplayRow> = {}): UsageModelDisplayRow {
  return {
    model: "test-model", sessions: 1, requests: 2, inputTokens: 200, uncachedInputTokens: 100,
    outputTokens: 20, cacheReadTokens: 75, cacheWriteTokens: 25, reasoningTokens: 10, totalTokens: 220,
    meteredAiCredits: 0, meteredTokens: 0, estimatedCostUsd: 0.0025, estimatedAiCredits: 0.25,
    pricingStatus: "exact", pricingKey: "test-model", ...overrides,
  };
}

describe("usage model disclosures", () => {
  let harness: ReactDomHarness | null = null;
  afterEach(async () => { await harness?.cleanup(); harness = null; });

  async function render(models: UsageModelDisplayRow[]) {
    harness ??= await createReactDomHarness();
    await harness.render(createElement(UsageModelList, { models }));
    return harness.dom.container;
  }

  it("shows each model and context tier with its own pricing and metering disclosure", async () => {
    const container = await render([
      row({ contextTier: "default", contextTierLabel: "Standard context" }),
      row({ contextTier: "long_context", contextTierLabel: "Long context", pricedAs: "canonical-model", normalizedPricingModel: "normalized-model" }),
      row({ model: "unknown-model", pricingStatus: "unpriced", estimatedCostUsd: 0, estimatedAiCredits: 0 }),
      row({ model: "free-model", meteredTokens: 220, estimatedCostUsd: 0 }),
      row({ model: COPILOT_USAGE_UNATTRIBUTED_MODEL, meteredAiCredits: 123.45, totalTokens: 0, pricingStatus: "unpriced" }),
    ]);
    const disclosures = findAllByTag(container, "DETAILS");
    expect(disclosures.every((detail) => !getReactProps(detail)?.open)).toBe(true);
    expect(findAllByTag(container, "TABLE")).toHaveLength(0);
    expect(disclosures.map((detail) => findAllByTag(detail, "SUMMARY")[0].textContent)).toEqual([
      "test-modelStandard context$0.0025 est.220 tokens",
      "test-modelLong context$0.0025 est.220 tokens",
      "unknown-modelUnpriced220 tokens",
      "free-model$0.00 est.220 tokens",
      `${COPILOT_USAGE_UNATTRIBUTED_MODEL}123.45 metered AI credits`,
    ]);
    const [standard, long, unknown, free, unattributed] = disclosures;
    for (const label of ["Sessions", "Requests", "Est. cost", "Est. credits", "Metered cost", "Metered credits", "Input", "Uncached input", "Cache read", "Cache write", "Output", "Reasoning"]) {
      expect(standard.textContent).toContain(label);
    }
    expect(standard.textContent).toContain("included in output");
    expect(standard.textContent).toContain("Metered costNot recorded");
    expect(standard.textContent).toContain("Metered creditsNot recorded");
    expect(long.textContent).toContain("priced as canonical-model");
    expect(long.textContent).toContain("normalized-model");
    expect(unknown.textContent).toContain("excluded from cost");
    expect(free.textContent).toContain("Metered cost$0.00");
    expect(free.textContent).toContain("covers all tokens");
    expect(unattributed.textContent).toContain("$1.23");
    expect(unattributed.textContent).toContain("Not model-attributed");
  });

  it("does not invent counters the SDK did not report", async () => {
    harness = await createReactDomHarness();
    await harness.render(createElement(TokenBreakdown, { totals: { outputTokens: 20, reasoningTokens: 0 } }));
    const labels = findAllByTag(harness.dom.container, "DT").map((element) => element.textContent);
    expect(labels).toEqual(["Output", "Reasoning"]);
    expect(harness.dom.container.textContent).toContain("0");
    expect(harness.dom.container.textContent).not.toContain("Input");
  });
});
