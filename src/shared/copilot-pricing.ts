export type CopilotPricingRateUnit = "usd_per_1m_tokens";

export interface CopilotPricingRatesUsdPerMillionTokens {
  readonly input: number;
  readonly cachedInput: number;
  readonly cacheWrite?: number;
  readonly output: number;
}

export interface CopilotTokenUsageForPricing {
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly cacheWriteTokens?: number;
  readonly outputTokens?: number;
}

export interface CopilotModelMetadataForPricing extends CopilotModelContextMetadata {}

export interface ResolveCopilotPricingModelOptions {
  readonly sdkModels?: readonly CopilotModelMetadataForPricing[];
}

export type CopilotPricingModelResolutionStatus = "exact" | "sdk-name" | "unpriced";

export interface PricedCopilotPricingModelResolution {
  readonly status: Exclude<CopilotPricingModelResolutionStatus, "unpriced">;
  readonly source: Exclude<CopilotPricingModelResolutionStatus, "unpriced">;
  readonly observedModel: string;
  readonly normalizedModel: string;
  readonly sku: string;
  readonly sdkModel: CopilotModelMetadataForPricing;
  readonly sdkModelId?: string;
  readonly sdkModelName?: string;
}

export interface UnpricedCopilotPricingModelResolution {
  readonly status: "unpriced";
  readonly source: "unpriced";
  readonly observedModel: string;
  readonly normalizedModel: string | null;
  readonly sku: null;
  readonly sdkModel: null;
}

export type CopilotPricingModelResolution =
  | PricedCopilotPricingModelResolution
  | UnpricedCopilotPricingModelResolution;

export const COPILOT_AI_CREDIT_USD = 0.01 as const;
export const COPILOT_PRICING_RATE_UNIT = "usd_per_1m_tokens" as const;
export const COPILOT_TOKEN_PRICING_UNIT = 1_000_000 as const;

export function getCopilotPricingRatesFromModelMetadata(
  model: CopilotModelMetadataForPricing | undefined,
  contextTier: CopilotContextTier | undefined,
): CopilotPricingRatesUsdPerMillionTokens | undefined {
  const tokenPrices = model?.billing?.tokenPrices;
  if (!tokenPrices) return undefined;
  const tierPrices = contextTier === "long_context" && tokenPrices.longContext
    ? tokenPrices.longContext
    : tokenPrices;
  const batchSize = firstPositiveBatchSize(tierPrices.batchSize, tokenPrices.batchSize);
  const input = tokenPriceCentsPerBatchToUsdPerMillion(tierPrices.inputPrice, batchSize);
  const output = tokenPriceCentsPerBatchToUsdPerMillion(tierPrices.outputPrice, batchSize);
  const cachedInput = tokenPriceCentsPerBatchToUsdPerMillion(tierPrices.cachePrice, batchSize);
  if (input === undefined || output === undefined || cachedInput === undefined) return undefined;
  return { input, output, cachedInput };
}

export function isCopilotModelPriceable(
  model: CopilotModelMetadataForPricing | undefined,
): model is CopilotModelMetadataForPricing {
  return getCopilotPricingRatesFromModelMetadata(model, undefined) !== undefined;
}

export function resolveCopilotPricingModel(
  observedModel: string | null | undefined,
  options: ResolveCopilotPricingModelOptions = {},
): CopilotPricingModelResolution {
  const observed = observedModel?.trim() ?? "";
  if (!observed) {
    return createUnpricedCopilotPricingResolution(observed, null);
  }

  const sdkModels = options.sdkModels ?? [];
  const priceableModels = sdkModels.filter(isCopilotModelPriceable);

  const exactModel = priceableModels.find((model) => model.id === observed);
  if (exactModel) {
    return createPricedCopilotPricingResolution("exact", observed, exactModel);
  }

  const observedModelEntry = sdkModels.find((model) => model.id === observed);
  const candidates: string[] = [];
  if (typeof observedModelEntry?.name === "string" && observedModelEntry.name.trim()) {
    candidates.push(observedModelEntry.name);
  }
  candidates.push(observed);

  for (const candidate of candidates) {
    const matched = matchPriceableModel(candidate, priceableModels);
    if (matched) {
      return createPricedCopilotPricingResolution(
        "sdk-name",
        observed,
        matched,
        observedModelEntry?.id,
        typeof observedModelEntry?.name === "string" ? observedModelEntry.name : undefined,
      );
    }
  }

  const normalizedObserved = normalizeCopilotModelNameForPricing(observed);
  return createUnpricedCopilotPricingResolution(observed, normalizedObserved || null);
}

export function calculateCopilotTokenCostUsd(
  rates: CopilotPricingRatesUsdPerMillionTokens,
  usage: CopilotTokenUsageForPricing,
): number {
  return (
    toMillionTokenUnits(usage.inputTokens) * rates.input
    + toMillionTokenUnits(usage.cachedInputTokens) * rates.cachedInput
    + toMillionTokenUnits(usage.cacheWriteTokens) * (rates.cacheWrite ?? 0)
    + toMillionTokenUnits(usage.outputTokens) * rates.output
  );
}

export function calculateCopilotTokenCostAiCredits(
  rates: CopilotPricingRatesUsdPerMillionTokens,
  usage: CopilotTokenUsageForPricing,
): number {
  return usdToCopilotAiCredits(calculateCopilotTokenCostUsd(rates, usage));
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

function firstPositiveBatchSize(...values: Array<number | undefined>): number {
  for (const value of values) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return value;
    }
  }
  return COPILOT_TOKEN_PRICING_UNIT;
}

function tokenPriceCentsPerBatchToUsdPerMillion(
  value: CopilotTokenPrices[keyof CopilotTokenPrices],
  batchSize: number,
): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return (value / 100) * (COPILOT_TOKEN_PRICING_UNIT / batchSize);
}

function matchPriceableModel(
  raw: string,
  priceableModels: readonly CopilotModelMetadataForPricing[],
): CopilotModelMetadataForPricing | null {
  const normalized = normalizeCopilotModelNameForPricing(raw);
  if (!normalized) return null;

  const direct = findModelByNormalizedIdentity(normalized, priceableModels);
  if (direct) return direct;

  let candidate = normalized;
  while (candidate) {
    const next = stripCopilotModelVariantSuffix(candidate);
    if (next === candidate) {
      return null;
    }
    const matched = findModelByNormalizedIdentity(next, priceableModels);
    if (matched) return matched;
    candidate = next;
  }

  return null;
}

function findModelByNormalizedIdentity(
  normalized: string,
  priceableModels: readonly CopilotModelMetadataForPricing[],
): CopilotModelMetadataForPricing | null {
  return (
    priceableModels.find((model) => {
      if (normalizeCopilotModelNameForPricing(model.id) === normalized) return true;
      return typeof model.name === "string"
        && normalizeCopilotModelNameForPricing(model.name) === normalized;
    }) ?? null
  );
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
  sdkModel: CopilotModelMetadataForPricing,
  sdkModelId?: string,
  sdkModelName?: string,
): PricedCopilotPricingModelResolution {
  return {
    status,
    source: status,
    observedModel,
    normalizedModel: sdkModel.id,
    sku: sdkModel.id,
    sdkModel,
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
    sdkModel: null,
  };
}
import type {
  CopilotContextTier,
  CopilotModelContextMetadata,
  CopilotTokenPrices,
} from "./copilot-context.js";
