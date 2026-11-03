/**
 * The shared words of the playbook workflow: what kind of skill something is, which family a
 * playbook belongs to, which roles a machine's own skills can fill and which kinds of evidence a
 * finished playbook can show. Skills declare these in their frontmatter `metadata` map.
 */
export const PLAYBOOK_FAMILIES = ["code", "knowledge", "ongoing", "errand", "meta"] as const;
export type PlaybookFamily = typeof PLAYBOOK_FAMILIES[number];

export const PLAYBOOK_FAMILY_LABELS: Record<PlaybookFamily, string> = {
  code: "Code",
  knowledge: "Knowledge work",
  ongoing: "Ongoing",
  errand: "Errands",
  meta: "Continuity",
};

export const SKILL_KINDS = ["playbook", "helper"] as const;
export type SkillKind = typeof SKILL_KINDS[number];

export const SKILL_ROLES = ["code-host", "ci", "issue-tracker", "messaging", "writing-style", "verify", "deploy"] as const;
export type SkillRole = typeof SKILL_ROLES[number];

export const SKILL_ROLE_DESCRIPTIONS: Record<SkillRole, string> = {
  "code-host": "pull requests, reviews, merge state and branch policies",
  ci: "builds, pipelines, test runs and artifacts",
  "issue-tracker": "issues, work items and tickets",
  messaging: "sending messages, posts, replies or email as the user",
  "writing-style": "the user's prose standard",
  verify: "proving a project's behavior on the real system",
  deploy: "releasing or deploying a project",
};

export const EVIDENCE_KINDS = [
  "reproduced", "fixed", "tested", "live", "measured", "reviewed", "sourced", "delivered", "baseline", "approved",
] as const;
export type EvidenceKind = typeof EVIDENCE_KINDS[number];

export const EVIDENCE_KIND_DESCRIPTIONS: Record<EvidenceKind, string> = {
  reproduced: "the problem was observed before the change",
  fixed: "the same check passes after the change",
  tested: "automated tests ran",
  live: "behavior was checked on the real system or surface",
  measured: "a number was measured against a baseline",
  reviewed: "an independent or cross-model review ran",
  sourced: "claims are backed by sources that were opened",
  delivered: "the artifact reached where it was meant to go",
  baseline: "a watch baseline was recorded or compared",
  approved: "the user approved a gated action",
};

/** `playbook_select` takes this to record that a request takes the direct path. */
export const NO_PLAYBOOK = "none";

/**
 * Who set a chat's playbook. The user's choice wins over the agent's, and both win over the
 * playbook the chat's task or schedule pins.
 */
export const PLAYBOOK_SOURCES = ["user", "agent", "task", "schedule"] as const;
export type PlaybookSource = typeof PLAYBOOK_SOURCES[number];

export function isPlaybookSource(value: unknown): value is PlaybookSource {
  return typeof value === "string" && (PLAYBOOK_SOURCES as readonly string[]).includes(value);
}

/** A playbook as the client shows it in pickers and chips. */
export interface PlaybookInfo {
  id: string;
  label: string;
  description: string;
  family: PlaybookFamily;
  evidence: EvidenceKind[];
  source: "home" | "pack" | "bundled";
  packName?: string;
}

/** A chat's active playbook. `playbook` is NO_PLAYBOOK when it takes the direct path. */
export interface SessionPlaybookView {
  playbook?: string;
  source?: PlaybookSource;
  label?: string;
}

/** Playbook skill names follow skill folder names. */
export function isPlaybookName(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9._-]{1,80}$/.test(value) && value !== "." && value !== "..";
}

export function isPlaybookFamily(value: unknown): value is PlaybookFamily {
  return typeof value === "string" && (PLAYBOOK_FAMILIES as readonly string[]).includes(value);
}

export function isSkillKind(value: unknown): value is SkillKind {
  return typeof value === "string" && (SKILL_KINDS as readonly string[]).includes(value);
}

export function isSkillRole(value: unknown): value is SkillRole {
  return typeof value === "string" && (SKILL_ROLES as readonly string[]).includes(value);
}

export function isEvidenceKind(value: unknown): value is EvidenceKind {
  return typeof value === "string" && (EVIDENCE_KINDS as readonly string[]).includes(value);
}

/** Metadata lists are comma-separated strings; YAML lists are accepted too. */
export function parseMetadataList(value: unknown): string[] {
  const parts = Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : typeof value === "string" ? value.split(",") : [];
  return [...new Set(parts.map((part) => part.trim()).filter(Boolean))];
}

/** A playbook description without its "Playbook:" marker, starting with a capital letter. */
export function describePlaybook(description: string): string {
  return description.replace(/^Playbook:\s*/i, "").replace(/^\p{Ll}/u, (letter) => letter.toUpperCase());
}
