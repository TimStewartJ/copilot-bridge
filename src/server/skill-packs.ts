// Skill packs: keeps git packs checked out under the data folder and reports each pack's state.
//
// A git pack is a shallow checkout at <dataDir>/skill-packs/<id>, refreshed with fetch + reset so
// local edits there never block a sync (edit the pack at its source instead). A folder pack is
// read where it is. Git runs through runGit (process host, off the main thread).

import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runGit } from "./git-command.js";
import { getProcessHost } from "./process-host.js";
import { resolvePackSkillsDir, type SkillPackRoot } from "./skills-registry.js";
import type { SkillPackConfig, SkillPackStatus } from "../shared/skill-packs.js";

const GIT_NETWORK_TIMEOUT_MS = 120_000;
const STATE_FILE = "state.json";

interface PersistedPackState {
  syncedAt?: string;
  commit?: string;
  error?: string;
}

export interface SkillPackManagerOptions {
  dataDir: string;
  getPacks(): readonly SkillPackConfig[];
  /** A pack's skills changed: the catalog rescans and cached sessions pick it up on resume. */
  onChanged?(): void;
  runGit?: typeof runGit;
  removeTree?(path: string): Promise<void>;
}

export function createSkillPackManager(options: SkillPackManagerOptions) {
  const packsDir = join(options.dataDir, "skill-packs");
  const git = options.runGit ?? runGit;
  const removeTree = options.removeTree ?? ((path: string) => getProcessHost().removeTree(path));
  const syncing = new Map<string, Promise<SkillPackStatus>>();
  let persisted: Record<string, PersistedPackState> | undefined;
  const statuses = new Map<string, SkillPackStatus>();

  function rootFor(pack: SkillPackConfig): string {
    return pack.source.kind === "git" ? join(packsDir, pack.id) : resolve(pack.source.path);
  }

  async function loadState(): Promise<Record<string, PersistedPackState>> {
    if (persisted) return persisted;
    try {
      const parsed = JSON.parse(await readFile(join(packsDir, STATE_FILE), "utf-8")) as unknown;
      persisted = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, PersistedPackState> : {};
    } catch {
      persisted = {};
    }
    return persisted;
  }

  async function saveState(id: string, state: PersistedPackState): Promise<void> {
    const all = await loadState();
    all[id] = state;
    await mkdir(packsDir, { recursive: true });
    await writeFile(join(packsDir, STATE_FILE), JSON.stringify(all, null, 2), "utf-8");
  }

  async function isDirectory(path: string): Promise<boolean> {
    try {
      return (await stat(path)).isDirectory();
    } catch {
      return false;
    }
  }

  async function countSkills(root: string): Promise<number> {
    const skillsDir = await resolvePackSkillsDir(root);
    try {
      const entries = await readdir(skillsDir, { withFileTypes: true });
      const checks = await Promise.all(entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => stat(join(skillsDir, entry.name, "SKILL.md")).then((info) => info.isFile(), () => false)));
      return checks.filter(Boolean).length;
    } catch {
      return 0;
    }
  }

  /** Reads a pack's state from disk without contacting its remote. */
  async function inspect(pack: SkillPackConfig): Promise<SkillPackStatus> {
    const root = rootFor(pack);
    const saved = (await loadState())[pack.id] ?? {};
    const present = await isDirectory(root);
    const status: SkillPackStatus = {
      id: pack.id,
      root,
      state: syncing.has(pack.id) ? "syncing" : !present ? (saved.error ? "error" : "missing") : saved.error ? "error" : "ready",
      ...(saved.syncedAt ? { syncedAt: saved.syncedAt } : {}),
      ...(saved.commit ? { commit: saved.commit } : {}),
      ...(saved.error ? { error: saved.error } : {}),
      ...(present ? { skillCount: await countSkills(root) } : {}),
    };
    // A folder pack has nothing to sync: it is ready whenever the folder exists.
    if (pack.source.kind === "folder") {
      status.state = present ? "ready" : "missing";
      delete status.error;
      if (!present) status.error = "The folder does not exist.";
    }
    statuses.set(pack.id, status);
    return status;
  }

  async function syncGitPack(pack: SkillPackConfig & { source: { kind: "git"; url: string; ref?: string } }): Promise<PersistedPackState> {
    const root = rootFor(pack);
    await mkdir(packsDir, { recursive: true });
    const ref = pack.source.ref;
    if (!(await isDirectory(join(root, ".git")))) {
      if (await isDirectory(root)) await removeTree(root);
      const cloned = await git(packsDir, [
        "clone", "--depth", "1", ...(ref ? ["--branch", ref] : []), "--", pack.source.url, root,
      ], GIT_NETWORK_TIMEOUT_MS);
      if (!cloned.ok) return { error: `Clone failed: ${cloned.error}` };
    } else {
      const remote = await git(root, ["remote", "set-url", "origin", "--", pack.source.url]);
      if (!remote.ok) return { error: `Could not set the remote: ${remote.error}` };
      const fetched = await git(root, ["fetch", "--depth", "1", "origin", ref ?? "HEAD"], GIT_NETWORK_TIMEOUT_MS);
      if (!fetched.ok) return { error: `Fetch failed: ${fetched.error}` };
      const reset = await git(root, ["reset", "--hard", "FETCH_HEAD"]);
      if (!reset.ok) return { error: `Could not update the checkout: ${reset.error}` };
    }
    const head = await git(root, ["rev-parse", "--short", "HEAD"]);
    return { syncedAt: new Date().toISOString(), ...(head.ok ? { commit: head.output } : {}) };
  }

  /** Brings one pack up to date: clone or fetch a git pack, check a folder pack exists. */
  function sync(id: string): Promise<SkillPackStatus> {
    const running = syncing.get(id);
    if (running) return running;
    const pack = options.getPacks().find((candidate) => candidate.id === id);
    if (!pack) return Promise.reject(new Error(`Skill pack "${id}" is not configured`));
    const work = (async () => {
      if (pack.source.kind === "git") {
        statuses.set(id, { id, root: rootFor(pack), state: "syncing" });
        let state: PersistedPackState;
        try {
          state = await syncGitPack(pack as SkillPackConfig & { source: { kind: "git"; url: string; ref?: string } });
        } catch (error) {
          state = { error: error instanceof Error ? error.message : String(error) };
        }
        const previous = (await loadState())[id];
        await saveState(id, state.error ? { ...previous, error: state.error } : state);
      }
      return pack;
    })().finally(() => syncing.delete(id)).then(async (synced) => {
      const status = await inspect(synced);
      options.onChanged?.();
      return status;
    });
    syncing.set(id, work);
    return work;
  }

  /**
   * Syncs every enabled pack, or with `staleAfterMs` only git packs not synced that recently, so a
   * restart does not fetch every pack again.
   */
  async function syncAll(syncOptions: { staleAfterMs?: number } = {}): Promise<SkillPackStatus[]> {
    const results: SkillPackStatus[] = [];
    const saved = await loadState();
    for (const pack of options.getPacks()) {
      if (pack.enabled === false) continue;
      if (syncOptions.staleAfterMs !== undefined) {
        const syncedAt = saved[pack.id]?.syncedAt;
        const fresh = pack.source.kind === "folder"
          || (syncedAt && Date.now() - Date.parse(syncedAt) < syncOptions.staleAfterMs && !saved[pack.id]?.error);
        if (fresh) {
          results.push(await inspect(pack));
          continue;
        }
      }
      results.push(await sync(pack.id).catch((error) => ({
        id: pack.id,
        root: rootFor(pack),
        state: "error" as const,
        error: error instanceof Error ? error.message : String(error),
      })));
    }
    return results;
  }

  async function listStatuses(): Promise<SkillPackStatus[]> {
    return Promise.all(options.getPacks().map((pack) => inspect(pack)));
  }

  /** Removes the checkout of a git pack that is no longer configured. Folder packs are never touched. */
  async function pruneRemoved(): Promise<void> {
    const configured = new Set(options.getPacks().filter((pack) => pack.source.kind === "git").map((pack) => pack.id));
    let entries: string[];
    try {
      entries = (await readdir(packsDir, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      return;
    }
    for (const name of entries) {
      if (configured.has(name)) continue;
      await removeTree(join(packsDir, name)).catch((error) => {
        console.warn(`[skill-packs] Could not remove the old checkout ${name}:`, error instanceof Error ? error.message : error);
      });
    }
  }

  /**
   * The packs a chat loads: on, present on disk, and either untagged or sharing a tag with the
   * chat's task. Uses the last known state so session setup never waits on the disk.
   */
  function activeRoots(taskTagNames?: readonly string[], filter: { ignoreTags?: boolean } = {}): SkillPackRoot[] {
    const tags = new Set((taskTagNames ?? []).map((tag) => tag.toLowerCase()));
    return options.getPacks().flatMap((pack) => {
      if (pack.enabled === false) return [];
      const status = statuses.get(pack.id);
      if (status && status.state === "missing") return [];
      if (status?.state === "error" && !status.syncedAt && pack.source.kind === "git") return [];
      if (!filter.ignoreTags && pack.tags?.length && !pack.tags.some((tag) => tags.has(tag.toLowerCase()))) return [];
      return [{ id: pack.id, name: pack.name, root: rootFor(pack) }];
    });
  }

  return { rootFor, sync, syncAll, listStatuses, pruneRemoved, activeRoots, inspect };
}

export type SkillPackManager = ReturnType<typeof createSkillPackManager>;
