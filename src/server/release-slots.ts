import { randomUUID } from "node:crypto";
import {
  existsSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  type Dirent,
} from "node:fs";
import { cp, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import { dependencySyncHash, preparePatchedPackagesForInstall } from "./dependency-sync.js";
import type { RestartValidationMode, RestartReleaseCandidate } from "./restart-signal.js";
import type { ValidationCommandOptions } from "./validation-pipeline.js";
import { isPathAtOrUnder, pathsEqual } from "./path-utils.js";

const RELEASE_SLOT_VERSION = 1;
const RELEASE_SLOT_MANIFEST = "release-slot.json";
const ACTIVE_RELEASE_FILE = "active-release.json";
const RELEASE_SLOT_KEEP_RECENT = 5;
const TEMP_DIR_SUFFIX = ".tmp";
/**
 * Upper bound on how long a release temp directory may sit untouched while its
 * recorded PID is still alive before we treat that PID as reused. Generously
 * larger than the default 10-minute build timeout.
 */
const TEMP_DIR_MAX_LIVE_AGE_MS = 60 * 60_000;
const RELEASE_SLOT_RENAME_RETRY_DELAYS_MS = [100, 250, 500, 1_000, 1_500] as const;
const RETRYABLE_RELEASE_SLOT_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);

const ROOT_COPY_EXCLUDES = new Set([
  ".env",
  ".git",
  ".vitest-slowest.json",
  "coverage",
  "data",
  "dist",
  "node_modules",
]);

export interface ReleaseSlotManifest extends RestartReleaseCandidate {
  version: typeof RELEASE_SLOT_VERSION;
  createdAt: string;
  validationMode: RestartValidationMode;
}

export interface ReleaseSlotRunResult {
  ok: boolean;
  output: string;
}

export type ReleaseSlotRunCommand = (
  command: string,
  cwd: string,
  options?: ValidationCommandOptions,
) => Promise<ReleaseSlotRunResult>;

export type PrepareReleaseSlotResult =
  | { ok: true; manifest: ReleaseSlotManifest }
  | {
      ok: false;
      command: string;
      cwd: string;
      output: string;
    };

export interface PrepareReleaseSlotOptions {
  sourceDir: string;
  dataDir: string;
  commitSha: string;
  source: string;
  validationMode: RestartValidationMode;
  run: ReleaseSlotRunCommand;
  log?: (message: string) => void;
  installCommand: string;
  installTimeoutMs: number;
  buildCommand?: string;
  buildTimeoutMs?: number;
  now?: Date;
  /** Test seam for deterministic Windows rename retry coverage. */
  renamePath?: typeof rename;
  /** Test seam for deterministic retry timing. */
  wait?: (delayMs: number) => Promise<void>;
}

export function getReleaseSlotsDir(dataDir: string): string {
  return join(dataDir, "release-slots");
}

export function getActiveReleaseFile(dataDir: string): string {
  return join(dataDir, ACTIVE_RELEASE_FILE);
}

function sanitizeSlotPart(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    || "release";
}

function formatSlotTimestamp(date: Date): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

export function buildReleaseSlotId(commitSha: string, now = new Date()): string {
  const shortSha = sanitizeSlotPart(commitSha.slice(0, 12));
  return `${formatSlotTimestamp(now)}-${shortSha}-${randomUUID().slice(0, 8)}`;
}

function parseReleaseSlotTempDirectoryName(name: string): { id: string; pid?: number } | null {
  if (!name.startsWith(".") || !name.endsWith(TEMP_DIR_SUFFIX)) return null;
  const idWithMaybePid = name.slice(1, -TEMP_DIR_SUFFIX.length);
  if (!idWithMaybePid) return null;

  const pidMatch = /^(.*)\.(\d+)$/.exec(idWithMaybePid);
  if (!pidMatch) return { id: idWithMaybePid };

  const id = pidMatch[1];
  const pid = Number(pidMatch[2]);
  if (!id || !Number.isSafeInteger(pid) || pid <= 0) return { id: idWithMaybePid };
  return { id, pid };
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return getErrorCode(error) === "EPERM";
  }
}

/**
 * Last time the release temp directory itself changed. A build in progress adds
 * and removes entries in this directory (dependency install, dist output), so
 * this doubles as a progress signal that does not depend on the recorded PID.
 *
 * Deliberately `mtime` only: `ctime` advances on any metadata touch and
 * `birthtime` is unreliable across filesystems, so neither reflects progress.
 */
function tempDirectoryLastActivityMs(root: string): number | undefined {
  try {
    const { mtimeMs } = statSync(root);
    return Number.isFinite(mtimeMs) && mtimeMs > 0 ? mtimeMs : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Decide whether a release temp directory still belongs to a live build.
 *
 * PID existence alone is not proof of ownership: the operating system reuses
 * PIDs, so an unrelated long-lived process can inherit the number recorded in
 * `.<slot>.<pid>.tmp` and pin a large abandoned tree forever. We therefore
 * combine the PID check with a bounded activity age — a real build is bounded by
 * the build timeout, so a "live" PID whose tree has been untouched for far
 * longer is PID reuse, not an in-flight build.
 */
function isReleaseTempDirectoryProtected(
  root: string,
  pid: number | undefined,
  now: number,
): boolean {
  if (pid === undefined) return false;
  // Our own in-flight build: identity is exact, never prune it.
  if (pid === process.pid) return true;
  if (!isProcessAlive(pid)) return false;
  const lastActivityMs = tempDirectoryLastActivityMs(root);
  // Unreadable timestamps: fall back to the previous PID-only behaviour.
  if (lastActivityMs === undefined) return true;
  return now - lastActivityMs <= TEMP_DIR_MAX_LIVE_AGE_MS;
}

function releaseSlotManifestPath(slotRoot: string): string {
  return join(slotRoot, RELEASE_SLOT_MANIFEST);
}

function normalizeManifest(value: unknown, dataDir: string): ReleaseSlotManifest | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : "";
  const root = typeof record.root === "string" && record.root.trim() ? resolve(record.root) : "";
  const commitSha = typeof record.commitSha === "string" && record.commitSha.trim() ? record.commitSha.trim() : "";
  const source = typeof record.source === "string" && record.source.trim() ? record.source.trim() : "";
  const dependencyHash = typeof record.dependencyHash === "string" && record.dependencyHash.trim()
    ? record.dependencyHash.trim()
    : "";
  const createdAt = typeof record.createdAt === "string" && record.createdAt.trim()
    ? record.createdAt.trim()
    : "";
  const validationMode = record.validationMode === "operational" ? "operational" : "deploy";
  if (
    record.version !== RELEASE_SLOT_VERSION
    || !id
    || !root
    || !commitSha
    || !source
    || !dependencyHash
    || !createdAt
  ) {
    return null;
  }
  const releaseSlotsDir = getReleaseSlotsDir(dataDir);
  if (!isPathAtOrUnder(releaseSlotsDir, root) || pathsEqual(releaseSlotsDir, root)) return null;
  if (basename(root) !== id) return null;
  return {
    version: RELEASE_SLOT_VERSION,
    id,
    root,
    commitSha,
    source,
    dependencyHash,
    createdAt,
    validationMode,
  };
}

export function readReleaseSlotManifest(slotRoot: string, dataDir: string): ReleaseSlotManifest | null {
  try {
    const parsed = JSON.parse(readFileSync(releaseSlotManifestPath(slotRoot), "utf-8")) as unknown;
    return normalizeManifest(parsed, dataDir);
  } catch {
    return null;
  }
}

export function resolveReleaseCandidate(
  dataDir: string,
  candidate: RestartReleaseCandidate | undefined,
): ReleaseSlotManifest | null {
  if (!candidate) return null;
  const root = resolve(candidate.root);
  const releaseSlotsDir = getReleaseSlotsDir(dataDir);
  if (!isPathAtOrUnder(releaseSlotsDir, root) || pathsEqual(releaseSlotsDir, root)) return null;
  const manifest = readReleaseSlotManifest(root, dataDir);
  if (!manifest) return null;
  if (manifest.id !== candidate.id || manifest.commitSha !== candidate.commitSha) return null;
  return manifest;
}

export function readActiveRelease(dataDir: string): ReleaseSlotManifest | null {
  try {
    const parsed = JSON.parse(readFileSync(getActiveReleaseFile(dataDir), "utf-8")) as unknown;
    const manifest = normalizeManifest(parsed, dataDir);
    if (!manifest) return null;
    if (!existsSync(join(manifest.root, "dist", "server", "index.js"))) return null;
    return manifest;
  } catch {
    return null;
  }
}

export function findReleaseSlotByCommit(
  dataDir: string,
  commitSha: string,
  options: { validationMode?: RestartValidationMode } = {},
): ReleaseSlotManifest | null {
  const releaseParent = getReleaseSlotsDir(dataDir);
  if (!existsSync(releaseParent)) return null;
  const candidates = (() => {
    try {
      return readdirSync(releaseParent, { withFileTypes: true }) as Dirent[];
    } catch {
      return [];
    }
  })();

  return candidates
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => readReleaseSlotManifest(join(releaseParent, entry.name), dataDir))
    .filter((manifest): manifest is ReleaseSlotManifest =>
      !!manifest
      && manifest.commitSha === commitSha
      && (!options.validationMode || manifest.validationMode === options.validationMode)
    )
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
}

export async function writeActiveRelease(dataDir: string, manifest: ReleaseSlotManifest): Promise<void> {
  await mkdir(dataDir, { recursive: true });
  const activePath = getActiveReleaseFile(dataDir);
  const tempPath = join(dirname(activePath), `.${basename(activePath)}.${randomUUID()}.tmp`);
  await writeFile(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
  await rename(tempPath, activePath);
}

function firstPathSegment(relativePath: string): string | null {
  const [firstSegment] = relativePath.split(/[\\/]/, 1);
  return firstSegment || null;
}

function shouldCopySourcePath(sourceDir: string, currentPath: string, rootExcludes: Set<string>): boolean {
  const rel = relative(sourceDir, currentPath);
  if (!rel) return true;
  const firstSegment = firstPathSegment(rel);
  return firstSegment === null || !rootExcludes.has(firstSegment);
}

function buildRootCopyExcludes(sourceDir: string, targetDir: string): Set<string> {
  const rootExcludes = new Set(ROOT_COPY_EXCLUDES);
  if (isPathAtOrUnder(sourceDir, targetDir) && !pathsEqual(sourceDir, targetDir)) {
    const firstSegment = firstPathSegment(relative(sourceDir, targetDir));
    if (firstSegment !== null) rootExcludes.add(firstSegment);
  }
  return rootExcludes;
}

async function copyReleaseSource(sourceDir: string, targetDir: string): Promise<void> {
  const rootExcludes = buildRootCopyExcludes(sourceDir, targetDir);
  await mkdir(targetDir, { recursive: true });
  const entries = await readdir(sourceDir, { withFileTypes: true });
  await Promise.all(entries.map(async (entry) => {
    if (rootExcludes.has(entry.name)) return;
    await cp(join(sourceDir, entry.name), join(targetDir, entry.name), {
      recursive: true,
      force: false,
      errorOnExist: true,
      filter: (sourcePath) => shouldCopySourcePath(sourceDir, sourcePath, rootExcludes),
    });
  }));
}

async function removePath(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function isRetryableReleaseSlotRenameError(error: unknown): boolean {
  if (!error || typeof error !== "object" || !("code" in error)) return false;
  return RETRYABLE_RELEASE_SLOT_RENAME_CODES.has(String((error as NodeJS.ErrnoException).code));
}

async function finalizeReleaseSlot(
  tempRoot: string,
  slotRoot: string,
  options: Pick<PrepareReleaseSlotOptions, "log" | "renamePath" | "wait">,
): Promise<void> {
  const renamePath = options.renamePath ?? rename;
  const wait = options.wait ?? ((delayMs: number) =>
    new Promise<void>((resolve) => setTimeout(resolve, delayMs)));

  for (let attempt = 0; ; attempt++) {
    try {
      await renamePath(tempRoot, slotRoot);
      return;
    } catch (error) {
      const delayMs = RELEASE_SLOT_RENAME_RETRY_DELAYS_MS[attempt];
      if (delayMs === undefined || !isRetryableReleaseSlotRenameError(error)) throw error;
      options.log?.(
        `Release slot rename failed with ${(error as NodeJS.ErrnoException).code}; retrying in ${delayMs}ms`,
      );
      await wait(delayMs);
    }
  }
}

export async function prepareReleaseSlot(options: PrepareReleaseSlotOptions): Promise<PrepareReleaseSlotResult> {
  const now = options.now ?? new Date();
  const sourceDir = resolve(options.sourceDir);
  const releaseParent = getReleaseSlotsDir(options.dataDir);
  const id = buildReleaseSlotId(options.commitSha, now);
  const slotRoot = join(releaseParent, id);
  const tempRoot = join(releaseParent, `.${id}.${process.pid}.tmp`);
  const dependencyHash = dependencySyncHash(sourceDir);
  const buildCommand = options.buildCommand ?? "npm run build";
  const buildTimeoutMs = options.buildTimeoutMs ?? 10 * 60_000;

  await mkdir(releaseParent, { recursive: true });
  await removePath(tempRoot);
  try {
    options.log?.(`Preparing inactive release slot ${id}`);
    await copyReleaseSource(sourceDir, tempRoot);

    const prepared = preparePatchedPackagesForInstall(tempRoot);
    try {
      if (prepared.packages.length > 0) {
        options.log?.(`Prepared patched packages for release slot install: ${prepared.packages.join(", ")}`);
      }
      const installResult = await options.run(options.installCommand, tempRoot, {
        timeoutMs: options.installTimeoutMs,
      });
      if (!installResult.ok) {
        prepared.restore();
        return {
          ok: false,
          command: options.installCommand,
          cwd: tempRoot,
          output: installResult.output,
        };
      }
      prepared.discard();
    } catch (error) {
      prepared.restore();
      throw error;
    }

    const buildResult = await options.run(buildCommand, tempRoot, {
      timeoutMs: buildTimeoutMs,
      isolateRuntimeEnv: true,
    });
    if (!buildResult.ok) {
      return {
        ok: false,
        command: buildCommand,
        cwd: tempRoot,
        output: buildResult.output,
      };
    }

    const manifest: ReleaseSlotManifest = {
      version: RELEASE_SLOT_VERSION,
      id,
      root: slotRoot,
      commitSha: options.commitSha,
      source: options.source,
      dependencyHash,
      createdAt: now.toISOString(),
      validationMode: options.validationMode,
    };
    await writeFile(releaseSlotManifestPath(tempRoot), `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
    await finalizeReleaseSlot(tempRoot, slotRoot, options);
    options.log?.(`Release slot prepared: ${slotRoot}`);
    return { ok: true, manifest };
  } catch (error) {
    return {
      ok: false,
      command: "prepare release slot",
      cwd: sourceDir,
      output: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await removePath(tempRoot);
  }
}

export function pruneReleaseSlots(
  dataDir: string,
  options: {
    keepRecent?: number;
    extraKeepIds?: Iterable<string | undefined>;
    log?: (message: string) => void;
    now?: () => number;
  } = {},
): number {
  const releaseParent = getReleaseSlotsDir(dataDir);
  if (!existsSync(releaseParent)) return 0;
  const now = (options.now ?? Date.now)();
  const active = readActiveRelease(dataDir);
  const keep = new Set<string>();
  if (active) keep.add(active.id);
  for (const id of options.extraKeepIds ?? []) {
    if (id) keep.add(id);
  }

  const entries = (() => {
    try {
      return readdirSync(releaseParent, { withFileTypes: true }) as Dirent[];
    } catch {
      return [];
    }
  })();

  const staleTempDirectories = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const temp = parseReleaseSlotTempDirectoryName(entry.name);
      if (!temp) return null;
      const root = join(releaseParent, entry.name);
      if (isReleaseTempDirectoryProtected(root, temp.pid, now)) return null;
      return { id: entry.name, root };
    })
    .filter((entry): entry is { id: string; root: string } => entry !== null);

  const candidates = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => {
      const root = join(releaseParent, entry.name);
      const manifest = readReleaseSlotManifest(root, dataDir);
      return {
        id: entry.name,
        root,
        createdAt: manifest?.createdAt ?? "",
        mtimeMs: (() => {
          try {
            return statSync(root).mtimeMs;
          } catch {
            return 0;
          }
        })(),
      };
    })
    .sort((a, b) => {
      const byCreated = b.createdAt.localeCompare(a.createdAt);
      return byCreated !== 0 ? byCreated : b.mtimeMs - a.mtimeMs;
    });

  const keepRecent = Math.max(1, options.keepRecent ?? RELEASE_SLOT_KEEP_RECENT);
  for (const entry of candidates.slice(0, keepRecent)) {
    keep.add(entry.id);
  }

  let removed = 0;
  for (const entry of staleTempDirectories) {
    try {
      rmSync(entry.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      removed++;
    } catch (error) {
      options.log?.(`Warning: failed to prune stale release slot temp dir ${entry.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  for (const entry of candidates) {
    if (keep.has(entry.id)) continue;
    try {
      rmSync(entry.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      removed++;
    } catch (error) {
      options.log?.(`Warning: failed to prune release slot ${entry.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return removed;
}
