// Which model each built-in sub-agent runs on. Settings › Models sets two roles: Helpers (task,
// explore, research; stored as the `subagents` role) and Reviewers (code-review, security-review,
// general-purpose). Rubber-duck has no setting: it gets the strongest tier from another model
// family than the chat's current model, so its second opinion does not share the chat's blind
// spots. The plan is applied to each live session through the runtime's sub-agent override,
// which replaces (not merges with) the CLI user's own `subagents` settings.
import { modelUsesDynamicSelection } from "./copilot-context.js";
import { getModelFamily, type ModelFamily } from "./model-families.js";

/** Use the parent session's model. Understood by the runtime. */
export const SUBAGENT_INHERIT_MODEL = "inherit";

export const HELPER_SUBAGENTS = ["task", "explore", "research"] as const;
export const REVIEWER_SUBAGENTS = ["code-review", "security-review", "general-purpose"] as const;
export const SECOND_OPINION_SUBAGENT = "rubber-duck";

/** What Helpers run on when their role is Automatic. */
export const BRIDGE_HELPER_DEFAULT: Readonly<{ model: string; effortLevel: string }> = { model: "gpt-6-luna", effortLevel: "max" };

export interface SubagentAgentSetting {
  model?: string;
  effortLevel?: string;
}

/** The map sent to the runtime. */
export interface ResolvedSubagentSettings {
  agents: Record<string, SubagentAgentSetting>;
}

export interface SubagentPlan {
  agents: Record<string, SubagentAgentSetting>;
  /** Rubber-duck candidates, strongest first; the first from another family than the chat's model wins. */
  secondOpinion: Array<SubagentAgentSetting & { model: string }>;
}

export interface SubagentModelMetadata {
  readonly id: string;
  readonly supportedReasoningEfforts?: readonly string[];
  readonly selectionMode?: "dynamic";
  readonly policy?: { readonly state?: string };
}

export interface SubagentModelChoice {
  model?: string;
  reasoningEffort?: string;
}

/**
 * A runtime entry for a model, or undefined when the known model list lacks it (the runtime would
 * silently run a different model). Effort is kept only when the list confirms the model supports
 * it, because the runtime fails a sub-agent whose effort its model rejects. A routed model's levels
 * are tiers (Copilot Fusion's), which sub-agent settings cannot carry, so its sub-agents use its default.
 */
function entryFor(model: string, effort: string | undefined, models: readonly SubagentModelMetadata[] | undefined): (SubagentAgentSetting & { model: string }) | undefined {
  const catalog = models && models.length > 0 ? models : undefined;
  if (!catalog) return { model };
  const metadata = catalog.find((candidate) => candidate.id === model && candidate.policy?.state !== "disabled");
  if (!metadata) return undefined;
  const keepsEffort = effort && !modelUsesDynamicSelection(metadata) && metadata.supportedReasoningEfforts?.includes(effort);
  return { model, ...(keepsEffort ? { effortLevel: effort } : {}) };
}

/** Only GPT and Claude are told apart; any other model (a router such as Auto included) has no known family. */
function knownFamily(model: string | undefined): Exclude<ModelFamily, "other"> | undefined {
  const family = model ? getModelFamily(model) : "other";
  return family === "other" ? undefined : family;
}

/**
 * The sub-agent plan for every session. `helpers` and `reviewers` are the resolved roles (no model
 * means Automatic); `tiers` are the tier models strongest first (Deep, Standard, Fast).
 */
export function buildSubagentPlan(
  roles: { helpers?: SubagentModelChoice; reviewers?: SubagentModelChoice; tiers: ReadonlyArray<SubagentModelChoice | undefined> },
  models?: readonly SubagentModelMetadata[],
): SubagentPlan {
  const agents: Record<string, SubagentAgentSetting> = {};
  const helper = roles.helpers?.model
    ? entryFor(roles.helpers.model, roles.helpers.reasoningEffort, models)
    : entryFor(BRIDGE_HELPER_DEFAULT.model, BRIDGE_HELPER_DEFAULT.effortLevel, models);
  // Without a usable helper model the runtime chooses, as it does for any unknown model.
  if (helper) for (const name of HELPER_SUBAGENTS) agents[name] = { ...helper };
  const reviewer = roles.reviewers?.model ? entryFor(roles.reviewers.model, roles.reviewers.reasoningEffort, models) : undefined;
  for (const name of REVIEWER_SUBAGENTS) agents[name] = reviewer ? { ...reviewer } : { model: SUBAGENT_INHERIT_MODEL };
  const secondOpinion: SubagentPlan["secondOpinion"] = [];
  for (const tier of roles.tiers) {
    if (!tier?.model || !knownFamily(tier.model) || secondOpinion.some((entry) => entry.model === tier.model)) continue;
    const entry = entryFor(tier.model, tier.reasoningEffort, models);
    if (entry) secondOpinion.push(entry);
  }
  return { agents, secondOpinion };
}

/** The strongest candidate from another family than the chat's; none when that family is unknown. */
export function pickSecondOpinion<T extends { model?: string }>(candidates: readonly T[], chatFamily: ModelFamily): T | undefined {
  const family = chatFamily === "other" ? undefined : chatFamily;
  if (!family) return undefined;
  return candidates.find((candidate) => {
    const other = knownFamily(candidate.model);
    return other !== undefined && other !== family;
  });
}

/** What to send the runtime for a session currently on `chatModel`. Without a pick, Copilot chooses rubber-duck's model itself. */
export function subagentSettingsForModel(plan: SubagentPlan, chatModel: string | undefined): ResolvedSubagentSettings {
  const pick = pickSecondOpinion(plan.secondOpinion, chatModel ? getModelFamily(chatModel) : "other");
  return { agents: { ...plan.agents, ...(pick ? { [SECOND_OPINION_SUBAGENT]: { ...pick } } : {}) } };
}
