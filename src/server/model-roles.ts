// Resolves a role (Settings › Models) to the model, effort and context it runs on. A role nobody set
// runs on its default tier (MODEL_ROLE_INFO.recommended). Only when that tier has no model, or the
// chosen model can't be used, does it return no model, and the caller falls back to its built-in pick.
/** What the resolver needs to know about a model; the backend's model list and sub-agent metadata both fit. */
export interface RoleModelInfo {
  id: string;
  policy?: { state?: string };
  supportedReasoningEfforts?: readonly string[];
}
import type { AppSettings } from "./settings-store.js";
import { defaultRoleTier, isTierChoice, MODEL_ROLE_INFO, MODEL_TIER_INFO, type ModelRole, type ModelRolesView, type ResolvedModelRole } from "../shared/model-roles.js";
import { MODEL_PRESET_SLOTS, type ModelPresetSlot } from "../shared/model-presets.js";
import type { CopilotContextTier } from "../shared/copilot-context.js";
import { REASONING_EFFORT_LEVELS, resolveSupportedReasoningEffort } from "../shared/reasoning-effort.js";

// New chats and background checks run on their older setting, which holds the tier's model, so they
// can't fall back. Helm checks the model itself when it starts (helm/helm-model.ts).
const FIELD_BACKED_ROLES: ReadonlySet<ModelRole> = new Set(["chat", "background"]);

/** The effort the hands-free layer runs at on a tier (see voice/hands-free-model.ts). */
const HANDS_FREE_TIER_EFFORT = "low";

function enabled(model: RoleModelInfo): boolean {
  // The same rule session creation applies: only a model the policy disables is refused.
  return model.policy?.state !== "disabled";
}

/** The lowest effort a model supports, for jobs that should not think at all. */
export function lowestSupportedEffort(model: RoleModelInfo | undefined): string | undefined {
  const supported = model?.supportedReasoningEfforts;
  if (!supported?.length) return undefined;
  return [...supported].sort((a, b) => (REASONING_EFFORT_LEVELS as readonly string[]).indexOf(a) - (REASONING_EFFORT_LEVELS as readonly string[]).indexOf(b))[0];
}

/**
 * What a role runs on. `models` is the live model list; without it (still loading) a configured
 * model is returned unchecked. Roles whose older field already carries the tier (New chats,
 * Background checks) are reported here for the Models page; their work reads the field.
 */
export function resolveModelRole(settings: Pick<AppSettings, "modelRoles" | "modelPresets">, role: ModelRole, models?: readonly RoleModelInfo[]): ResolvedModelRole {
  const saved = settings.modelRoles?.[role];
  const fallbackTier = saved ? undefined : defaultRoleTier(role);
  const choice = saved ?? (fallbackTier ? { tier: fallbackTier } : undefined);
  if (!choice) return { role, source: "automatic" };
  const isDefault = !saved ? { isDefault: true as const } : {};
  const fallback = lowerFirst(MODEL_ROLE_INFO[role].automatic);
  const tier = isTierChoice(choice) ? choice.tier : undefined;
  const target = tier ? settings.modelPresets?.[tier] : choice as { model: string; reasoningEffort?: string; contextTier?: "default" | "long_context" };
  if (!target?.model) {
    return { role, source: "automatic", ...(tier ? { tier } : {}), ...isDefault, warning: `${tier ? `The ${MODEL_TIER_INFO[tier].label} tier` : "That choice"} has no model yet, so this uses ${fallback}.` };
  }
  const known = models && models.length > 0 ? models.find((model) => model.id === target.model) : undefined;
  if (models && models.length > 0 && (!known || !enabled(known))) {
    // These roles run on their older setting, which holds the tier's model, so they don't fall back.
    if (FIELD_BACKED_ROLES.has(role)) {
      return { role, source: tier ? "tier" : "custom", ...(tier ? { tier } : {}), model: target.model, warning: `${target.model} isn't available right now, so this work may fail until the ${tier ? "tier gets" : "role gets"} another model.` };
    }
    return { role, source: "automatic", ...(tier ? { tier } : {}), ...isDefault, warning: `${target.model} isn't available, so this uses ${fallback}.` };
  }
  // Hands-free has to answer in about a second: on a tier it runs at low, whatever the tier's effort.
  const wanted = role === "handsFree" && tier ? HANDS_FREE_TIER_EFFORT : target.reasoningEffort;
  const reasoningEffort = role === "helper"
    ? (known ? lowestSupportedEffort(known) : undefined)
    : known ? resolveSupportedReasoningEffort(wanted, known.supportedReasoningEfforts) : wanted;
  return {
    role,
    source: tier ? "tier" : "custom",
    ...(tier ? { tier } : {}),
    ...isDefault,
    model: target.model,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(target.contextTier ? { contextTier: target.contextTier } : {}),
  };
}

export type ResolvedModelTier =
  | { model: string; reasoningEffort?: string; contextTier?: CopilotContextTier }
  | { model?: undefined; warning: string };

/** A tier's current model for work that follows it (schedules), or why it can't be used. */
export function resolveModelTier(settings: Pick<AppSettings, "modelPresets"> | undefined, tier: ModelPresetSlot, models?: readonly RoleModelInfo[]): ResolvedModelTier {
  const label = MODEL_TIER_INFO[tier].label;
  const target = settings?.modelPresets?.[tier];
  if (!target?.model) return { warning: `The ${label} tier has no model yet.` };
  const known = models && models.length > 0 ? models.find((model) => model.id === target.model) : undefined;
  if (models && models.length > 0 && (!known || !enabled(known))) {
    return { warning: `The ${label} tier's model ${target.model} isn't available.` };
  }
  const reasoningEffort = known ? resolveSupportedReasoningEffort(target.reasoningEffort, known.supportedReasoningEfforts) : target.reasoningEffort;
  return {
    model: target.model,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(target.contextTier ? { contextTier: target.contextTier } : {}),
  };
}

/** Whether a model can start a session, judged by the live list (unknown when the list is missing). */
export function isModelUsable(modelId: string, models?: readonly RoleModelInfo[]): boolean {
  if (!models || models.length === 0) return true;
  const known = models.find((model) => model.id === modelId);
  return !!known && enabled(known);
}

export function describeModelRoles(settings: AppSettings, models: readonly RoleModelInfo[] | undefined, roles: readonly ModelRole[]): ModelRolesView {
  const tiers: ModelRolesView["tiers"] = {};
  for (const slot of MODEL_PRESET_SLOTS) {
    const preset = settings.modelPresets?.[slot];
    if (preset) tiers[slot] = { ...preset };
  }
  return { tiers, roles: roles.map((role) => resolveModelRole(settings, role, models)) };
}

function lowerFirst(text: string): string {
  return text ? text[0]!.toLowerCase() + text.slice(1) : text;
}
