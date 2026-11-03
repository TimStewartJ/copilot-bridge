import type { Skill } from "../api";
import { PLAYBOOK_FAMILY_LABELS } from "../../shared/workflow-vocabulary.js";
import { timeAgo } from "../time";

export interface SkillGroups {
  playbooks: Skill[];
  helpers: Skill[];
  other: Skill[];
}

function byDisplayName(a: Skill, b: Skill): number {
  return (a.label ?? a.name).localeCompare(b.label ?? b.name, undefined, { sensitivity: "base" });
}

/** Skills split by what they are to the workflow: playbooks, their helpers, and everything else. */
export function groupSkills(skills: readonly Skill[]): SkillGroups {
  const sorted = [...skills].sort(byDisplayName);
  return {
    playbooks: sorted.filter((skill) => skill.kind === "playbook"),
    helpers: sorted.filter((skill) => skill.kind === "helper"),
    other: sorted.filter((skill) => skill.kind !== "playbook" && skill.kind !== "helper"),
  };
}

export function skillSourceLabel(skill: Pick<Skill, "source" | "packName" | "packId">): string {
  if (skill.source === "pack") return skill.packName ?? skill.packId ?? "Pack";
  return skill.source === "home" ? "Home" : "Bundled";
}

export function skillKindLabel(skill: Pick<Skill, "kind" | "family">): string | undefined {
  if (skill.kind === "helper") return "Helper";
  if (skill.kind !== "playbook") return undefined;
  return skill.family ? `Playbook · ${PLAYBOOK_FAMILY_LABELS[skill.family]}` : "Playbook";
}

/** "Used 12 times · last 3d ago", or undefined when the skill has not been used. */
export function skillUsageLabel(skill: Pick<Skill, "useCount" | "lastUsedAt">): string | undefined {
  if (!skill.useCount) return undefined;
  const times = skill.useCount === 1 ? "Used once" : `Used ${skill.useCount} times`;
  return skill.lastUsedAt ? `${times} · last ${timeAgo(skill.lastUsedAt)}` : times;
}

/** A home skill that hides a bundled or pack skill of the same name. */
export function isCustomizedSkill(skill: Pick<Skill, "source" | "overrides">): boolean {
  return skill.source === "home" && skill.overrides.length > 0;
}
