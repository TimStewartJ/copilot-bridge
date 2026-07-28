import { readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";

export const RETENTION_DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Artifacts touched more recently than this are never deleted, so a sweep can
 * never remove a log another process is still appending to (on POSIX an unlink
 * would silently redirect the writer's output into an unreachable inode).
 */
export const DEFAULT_RETENTION_GRACE_MS = 15 * 60_000;

const REMOVE_CONCURRENCY = 32;

export interface LogRetentionPolicy {
  /** Artifacts older than this are deleted. `Infinity` disables the age cap. */
  maxAgeMs: number;
  /** Newest unprotected artifacts to keep. `Infinity` disables the count cap. */
  maxCount: number;
}

export interface ResolveLogRetentionPolicyOptions {
  env?: NodeJS.ProcessEnv;
  maxAgeDaysEnvKey: string;
  maxCountEnvKey: string;
  defaultMaxAgeDays: number;
  defaultMaxCount: number;
  overrides?: Partial<LogRetentionPolicy>;
}

export interface RetentionEntry {
  id: string;
  timestampMs: number;
  /** Protected artifacts are never deleted and never consume the count cap. */
  protected?: boolean;
}

export interface RemoveRetainedFilesResult {
  deleted: string[];
  skippedRecent: number;
  failed: number;
}

export interface PruneRetainedLogFilesOptions {
  dir: string;
  policy: LogRetentionPolicy;
  nowMs?: number;
  graceMs?: number;
  isEligible?: (name: string) => boolean;
  isProtected?: (name: string) => boolean;
  /** Avoids a stat per file when the artifact name already encodes its time. */
  timestampFromName?: (name: string) => number | null;
}

export interface PruneRetainedLogFilesResult extends RemoveRetainedFilesResult {
  dir: string;
  scanned: number;
}

export interface RetentionSweepScheduler<T> {
  run(key: string, options?: { force?: boolean }): Promise<T | null>;
  reset(key?: string): void;
}

/** Non-positive or invalid values fall back to the default cap. */
function parseCap(value: string | undefined, fallback: number, scale: number): number {
  const parsed = Number(value?.trim());
  if (!Number.isFinite(parsed) || parsed < 1) return fallback * scale;
  return Math.floor(parsed) * scale;
}

export function resolveLogRetentionPolicy(options: ResolveLogRetentionPolicyOptions): LogRetentionPolicy {
  const env = options.env ?? process.env;
  return {
    maxAgeMs: options.overrides?.maxAgeMs
      ?? parseCap(env[options.maxAgeDaysEnvKey], options.defaultMaxAgeDays, RETENTION_DAY_MS),
    maxCount: options.overrides?.maxCount
      ?? parseCap(env[options.maxCountEnvKey], options.defaultMaxCount, 1),
  };
}

/**
 * Selects artifacts to delete: everything older than the age cap, plus everything
 * past the newest `maxCount` survivors. Protected artifacts are kept and excluded
 * from the count budget so an active job never pushes its own log out of range.
 */
export function selectRetentionDeletions<T extends RetentionEntry>(
  entries: readonly T[],
  policy: LogRetentionPolicy,
  nowMs: number,
): T[] {
  const cutoffMs = policy.maxAgeMs === Number.POSITIVE_INFINITY
    ? Number.NEGATIVE_INFINITY
    : nowMs - policy.maxAgeMs;
  const sorted = [...entries].sort((a, b) => {
    if (a.timestampMs !== b.timestampMs) return b.timestampMs - a.timestampMs;
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
  });

  const deletions: T[] = [];
  let kept = 0;
  for (const entry of sorted) {
    if (entry.protected) continue;
    if (entry.timestampMs < cutoffMs || kept >= policy.maxCount) {
      deletions.push(entry);
      continue;
    }
    kept++;
  }
  return deletions;
}

async function mapWithConcurrency<T>(
  items: readonly T[],
  limit: number,
  run: (item: T) => Promise<void>,
): Promise<void> {
  for (let index = 0; index < items.length; index += limit) {
    await Promise.all(items.slice(index, index + limit).map(run));
  }
}

async function modifiedAtMs(path: string): Promise<number | null> {
  try {
    return (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

function isMissingDirectoryError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Removes files in bounded batches so a large first sweep yields to the event
 * loop. Files modified inside the grace window are left for a later pass, and
 * per-file failures (Windows `EPERM`/`EBUSY` on open handles) are counted and
 * retried by the next sweep instead of aborting it.
 */
export async function removeRetainedFiles(
  paths: readonly string[],
  options: { nowMs?: number; graceMs?: number } = {},
): Promise<RemoveRetainedFilesResult> {
  const nowMs = options.nowMs ?? Date.now();
  const graceMs = options.graceMs ?? DEFAULT_RETENTION_GRACE_MS;
  const deleted: string[] = [];
  let skippedRecent = 0;
  let failed = 0;

  await mapWithConcurrency(paths, REMOVE_CONCURRENCY, async (path) => {
    const mtimeMs = await modifiedAtMs(path);
    if (mtimeMs === null) return;
    if (nowMs - mtimeMs < graceMs) {
      skippedRecent++;
      return;
    }
    try {
      await rm(path, { force: true });
      deleted.push(path);
    } catch {
      failed++;
    }
  });

  return { deleted, skippedRecent, failed };
}

export async function pruneRetainedLogFiles(
  options: PruneRetainedLogFilesOptions,
): Promise<PruneRetainedLogFilesResult> {
  const nowMs = options.nowMs ?? Date.now();
  const empty: PruneRetainedLogFilesResult = {
    dir: options.dir,
    scanned: 0,
    deleted: [],
    skippedRecent: 0,
    failed: 0,
  };

  let dirEntries;
  try {
    dirEntries = await readdir(options.dir, { withFileTypes: true });
  } catch (error) {
    if (isMissingDirectoryError(error)) return empty;
    throw error;
  }

  const entries: RetentionEntry[] = [];
  const pendingStat: Array<{ path: string; isProtected: boolean }> = [];
  for (const dirEntry of dirEntries) {
    if (!dirEntry.isFile()) continue;
    if (options.isEligible && !options.isEligible(dirEntry.name)) continue;
    const path = join(options.dir, dirEntry.name);
    const isProtected = options.isProtected?.(dirEntry.name) === true;
    const timestampMs = options.timestampFromName?.(dirEntry.name) ?? null;
    if (timestampMs === null) {
      pendingStat.push({ path, isProtected });
      continue;
    }
    entries.push({ id: path, timestampMs, protected: isProtected });
  }

  await mapWithConcurrency(pendingStat, REMOVE_CONCURRENCY, async ({ path, isProtected }) => {
    const mtimeMs = await modifiedAtMs(path);
    if (mtimeMs === null) return;
    entries.push({ id: path, timestampMs: mtimeMs, protected: isProtected });
  });

  const deletions = selectRetentionDeletions(entries, options.policy, nowMs);
  const removal = await removeRetainedFiles(deletions.map((entry) => entry.id), {
    nowMs,
    graceMs: options.graceMs,
  });

  return { dir: options.dir, scanned: entries.length, ...removal };
}

/**
 * Rate-limits background sweeps per directory and shares one in-flight sweep
 * between callers, so startup and post-write sweeps never stack up.
 */
export function createRetentionSweepScheduler<T>(
  sweep: (key: string) => Promise<T>,
  options: { minIntervalMs: number; now?: () => number },
): RetentionSweepScheduler<T> {
  const now = options.now ?? (() => Date.now());
  const lastRunMs = new Map<string, number>();
  const inFlight = new Map<string, Promise<T>>();

  return {
    run(key, runOptions = {}) {
      const pending = inFlight.get(key);
      if (pending) return pending;

      const previousMs = lastRunMs.get(key);
      if (!runOptions.force && previousMs !== undefined && now() - previousMs < options.minIntervalMs) {
        return Promise.resolve(null);
      }

      const started = (async () => sweep(key))();
      inFlight.set(key, started);
      return started.finally(() => {
        lastRunMs.set(key, now());
        inFlight.delete(key);
      });
    },
    reset(key) {
      if (key === undefined) {
        lastRunMs.clear();
        return;
      }
      lastRunMs.delete(key);
    },
  };
}
