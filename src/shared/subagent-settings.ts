// Bridge-owned sub-agent model preferences. Bridge ships its own defaults and
// applies the resolved map to every session through the runtime's live
// subagent-settings override, which replaces (not merges with) the CLI user's
// `subagents` settings. Choosing the CLI source sends nothing, so the CLI's own
// settings.json applies instead.

/** Use the parent session's model. Understood by the runtime. */
export const SUBAGENT_INHERIT_MODEL = "inherit";
/** Bridge-only marker: omit the value so the runtime chooses. */
export const SUBAGENT_RUNTIME_DEFAULT = "runtime-default";

export type SubagentSettingsSource = "bridge" | "cli";

export interface SubagentAgentSetting {
  /** A model id, `inherit`, or `runtime-default`. Absent keeps the Bridge default. */
  model?: string;
  /** A reasoning effort, or `runtime-default`. Absent keeps the Bridge default. */
  effortLevel?: string;
}

/** Stored user choices. Absent means Bridge defaults with no overrides. */
export interface SubagentSettings {
  source?: SubagentSettingsSource;
  /** Per-agent overrides layered over the Bridge defaults. */
  agents?: Record<string, SubagentAgentSetting>;
}

/** The map sent to the runtime. */
export interface ResolvedSubagentSettings {
  agents: Record<string, SubagentAgentSetting>;
}

export interface SubagentModelMetadata {
  readonly id: string;
  readonly supportedReasoningEfforts?: readonly string[];
  readonly policy?: { readonly state?: string };
}

/** Built-in runtime agents shown in Settings, in display order. */
export const BUILT_IN_SUBAGENTS = [
  { name: "task", description: "Runs commands such as tests, builds and installs." },
  { name: "explore", description: "Read-only codebase exploration." },
  { name: "research", description: "Web and GitHub research with citations." },
  { name: "code-review", description: "Reviews diffs for bugs and logic errors." },
  { name: "security-review", description: "Looks for exploitable vulnerabilities." },
  { name: "general-purpose", description: "Full-capability delegated implementation." },
  { name: "rubber-duck", description: "Second-opinion review of plans and changes." },
] as const;

/** What Bridge applies when the user has not overridden an agent. */
export const BRIDGE_DEFAULT_SUBAGENTS: Readonly<Record<string, Readonly<{ model: string; effortLevel?: string }>>> = {
  task: { model: "gpt-6-luna", effortLevel: "max" },
  explore: { model: "gpt-6-luna", effortLevel: "max" },
  research: { model: "gpt-6-luna", effortLevel: "max" },
  "code-review": { model: SUBAGENT_INHERIT_MODEL },
  "security-review": { model: SUBAGENT_INHERIT_MODEL },
  "general-purpose": { model: SUBAGENT_INHERIT_MODEL },
  "rubber-duck": { model: "gpt-6-sol", effortLevel: "high" },
};

export const SUBAGENT_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
export const SUBAGENT_EFFORT_PATTERN = /^[a-z][a-z-]{0,31}$/;

export function isConcreteSubagentModel(model: string | undefined): model is string {
  return !!model && model !== SUBAGENT_INHERIT_MODEL && model !== SUBAGENT_RUNTIME_DEFAULT;
}

/**
 * The model and effort an agent should use before availability checks. The
 * default effort belongs to the default model, so overriding only the model
 * drops it. Effort only applies to a named model: the runtime fails a
 * sub-agent whose effort its model does not support, and Bridge cannot know
 * the model behind `inherit` or the runtime's own choice.
 */
export function effectiveSubagentSetting(
  name: string,
  override: SubagentAgentSetting | undefined,
): SubagentAgentSetting {
  const fallback = BRIDGE_DEFAULT_SUBAGENTS[name];
  const model = override?.model ?? fallback?.model;
  const keepsDefaultModel = override?.model === undefined || override.model === fallback?.model;
  const effort = override?.effortLevel ?? (keepsDefaultModel ? fallback?.effortLevel : undefined);
  const concreteModel = isConcreteSubagentModel(model);
  return {
    ...(model && model !== SUBAGENT_RUNTIME_DEFAULT ? { model } : {}),
    ...(concreteModel && effort && effort !== SUBAGENT_RUNTIME_DEFAULT ? { effortLevel: effort } : {}),
  };
}

/**
 * Bridge defaults plus user overrides, or `undefined` when the CLI settings
 * should apply. With a known model list, a missing or disabled model is
 * omitted (the runtime would silently run a different model). An effort is
 * sent only when the model list confirms the model supports it, because the
 * runtime fails a sub-agent whose effort its model rejects.
 */
export function resolveSubagentSettings(
  settings: SubagentSettings | undefined,
  models?: readonly SubagentModelMetadata[],
): ResolvedSubagentSettings | undefined {
  if (settings?.source === "cli") return undefined;
  const catalog = models && models.length > 0 ? models : undefined;
  const names = new Set([...Object.keys(BRIDGE_DEFAULT_SUBAGENTS), ...Object.keys(settings?.agents ?? {})]);
  const agents: Record<string, SubagentAgentSetting> = {};
  for (const name of names) {
    const entry = effectiveSubagentSetting(name, settings?.agents?.[name]);
    const metadata = catalog && isConcreteSubagentModel(entry.model)
      ? catalog.find((model) => model.id === entry.model && model.policy?.state !== "disabled")
      : undefined;
    if (catalog && isConcreteSubagentModel(entry.model) && !metadata) continue;
    if (entry.effortLevel && !metadata?.supportedReasoningEfforts?.includes(entry.effortLevel)) {
      delete entry.effortLevel;
    }
    if (entry.model || entry.effortLevel) agents[name] = entry;
  }
  return { agents };
}

/** Named model selections introduced by an overrides change, for validation. */
export function changedSubagentSelections(
  current: SubagentSettings | undefined,
  next: SubagentSettings | undefined,
): Array<{ model: string; reasoningEffort?: string }> {
  const selections: Array<{ model: string; reasoningEffort?: string }> = [];
  for (const [name, override] of Object.entries(next?.agents ?? {})) {
    if (JSON.stringify(current?.agents?.[name]) === JSON.stringify(override)) continue;
    const entry = effectiveSubagentSetting(name, override);
    if (!isConcreteSubagentModel(entry.model)) continue;
    selections.push({
      model: entry.model,
      ...(override.effortLevel && entry.effortLevel ? { reasoningEffort: entry.effortLevel } : {}),
    });
  }
  return selections;
}
