export type CopilotContextTier = "default" | "long_context";

export const COPILOT_CONTEXT_TIERS = ["default", "long_context"] as const satisfies readonly CopilotContextTier[];

export interface CopilotTokenPrices {
  readonly inputPrice?: number;
  readonly outputPrice?: number;
  readonly cachePrice?: number;
  readonly batchSize?: number;
  readonly maxPromptTokens?: number;
  readonly contextMax?: number;
}

export interface CopilotTieredTokenPrices extends CopilotTokenPrices {
  readonly longContext?: CopilotTokenPrices;
}

export interface CopilotModelContextMetadata {
  readonly id: string;
  readonly name?: string | null;
  /** The runtime picks the model per request (Auto, Copilot Fusion), so there is no context tier to choose. */
  readonly selectionMode?: "dynamic";
  readonly supportedReasoningEfforts?: readonly string[];
  readonly defaultReasoningEffort?: string;
  /** Names for effort values that are not reasoning levels, such as Copilot Fusion's Standard, High and Max. */
  readonly reasoningEffortLabels?: Readonly<Record<string, string>>;
  readonly capabilities?: {
    readonly supports?: {
      readonly [key: string]: unknown;
    };
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

export function modelUsesDynamicSelection(
  model: CopilotModelContextMetadata | null | undefined,
): boolean {
  return model?.selectionMode === "dynamic";
}

export function isCopilotContextTier(value: unknown): value is CopilotContextTier {
  return value === "default" || value === "long_context";
}

export function normalizeCopilotContextTier(value: unknown): CopilotContextTier | undefined {
  return isCopilotContextTier(value) ? value : undefined;
}

export function modelSupportsLongContext(model: CopilotModelContextMetadata | null | undefined): boolean {
  const longContextMax = getTierPromptTokens(model?.billing?.tokenPrices?.longContext);
  const defaultContextMax = getTierPromptTokens(model?.billing?.tokenPrices);
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

export function getContextPromptTokensForTier(
  model: CopilotModelContextMetadata | null | undefined,
  tier: CopilotContextTier | undefined,
): number | undefined {
  if (!model) return undefined;
  if (tier === "long_context") {
    return getTierPromptTokens(model.billing?.tokenPrices?.longContext)
      ?? finitePositiveNumber(model.capabilities?.limits?.max_prompt_tokens);
  }
  if (tier === "default") {
    return getTierPromptTokens(model.billing?.tokenPrices)
      ?? finitePositiveNumber(model.capabilities?.limits?.max_prompt_tokens);
  }
  return finitePositiveNumber(model.capabilities?.limits?.max_prompt_tokens);
}

export function getContextTierLabel(
  model: CopilotModelContextMetadata | null | undefined,
  tier: CopilotContextTier | undefined,
): string | undefined {
  if (!tier || !modelSupportsLongContext(model)) return undefined;
  const promptTokens = getContextPromptTokensForTier(model, tier);
  const suffix = promptTokens ? ` (${formatContextWindowTokens(promptTokens)})` : "";
  return tier === "long_context" ? `Long context${suffix}` : `Standard context${suffix}`;
}

export function formatContextWindowTokens(tokens: number): string {
  if (tokens >= 1_000_000) {
    const millions = tokens / 1_000_000;
    return `${Number.isInteger(millions) ? millions.toFixed(0) : millions.toFixed(1)}M`;
  }
  return `${Math.round(tokens / 1_000).toLocaleString()}K`;
}

function getTierPromptTokens(prices: CopilotTokenPrices | undefined): number | undefined {
  return finitePositiveNumber(prices?.maxPromptTokens) ?? finitePositiveNumber(prices?.contextMax);
}

function finitePositiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined;
}
