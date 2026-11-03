// Read and write management for on-disk Copilot skills, with the Bridge's workflow metadata.
//
// Skills reach sessions from three kinds of directory (see session-config-builder.ts): the
// repo-bundled `<repoRoot>/skills`, the user-managed `<copilotHome>/skills`, and skill packs
// (folders or git checkouts the user adds in Settings). A home skill overrides a pack skill with
// the same id, and both override a bundled one. Only home skills can be edited or deleted here:
// bundled skills ship through staging/deploy and packs come from their source.
//
// Everything reads with fs.promises: home skills and packs are written by other programs, and
// the server's event loop must not wait on them (see server-runtime.instructions.md).

import matter from "gray-matter";
import { lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBridgeControlRoot } from "./control-root.js";
import {
  isEvidenceKind,
  isPlaybookFamily,
  isSkillKind,
  isSkillRole,
  parseMetadataList,
  type EvidenceKind,
  type PlaybookFamily,
  type SkillKind,
  type SkillRole,
} from "../shared/workflow-vocabulary.js";

export type SkillSource = "home" | "pack" | "bundled";

/** A skill pack's folder as the catalog sees it. */
export interface SkillPackRoot {
  id: string;
  name: string;
  /** The pack's checkout or folder; skills live in its `skills` folder when it has one. */
  root: string;
}

export interface SkillWorkflowMetadata {
  kind?: SkillKind;
  family?: PlaybookFamily;
  label?: string;
  /** Evidence kinds verify_complete requires before a playbook counts as done. */
  evidence: EvidenceKind[];
  /** Scheduled runs of this playbook get the previous run's report to compare against. */
  comparePrevious: boolean;
  /** Roles this skill fills on this machine. */
  roles: SkillRole[];
  /** Playbooks this skill adds steps to. */
  extends: string[];
}

export interface SkillSummary extends SkillWorkflowMetadata {
  /** Directory name — the stable identifier used in API paths. */
  id: string;
  /** Display name: frontmatter `name` when present, otherwise the directory name. */
  name: string;
  description: string;
  allowedTools: string[];
  source: SkillSource;
  packId?: string;
  packName?: string;
  /** The folder that holds this skill's directory. */
  skillsDir: string;
  lastModified: string | null;
  /** Only home skills can be edited or deleted. */
  editable: boolean;
  /** Sources of lower precedence that this skill hides, such as a customized bundled playbook. */
  overrides: SkillSource[];
}

export interface SkillDetail extends SkillSummary {
  body: string;
  raw: string;
}

export type DeleteSkillResult = "deleted" | "not-found" | "invalid";
export type WriteSkillResult =
  | { status: "written"; skill: SkillDetail }
  | { status: "invalid"; error: string }
  | { status: "not-found" }
  | { status: "exists" };

export interface SkillsRegistryOptions {
  copilotHome: string;
  /** Override the repo root used to locate bundled skills (primarily for tests). */
  repoRoot?: string;
  packs?: readonly SkillPackRoot[];
}

const __dirname = dirname(fileURLToPath(import.meta.url));

// Directory names are filesystem identifiers used directly in URLs; keep them to
// a conservative character set so they can never traverse out of the skills root.
const SKILL_ID_PATTERN = /^[A-Za-z0-9._-]+$/;
export const MAX_SKILL_FILE_BYTES = 256 * 1024;

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

/** A pack keeps its skills in a `skills` folder when it has one, otherwise at its root. */
export async function resolvePackSkillsDir(root: string): Promise<string> {
  const nested = join(root, "skills");
  try {
    if ((await stat(nested)).isDirectory()) return nested;
  } catch {
    // No nested folder: the root holds the skills.
  }
  return root;
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

async function readSkillFile(skillDir: string): Promise<RawSkillFile | null> {
  const file = join(skillDir, "SKILL.md");
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size > MAX_SKILL_FILE_BYTES) return null;
    const raw = await readFile(file, "utf-8");
    return { raw, lastModified: info.mtime.toISOString() };
  } catch {
    return null;
  }
}

export function parseSkillFrontmatter(raw: string): { data: Record<string, unknown>; body: string; error?: string } {
  try {
    const parsed = matter(raw);
    const data = (parsed.data ?? {}) as Record<string, unknown>;
    return { data, body: parsed.content.trim() };
  } catch (error) {
    return { data: {}, body: raw.trim(), error: error instanceof Error ? error.message : String(error) };
  }
}

function metadataString(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

/** The Bridge's workflow fields from a skill's frontmatter `metadata` map. Unknown values are dropped. */
export function parseWorkflowMetadata(data: Record<string, unknown>): SkillWorkflowMetadata {
  const metadata = data.metadata && typeof data.metadata === "object" && !Array.isArray(data.metadata)
    ? data.metadata as Record<string, unknown>
    : {};
  const kind = metadataString(metadata, "bridge-kind");
  const family = metadataString(metadata, "bridge-family");
  const label = metadataString(metadata, "bridge-label");
  return {
    ...(isSkillKind(kind) ? { kind } : {}),
    ...(isSkillKind(kind) && kind === "playbook" && isPlaybookFamily(family) ? { family } : {}),
    ...(label ? { label: label.slice(0, 60) } : {}),
    evidence: parseMetadataList(metadata["bridge-evidence"]).filter(isEvidenceKind),
    comparePrevious: metadataString(metadata, "bridge-compare-previous") === "true",
    roles: parseMetadataList(metadata["bridge-roles"]).filter(isSkillRole),
    extends: parseMetadataList(metadata["bridge-extends"]).filter(isValidSkillId),
  };
}

function toSummary(
  id: string,
  source: SkillSource,
  skillsDir: string,
  file: RawSkillFile,
  pack?: SkillPackRoot,
): SkillSummary {
  const { data } = parseSkillFrontmatter(file.raw);
  const name = typeof data.name === "string" && data.name.trim() ? data.name.trim() : id;
  const description = typeof data.description === "string" ? data.description.trim() : "";
  return {
    id,
    name,
    description,
    allowedTools: parseAllowedTools(data["allowed-tools"]),
    source,
    ...(pack ? { packId: pack.id, packName: pack.name } : {}),
    skillsDir,
    lastModified: file.lastModified,
    editable: source === "home",
    overrides: [],
    ...parseWorkflowMetadata(data),
  };
}

async function listSkillIdsInDir(skillsDir: string): Promise<string[]> {
  try {
    const entries = await readdir(skillsDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory() && isValidSkillId(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

interface SkillLocation {
  dir: string;
  source: SkillSource;
  pack?: SkillPackRoot;
}

/** Skill folders in precedence order: home, then packs in their configured order, then bundled. */
async function skillLocations(options: SkillsRegistryOptions): Promise<SkillLocation[]> {
  const packs = await Promise.all((options.packs ?? []).map(async (pack) => ({
    dir: await resolvePackSkillsDir(pack.root),
    source: "pack" as const,
    pack,
  })));
  return [
    { dir: getHomeSkillsDir(options.copilotHome), source: "home" },
    ...packs,
    { dir: getBundledSkillsDir(options.repoRoot), source: "bundled" },
  ];
}

/** The skill folders sessions load, in the order the catalog gives them precedence. */
export async function listSkillDirectories(options: SkillsRegistryOptions): Promise<string[]> {
  return (await skillLocations(options)).map((location) => location.dir);
}

/** Every skill a session can load, with home overriding packs and packs overriding bundled skills. */
export async function scanSkills(options: SkillsRegistryOptions): Promise<SkillSummary[]> {
  const locations = await skillLocations(options);
  const found = await Promise.all(locations.map(async (location) => {
    const ids = await listSkillIdsInDir(location.dir);
    const files = await Promise.all(ids.map(async (id) => ({ id, file: await readSkillFile(join(location.dir, id)) })));
    return files.flatMap(({ id, file }) => file ? [toSummary(id, location.source, location.dir, file, location.pack)] : []);
  }));
  const byId = new Map<string, SkillSummary>();
  for (const skills of found) {
    for (const skill of skills) {
      const winner = byId.get(skill.id);
      if (winner) {
        if (!winner.overrides.includes(skill.source)) winner.overrides.push(skill.source);
        continue;
      }
      byId.set(skill.id, skill);
    }
  }
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

/** Read one skill (home, then packs, then bundled) including its markdown body. */
export async function readSkill(options: SkillsRegistryOptions, id: string): Promise<SkillDetail | null> {
  if (!isValidSkillId(id)) return null;
  const locations = await skillLocations(options);
  for (const [index, location] of locations.entries()) {
    const file = await readSkillFile(join(location.dir, id));
    if (!file) continue;
    const { body } = parseSkillFrontmatter(file.raw);
    const summary = toSummary(id, location.source, location.dir, file, location.pack);
    for (const lower of locations.slice(index + 1)) {
      const hidden = await stat(join(lower.dir, id, "SKILL.md")).then((info) => info.isFile(), () => false);
      if (hidden && !summary.overrides.includes(lower.source)) summary.overrides.push(lower.source);
    }
    return { ...summary, body, raw: file.raw };
  }
  return null;
}

/** Checks a SKILL.md before it is saved. Returns an error sentence, or undefined when it is usable. */
export function validateSkillContent(id: string, raw: string): string | undefined {
  if (typeof raw !== "string" || !raw.trim()) return "The skill file is empty.";
  if (Buffer.byteLength(raw, "utf-8") > MAX_SKILL_FILE_BYTES) return "The skill file is larger than 256 KB.";
  if (!raw.startsWith("---")) return "The skill file must start with YAML frontmatter.";
  const parsed = parseSkillFrontmatter(raw);
  if (parsed.error) return `The frontmatter is not valid YAML: ${parsed.error}`;
  if (typeof parsed.data.name === "string" && parsed.data.name.trim() && parsed.data.name.trim() !== id) {
    return `The frontmatter name must match the folder name "${id}".`;
  }
  if (typeof parsed.data.description !== "string" || !parsed.data.description.trim()) {
    return "The frontmatter needs a description.";
  }
  return undefined;
}

function homeSkillDir(copilotHome: string, id: string): string | undefined {
  if (!isValidSkillId(id)) return undefined;
  const skillsRoot = resolve(getHomeSkillsDir(copilotHome));
  const target = resolve(skillsRoot, id);
  // Defense-in-depth: the resolved target must be a direct child of the root.
  return dirname(target) === skillsRoot ? target : undefined;
}

async function isRealSkillDir(target: string): Promise<boolean> {
  try {
    // lstat (not stat) so a symlink/junction is never treated as a home skill directory.
    if (!(await lstat(target)).isDirectory()) return false;
    return (await stat(join(target, "SKILL.md"))).isFile();
  } catch {
    return false;
  }
}

async function writeSkillFileAtomically(target: string, raw: string): Promise<void> {
  await mkdir(target, { recursive: true });
  const file = join(target, "SKILL.md");
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, raw, "utf-8");
  await rename(temp, file);
}

/** Replace a home skill's SKILL.md. Other skills, and other files in its folder, are left alone. */
export async function writeHomeSkill(options: SkillsRegistryOptions, id: string, raw: string): Promise<WriteSkillResult> {
  const target = homeSkillDir(options.copilotHome, id);
  if (!target) return { status: "invalid", error: "invalid skill id" };
  if (!(await isRealSkillDir(target))) return { status: "not-found" };
  const error = validateSkillContent(id, raw);
  if (error) return { status: "invalid", error };
  await writeSkillFileAtomically(target, raw);
  const skill = await readSkill(options, id);
  return skill ? { status: "written", skill } : { status: "not-found" };
}

/**
 * Copy a bundled or pack skill into the home folder so it can be changed there. The home copy then
 * overrides the original on this machine; deleting it restores the original.
 */
export async function customizeSkill(options: SkillsRegistryOptions, id: string): Promise<WriteSkillResult> {
  const target = homeSkillDir(options.copilotHome, id);
  if (!target) return { status: "invalid", error: "invalid skill id" };
  if (await isRealSkillDir(target)) return { status: "exists" };
  const source = await readSkill(options, id);
  if (!source) return { status: "not-found" };
  await writeSkillFileAtomically(target, source.raw);
  const skill = await readSkill(options, id);
  return skill ? { status: "written", skill } : { status: "not-found" };
}

/**
 * Delete a home skill directory. Bundled and pack skills are never deletable. Returns
 * "invalid" for unsafe ids, "not-found" when no matching home skill exists.
 */
export async function deleteHomeSkill(options: { copilotHome: string; id: string }): Promise<DeleteSkillResult> {
  const target = homeSkillDir(options.copilotHome, options.id);
  if (!target) return "invalid";
  if (!(await isRealSkillDir(target))) return "not-found";
  await rm(target, { recursive: true, force: true });
  return "deleted";
}
