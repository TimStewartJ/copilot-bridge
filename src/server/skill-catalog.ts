// The skill catalog: a cached view of every skill sessions can load, with the workflow metadata
// playbooks and machine skills declare. Session setup is synchronous, so it reads the last scan;
// scans run in the background, after skill or pack changes and on a slow timer.

import {
  scanSkills,
  type SkillPackRoot,
  type SkillSummary,
} from "./skills-registry.js";
import { resolveModelRole, type RoleModelInfo } from "./model-roles.js";
import type { AppSettings } from "./settings-store.js";
import { MODEL_PRESET_SLOTS } from "../shared/model-presets.js";
import { MODEL_TIER_INFO } from "../shared/model-roles.js";
import { getModelFamily, getModelFamilyLabel } from "../shared/model-families.js";
import { SKILL_ROLES, SKILL_ROLE_DESCRIPTIONS } from "../shared/workflow-vocabulary.js";

export const SKILL_CATALOG_REFRESH_MS = 5 * 60_000;

export interface SkillCatalogOptions {
  getCopilotHome(): string;
  repoRoot?: string;
  /** Every enabled pack, whatever its tags: the catalog lists them all. */
  listPackRoots?(): readonly SkillPackRoot[];
  onRefreshed?(skills: readonly SkillSummary[]): void;
}

export function createSkillCatalog(options: SkillCatalogOptions) {
  let snapshot: SkillSummary[] = [];
  let scannedAt: string | undefined;
  let inflight: Promise<SkillSummary[]> | undefined;
  let rerun = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  async function scan(): Promise<SkillSummary[]> {
    const skills = await scanSkills({
      copilotHome: options.getCopilotHome(),
      ...(options.repoRoot ? { repoRoot: options.repoRoot } : {}),
      packs: options.listPackRoots?.() ?? [],
    });
    snapshot = skills;
    scannedAt = new Date().toISOString();
    options.onRefreshed?.(skills);
    return skills;
  }

  /** Rescans now. Calls during a scan share it, and one more scan follows so late changes are seen. */
  function refresh(): Promise<SkillSummary[]> {
    if (inflight) {
      rerun = true;
      return inflight;
    }
    inflight = scan().finally(() => {
      inflight = undefined;
      if (rerun) {
        rerun = false;
        void refresh().catch(() => undefined);
      }
    });
    return inflight;
  }

  function start(intervalMs = SKILL_CATALOG_REFRESH_MS): void {
    void refresh().catch((error) => console.warn("[skills] Catalog scan failed:", error instanceof Error ? error.message : error));
    if (timer) return;
    timer = setInterval(() => {
      void refresh().catch((error) => console.warn("[skills] Catalog scan failed:", error instanceof Error ? error.message : error));
    }, intervalMs);
    timer.unref?.();
  }

  function stop(): void {
    if (timer) clearInterval(timer);
    timer = undefined;
  }

  function current(): readonly SkillSummary[] {
    return snapshot;
  }

  function playbooks(): SkillSummary[] {
    return snapshot.filter((skill) => skill.kind === "playbook");
  }

  function findPlaybook(name: string | undefined): SkillSummary | undefined {
    if (!name) return undefined;
    return snapshot.find((skill) => skill.kind === "playbook" && skill.id === name);
  }

  return {
    refresh,
    start,
    stop,
    current,
    playbooks,
    findPlaybook,
    get scannedAt() { return scannedAt; },
  };
}

export type SkillCatalog = ReturnType<typeof createSkillCatalog>;

/**
 * Which installed skill fills each role a playbook can name, and which skills add steps to a
 * playbook. Only skills this chat loads count: packs outside the chat's tags are left out.
 */
export function formatSkillRolesBlock(skills: readonly SkillSummary[], activePackIds: ReadonlySet<string>): string | undefined {
  const loaded = skills.filter((skill) => skill.source !== "pack" || (skill.packId && activePackIds.has(skill.packId)));
  const roleLines: string[] = [];
  for (const role of SKILL_ROLES) {
    const fillers = loaded.filter((skill) => skill.roles.includes(role)).map((skill) => skill.id);
    roleLines.push(`- ${role} (${SKILL_ROLE_DESCRIPTIONS[role]}): ${fillers.length > 0 ? fillers.join(", ") : "none installed"}`);
  }
  const extensionLines = new Map<string, string[]>();
  for (const skill of loaded) {
    for (const playbook of skill.extends) {
      extensionLines.set(playbook, [...extensionLines.get(playbook) ?? [], skill.id]);
    }
  }
  const anyFilled = loaded.some((skill) => skill.roles.length > 0);
  if (!anyFilled && extensionLines.size === 0) {
    return `<skill_roles>
Playbooks name roles instead of services. No installed skill fills a role on this machine, so use the tools and CLIs available and say which you used.
</skill_roles>`;
  }
  return [
    "<skill_roles>",
    "Playbooks name roles instead of services. On this machine, load the skill that fills a role when a step needs it; with none, use the tools and CLIs available and say which you used.",
    ...roleLines,
    ...(extensionLines.size > 0
      ? [
          "Skills that add steps to a playbook (load them together with it and follow both):",
          ...[...extensionLines.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([playbook, ids]) => `- ${playbook}: ${ids.join(", ")}`),
        ]
      : []),
    "</skill_roles>",
  ].join("\n");
}

/**
 * The models playbooks refer to by role: helpers and reviewers from Settings › Models, and a
 * panel of distinct models from the tiers for cross-model review.
 */
export function formatModelRolesBlock(
  settings: Pick<AppSettings, "modelRoles" | "modelPresets" | "model"> | undefined,
  models?: readonly RoleModelInfo[],
): string | undefined {
  if (!settings) return undefined;
  const helpers = resolveModelRole(settings, "subagents", models);
  const reviewers = resolveModelRole(settings, "reviewers", models);
  const describe = (resolved: { model?: string; reasoningEffort?: string }, fallback: string) => resolved.model
    ? `${resolved.model}${resolved.reasoningEffort ? ` (${resolved.reasoningEffort})` : ""}`
    : fallback;
  const panel = new Map<string, string>();
  const addToPanel = (model: string | undefined, label: string) => {
    if (!model || panel.has(model)) return;
    if (models && models.length > 0 && !models.some((candidate) => candidate.id === model && candidate.policy?.state !== "disabled")) return;
    panel.set(model, label);
  };
  addToPanel(reviewers.model, "reviewers");
  for (const slot of [...MODEL_PRESET_SLOTS].reverse()) {
    addToPanel(settings.modelPresets?.[slot]?.model, `${MODEL_TIER_INFO[slot].label} tier`);
  }
  addToPanel(settings.model, "new chats");
  const families = new Set([...panel.keys()].map((model) => getModelFamily(model)));
  const panelLines = [...panel.entries()].map(([model, label]) => `${model} (${getModelFamilyLabel(getModelFamily(model))}, ${label})`);
  return [
    "<model_roles>",
    "Playbooks ask for models by role. Pass the model to the task tool when a step names a role.",
    `- helpers (searches, commands, routine sub-tasks): ${describe(helpers, "the runtime's default for sub-agents")}`,
    `- reviewers (review and judgment): ${describe(reviewers, "the chat's own model")}`,
    `- panel (cross-model review, different families first): ${panelLines.length > 0 ? panelLines.join("; ") : "only the chat's own model is configured"}`,
    families.size < 2
      ? "The panel has one model family, so a panel review is degraded: say so in its result."
      : `The panel covers ${families.size} model families.`,
    "</model_roles>",
  ].join("\n");
}
