import {
  isAcceptableGitRef,
  isAcceptableGitUrl,
  MAX_SKILL_PACKS,
  skillPackIdFromName,
  type SkillPackConfig,
  type SkillPackSource,
  type SkillPackStatus,
} from "../../shared/skill-packs.js";
import { timeAgo } from "../time";

/** A pack id from its name that no configured pack uses yet: "tools", then "tools-2", "tools-3". */
export function uniqueSkillPackId(name: string, existingIds: Iterable<string>): string {
  const taken = new Set(existingIds);
  const base = skillPackIdFromName(name);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, 40 - suffix.length).replace(/-+$/, "")}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export interface SkillPackForm {
  name: string;
  kind: "git" | "folder";
  url: string;
  ref: string;
  path: string;
  tags: string[];
}

export const EMPTY_SKILL_PACK_FORM: SkillPackForm = { name: "", kind: "git", url: "", ref: "", path: "", tags: [] };

/** Turns the add-pack form into a pack, or says what is wrong with it. */
export function buildSkillPack(
  form: SkillPackForm,
  existing: readonly SkillPackConfig[],
): { pack: SkillPackConfig } | { error: string } {
  const name = form.name.trim();
  if (!name) return { error: "Name the pack." };
  if (name.length > 80) return { error: "Keep the name to 80 characters." };
  if (existing.length >= MAX_SKILL_PACKS) return { error: `At most ${MAX_SKILL_PACKS} packs.` };
  let source: SkillPackSource;
  if (form.kind === "git") {
    const url = form.url.trim();
    const ref = form.ref.trim();
    if (!isAcceptableGitUrl(url)) return { error: "Use an https://, ssh://, git@ or file:// URL." };
    if (ref && !isAcceptableGitRef(ref)) return { error: "That branch or tag name is not valid." };
    source = { kind: "git", url, ...(ref ? { ref } : {}) };
  } else {
    const path = form.path.trim();
    if (!/^(\/|[A-Za-z]:[\\/]|\\\\)/.test(path)) return { error: "Use an absolute folder path." };
    source = { kind: "folder", path };
  }
  const tags = [...new Set(form.tags.map((tag) => tag.trim()).filter(Boolean))];
  return {
    pack: {
      id: uniqueSkillPackId(name, existing.map((pack) => pack.id)),
      name,
      source,
      ...(tags.length > 0 ? { tags } : {}),
    },
  };
}

export function skillPackSourceLabel(source: SkillPackSource): string {
  if (source.kind === "folder") return source.path;
  return source.ref ? `${source.url}@${source.ref}` : source.url;
}

/** One line for a pack's state: "Ready · 4 skills · synced 2h ago · abc1234". */
export function skillPackStatusLabel(status: SkillPackStatus | undefined): string {
  if (!status) return "Not synced";
  switch (status.state) {
    case "syncing":
      return "Syncing";
    case "missing":
      return "Missing";
    case "error":
      return status.error ? `Error: ${status.error}` : "Error";
    case "ready": {
      const count = status.skillCount;
      return [
        "Ready",
        count === undefined ? undefined : `${count} skill${count === 1 ? "" : "s"}`,
        status.syncedAt ? `synced ${timeAgo(status.syncedAt)}` : undefined,
        status.commit ? status.commit.slice(0, 7) : undefined,
      ].filter(Boolean).join(" · ");
    }
  }
}
