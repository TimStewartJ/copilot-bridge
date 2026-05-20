import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  type Dirent,
} from "node:fs";
import { cp, mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { dependencySyncHash, preparePatchedPackagesForInstall } from "./dependency-sync.js";
import type { RestartValidationMode, RestartReleaseCandidate } from "./restart-signal.js";
import type { ValidationCommandOptions } from "./validation-pipeline.js";

const RELEASE_SLOT_VERSION = 1;
const RELEASE_SLOT_MANIFEST = "release-slot.json";
const ACTIVE_RELEASE_FILE = "active-release.json";
const RELEASE_SLOT_KEEP_RECENT = 5;
const TEMP_DIR_SUFFIX = ".tmp";

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

function isPathInside(parentDir: string, childPath: string): boolean {
  const parent = resolve(parentDir);
  const child = resolve(childPath);
  const rel = relative(parent, child);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel);
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
  if (!isPathInside(getReleaseSlotsDir(dataDir), root)) return null;
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
  if (!isPathInside(getReleaseSlotsDir(dataDir), root)) return null;
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
  if (isPathInside(sourceDir, targetDir)) {
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

    const buildResult = await options.run(buildCommand, tempRoot, { timeoutMs: buildTimeoutMs });
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
    await rename(tempRoot, slotRoot);
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
  } = {},
): number {
  const releaseParent = getReleaseSlotsDir(dataDir);
  if (!existsSync(releaseParent)) return 0;
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
      if (temp.pid !== undefined && isProcessAlive(temp.pid)) return null;
      return {
        id: entry.name,
        root: join(releaseParent, entry.name),
      };
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

export function writeActiveReleaseSync(dataDir: string, manifest: ReleaseSlotManifest): void {
  mkdirSync(dataDir, { recursive: true });
  const activePath = getActiveReleaseFile(dataDir);
  const tempPath = join(dirname(activePath), `.${basename(activePath)}.${randomUUID()}.tmp`);
  writeFileSync(tempPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");
  renameSync(tempPath, activePath);
}
