// Which model Helm runs on, for its chat and for the looks that write the brief on Home: the
// "Helm" row in Settings › Models (a tier, or a model of its own), checked against the models that
// can be used right now; otherwise Automatic.
import type { AgentModelInfo } from "../agent-backend/types.js";
import type { AppSettings } from "../settings-store.js";
import type { CopilotContextTier } from "../../shared/copilot-context.js";
import { resolveSupportedReasoningEffort } from "../../shared/reasoning-effort.js";
import { resolveModelRole } from "../model-roles.js";

/** Output price above which Automatic never picks a model (premium tiers priced for speed or research). */
export const HELM_MAX_AUTOMATIC_PRICE = 2_000;

export interface HelmModelChoice {
  model?: string;
  reasoningEffort?: string;
  contextTier?: CopilotContextTier;
}

export function usableModels(models: readonly AgentModelInfo[]): AgentModelInfo[] {
  return models.filter((model) => {
    const policy = (model as { policy?: { state?: string } }).policy;
    return !policy || policy.state === "enabled";
  });
}

function price(model: AgentModelInfo): number | undefined {
  return (model as { billing?: { tokenPrices?: { outputPrice?: number } } }).billing?.tokenPrices?.outputPrice;
}

/** A real model that reasons. A router such as "auto" has no price and picks per request, often a light model. */
function thinks(model: AgentModelInfo | undefined): model is AgentModelInfo {
  return !!model && typeof price(model) === "number" && (model.supportedReasoningEfforts?.length ?? 0) > 0;
}

/**
 * Helm's model, for its chat and for the brief's looks. `requested` (a conversation started on a
 * named model) wins when it can be used, then the Helm role (a tier, or a model of its own, with that
 * choice's effort and context), then Automatic: the user's default chat model when it is a real model
 * that reasons, else the most capable ordinary model. Effort is the role's, else the user's default
 * effort for that model, else `fallbackEffort`, always clamped to what the model supports.
 */
export function chooseHelmModel(
  settings: AppSettings,
  allModels: readonly AgentModelInfo[],
  options: { requested?: string; fallbackEffort?: string } = {},
): HelmModelChoice {
  const models = usableModels(allModels);
  const find = (id: string | undefined) => (id ? models.find((model) => model.id === id) : undefined);
  const role = resolveModelRole(settings, "helm", models);
  const roleModel = role.source !== "automatic" ? find(role.model) : undefined;
  const userDefault = find(settings.model);
  const requested = find(options.requested);
  const chosen = requested
    ?? roleModel
    ?? (thinks(userDefault) ? userDefault : undefined)
    ?? [...models].filter((model) => thinks(model) && price(model)! <= HELM_MAX_AUTOMATIC_PRICE).sort((a, b) => price(b)! - price(a)!)[0]
    ?? userDefault
    ?? models[0];
  // No model list (the runtime is starting): name what was asked for and let the runtime decide the rest.
  if (!chosen) {
    const fallback = options.requested ?? (role.source !== "automatic" ? role.model : undefined);
    return fallback ? { model: fallback, ...(role.reasoningEffort && !options.requested ? { reasoningEffort: role.reasoningEffort } : {}) } : {};
  }
  const onRole = chosen === roleModel && !requested;
  const wanted = (onRole ? role.reasoningEffort : undefined)
    ?? (chosen.id === settings.model ? settings.reasoningEffort : undefined)
    ?? options.fallbackEffort;
  const reasoningEffort = resolveSupportedReasoningEffort(wanted, chosen.supportedReasoningEfforts);
  return {
    model: chosen.id,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(onRole && role.contextTier ? { contextTier: role.contextTier } : {}),
  };
}
