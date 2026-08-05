export type CopilotPricingRateUnit = "usd_per_1m_tokens";

export interface CopilotPricingRatesUsdPerMillionTokens {
  readonly input: number;
  readonly cachedInput: number;
  readonly cacheWrite?: number;
  readonly output: number;
}

export interface CopilotTokenUsageForPricing {
  /** Uncached input tokens only. Cache reads and cache writes are priced separately. */
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
  readonly observedModel: string;
  readonly normalizedModel: string;
  readonly sku: string;
  readonly sdkModel: CopilotModelMetadataForPricing;
  readonly sdkModelId?: string;
  readonly sdkModelName?: string;
}

export interface UnpricedCopilotPricingModelResolution {
  readonly status: "unpriced";
  readonly observedModel: string;
  readonly normalizedModel: string | null;
  readonly sku: null;
  readonly sdkModel: null;
}

export type CopilotPricingModelResolution =
  | PricedCopilotPricingModelResolution
  | UnpricedCopilotPricingModelResolution;

/**
 * GitHub converts per-token model pricing into AI credits at a fixed rate of
 * 1 AI credit = $0.01 USD. This is not returned by any API, so it has to live
 * here, but it is a published rate rather than an assumption.
 *
 * Source: https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing
 */
export const COPILOT_AI_CREDIT_USD = 0.01 as const;
export const COPILOT_PRICING_RATE_UNIT = "usd_per_1m_tokens" as const;
export const COPILOT_TOKEN_PRICING_UNIT = 1_000_000 as const;

/**
 * Copilot's SDK price card exposes input, cached-input, and output rates but no
 * cache-write rate, even though cache writes are billed. GitHub's published
 * pricing table lists cache write at exactly 1.25x the input rate for every
 * model that charges it (Claude Opus $5.00 -> $6.25, Claude Sonnet 4.6 $3.00 ->
 * $3.75, Claude Haiku 4.5 $1.00 -> $1.25, GPT-5.6 Sol $5.00 -> $6.25, GPT-5.6
 * Terra $2.00 -> $2.50, GPT-5.6 Luna $0.20 -> $0.25, and the same 1.25 ratio on
 * each long-context tier). Reconciling the CLI's own `totalNanoAiu` metering
 * against the card across local history independently resolves the same 1.25.
 *
 * Models that GitHub lists as having no cache-write cost (earlier OpenAI,
 * Gemini, Grok, MAI, Raptor) also emit no cache-write tokens, so applying the
 * ratio uniformly costs them nothing rather than requiring a hardcoded model
 * list that would drift as models ship.
 *
 * Source: https://docs.github.com/en/copilot/reference/copilot-billing/models-and-pricing
 */
export const COPILOT_CACHE_WRITE_INPUT_RATE_MULTIPLIER = 1.25 as const;

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
  return { input, output, cachedInput, cacheWrite: input * COPILOT_CACHE_WRITE_INPUT_RATE_MULTIPLIER };
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
