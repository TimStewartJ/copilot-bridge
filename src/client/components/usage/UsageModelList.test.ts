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

  it("starts closed, with meaningful figures and all accounting fields one click away", async () => {
    const container = await render([row()]);
    const details = findAllByTag(container, "DETAILS")[0];
    expect(Boolean(getReactProps(details)?.open)).toBe(false);
    expect(findAllByTag(details, "SUMMARY")[0].textContent).toContain("$0.0025 est.");
    expect(findAllByTag(details, "SUMMARY")[0].textContent).toContain("220 tokens");
    expect(findAllByTag(container, "TABLE")).toHaveLength(0);
    for (const label of ["Sessions", "Requests", "Est. cost", "Est. credits", "Metered cost", "Metered credits", "Input", "Uncached input", "Cache read", "Cache write", "Output", "Reasoning"]) {
      expect(container.textContent).toContain(label);
    }
    expect(container.textContent).toContain("included in output");
    expect(container.textContent).toContain("Not recorded");
  });

  it("does not present unknown pricing as a free model", async () => {
    const container = await render([row({ pricingStatus: "unpriced", estimatedCostUsd: 0, estimatedAiCredits: 0 })]);
    const summary = findAllByTag(container, "SUMMARY")[0];
    expect(summary.textContent).toContain("Unpriced");
    expect(summary.textContent).not.toContain("$0.00");
    expect(container.textContent).toContain("excluded from cost");
  });

  it("distinguishes a recorded free run and unattributed metering from missing metering", async () => {
    const container = await render([
      row({ model: "free-model", meteredTokens: 220, estimatedCostUsd: 0 }),
      row({ model: COPILOT_USAGE_UNATTRIBUTED_MODEL, meteredTokens: 0, meteredAiCredits: 123.45, totalTokens: 0, pricingStatus: "unpriced" }),
    ]);
    const [free, unattributed] = findAllByTag(container, "DETAILS");
    expect(free.textContent).toContain("$0.00");
    expect(free.textContent).toContain("covers all tokens");
    expect(unattributed.textContent).toContain("123.45 metered AI credits");
    expect(unattributed.textContent).toContain("$1.23");
    expect(unattributed.textContent).toContain("Not model-attributed");
    expect(findAllByTag(unattributed, "SUMMARY")[0].textContent).not.toContain("Unpriced");
  });

  it("keeps different context tiers and price aliases readable", async () => {
    const container = await render([
      row({ contextTier: "default", contextTierLabel: "Standard context" }),
      row({ contextTier: "long_context", contextTierLabel: "Long context", pricedAs: "canonical-model", normalizedPricingModel: "normalized-model" }),
    ]);
    expect(findAllByTag(container, "DETAILS")).toHaveLength(2);
    expect(container.textContent).toContain("Standard context");
    expect(container.textContent).toContain("Long context");
    expect(container.textContent).toContain("priced as canonical-model");
    expect(container.textContent).toContain("normalized-model");
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
