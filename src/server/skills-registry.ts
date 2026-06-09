// Read-only + delete management for on-disk Copilot skills.
//
// Skills are discovered by the Copilot SDK from two directories (see
// session-config-builder.ts): the repo-bundled `<repoRoot>/skills` and the
// user-managed `<copilotHome>/skills`. This module lists and reads both, but
// only home skills may be deleted — bundled skills ship through staging/deploy.

import matter from "gray-matter";
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBridgeControlRoot } from "./control-root.js";

export type SkillSource = "home" | "bundled";

export interface SkillSummary {
  /** Directory name — the stable identifier used in API paths. */
  id: string;
  /** Display name: frontmatter `name` when present, otherwise the directory name. */
  name: string;
  description: string;
  allowedTools: string[];
  source: SkillSource;
  lastModified: string | null;
}

export interface SkillDetail extends SkillSummary {
  body: string;
  raw: string;
}

export type DeleteSkillResult = "deleted" | "not-found" | "invalid";

export interface SkillsRegistryOptions {
  copilotHome: string;
  /** Override the repo root used to locate bundled skills (primarily for tests). */
  repoRoot?: string;
}

const __dirname = dirname(fileURLToPath(import.meta.url));

// Directory names are filesystem identifiers used directly in URLs; keep them to
// a conservative character set so they can never traverse out of the skills root.
const SKILL_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

export function isValidSkillId(id: unknown): id is string {
  if (typeof id !== "string") return false;
  if (!id || id !== id.trim() || id === "." || id === "..") return false;
  return SKILL_ID_PATTERN.test(id);
}

export function getBundledSkillsDir(repoRoot?: string): string {
  const root = repoRoot ?? resolveBridgeControlRoot(join(__dirname, "..", ".."));
  return join(root, "skills");
}

export function getHomeSkillsDir(copilotHome: string): string {
  return join(copilotHome, "skills");
}

function parseAllowedTools(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return [value.trim()];
  }
  return [];
}

interface RawSkillFile {
  raw: string;
  lastModified: string | null;
}

function readSkillFile(skillDir: string): RawSkillFile | null {
  const file = join(skillDir, "SKILL.md");
  if (!existsSync(file)) return null;
  try {
    const raw = readFileSync(file, "utf-8");
    const lastModified = statSync(file).mtime.toISOString();
    return { raw, lastModified };
  } catch {
    return null;
  }
}

function parseFrontmatter(raw: string): { data: Record<string, unknown>; body: string } {
  try {
    const parsed = matter(raw);
    const data = (parsed.data ?? {}) as Record<string, unknown>;
    return { data, body: parsed.content.trim() };
  } catch {
    return { data: {}, body: raw.trim() };
  }
}

function toSummary(id: string, source: SkillSource, file: RawSkillFile): SkillSummary {
  const { data } = parseFrontmatter(file.raw);
  const name = typeof data.name === "string" && data.name.trim() ? data.name.trim() : id;
  const description = typeof data.description === "string" ? data.description.trim() : "";
  return {
    id,
    name,
    description,
    allowedTools: parseAllowedTools(data["allowed-tools"]),
    source,
    lastModified: file.lastModified,
  };
}

function listSkillIdsInDir(skillsDir: string): string[] {
  try {
    return readdirSync(skillsDir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((name) => isValidSkillId(name) && existsSync(join(skillsDir, name, "SKILL.md")));
  } catch {
    return [];
  }
}

/**
 * List skills from the home and bundled directories. Home skills take
 * precedence when an id exists in both. Results are sorted by display name.
 */
export function listSkills(options: SkillsRegistryOptions): SkillSummary[] {
  const homeDir = getHomeSkillsDir(options.copilotHome);
  const bundledDir = getBundledSkillsDir(options.repoRoot);

  const summaries: SkillSummary[] = [];
  const seen = new Set<string>();

  for (const [dir, source] of [[homeDir, "home"], [bundledDir, "bundled"]] as const) {
    for (const id of listSkillIdsInDir(dir)) {
      if (seen.has(id)) continue;
      const file = readSkillFile(join(dir, id));
      if (!file) continue;
      seen.add(id);
      summaries.push(toSummary(id, source, file));
    }
  }

  return summaries.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

/** Read a single skill (home preferred over bundled) including its markdown body. */
export function readSkill(options: SkillsRegistryOptions, id: string): SkillDetail | null {
  if (!isValidSkillId(id)) return null;

  const candidates: Array<[string, SkillSource]> = [
    [getHomeSkillsDir(options.copilotHome), "home"],
    [getBundledSkillsDir(options.repoRoot), "bundled"],
  ];

  for (const [dir, source] of candidates) {
    const file = readSkillFile(join(dir, id));
    if (!file) continue;
    const { body } = parseFrontmatter(file.raw);
    return { ...toSummary(id, source, file), body, raw: file.raw };
  }

  return null;
}

/**
 * Delete a home skill directory. Bundled skills are never deletable. Returns
 * "invalid" for unsafe ids, "not-found" when no matching home skill exists.
 */
export async function deleteHomeSkill(options: { copilotHome: string; id: string }): Promise<DeleteSkillResult> {
  if (!isValidSkillId(options.id)) return "invalid";

  const skillsRoot = resolve(getHomeSkillsDir(options.copilotHome));
  const target = resolve(skillsRoot, options.id);
  // Defense-in-depth: the resolved target must be a direct child of the root.
  if (dirname(target) !== skillsRoot) return "invalid";

  let isSkillDir = false;
  try {
    // lstat (not stat) so a symlink/junction is never treated as a deletable
    // skill directory — we only remove real directories under the home root.
    isSkillDir = lstatSync(target).isDirectory() && existsSync(join(target, "SKILL.md"));
  } catch {
    isSkillDir = false;
  }
  if (!isSkillDir) return "not-found";

  await rm(target, { recursive: true, force: true });
  return "deleted";
}
