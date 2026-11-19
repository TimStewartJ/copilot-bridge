import { describe, expect, it } from "vitest";
import { modelMaker, modelVersion, resolveBestModels, type BestModelCatalogEntry } from "./best-models.js";

const priced = (id: string, outputPrice: number, extra: Partial<BestModelCatalogEntry> = {}): BestModelCatalogEntry => ({
  id, supportedReasoningEfforts: ["low", "high"], billing: { tokenPrices: { outputPrice } }, ...extra,
});

describe("resolveBestModels", () => {
  const catalog = [
    { id: "auto", selectionMode: "dynamic" as const },
    priced("gpt-6", 1000), priced("gpt-6.2", 1000), priced("gpt-5-fast", 4000, { policy: { state: "disabled" } }),
    priced("claude-9", 2000), priced("claude-9-mini", 100),
    priced("o3", 3000),
  ];

  it("defaults each maker to its priciest enabled model, newer release on a tie, strongest maker first", () => {
    expect(resolveBestModels(catalog, undefined)).toEqual([
      { maker: "gpt", model: "o3", reasoningEffort: "high", contextTier: "default", custom: false },
      { maker: "claude", model: "claude-9", reasoningEffort: "high", contextTier: "default", custom: false },
    ]);
    expect(resolveBestModels(catalog.filter((model) => model.id !== "o3"), undefined)[1]).toMatchObject({ model: "gpt-6.2" });
    // Prices are per batch of tokens: 1500 per half million beats 2000 per million.
    const batched = priced("claude-9-max", 1500, { billing: { tokenPrices: { outputPrice: 1500, batchSize: 500_000 } } });
    expect(resolveBestModels([...catalog, batched], undefined)).toContainEqual(expect.objectContaining({ model: "claude-9-max" }));
  });

  it("keeps the user's model, effort and context, and drops what that model can't run", () => {
    const resolved = resolveBestModels(catalog, {
      claude: { model: "claude-9-mini", reasoningEffort: "low", contextTier: "long_context" },
      gpt: { model: "gpt-4-retired", reasoningEffort: "low" },
    });
    expect(resolved).toContainEqual({ maker: "claude", model: "claude-9-mini", reasoningEffort: "low", contextTier: "default", custom: true });
    expect(resolved).toContainEqual({ maker: "gpt", model: "o3", reasoningEffort: "high", contextTier: "default", custom: false });
  });
});

it("reads makers and release numbers from any id, o-series included", () => {
  expect(["gpt-6.2-sol", "o3", "claude-opus-5.10", "mai-code"].map(modelMaker)).toEqual(["gpt", "gpt", "claude", "mai"]);
  expect(["gpt-6.2-sol", "o3", "claude-opus-5.10", "mai-code"].map(modelVersion)).toEqual([[6, 2], [3], [5, 10], []]);
});
