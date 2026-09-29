import { isRecord } from "../shared/is-record.js";
import { resolveSupportedReasoningEffort } from "../shared/reasoning-effort.js";
import type { AgentModelInfo } from "./agent-backend/index.js";

// Picks the model for the Bridge's small helper sessions (session titles, the deferred-work
// worker's default, Helm) from what the model list says about each model, never from its name.

/** The effort helper sessions run at unless a caller asks for another: skip reasoning entirely. */
export const HELPER_REASONING_EFFORT = "none";

export interface HelperModelSelection {
  model: string;
  /** Undefined when the model has no effort control, so the session keeps the model's own setting. */
  reasoningEffort?: string;
}

const TOKEN_PRICE_FIELDS = ["inputPrice", "outputPrice", "cachePrice"] as const;

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function isEnabled(model: AgentModelInfo): boolean {
  const policy = (model as { policy?: unknown }).policy;
  if (!isRecord(policy)) return true;
  return typeof policy.state === "string" && policy.state.toLowerCase() === "enabled";
}

/**
 * What one request costs relative to other models, or undefined when the model list gives no
 * usable price. A router such as "auto" and placeholder entries (batch size 0) have none, so they
 * are never picked.
 */
export function helperModelCost(model: AgentModelInfo): number | undefined {
  const billing = isRecord(model.billing) ? model.billing : undefined;
  const multiplier = finiteNumber(billing?.multiplier);
  if (multiplier !== undefined) return multiplier;

  const rawPrices = billing?.tokenPrices;
  const tokenPrices = isRecord(rawPrices) ? rawPrices : undefined;
  const batchSize = finiteNumber(tokenPrices?.batchSize);
  if (!tokenPrices || batchSize === undefined || batchSize <= 0) return undefined;
  let total = 0;
  let priced = false;
  for (const field of TOKEN_PRICE_FIELDS) {
    const price = finiteNumber(tokenPrices[field]);
    if (price === undefined || price < 0) continue;
    total += price / batchSize;
    priced = true;
  }
  return priced ? total : undefined;
}

function supportsEffort(model: AgentModelInfo, effort: string): boolean {
  return (model.supportedReasoningEfforts as readonly string[] | undefined)?.includes(effort) === true;
}

/**
 * The cheapest enabled, priced model that can run without reasoning, falling back to the cheapest
 * enabled, priced model when none can. The effort is the wanted one (default "none") or the
 * nearest the model supports below it, otherwise its lowest.
 */
export function selectHelperModel(
  models: readonly AgentModelInfo[],
  wantedEffort: string = HELPER_REASONING_EFFORT,
): HelperModelSelection | undefined {
  const candidates = models
    .filter((model) => !!model.id && isEnabled(model))
    .map((model) => ({ model, cost: helperModelCost(model) }))
    .filter((entry): entry is { model: AgentModelInfo; cost: number } => entry.cost !== undefined)
    .sort((a, b) =>
      Number(supportsEffort(b.model, HELPER_REASONING_EFFORT)) - Number(supportsEffort(a.model, HELPER_REASONING_EFFORT))
      || a.cost - b.cost
      || a.model.id.localeCompare(b.model.id));
  const chosen = candidates[0]?.model;
  if (!chosen) return undefined;
  const reasoningEffort = resolveSupportedReasoningEffort(wantedEffort, chosen.supportedReasoningEfforts);
  return { model: chosen.id, ...(reasoningEffort ? { reasoningEffort } : {}) };
}
