// Rubber-duck uses another model family; the override replaces the CLI user's subagents settings.
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
  /** Rubber-duck candidates, strongest first; the first not in the chat model's family wins. */
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

/** Unlisted model: undefined (runtime swaps it). Effort only if supported and not routed. */
function entryFor(model: string, effort: string | undefined, models: readonly SubagentModelMetadata[] | undefined): (SubagentAgentSetting & { model: string }) | undefined {
  const catalog = models && models.length > 0 ? models : undefined;
  if (!catalog) return { model };
  const metadata = catalog.find((candidate) => candidate.id === model && candidate.policy?.state !== "disabled");
  if (!metadata) return undefined;
  const keepsEffort = effort && !modelUsesDynamicSelection(metadata) && metadata.supportedReasoningEfforts?.includes(effort);
  return { model, ...(keepsEffort ? { effortLevel: effort } : {}) };
}

/** Only GPT and Claude are told apart; any other model, Auto included, has no known family. */
function knownFamily(model: string | undefined): Exclude<ModelFamily, "other"> | undefined {
  const family = model ? getModelFamily(model) : "other";
  return family === "other" ? undefined : family;
}

/** In `helpers` and `reviewers` no model means Automatic; `tiers` run strongest first. */
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

/** Strongest candidate from another family than the chat's; none when that family is unknown. */
export function pickSecondOpinion<T extends { model?: string }>(candidates: readonly T[], chatFamily: ModelFamily): T | undefined {
  const family = chatFamily === "other" ? undefined : chatFamily;
  if (!family) return undefined;
  return candidates.find((candidate) => {
    const other = knownFamily(candidate.model);
    return other !== undefined && other !== family;
  });
}

/** Without a pick, Copilot chooses rubber-duck's model itself. */
export function subagentSettingsForModel(plan: SubagentPlan, chatModel: string | undefined): ResolvedSubagentSettings {
  const pick = pickSecondOpinion(plan.secondOpinion, chatModel ? getModelFamily(chatModel) : "other");
  return { agents: { ...plan.agents, ...(pick ? { [SECOND_OPINION_SUBAGENT]: { ...pick } } : {}) } };
}
