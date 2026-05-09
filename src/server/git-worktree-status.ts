import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { posix, win32 } from "node:path";

const LOCAL_GIT_TIMEOUT_MS = 5_000;
const GIT_WORKTREE_STATUS_CACHE_TTL_MS = 60_000;
const GIT_WORKTREE_STATUS_CACHE_MAX_STALE_MS = 2 * GIT_WORKTREE_STATUS_CACHE_TTL_MS;
const GIT_WORKTREE_STATUS_CACHE_MAX_ENTRIES = 128;
const GIT_WORKTREE_STATUS_REFRESH_ERROR_LOG_INTERVAL_MS = 5 * 60_000;

export interface GitWorktreeBranchHead {
  kind: "branch";
  name: string;
}

export interface GitWorktreeDetachedHead {
  kind: "detached";
  shortSha: string;
}

export type GitWorktreeHead = GitWorktreeBranchHead | GitWorktreeDetachedHead;

export interface GitWorktreeDirtyState {
  clean: boolean;
  staged: number;
  modified: number;
  untracked: number;
  conflicts: number;
}

export interface GitSiblingWorktree {
  worktreePath: string;
  workspaceKind: "main" | "linked";
  head: GitWorktreeHead;
}

export interface GitWorktreeStatusOk {
  status: "ok";
  cwd: string;
  repoRoot: string;
  repoName: string;
  worktreePath: string;
  workspaceKind: "main" | "linked";
  head: GitWorktreeHead;
  dirty: GitWorktreeDirtyState;
  siblingWorktrees: GitSiblingWorktree[];
  branch: string | null;
  clean: boolean;
  staged: number;
  modified: number;
  untracked: number;
  conflicts: number;
}

export interface GitWorktreeStatusNotRepo {
  status: "not_repo";
  cwd: string;
}

export interface GitWorktreeStatusUnavailable {
  status: "unavailable";
  cwd: string;
  error: string;
}

export type GitWorktreeStatus = GitWorktreeStatusOk | GitWorktreeStatusNotRepo | GitWorktreeStatusUnavailable;

export interface TaskGitStatusNotConfigured {
  status: "not_configured";
  error: string;
}

export type TaskGitStatusResponse = GitWorktreeStatus | TaskGitStatusNotConfigured;

type GitCommandResult =
  | { ok: true; output: string }
  | { ok: false; error: string };

interface ReadCachedGitWorktreeStatusOptions {
  forceRefresh?: boolean;
  now?: () => number;
  ttlMs?: number;
  maxStaleMs?: number;
}

interface GitWorktreeStatusCacheEntry {
  value?: GitWorktreeStatus;
  updatedAt: number;
  lastAccessedAt: number;
  refresh?: Promise<GitWorktreeStatus>;
  lastRefreshErrorLoggedAt?: number;
}

interface ParsedWorktreeStatus {
  staged: number;
  modified: number;
  untracked: number;
  conflicts: number;
  clean: boolean;
}

interface ParsedWorktreeEntry {
  worktreePath: string;
  normalizedWorktreePath: string;
  head: GitWorktreeHead;
}

interface ParsedWorktreeBlock {
  worktreePath: string;
  head: GitWorktreeHead;
}

type UnmergedPorcelainStatusCode = "DD" | "AU" | "UD" | "UA" | "DU" | "AA" | "UU";

const UNMERGED_PORCELAIN_STATUS_CODES: ReadonlySet<UnmergedPorcelainStatusCode> = new Set([
  "DD",
  "AU",
  "UD",
  "UA",
  "DU",
  "AA",
  "UU",
]);

function isUnmergedPorcelainStatus(code: string): code is UnmergedPorcelainStatusCode {
  return UNMERGED_PORCELAIN_STATUS_CODES.has(code as UnmergedPorcelainStatusCode);
}

function normalizeStreamOutput(output: unknown): string {
  if (typeof output === "string") return output.trim();
  if (Buffer.isBuffer(output)) return output.toString("utf-8").trim();
  return "";
}

function formatGitError(error: unknown, stdout?: unknown, stderr?: unknown): string {
  const stderrText = normalizeStreamOutput(stderr ?? (error as { stderr?: unknown } | null)?.stderr);
  if (stderrText) return stderrText;
  const stdoutText = normalizeStreamOutput(stdout ?? (error as { stdout?: unknown } | null)?.stdout);
  if (stdoutText) return stdoutText;
  return error instanceof Error ? error.message : String(error);
}

function runGit(cwd: string, args: string[], timeoutMs = LOCAL_GIT_TIMEOUT_MS): Promise<GitCommandResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      args,
      {
        cwd,
        encoding: "utf-8",
        timeout: timeoutMs,
      },
      (error, stdout, stderr) => {
        if (error) {
          resolve({
            ok: false,
            error: formatGitError(error, stdout, stderr),
          });
          return;
        }
        resolve({ ok: true, output: stdout.trim() });
      },
    );
  });
}

function isNotRepoError(error: string): boolean {
  return /not a git repository|outside repository|unable to find repository/i.test(error);
}

function getPathFlavor(filePath: string) {
  return /^[A-Za-z]:[\\/]/.test(filePath) || filePath.startsWith("\\\\") || filePath.includes("\\")
    ? win32
    : posix;
}

function normalizeComparablePath(filePath: string): string {
  const normalized = getPathFlavor(filePath).normalize(filePath.trim()).replace(/\\/g, "/");
  let comparable = normalized;
  if (/^[A-Z]:\//.test(comparable)) {
    comparable = `${comparable[0].toLowerCase()}${comparable.slice(1)}`;
  }
  if (comparable.length > 1 && !/^[A-Za-z]:\/$/.test(comparable) && !/^\/\/[^/]+\/[^/]+\/?$/.test(comparable)) {
    comparable = comparable.replace(/\/+$/, "");
  }
  return comparable;
}

const gitWorktreeStatusCache = new Map<string, GitWorktreeStatusCacheEntry>();

function getGitWorktreeStatusCacheKey(cwd: string): string {
  return normalizeComparablePath(cwd);
}

function pruneGitWorktreeStatusCache(now: number): void {
  for (const [key, entry] of gitWorktreeStatusCache) {
    if (!entry.refresh && now - entry.lastAccessedAt > GIT_WORKTREE_STATUS_CACHE_MAX_STALE_MS) {
      gitWorktreeStatusCache.delete(key);
    }
  }

  while (gitWorktreeStatusCache.size > GIT_WORKTREE_STATUS_CACHE_MAX_ENTRIES) {
    const oldest = [...gitWorktreeStatusCache.entries()]
      .filter(([, entry]) => !entry.refresh)
      .sort(([, left], [, right]) => left.lastAccessedAt - right.lastAccessedAt)[0];
    if (!oldest) return;
    gitWorktreeStatusCache.delete(oldest[0]);
  }
}

function formatRefreshError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logGitWorktreeStatusRefreshError(
  key: string,
  cwd: string,
  error: unknown,
  now: () => number,
): void {
  const entry = gitWorktreeStatusCache.get(key);
  const nowMs = now();
  if (
    entry?.lastRefreshErrorLoggedAt !== undefined
    && nowMs - entry.lastRefreshErrorLoggedAt < GIT_WORKTREE_STATUS_REFRESH_ERROR_LOG_INTERVAL_MS
  ) {
    return;
  }

  if (entry) entry.lastRefreshErrorLoggedAt = nowMs;
  console.warn(`[git-status] Background refresh failed for ${cwd}: ${formatRefreshError(error)}`);
}

function startGitWorktreeStatusRefresh(
  key: string,
  cwd: string,
  entry: GitWorktreeStatusCacheEntry,
  now: () => number,
): Promise<GitWorktreeStatus> {
  let refresh!: Promise<GitWorktreeStatus>;
  refresh = readGitWorktreeStatus(cwd)
    .then((status) => {
      const refreshedAt = now();
      const current = gitWorktreeStatusCache.get(key) ?? entry;
      current.value = status;
      current.updatedAt = refreshedAt;
      current.lastAccessedAt = refreshedAt;
      current.lastRefreshErrorLoggedAt = undefined;
      if (current.refresh === refresh) current.refresh = undefined;
      gitWorktreeStatusCache.set(key, current);
      pruneGitWorktreeStatusCache(refreshedAt);
      return status;
    })
    .catch((error: unknown) => {
      const current = gitWorktreeStatusCache.get(key);
      if (current?.refresh === refresh) {
        current.refresh = undefined;
        current.lastAccessedAt = now();
        if (!current.value) gitWorktreeStatusCache.delete(key);
      }
      throw error;
    });

  entry.refresh = refresh;
  gitWorktreeStatusCache.set(key, entry);
  return refresh;
}

function basenamePortable(filePath: string): string {
  return getPathFlavor(filePath).basename(filePath);
}

function dirnamePortable(filePath: string): string {
  return getPathFlavor(filePath).dirname(filePath);
}

async function resolveRealPath(filePath: string): Promise<string> {
  try {
    return await realpath(filePath);
  } catch {
    return filePath;
  }
}

function parsePorcelainStatus(output: string): ParsedWorktreeStatus | null {
  const lines = output.split(/\r?\n/).filter((line) => line.length > 0);
  const [branchLine, ...statusLines] = lines;
  if (!branchLine?.startsWith("## ")) return null;

  let staged = 0;
  let modified = 0;
  let untracked = 0;
  let conflicts = 0;

  for (const line of statusLines) {
    if (line.startsWith("??")) {
      untracked += 1;
      continue;
    }
    if (line.length < 2) return null;

    const statusCode = line.slice(0, 2);
    if (isUnmergedPorcelainStatus(statusCode)) {
      conflicts += 1;
      continue;
    }

    const indexStatus = line[0];
    const worktreeStatus = line[1];

    if (indexStatus !== " " && indexStatus !== "?") staged += 1;
    if (worktreeStatus !== " ") modified += 1;
  }

  return {
    staged,
    modified,
    untracked,
    conflicts,
    clean: staged === 0 && modified === 0 && untracked === 0 && conflicts === 0,
  };
}

function parseWorktreeHead(branchRef: string | null, headSha: string | null, detached: boolean): GitWorktreeHead | null {
  if (branchRef) {
    return {
      kind: "branch",
      name: branchRef.replace(/^refs\/heads\//, ""),
    };
  }
  if (!detached || !headSha) return null;
  return {
    kind: "detached",
    shortSha: headSha.slice(0, 7),
  };
}

async function parseWorktreeList(output: string): Promise<ParsedWorktreeEntry[] | null> {
  const blocks = output
    .split(/\r?\n\r?\n/)
    .map((block) => block.trim())
    .filter((block) => block.length > 0);

  const parsedBlocks = blocks.map((block) => {
    let worktreePath: string | null = null;
    let branchRef: string | null = null;
    let headSha: string | null = null;
    let detached = false;

    for (const rawLine of block.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line) continue;
      if (line.startsWith("worktree ")) {
        worktreePath = line.slice("worktree ".length).trim();
        continue;
      }
      if (line.startsWith("branch ")) {
        branchRef = line.slice("branch ".length).trim() || null;
        continue;
      }
      if (line.startsWith("HEAD ")) {
        headSha = line.slice("HEAD ".length).trim() || null;
        continue;
      }
      if (line === "detached") {
        detached = true;
      }
    }

    const head = parseWorktreeHead(branchRef, headSha, detached);
    if (!worktreePath || !head) return null;
    return { worktreePath, head };
  });

  if (parsedBlocks.some((entry) => entry === null)) return null;

  const completeBlocks = parsedBlocks.filter((entry): entry is ParsedWorktreeBlock => entry !== null);

  return Promise.all(completeBlocks.map(async (entry) => {
    const resolvedPath = await resolveRealPath(entry.worktreePath);
    return {
      worktreePath: resolvedPath,
      normalizedWorktreePath: normalizeComparablePath(resolvedPath),
      head: entry.head,
    };
  }));
}

export async function readGitWorktreeStatus(cwd: string): Promise<GitWorktreeStatus> {
  const worktreePathResult = await runGit(cwd, ["rev-parse", "--show-toplevel"]);
  if (!worktreePathResult.ok) {
    if (isNotRepoError(worktreePathResult.error)) {
      return {
        status: "not_repo",
        cwd,
      };
    }
    return {
      status: "unavailable",
      cwd,
      error: worktreePathResult.error,
    };
  }

  if (!worktreePathResult.output) {
    return {
      status: "unavailable",
      cwd,
      error: "Git worktree root was empty.",
    };
  }

  const worktreePath = await resolveRealPath(worktreePathResult.output);
  const [statusResult, commonDirResult, worktreeListResult] = await Promise.all([
    runGit(cwd, ["status", "--porcelain=v1", "--branch"]),
    runGit(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    runGit(cwd, ["worktree", "list", "--porcelain"]),
  ]);

  if (!statusResult.ok) {
    return {
      status: "unavailable",
      cwd,
      error: statusResult.error,
    };
  }

  if (!commonDirResult.ok) {
    return {
      status: "unavailable",
      cwd,
      error: commonDirResult.error,
    };
  }

  if (!worktreeListResult.ok) {
    return {
      status: "unavailable",
      cwd,
      error: worktreeListResult.error,
    };
  }

  const dirty = parsePorcelainStatus(statusResult.output);
  if (!dirty) {
    return {
      status: "unavailable",
      cwd,
      error: "Unable to parse git worktree status.",
    };
  }

  if (!commonDirResult.output) {
    return {
      status: "unavailable",
      cwd,
      error: "Git common directory was empty.",
    };
  }

  const repoRoot = await resolveRealPath(dirnamePortable(commonDirResult.output));
  const parsedWorktrees = await parseWorktreeList(worktreeListResult.output);
  if (!parsedWorktrees) {
    return {
      status: "unavailable",
      cwd,
      error: "Unable to parse git worktree list.",
    };
  }

  const normalizedWorktreePath = normalizeComparablePath(worktreePath);
  const normalizedRepoRoot = normalizeComparablePath(repoRoot);
  const currentWorktree = parsedWorktrees.find((entry) => entry.normalizedWorktreePath === normalizedWorktreePath);
  if (!currentWorktree) {
    return {
      status: "unavailable",
      cwd,
      error: "Unable to match the current git worktree.",
    };
  }

  const workspaceKind = currentWorktree.normalizedWorktreePath === normalizedRepoRoot ? "main" : "linked";

  return {
    status: "ok",
    cwd,
    repoRoot,
    repoName: basenamePortable(repoRoot),
    worktreePath: currentWorktree.worktreePath,
    workspaceKind,
    head: currentWorktree.head,
    dirty,
    siblingWorktrees: parsedWorktrees
      .filter((entry) => entry.normalizedWorktreePath !== normalizedWorktreePath)
      .map((entry) => ({
        worktreePath: entry.worktreePath,
        workspaceKind: entry.normalizedWorktreePath === normalizedRepoRoot ? "main" : "linked",
        head: entry.head,
      })),
    branch: currentWorktree.head.kind === "branch" ? currentWorktree.head.name : null,
    clean: dirty.clean,
    staged: dirty.staged,
    modified: dirty.modified,
    untracked: dirty.untracked,
    conflicts: dirty.conflicts,
  };
}

export function clearGitWorktreeStatusCache(): void {
  gitWorktreeStatusCache.clear();
}

export async function readCachedGitWorktreeStatus(
  cwd: string,
  options: ReadCachedGitWorktreeStatusOptions = {},
): Promise<GitWorktreeStatus> {
  const now = options.now ?? Date.now;
  const ttlMs = options.ttlMs ?? GIT_WORKTREE_STATUS_CACHE_TTL_MS;
  const maxStaleMs = options.maxStaleMs ?? GIT_WORKTREE_STATUS_CACHE_MAX_STALE_MS;
  const key = getGitWorktreeStatusCacheKey(cwd);
  const nowMs = now();
  pruneGitWorktreeStatusCache(nowMs);

  const entry = gitWorktreeStatusCache.get(key);
  if (!entry) {
    return startGitWorktreeStatusRefresh(key, cwd, {
      updatedAt: 0,
      lastAccessedAt: nowMs,
    }, now);
  }

  entry.lastAccessedAt = nowMs;
  if (options.forceRefresh) {
    if (!entry.refresh) {
      return startGitWorktreeStatusRefresh(key, cwd, entry, now);
    }

    const pendingRefresh = entry.refresh;
    const forcedRefresh = pendingRefresh
      .catch(() => undefined)
      .then(() => {
        const current = gitWorktreeStatusCache.get(key) ?? entry;
        return startGitWorktreeStatusRefresh(key, cwd, current, now);
      });
    entry.refresh = forcedRefresh;
    return forcedRefresh;
  }

  if (entry.value && nowMs - entry.updatedAt <= ttlMs) {
    return entry.value;
  }

  if (entry.refresh) {
    if (entry.value && nowMs - entry.updatedAt <= maxStaleMs) {
      return entry.value;
    }
    return entry.refresh;
  }

  const refresh = startGitWorktreeStatusRefresh(key, cwd, entry, now);
  if (entry.value && nowMs - entry.updatedAt <= maxStaleMs) {
    void refresh.catch((error: unknown) => {
      logGitWorktreeStatusRefreshError(key, cwd, error, now);
    });
    return entry.value;
  }

  return refresh;
}
