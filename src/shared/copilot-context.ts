export type CopilotContextTier = "default" | "long_context";

export const COPILOT_CONTEXT_TIERS = ["default", "long_context"] as const satisfies readonly CopilotContextTier[];

export interface CopilotTokenPrices {
  readonly inputPrice?: number;
  readonly outputPrice?: number;
  readonly cachePrice?: number;
  readonly batchSize?: number;
  readonly contextMax?: number;
}

export interface CopilotTieredTokenPrices extends CopilotTokenPrices {
  readonly longContext?: CopilotTokenPrices;
}

export interface CopilotModelContextMetadata {
  readonly id: string;
  readonly name?: string | null;
  readonly capabilities?: {
    readonly limits?: {
      readonly max_context_window_tokens?: number;
      readonly max_prompt_tokens?: number;
      readonly max_output_tokens?: number;
    };
  };
  readonly billing?: {
    readonly multiplier?: number;
    readonly tokenPrices?: CopilotTieredTokenPrices;
  };
}

export interface CopilotModelCapabilitiesOverride {
  limits?: {
    max_context_window_tokens?: number;
    max_prompt_tokens?: number;
  };
}

export function isCopilotContextTier(value: unknown): value is CopilotContextTier {
  return value === "default" || value === "long_context";
}

export function normalizeCopilotContextTier(value: unknown): CopilotContextTier | undefined {
  return isCopilotContextTier(value) ? value : undefined;
}

export function modelSupportsLongContext(model: CopilotModelContextMetadata | null | undefined): boolean {
  const longContextMax = finitePositiveNumber(model?.billing?.tokenPrices?.longContext?.contextMax);
  const defaultContextMax = finitePositiveNumber(model?.billing?.tokenPrices?.contextMax);
  return longContextMax !== undefined && (
    defaultContextMax === undefined || longContextMax > defaultContextMax
  );
}

export function resolveContextTierForModel(
  model: CopilotModelContextMetadata | null | undefined,
  requested: CopilotContextTier | undefined,
): CopilotContextTier | undefined {
  if (!modelSupportsLongContext(model)) return undefined;
  return requested ?? "default";
}

export function getContextWindowTokensForTier(
  model: CopilotModelContextMetadata | null | undefined,
  tier: CopilotContextTier | undefined,
): number | undefined {
  if (!model) return undefined;
  if (tier === "long_context") {
    return finitePositiveNumber(model.billing?.tokenPrices?.longContext?.contextMax)
      ?? finitePositiveNumber(model.capabilities?.limits?.max_context_window_tokens);
  }
  if (tier === "default") {
    return finitePositiveNumber(model.billing?.tokenPrices?.contextMax)
      ?? finitePositiveNumber(model.capabilities?.limits?.max_context_window_tokens);
  }
  return finitePositiveNumber(model.capabilities?.limits?.max_context_window_tokens);
}

export function getContextTierLabel(
  model: CopilotModelContextMetadata | null | undefined,
  tier: CopilotContextTier | undefined,
): string | undefined {
  if (!tier || !modelSupportsLongContext(model)) return undefined;
  const windowTokens = getContextWindowTokensForTier(model, tier);
  const suffix = windowTokens ? ` (${formatContextWindowTokens(windowTokens)})` : "";
  return tier === "long_context" ? `Long context${suffix}` : `Standard context${suffix}`;
}

export function formatContextWindowTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${Number.isInteger(millions) ? millions.toFixed(0) : millions.toFixed(1)}M`;
  }
  return `${Math.round(tokens / 1_000).toLocaleString()}K`;
}

export function getModelCapabilitiesOverrideForContextTier(
  model: CopilotModelContextMetadata | null | undefined,
  tier: CopilotContextTier | undefined,
): CopilotModelCapabilitiesOverride | undefined {
  if (!modelSupportsLongContext(model) || tier !== "default") return undefined;

  const defaultContextMax = finitePositiveNumber(model?.billing?.tokenPrices?.contextMax);
  const fullContextMax = finitePositiveNumber(model?.capabilities?.limits?.max_context_window_tokens);
  if (!defaultContextMax || (fullContextMax && defaultContextMax >= fullContextMax)) return undefined;

  const limits: NonNullable<CopilotModelCapabilitiesOverride["limits"]> = {
    max_context_window_tokens: defaultContextMax,
  };
  const promptLimit = defaultContextMax - (finiteNonNegativeNumber(model?.capabilities?.limits?.max_output_tokens) ?? 0);
  const fullPromptLimit = finitePositiveNumber(model?.capabilities?.limits?.max_prompt_tokens);
  if (promptLimit > 0 && (!fullPromptLimit || fullPromptLimit > promptLimit)) {
    limits.max_prompt_tokens = promptLimit;
  }
  return { limits };
}

function finitePositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}

function finiteNonNegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}
