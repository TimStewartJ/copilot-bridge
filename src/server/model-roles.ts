// Resolves a role (Settings › Models) to the model, effort and context it runs on. A role on a tier
// or a model of its own resolves here; an Automatic role (or one whose model can't be used) returns
// no model, and the caller keeps the choice it made before roles existed.
/** What the resolver needs to know about a model; the backend's model list and sub-agent metadata both fit. */
export interface RoleModelInfo {
  id: string;
  policy?: { state?: string };
  supportedReasoningEfforts?: readonly string[];
}
import type { AppSettings } from "./settings-store.js";
import { isTierChoice, type ModelRole, type ModelRolesView, type ResolvedModelRole } from "../shared/model-roles.js";
import { MODEL_PRESET_SLOTS } from "../shared/model-presets.js";
import { REASONING_EFFORT_LEVELS, resolveSupportedReasoningEffort } from "../shared/reasoning-effort.js";

// New chats and background checks run on their older setting, which holds the tier's model, so they
// can't fall back. Helm checks the model itself when it starts (helm/helm-model.ts).
const FIELD_BACKED_ROLES: ReadonlySet<ModelRole> = new Set(["chat", "background"]);

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
 * model is returned unchecked. Roles whose older field already carries the tier (New chats, Helm,
 * Background checks) are reported here for the Models page; their work reads the field.
 */
export function resolveModelRole(settings: Pick<AppSettings, "modelRoles" | "modelPresets">, role: ModelRole, models?: readonly RoleModelInfo[]): ResolvedModelRole {
  const choice = settings.modelRoles?.[role];
  if (!choice) return { role, source: "automatic" };
  const tier = isTierChoice(choice) ? choice.tier : undefined;
  const target = tier ? settings.modelPresets?.[tier] : choice as { model: string; reasoningEffort?: string; contextTier?: "default" | "long_context" };
  if (!target?.model) {
    return { role, source: "automatic", ...(tier ? { tier } : {}), warning: "That tier has no model yet, so this uses Automatic." };
  }
  const known = models && models.length > 0 ? models.find((model) => model.id === target.model) : undefined;
  if (models && models.length > 0 && (!known || !enabled(known))) {
    // These roles run on their older setting, which holds the tier's model, so they don't fall back.
    if (FIELD_BACKED_ROLES.has(role)) {
      return { role, source: tier ? "tier" : "custom", ...(tier ? { tier } : {}), model: target.model, warning: `${target.model} isn't available right now, so this work may fail until the ${tier ? "tier gets" : "role gets"} another model.` };
    }
    return { role, source: "automatic", ...(tier ? { tier } : {}), warning: `${target.model} isn't available, so this uses Automatic.` };
  }
  const reasoningEffort = role === "helper"
    ? (known ? lowestSupportedEffort(known) : undefined)
    : known ? resolveSupportedReasoningEffort(target.reasoningEffort, known.supportedReasoningEfforts) : target.reasoningEffort;
  return {
    role,
    source: tier ? "tier" : "custom",
    ...(tier ? { tier } : {}),
    model: target.model,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(target.contextTier ? { contextTier: target.contextTier } : {}),
  };
}

export function describeModelRoles(settings: AppSettings, models: readonly RoleModelInfo[] | undefined, scheduleOverrides: number, roles: readonly ModelRole[]): ModelRolesView {
  const tiers: ModelRolesView["tiers"] = {};
  for (const slot of MODEL_PRESET_SLOTS) {
    const preset = settings.modelPresets?.[slot];
    if (preset) tiers[slot] = { ...preset };
  }
  return { tiers, roles: roles.map((role) => resolveModelRole(settings, role, models)), scheduleOverrides };
}
