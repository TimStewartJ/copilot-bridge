// Each maker's best model: its priciest by default, or the user's choice with effort and context.
import { modelSupportsLongContext, modelUsesDynamicSelection, type CopilotContextTier, type CopilotModelContextMetadata } from "./copilot-context.js";

export interface BestModelChoice {
  model: string;
  reasoningEffort?: string;
  contextTier?: CopilotContextTier;
}

/** The user's choices by maker; a maker missing here uses its default. */
export type BestModels = Record<string, BestModelChoice>;

export interface BestModelCatalogEntry extends CopilotModelContextMetadata {
  readonly policy?: { readonly state?: string } | null;
}

export interface ResolvedBestModel {
  maker: string;
  model: string;
  reasoningEffort?: string;
  contextTier: CopilotContextTier;
  /** The user chose it; false means the maker's default. */
  custom: boolean;
}

/** Effort a default best model runs at, when the model has it. */
export const BEST_MODEL_DEFAULT_EFFORT = "high";

/** The model maker, by the id's first word. */
export function modelMaker(modelId: string): string {
  const id = modelId.trim().toLowerCase();
  const dash = id.indexOf("-");
  const first = dash > 0 ? id.slice(0, dash) : id;
  // agent-text-audit: catalog (model ids); o1, o3 and the like are GPT's maker too.
  return /^o\d/.test(first) ? "gpt" : first;
}

const MAKER_LABELS: Readonly<Record<string, string>> = { gpt: "GPT", claude: "Claude", gemini: "Gemini", grok: "Grok", mai: "MAI" };

export function modelMakerLabel(maker: string): string {
  return MAKER_LABELS[maker] ?? (maker ? `${maker[0].toUpperCase()}${maker.slice(1)}` : maker);
}

/** The first release number in an id (6.2 in gpt-6.2-sol, 3 in o3), as numeric parts. */
export function modelVersion(modelId: string): number[] {
  // agent-text-audit: catalog (model ids)
  const match = /\d+(?:\.\d+)*/.exec(modelId);
  return match ? match[0].split(".").map(Number) : [];
}

function compareVersions(left: number[], right: number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] ?? 0) - (right[index] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/** Output price in USD per million tokens; 0 when unpriced, so it ranks last. */
export function modelOutputPrice(model: BestModelCatalogEntry | undefined): number {
  const prices = model?.billing?.tokenPrices;
  const cents = prices?.outputPrice;
  if (typeof cents !== "number" || !Number.isFinite(cents) || cents < 0) return 0;
  const batch = typeof prices?.batchSize === "number" && prices.batchSize > 0 ? prices.batchSize : 1_000_000;
  return (cents / 100) * (1_000_000 / batch);
}

/** Enabled, and not a router that picks a model per request. */
export function canBeBestModel(model: BestModelCatalogEntry): boolean {
  return model.id !== "auto" && model.policy?.state !== "disabled" && !modelUsesDynamicSelection(model);
}

/** Priciest first, then the newer release, then by id. */
function strongerFirst(left: BestModelCatalogEntry, right: BestModelCatalogEntry): number {
  return modelOutputPrice(right) - modelOutputPrice(left)
    || compareVersions(modelVersion(right.id), modelVersion(left.id))
    || left.id.localeCompare(right.id);
}

function fit(model: BestModelCatalogEntry, choice: Omit<BestModelChoice, "model">, custom: boolean, maker: string): ResolvedBestModel {
  const efforts = model.supportedReasoningEfforts ?? [];
  const reasoningEffort = choice.reasoningEffort && efforts.includes(choice.reasoningEffort) ? choice.reasoningEffort : undefined;
  return {
    maker,
    model: model.id,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    contextTier: choice.contextTier === "long_context" && modelSupportsLongContext(model) ? "long_context" : "default",
    custom,
  };
}

/** One entry per maker, strongest first; a choice whose model left the catalog is ignored. */
export function resolveBestModels(
  catalog: readonly BestModelCatalogEntry[] | undefined,
  choices: BestModels | undefined,
): ResolvedBestModel[] {
  const byMaker = new Map<string, BestModelCatalogEntry[]>();
  for (const model of catalog ?? []) {
    if (!canBeBestModel(model)) continue;
    const maker = modelMaker(model.id);
    byMaker.set(maker, [...(byMaker.get(maker) ?? []), model]);
  }
  const resolved: Array<ResolvedBestModel & { price: number }> = [];
  for (const [maker, models] of byMaker) {
    const choice = choices?.[maker];
    const chosen = choice ? models.find((model) => model.id === choice.model) : undefined;
    const model = chosen ?? [...models].sort(strongerFirst)[0];
    const entry = chosen && choice
      ? fit(chosen, choice, true, maker)
      : fit(model, { reasoningEffort: BEST_MODEL_DEFAULT_EFFORT }, false, maker);
    resolved.push({ ...entry, price: modelOutputPrice(model) });
  }
  return resolved
    .sort((left, right) => right.price - left.price || left.maker.localeCompare(right.maker))
    .map(({ price: _price, ...entry }) => entry);
}
