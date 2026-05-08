export type CopilotPricingProvider = "OpenAI" | "Anthropic" | "Google" | "xAI" | "GitHub fine-tuned";
export type CopilotPricingRateUnit = "usd_per_1m_tokens";

export interface CopilotPricingSourceMetadata {
  readonly name: string;
  readonly url: string;
  readonly rateUnit: CopilotPricingRateUnit;
  readonly creditUnitUsd: number;
}

export interface CopilotPricingRatesUsdPerMillionTokens {
  readonly input: number;
  readonly cachedInput: number;
  readonly cacheWrite?: number;
  readonly output: number;
}

export interface CopilotPricingCatalogEntry {
  readonly sku: string;
  readonly provider: CopilotPricingProvider;
  readonly rates: CopilotPricingRatesUsdPerMillionTokens;
  readonly source: CopilotPricingSourceMetadata;
}

export interface CopilotTokenUsageForPricing {
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly outputTokens?: number;
}

export interface CopilotModelMetadataForPricing {
  readonly id: string;
  readonly name?: string | null;
}

export interface ResolveCopilotPricingModelOptions {
  readonly sdkModels?: readonly CopilotModelMetadataForPricing[];
}

export type CopilotPricingModelResolutionStatus =
  | "exact"
  | "sdk-name"
  | "normalized-variant"
  | "unpriced";

export interface PricedCopilotPricingModelResolution {
  readonly status: Exclude<CopilotPricingModelResolutionStatus, "unpriced">;
  readonly source: Exclude<CopilotPricingModelResolutionStatus, "unpriced">;
  readonly observedModel: string;
  readonly normalizedModel: PublicCopilotPricingSku;
  readonly sku: PublicCopilotPricingSku;
  readonly entry: PublicCopilotPricingCatalogEntry;
  readonly sdkModelId?: string;
  readonly sdkModelName?: string;
}

export interface UnpricedCopilotPricingModelResolution {
  readonly status: "unpriced";
  readonly source: "unpriced";
  readonly observedModel: string;
  readonly normalizedModel: string | null;
  readonly sku: null;
  readonly entry: null;
}

export type CopilotPricingModelResolution =
  | PricedCopilotPricingModelResolution
  | UnpricedCopilotPricingModelResolution;

export const COPILOT_AI_CREDIT_USD = 0.01 as const;
export const COPILOT_PRICING_RATE_UNIT = "usd_per_1m_tokens" as const;
export const COPILOT_TOKEN_PRICING_UNIT = 1_000_000 as const;

export const GITHUB_COPILOT_PRICING_SOURCE = {
  name: "GitHub Docs: Copilot billing models and pricing",
  url: "https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing",
  rateUnit: COPILOT_PRICING_RATE_UNIT,
  creditUnitUsd: COPILOT_AI_CREDIT_USD,
} as const satisfies CopilotPricingSourceMetadata;

function defineCopilotPricingEntry<const Sku extends string, const Provider extends CopilotPricingProvider>(
  sku: Sku,
  provider: Provider,
  rates: CopilotPricingRatesUsdPerMillionTokens,
) {
  return {
    sku,
    provider,
    rates,
    source: GITHUB_COPILOT_PRICING_SOURCE,
  } as const satisfies CopilotPricingCatalogEntry;
}

export const COPILOT_PUBLIC_PRICING_CATALOG = [
  defineCopilotPricingEntry("gpt-4.1", "OpenAI", { input: 2, cachedInput: 0.5, output: 8 }),
  defineCopilotPricingEntry("gpt-5-mini", "OpenAI", { input: 0.25, cachedInput: 0.025, output: 2 }),
  defineCopilotPricingEntry("gpt-5.2", "OpenAI", { input: 1.75, cachedInput: 0.175, output: 14 }),
  defineCopilotPricingEntry("gpt-5.2-codex", "OpenAI", { input: 1.75, cachedInput: 0.175, output: 14 }),
  defineCopilotPricingEntry("gpt-5.3-codex", "OpenAI", { input: 1.75, cachedInput: 0.175, output: 14 }),
  defineCopilotPricingEntry("gpt-5.4", "OpenAI", { input: 2.5, cachedInput: 0.25, output: 15 }),
  defineCopilotPricingEntry("gpt-5.4-mini", "OpenAI", { input: 0.75, cachedInput: 0.075, output: 4.5 }),
  defineCopilotPricingEntry("gpt-5.4-nano", "OpenAI", { input: 0.2, cachedInput: 0.02, output: 1.25 }),
  defineCopilotPricingEntry("gpt-5.5", "OpenAI", { input: 5, cachedInput: 0.5, output: 30 }),
  defineCopilotPricingEntry("claude-haiku-4.5", "Anthropic", { input: 1, cachedInput: 0.1, cacheWrite: 1.25, output: 5 }),
  defineCopilotPricingEntry("claude-sonnet-4", "Anthropic", { input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 15 }),
  defineCopilotPricingEntry("claude-sonnet-4.5", "Anthropic", { input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 15 }),
  defineCopilotPricingEntry("claude-sonnet-4.6", "Anthropic", { input: 3, cachedInput: 0.3, cacheWrite: 3.75, output: 15 }),
  defineCopilotPricingEntry("claude-opus-4.5", "Anthropic", { input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 25 }),
  defineCopilotPricingEntry("claude-opus-4.6", "Anthropic", { input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 25 }),
  defineCopilotPricingEntry("claude-opus-4.7", "Anthropic", { input: 5, cachedInput: 0.5, cacheWrite: 6.25, output: 25 }),
  defineCopilotPricingEntry("gemini-2.5-pro", "Google", { input: 1.25, cachedInput: 0.125, output: 10 }),
  defineCopilotPricingEntry("gemini-3-flash", "Google", { input: 0.5, cachedInput: 0.05, output: 3 }),
  defineCopilotPricingEntry("gemini-3.1-pro", "Google", { input: 2, cachedInput: 0.2, output: 12 }),
  defineCopilotPricingEntry("grok-code-fast-1", "xAI", { input: 0.2, cachedInput: 0.02, output: 1.5 }),
  defineCopilotPricingEntry("raptor-mini", "GitHub fine-tuned", { input: 0.25, cachedInput: 0.025, output: 2 }),
  defineCopilotPricingEntry("goldeneye", "GitHub fine-tuned", { input: 1.25, cachedInput: 0.125, output: 10 }),
] as const satisfies readonly CopilotPricingCatalogEntry[];

export type PublicCopilotPricingSku = (typeof COPILOT_PUBLIC_PRICING_CATALOG)[number]["sku"];
export type PublicCopilotPricingCatalogEntry = (typeof COPILOT_PUBLIC_PRICING_CATALOG)[number];

export const COPILOT_PUBLIC_PRICING_SKUS = COPILOT_PUBLIC_PRICING_CATALOG.map(
  ({ sku }) => sku,
) as readonly PublicCopilotPricingSku[];

export const COPILOT_PUBLIC_PRICING_BY_SKU = Object.freeze(
  Object.fromEntries(COPILOT_PUBLIC_PRICING_CATALOG.map((entry) => [entry.sku, entry])),
) as Readonly<Record<PublicCopilotPricingSku, PublicCopilotPricingCatalogEntry>>;

export function isPublicCopilotPricingSku(sku: string): sku is PublicCopilotPricingSku {
  return Object.prototype.hasOwnProperty.call(COPILOT_PUBLIC_PRICING_BY_SKU, sku);
}

export function getCopilotPricingEntry(sku: string): PublicCopilotPricingCatalogEntry | undefined {
  return isPublicCopilotPricingSku(sku) ? COPILOT_PUBLIC_PRICING_BY_SKU[sku] : undefined;
}

export function resolveCopilotPricingModel(
  observedModel: string | null | undefined,
  options: ResolveCopilotPricingModelOptions = {},
): CopilotPricingModelResolution {
  const observed = observedModel?.trim() ?? "";
  if (!observed) {
    return createUnpricedCopilotPricingResolution(observed, null);
  }

  const exactEntry = getCopilotPricingEntry(observed);
  if (exactEntry) {
    return createPricedCopilotPricingResolution("exact", observed, exactEntry.sku, exactEntry);
  }

  const sdkResolution = resolveCopilotPricingModelFromSdkName(observed, options.sdkModels);
  if (sdkResolution) {
    return sdkResolution;
  }

  const normalizedObserved = normalizeCopilotModelNameForPricing(observed);
  const variantSku = resolveCopilotPublicSkuFromVariant(normalizedObserved);
  if (variantSku) {
    return createPricedCopilotPricingResolution(
      "normalized-variant",
      observed,
      variantSku,
      COPILOT_PUBLIC_PRICING_BY_SKU[variantSku],
    );
  }

  return createUnpricedCopilotPricingResolution(observed, normalizedObserved);
}

export function getResolvedCopilotPricingEntry(
  observedModel: string | null | undefined,
  options: ResolveCopilotPricingModelOptions = {},
): PublicCopilotPricingCatalogEntry | null {
  return resolveCopilotPricingModel(observedModel, options).entry;
}

export function calculateCopilotTokenCostUsd(
  entry: CopilotPricingCatalogEntry,
  usage: CopilotTokenUsageForPricing,
): number {
  const rates = entry.rates;

  return (
    toMillionTokenUnits(usage.inputTokens) * rates.input
    + toMillionTokenUnits(usage.cachedInputTokens) * rates.cachedInput
    + toMillionTokenUnits(usage.cacheWriteTokens) * (rates.cacheWrite ?? 0)
    + toMillionTokenUnits(usage.outputTokens) * rates.output
  );
}

export function calculateCopilotTokenCostAiCredits(
  entry: CopilotPricingCatalogEntry,
  usage: CopilotTokenUsageForPricing,
): number {
  return usdToCopilotAiCredits(calculateCopilotTokenCostUsd(entry, usage));
}

export function usdToCopilotAiCredits(amountUsd: number): number {
  assertNonNegativeFiniteNumber(amountUsd, "amountUsd");
  return amountUsd / COPILOT_AI_CREDIT_USD;
}

export function copilotAiCreditsToUsd(aiCredits: number): number {
  assertNonNegativeFiniteNumber(aiCredits, "aiCredits");
  return aiCredits * COPILOT_AI_CREDIT_USD;
}

function toMillionTokenUnits(tokenCount = 0): number {
  assertNonNegativeFiniteNumber(tokenCount, "tokenCount");
  return tokenCount / COPILOT_TOKEN_PRICING_UNIT;
}

function assertNonNegativeFiniteNumber(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number.`);
  }
}

function resolveCopilotPricingModelFromSdkName(
  observedModel: string,
  sdkModels: readonly CopilotModelMetadataForPricing[] | undefined,
): CopilotPricingModelResolution | null {
  const sdkModel = sdkModels?.find((model) => model.id === observedModel);
  if (!sdkModel?.name) {
    return null;
  }

  const normalizedName = normalizeCopilotModelNameForPricing(sdkModel.name);
  const entry = getCopilotPricingEntry(normalizedName);
  if (entry) {
    return createPricedCopilotPricingResolution(
      "sdk-name",
      observedModel,
      entry.sku,
      entry,
      sdkModel.id,
      sdkModel.name,
    );
  }

  const variantSku = resolveCopilotPublicSkuFromVariant(normalizedName);
  if (!variantSku) {
    return null;
  }

  return createPricedCopilotPricingResolution(
    "sdk-name",
    observedModel,
    variantSku,
    COPILOT_PUBLIC_PRICING_BY_SKU[variantSku],
    sdkModel.id,
    sdkModel.name,
  );
}

function resolveCopilotPublicSkuFromVariant(normalizedModel: string): PublicCopilotPricingSku | null {
  let candidate = normalizedModel;
  while (candidate) {
    const next = stripCopilotModelVariantSuffix(candidate);
    if (next === candidate) {
      return null;
    }

    if (isPublicCopilotPricingSku(next)) {
      return next;
    }
    candidate = next;
  }

  return null;
}

function stripCopilotModelVariantSuffix(normalizedModel: string): string {
  return normalizedModel.replace(
    /-(?:(?:\d+(?:k|m))|context|internal|only|reasoning|extra|xhigh|high|medium|low)$/u,
    "",
  );
}

function normalizeCopilotModelNameForPricing(modelName: string): string {
  return modelName
    .trim()
    .toLowerCase()
    .replace(/['’]/gu, "")
    .replace(/[^a-z0-9.]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .replace(/-{2,}/gu, "-");
}

function createPricedCopilotPricingResolution(
  status: Exclude<CopilotPricingModelResolutionStatus, "unpriced">,
  observedModel: string,
  sku: PublicCopilotPricingSku,
  entry: PublicCopilotPricingCatalogEntry,
  sdkModelId?: string,
  sdkModelName?: string,
): PricedCopilotPricingModelResolution {
  return {
    status,
    source: status,
    observedModel,
    normalizedModel: sku,
    sku,
    entry,
    ...(sdkModelId ? { sdkModelId } : {}),
    ...(sdkModelName ? { sdkModelName } : {}),
  };
}

function createUnpricedCopilotPricingResolution(
  observedModel: string,
  normalizedModel: string | null,
): UnpricedCopilotPricingModelResolution {
  return {
    status: "unpriced",
    source: "unpriced",
    observedModel,
    normalizedModel,
    sku: null,
    entry: null,
  };
}
