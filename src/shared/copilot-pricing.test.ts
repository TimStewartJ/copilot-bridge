import { describe, expect, it } from "vitest";
import {
  calculateCopilotTokenCostAiCredits,
  calculateCopilotTokenCostUsd,
  copilotAiCreditsToUsd,
  COPILOT_AI_CREDIT_USD,
  getCopilotPricingRatesFromModelMetadata,
  isCopilotModelPriceable,
  resolveCopilotPricingModel,
  usdToCopilotAiCredits,
  type CopilotModelMetadataForPricing,
} from "./copilot-pricing.js";

function priceableModel(
  id: string,
  overrides: Partial<CopilotModelMetadataForPricing> = {},
): CopilotModelMetadataForPricing {
  return {
    id,
    name: id,
    billing: {
      tokenPrices: { inputPrice: 300, outputPrice: 1500, cachePrice: 30, batchSize: 1_000_000 },
    },
    ...overrides,
  };
}

describe("getCopilotPricingRatesFromModelMetadata", () => {
  it("converts SDK cents-per-batch token prices into USD-per-1M rates", () => {
    const rates = getCopilotPricingRatesFromModelMetadata(priceableModel("model-x"), undefined);
    expect(rates).toEqual({ input: 3, output: 15, cachedInput: 0.3 });
  });

  it("never derives a cacheWrite rate because the SDK does not expose one", () => {
    const rates = getCopilotPricingRatesFromModelMetadata(priceableModel("model-x"), undefined);
    expect(rates && "cacheWrite" in rates).toBe(false);
  });

  it("uses long_context tier prices when requested and present", () => {
    const model: CopilotModelMetadataForPricing = {
      id: "model-x",
      billing: {
        tokenPrices: {
          inputPrice: 300,
          outputPrice: 1500,
          cachePrice: 30,
          batchSize: 1_000_000,
          longContext: { inputPrice: 600, outputPrice: 3000, cachePrice: 60, batchSize: 1_000_000 },
        },
      },
    };
    expect(getCopilotPricingRatesFromModelMetadata(model, "long_context")).toEqual({
      input: 6,
      output: 30,
      cachedInput: 0.6,
    });
  });

  it("prefers the tier batchSize over the base batchSize when converting long_context prices", () => {
    const model: CopilotModelMetadataForPricing = {
      id: "model-x",
      billing: {
        tokenPrices: {
          inputPrice: 300,
          outputPrice: 1500,
          cachePrice: 30,
          batchSize: 1_000_000,
          // Half the batch size means the same cents map to double the per-1M rate.
          longContext: { inputPrice: 300, outputPrice: 1500, cachePrice: 30, batchSize: 500_000 },
        },
      },
    };
    expect(getCopilotPricingRatesFromModelMetadata(model, "long_context")).toEqual({
      input: 6,
      output: 30,
      cachedInput: 0.6,
    });
  });

  it("returns undefined when no token prices are present", () => {
    expect(getCopilotPricingRatesFromModelMetadata({ id: "auto" }, undefined)).toBeUndefined();
    expect(getCopilotPricingRatesFromModelMetadata({ id: "m", billing: { multiplier: 1 } }, undefined))
      .toBeUndefined();
  });
});

describe("isCopilotModelPriceable", () => {
  it("is true only for models that carry usable token prices", () => {
    expect(isCopilotModelPriceable(priceableModel("model-x"))).toBe(true);
    expect(isCopilotModelPriceable({ id: "auto" })).toBe(false);
    expect(isCopilotModelPriceable(undefined)).toBe(false);
  });
});

describe("Copilot token cost helpers", () => {
  it("computes USD cost from explicit rates, charging cacheWrite only when provided", () => {
    const usage = {
      inputTokens: 1_000_000,
      cachedInputTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
      outputTokens: 1_000_000,
    };
    expect(calculateCopilotTokenCostUsd({ input: 3, cachedInput: 0.3, output: 15 }, usage))
      .toBeCloseTo(18.3);
    expect(calculateCopilotTokenCostUsd({ input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 15 }, usage))
      .toBeCloseTo(22.05);
  });

  it("converts between USD and AI credits", () => {
    expect(COPILOT_AI_CREDIT_USD).toBe(0.01);
    expect(calculateCopilotTokenCostAiCredits({ input: 3, cachedInput: 0.3, output: 15 }, { inputTokens: 1_000_000 }))
      .toBeCloseTo(300);
    expect(usdToCopilotAiCredits(18.3)).toBeCloseTo(1_830);
    expect(copilotAiCreditsToUsd(1_830)).toBeCloseTo(18.3);
  });
});

describe("resolveCopilotPricingModel", () => {
  it("resolves an exact id match against priceable SDK models", () => {
    const result = resolveCopilotPricingModel("model-x", { sdkModels: [priceableModel("model-x")] });
    expect(result).toMatchObject({
      status: "exact",
      source: "exact",
      observedModel: "model-x",
      normalizedModel: "model-x",
      sku: "model-x",
    });
    expect(result.status !== "unpriced" && result.sdkModel.id).toBe("model-x");
  });

  it("matches an opaque observed id through its display name to a priceable model", () => {
    const result = resolveCopilotPricingModel("opaque-id", {
      sdkModels: [
        { id: "opaque-id", name: "Model X Pro" },
        priceableModel("model-x-pro", { name: "Model X Pro" }),
      ],
    });
    expect(result).toMatchObject({
      status: "sdk-name",
      source: "sdk-name",
      observedModel: "opaque-id",
      normalizedModel: "model-x-pro",
      sku: "model-x-pro",
      sdkModelId: "opaque-id",
      sdkModelName: "Model X Pro",
    });
  });

  it("strips generic variant suffixes to match a priceable core model", () => {
    const sdkModels = [priceableModel("model-x")];
    for (const observed of ["model-x-high", "model-x-context-low", "model-x-200k", "model-x-reasoning"]) {
      const result = resolveCopilotPricingModel(observed, { sdkModels });
      expect(result).toMatchObject({ status: "sdk-name", normalizedModel: "model-x", sku: "model-x" });
    }
  });

  it("prefers live entries over cached entries when names collide (live-first ordering)", () => {
    const live = priceableModel("live-model", {
      name: "Shared Name",
      billing: { tokenPrices: { inputPrice: 500, outputPrice: 3000, cachePrice: 50, batchSize: 1_000_000 } },
    });
    const cached = priceableModel("cached-model", { name: "Shared Name" });
    const result = resolveCopilotPricingModel("Shared Name", { sdkModels: [live, cached] });
    expect(result.status).toBe("sdk-name");
    expect(result.status !== "unpriced" && result.sdkModel.id).toBe("live-model");
  });

  it("fails closed when there are no priceable SDK models", () => {
    const optionSets = [undefined, { sdkModels: [] }, { sdkModels: [{ id: "model-x" }] }];
    for (const options of optionSets) {
      const result = resolveCopilotPricingModel("model-x", options);
      expect(result).toMatchObject({ status: "unpriced", source: "unpriced", sku: null, sdkModel: null });
    }
  });

  it("fails closed for unknown models and blank input", () => {
    const unknown = resolveCopilotPricingModel("mystery-model", { sdkModels: [priceableModel("model-x")] });
    expect(unknown).toMatchObject({ status: "unpriced", sku: null });

    const blank = resolveCopilotPricingModel("   ", { sdkModels: [priceableModel("model-x")] });
    expect(blank).toMatchObject({ status: "unpriced", normalizedModel: null, sku: null });
  });
});
