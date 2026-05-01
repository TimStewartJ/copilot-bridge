import { describe, expect, it } from "vitest";
import {
  calculateCopilotTokenCostAiCredits,
  calculateCopilotTokenCostUsd,
  copilotAiCreditsToUsd,
  COPILOT_AI_CREDIT_USD,
  COPILOT_PUBLIC_PRICING_CATALOG,
  COPILOT_PUBLIC_PRICING_SKUS,
  COPILOT_PRICING_RATE_UNIT,
  getCopilotPricingEntry,
  getResolvedCopilotPricingEntry,
  GITHUB_COPILOT_PRICING_SOURCE,
  isPublicCopilotPricingSku,
  resolveCopilotPricingModel,
  usdToCopilotAiCredits,
} from "./copilot-pricing.js";

const EXPECTED_PUBLIC_PRICING = [
  { sku: "gpt-4.1", provider: "OpenAI", rates: { input: 2, cachedInput: 0.5, output: 8 } },
  { sku: "gpt-5-mini", provider: "OpenAI", rates: { input: 0.25, cachedInput: 0.025, output: 2 } },
  { sku: "gpt-5.2", provider: "OpenAI", rates: { input: 1.75, cachedInput: 0.175, output: 14 } },
  { sku: "gpt-5.2-codex", provider: "OpenAI", rates: { input: 1.75, cachedInput: 0.175, output: 14 } },
  { sku: "gpt-5.3-codex", provider: "OpenAI", rates: { input: 1.75, cachedInput: 0.175, output: 14 } },
  { sku: "gpt-5.4", provider: "OpenAI", rates: { input: 2.5, cachedInput: 0.25, output: 15 } },
  { sku: "gpt-5.4-mini", provider: "OpenAI", rates: { input: 0.75, cachedInput: 0.075, output: 4.5 } },
  { sku: "gpt-5.4-nano", provider: "OpenAI", rates: { input: 0.2, cachedInput: 0.02, output: 1.25 } },
  { sku: "gpt-5.5", provider: "OpenAI", rates: { input: 5, cachedInput: 0.5, output: 30 } },
  { sku: "claude-haiku-4.5", provider: "Anthropic", rates: { input: 1, cachedInput: 0.1, cacheWrite: 1.25, output: 5 } },
  { sku: "claude-sonnet-4", provider: "Anthropic", rates: { input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 15 } },
  { sku: "claude-sonnet-4.5", provider: "Anthropic", rates: { input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 15 } },
  { sku: "claude-sonnet-4.6", provider: "Anthropic", rates: { input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 15 } },
  { sku: "claude-opus-4.5", provider: "Anthropic", rates: { input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 25 } },
  { sku: "claude-opus-4.6", provider: "Anthropic", rates: { input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 25 } },
  { sku: "claude-opus-4.7", provider: "Anthropic", rates: { input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 25 } },
  { sku: "gemini-2.5-pro", provider: "Google", rates: { input: 1.25, cachedInput: 0.125, output: 10 } },
  { sku: "gemini-3-flash", provider: "Google", rates: { input: 0.5, cachedInput: 0.05, output: 3 } },
  { sku: "gemini-3.1-pro", provider: "Google", rates: { input: 2, cachedInput: 0.2, output: 12 } },
  { sku: "grok-code-fast-1", provider: "xAI", rates: { input: 0.2, cachedInput: 0.02, output: 1.5 } },
  { sku: "raptor-mini", provider: "GitHub fine-tuned", rates: { input: 0.25, cachedInput: 0.025, output: 2 } },
  { sku: "goldeneye", provider: "GitHub fine-tuned", rates: { input: 1.25, cachedInput: 0.125, output: 10 } },
] as const;
const EXPECTED_PUBLIC_SKUS = EXPECTED_PUBLIC_PRICING.map(({ sku }) => sku);

describe("Copilot public pricing catalog", () => {
  it("contains exactly the expected public SKU set without duplicates", () => {
    expect(COPILOT_PUBLIC_PRICING_SKUS).toEqual(EXPECTED_PUBLIC_SKUS);
    expect(new Set(COPILOT_PUBLIC_PRICING_SKUS).size).toBe(COPILOT_PUBLIC_PRICING_SKUS.length);
  });

  it("keeps catalog identifiers public and source-backed", () => {
    for (const entry of COPILOT_PUBLIC_PRICING_CATALOG) {
      expect(entry.sku).not.toMatch(/(?:^|-)internal(?:$|-)/i);
      expect(entry.sku).not.toMatch(/(?:^|-)(?:1m|200k|272k)(?:$|-)/i);
      expect(entry.sku).not.toMatch(/-(?:low|medium|high|xhigh|max)$/i);
      expect(entry.source).toBe(GITHUB_COPILOT_PRICING_SOURCE);
      expect(entry.source.rateUnit).toBe(COPILOT_PRICING_RATE_UNIT);
      expect(entry.source.url).toBe("https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing");
    }
  });

  it("exposes per-1M token rates and lookup helpers", () => {
    expect(COPILOT_PUBLIC_PRICING_CATALOG.map(({ sku, provider, rates }) => ({ sku, provider, rates }))).toEqual(
      EXPECTED_PUBLIC_PRICING,
    );
    expect(getCopilotPricingEntry("gpt-5.5")?.rates).toEqual({ input: 5, cachedInput: 0.5, output: 30 });
    expect(getCopilotPricingEntry("claude-sonnet-4.6")?.rates).toEqual({
      input: 3,
      cachedInput: 0.3,
      cacheWrite: 3.75,
      output: 15,
    });
    expect(getCopilotPricingEntry("gemini-3.1-pro")?.provider).toBe("Google");
    expect(isPublicCopilotPricingSku("gpt-5.4-nano")).toBe(true);
    expect(isPublicCopilotPricingSku("custom-model")).toBe(false);
  });

  it("converts token costs between USD and AI credits", () => {
    const entry = getCopilotPricingEntry("claude-sonnet-4.6");
    expect(entry).toBeDefined();
    expect(COPILOT_AI_CREDIT_USD).toBe(0.01);
    expect(GITHUB_COPILOT_PRICING_SOURCE.creditUnitUsd).toBe(COPILOT_AI_CREDIT_USD);

    const usd = calculateCopilotTokenCostUsd(entry!, {
      inputTokens: 1_000_000,
      cachedInputTokens: 1_000_000,
      cacheWriteTokens: 1_000_000,
      outputTokens: 1_000_000,
    });

    expect(usd).toBeCloseTo(22.05);
    expect(calculateCopilotTokenCostAiCredits(entry!, { inputTokens: 1_000_000 })).toBeCloseTo(300);
    expect(usdToCopilotAiCredits(usd)).toBeCloseTo(2_205);
    expect(copilotAiCreditsToUsd(2_205)).toBeCloseTo(22.05);
  });
});

describe("Copilot pricing model resolver", () => {
  it("resolves exact public SKU matches", () => {
    const result = resolveCopilotPricingModel("gpt-5.5");

    expect(result).toMatchObject({
      status: "exact",
      source: "exact",
      observedModel: "gpt-5.5",
      normalizedModel: "gpt-5.5",
      sku: "gpt-5.5",
    });
    expect(result.entry).toBe(getCopilotPricingEntry("gpt-5.5"));
    expect(getResolvedCopilotPricingEntry("gpt-5.5")).toBe(result.entry);
  });

  it("resolves SDK model names by normalizing display names to public SKUs", () => {
    const result = resolveCopilotPricingModel("sdk-arbitrary-opus-id", {
      sdkModels: [
        { id: "sdk-other-model", name: "GPT-5.4 Mini" },
        { id: "sdk-arbitrary-opus-id", name: "Claude Opus 4.7" },
      ],
    });

    expect(result).toMatchObject({
      status: "sdk-name",
      source: "sdk-name",
      observedModel: "sdk-arbitrary-opus-id",
      normalizedModel: "claude-opus-4.7",
      sku: "claude-opus-4.7",
      sdkModelId: "sdk-arbitrary-opus-id",
      sdkModelName: "Claude Opus 4.7",
    });
    expect(result.entry).toBe(getCopilotPricingEntry("claude-opus-4.7"));
  });

  it("resolves SDK display names with generic variant suffixes without catalog aliases", () => {
    const cases = [
      ["sdk-context-model", "Claude Opus 4.7 (Context)"],
      ["sdk-effort-model", "Claude Opus 4.7 Low"],
      ["sdk-extra-model", "Claude Opus 4.7 Extra Low"],
      ["sdk-medium-model", "Claude Opus 4.7 Medium"],
    ] as const;

    for (const [id, name] of cases) {
      const result = resolveCopilotPricingModel(id, { sdkModels: [{ id, name }] });

      expect(result).toMatchObject({
        status: "sdk-name",
        source: "sdk-name",
        observedModel: id,
        normalizedModel: "claude-opus-4.7",
        sku: "claude-opus-4.7",
        sdkModelId: id,
        sdkModelName: name,
      });
      expect(result.entry).toBe(getCopilotPricingEntry("claude-opus-4.7"));
    }
    expect(getCopilotPricingEntry("claude-opus-4.7-context-low")).toBeUndefined();
  });

  it("generically strips context, environment, and effort suffixes when a public core SKU remains", () => {
    const cases = [
      ["claude-opus-4.7-context-low", "claude-opus-4.7"],
      ["claude-opus-4.7-context-only", "claude-opus-4.7"],
      ["claude-sonnet-4.6-context-medium", "claude-sonnet-4.6"],
      ["claude-opus-4.7-low-reasoning", "claude-opus-4.7"],
      ["claude-opus-4.7-extra-low", "claude-opus-4.7"],
      ["gpt-5.4-mini-context-low", "gpt-5.4-mini"],
      ["gpt-5.5-low", "gpt-5.5"],
      ["gemini-3.1-pro-medium", "gemini-3.1-pro"],
      ["claude-sonnet-4-low", "claude-sonnet-4"],
    ] as const;

    for (const [observedModel, sku] of cases) {
      const result = resolveCopilotPricingModel(observedModel);

      expect(result).toMatchObject({
        status: "normalized-variant",
        source: "normalized-variant",
        observedModel,
        normalizedModel: sku,
        sku,
      });
      expect(result.entry).toBe(getCopilotPricingEntry(sku));
    }
  });

  it("fails closed for unknown models, including unknown models with variant-like suffixes", () => {
    for (const observedModel of ["unknown-model", "unknown-model-context-low", "gpt-5.5-experimental"]) {
      const result = resolveCopilotPricingModel(observedModel);

      expect(result).toMatchObject({
        status: "unpriced",
        source: "unpriced",
        observedModel,
        sku: null,
        entry: null,
      });
    }
  });

  it("fails closed for SDK names that are not public SKUs after safe normalization", () => {
    const result = resolveCopilotPricingModel("sdk-preview-model", {
      sdkModels: [
        { id: "sdk-preview-model", name: "GPT-5.5 Experimental" },
      ],
    });

    expect(result).toMatchObject({
      status: "unpriced",
      source: "unpriced",
      observedModel: "sdk-preview-model",
      sku: null,
      entry: null,
    });
  });

  it("does not add variant or effort-specific exact aliases to the public catalog", () => {
    const variantLikeAliases = [
      "claude-opus-4.7-context",
      "claude-opus-4.7-context-low",
      "claude-opus-4.7-only",
      "claude-opus-4.7-low",
      "claude-opus-4.7-medium",
      "gpt-5.5-low",
    ];

    for (const alias of variantLikeAliases) {
      expect(COPILOT_PUBLIC_PRICING_SKUS).not.toContain(alias);
      expect(isPublicCopilotPricingSku(alias)).toBe(false);
      expect(getCopilotPricingEntry(alias)).toBeUndefined();
    }
  });
});
