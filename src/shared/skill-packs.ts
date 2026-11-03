/**
 * Skill packs: sets of skills a machine adds on top of the Bridge's bundled ones, from a git
 * repository the Bridge keeps checked out or from a folder on disk. A pack can be limited to tasks
 * with certain tags, the way MCP servers are.
 */
export type SkillPackSource =
  | { kind: "git"; url: string; ref?: string }
  | { kind: "folder"; path: string };

export interface SkillPackConfig {
  id: string;
  name: string;
  source: SkillPackSource;
  /** Unset means on. */
  enabled?: boolean;
  /** Tag names; when set, the pack loads only in chats whose task has one of them. */
  tags?: string[];
}

export interface SkillPackStatus {
  id: string;
  /** The folder sessions load the pack from. */
  root: string;
  state: "ready" | "syncing" | "missing" | "error";
  syncedAt?: string;
  commit?: string;
  error?: string;
  skillCount?: number;
}

export const MAX_SKILL_PACKS = 20;
const PACK_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function isValidSkillPackId(value: unknown): value is string {
  return typeof value === "string" && PACK_ID_PATTERN.test(value);
}

/** Turns a pack name into an id: lower case, hyphens, at most 40 characters. */
export function skillPackIdFromName(name: string): string {
  const id = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return id || "pack";
}

/**
 * A git URL must not start with "-" (it would read as an option) and must use a scheme git
 * fetches over the network or a local path git can clone.
 */
export function isAcceptableGitUrl(url: string): boolean {
  if (!url || url.startsWith("-") || /\s/.test(url)) return false;
  return /^(https:\/\/|ssh:\/\/|git@[^:]+:|file:\/\/)/i.test(url);
}

export function isAcceptableGitRef(ref: string): boolean {
  return /^[A-Za-z0-9._/-]{1,100}$/.test(ref) && !ref.startsWith("-") && !ref.includes("..");
}
