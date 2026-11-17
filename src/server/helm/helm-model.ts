import type { AgentModelInfo } from "../agent-backend/types.js";
import type { AppSettings } from "../settings-store.js";
import type { CopilotContextTier } from "../../shared/copilot-context.js";
import { resolveSupportedReasoningEffort } from "../../shared/reasoning-effort.js";
import { resolveModelRole } from "../model-roles.js";

/** Output price above which Automatic never picks a model (premium speed or research tiers). */
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

/** A priced model that reasons; a router like "auto" has no price and often picks a light model. */
function thinks(model: AgentModelInfo | undefined): model is AgentModelInfo {
  return !!model && typeof price(model) === "number" && (model.supportedReasoningEfforts?.length ?? 0) > 0;
}

/** Order: requested, Helm role, thinking user default, best model; effort clamped to the model. */
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
  // No model list yet (runtime starting): name what was asked for and let the runtime decide.
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
