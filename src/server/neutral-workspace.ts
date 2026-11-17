import { mkdirSync } from "node:fs";
import { mkdir, realpath, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, parse } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBridgeControlRoot } from "./control-root.js";
import { isPathAtOrUnder, pathsEqual } from "./path-utils.js";
import { getReleaseSlotsDir } from "./release-slots.js";
import { resolveDefaultWorkspaceDir, type RuntimePaths } from "./runtime-paths.js";
import { getWorkspaceAvailability, type WorkspaceAvailability } from "./session-workspace-availability.js";

// Must sit outside any git work tree: the CLI loads AGENTS.md from the cwd's git root.

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolveBridgeControlRoot(join(__dirname, "..", ".."));

type NeutralWorkspacePaths = Pick<RuntimePaths, "workspaceDir" | "dataDir"> | undefined;

export function getNeutralWorkspaceDir(runtimePaths: NeutralWorkspacePaths): string | undefined {
  return runtimePaths?.workspaceDir?.trim() || undefined;
}

export function isNeutralWorkspaceCwd(cwd: string | undefined, runtimePaths: NeutralWorkspacePaths): boolean {
  const neutral = getNeutralWorkspaceDir(runtimePaths);
  return !!cwd && !!neutral && pathsEqual(cwd, neutral);
}

/** A cwd the CLI recorded by default; never a user choice, and reusing it loads our repo rules. */
export function isImplicitHostCwd(
  cwd: string | undefined,
  runtimePaths: NeutralWorkspacePaths,
  hostRoots: readonly string[] = [REPO_ROOT, process.cwd()],
): boolean {
  if (!cwd) return false;
  if (hostRoots.some((root) => pathsEqual(cwd, root))) return true;
  return !!runtimePaths?.dataDir && isPathAtOrUnder(getReleaseSlotsDir(runtimePaths.dataDir), cwd);
}

/** Returns the path even if mkdir fails, so session creation errors instead of using our cwd. */
export function ensureNeutralWorkspaceDir(runtimePaths: NeutralWorkspacePaths): string | undefined {
  const dir = getNeutralWorkspaceDir(runtimePaths);
  if (!dir) return undefined;
  if (!getWorkspaceAvailability(dir)?.available) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch (error) {
      console.warn(`[workspace] Could not create the Bridge workspace ${dir}:`, error);
    }
  }
  return dir;
}

/** Recreates a missing neutral folder instead of falling through to another cwd. */
export function getNeutralAwareAvailability(
  cwd: string | undefined,
  runtimePaths: NeutralWorkspacePaths,
): WorkspaceAvailability | undefined {
  if (isNeutralWorkspaceCwd(cwd, runtimePaths)) {
    return { cwd: ensureNeutralWorkspaceDir(runtimePaths)!, available: true, clearStalePin: false };
  }
  return getWorkspaceAvailability(cwd);
}

export function resolveNeutralAwareCwd(cwd: string | undefined, runtimePaths: NeutralWorkspacePaths): string | undefined {
  const availability = getNeutralAwareAvailability(cwd, runtimePaths);
  return availability?.available ? availability.cwd : undefined;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Nearest ancestor (inclusive) with a `.git` entry, after resolving symlinks. */
export async function findEnclosingGitRoot(dir: string): Promise<string | undefined> {
  let current = await realpath(dir);
  const { root } = parse(current);
  for (;;) {
    if (await pathExists(join(current, ".git"))) return current;
    if (current === root) return undefined;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

export interface PrepareNeutralWorkspaceOptions {
  fallbackDirs?: readonly string[];
  log?: Pick<Console, "warn" | "error">;
}

/** Picks the first candidate outside any git work tree and updates runtimePaths; throws if none. */
export async function prepareNeutralWorkspaceDir(
  runtimePaths: RuntimePaths,
  options: PrepareNeutralWorkspaceOptions = {},
): Promise<string | undefined> {
  const log = options.log ?? console;
  const configured = getNeutralWorkspaceDir(runtimePaths);
  if (!configured) return undefined;
  const fallbacks = options.fallbackDirs ?? [
    resolveDefaultWorkspaceDir(runtimePaths.env),
    join(tmpdir(), "CopilotBridge", "workspace"),
  ];
  const candidates = [configured, ...fallbacks].filter(
    (candidate, index, all) => all.findIndex((other) => pathsEqual(other, candidate)) === index,
  );

  for (const candidate of candidates) {
    try {
      await mkdir(candidate, { recursive: true });
      const gitRoot = await findEnclosingGitRoot(candidate);
      if (gitRoot) {
        log.error(`[workspace] Rejected Bridge workspace ${candidate}: it is inside the git work tree ${gitRoot}`);
        continue;
      }
    } catch (error) {
      log.error(`[workspace] Rejected Bridge workspace ${candidate}:`, error);
      continue;
    }
    if (candidate !== configured) {
      log.warn(`[workspace] Using ${candidate} as the Bridge workspace instead of ${configured}`);
      runtimePaths.workspaceDir = candidate;
      runtimePaths.env.BRIDGE_WORKSPACE_DIR = candidate;
    }
    return candidate;
  }

  // Inside a repository, every no-folder session would load that repository's instructions.
  throw new Error(`No Bridge workspace candidate is outside a git work tree: ${candidates.join(", ")}`);
}
