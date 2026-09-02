import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isBridgeSourceManagementAvailable } from "./distribution-mode.js";
import { resolveBridgeControlRoot } from "./control-root.js";
import { resolveRuntimePaths } from "./runtime-paths.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const PRODUCTION_ROOT = resolveBridgeControlRoot(join(__dirname, "..", ".."));
export const STAGING_PARENT = join(PRODUCTION_ROOT, "..", "bridge-staging");
export const PRODUCTION_RUNTIME_PATHS = resolveRuntimePaths(process.env);
export const PRODUCTION_DATA_DIR = PRODUCTION_RUNTIME_PATHS.dataDir;
export const SIGNAL_FILE = join(PRODUCTION_DATA_DIR, "restart.signal");
export const PRE_DEPLOY_SHA_FILE = join(PRODUCTION_DATA_DIR, "pre-deploy-sha");
export const STAGING_PREVIEW_DIR_ENV = "BRIDGE_STAGING_PREVIEW_DIR";
export const STAGING_PREVIEW_ACTIVE_DIRNAME = ".active";
export const STAGING_PREVIEW_GENERATIONS_DIRNAME = ".generations";
export const FAILURE_DETAIL_OUTPUT_LIMIT = 500;
export const FAILURE_SESSION_LOG_OUTPUT_LIMIT = 4_000;
export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
export const COMMAND_OUTPUT_CAPTURE_LIMIT = 1024 * 1024;
export const STAGING_INSTALL_COMMAND = "npm install --no-audit --no-fund --include=dev";
export const STAGING_INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
export const STAGING_PREVIEW_MODEL = "claude-haiku-4.5";
export const STAGING_BACKEND_STARTUP_TIMEOUT_MS = 30_000;
export const STAGING_BACKEND_IDENTITY_RECAPTURE_TIMEOUT_MS = 10_000;
export const STAGING_BACKEND_SWITCH_STOP_MAX_ATTEMPTS = 2;
export const STAGING_BACKEND_SWITCH_STOP_RETRY_DELAY_MS = 1_000;
export const STAGING_BACKEND_REQUEST_START_WAIT_MS = 2_000;
export const STAGING_BACKEND_FAILURE_BACKOFF_BASE_MS = 30_000;
export const STAGING_BACKEND_FAILURE_BACKOFF_MAX_MS = 5 * 60_000;
/**
 * Consecutive lazy-start failures after which a preview is treated as
 * permanently dead: its route is removed instead of answering 502 forever.
 */
export const STAGING_BACKEND_START_MAX_ATTEMPTS = parsePositiveIntegerEnv("BRIDGE_STAGING_BACKEND_START_MAX_ATTEMPTS", 5);
export const STAGING_BACKEND_LIVE_LIMIT = parsePositiveIntegerEnv("BRIDGE_STAGING_BACKEND_LIVE_LIMIT", 3);
export const STAGING_BACKEND_STARTUP_RESTORE_LIMIT = parseNonNegativeIntegerEnv("BRIDGE_STAGING_BACKEND_STARTUP_RESTORE_LIMIT", 1);
export const STAGING_BACKEND_IDLE_TTL_MS = parsePositiveIntegerEnv("BRIDGE_STAGING_BACKEND_IDLE_TTL_MS", 30 * 60_000);
export const STAGING_BACKEND_IDLE_REAPER_INTERVAL_MS = parsePositiveIntegerEnv("BRIDGE_STAGING_BACKEND_IDLE_REAPER_INTERVAL_MS", 5 * 60_000);
export const STAGING_STALE_ARTIFACT_MAX_AGE_MS = parsePositiveIntegerEnv("BRIDGE_STAGING_STALE_ARTIFACT_MAX_AGE_MS", 14 * 24 * 60 * 60_000);
export const STAGING_STALE_ARTIFACT_KEEP_RECENT = parsePositiveIntegerEnv("BRIDGE_STAGING_STALE_ARTIFACT_KEEP_RECENT", 25);
export const STAGING_STALE_ARTIFACT_RECENT_GRACE_MS = parsePositiveIntegerEnv("BRIDGE_STAGING_STALE_ARTIFACT_RECENT_GRACE_MS", 2 * 60 * 60_000);
export const STAGING_ARTIFACT_CLEANUP_MAX_RETRIES = 20;
export const STAGING_ARTIFACT_CLEANUP_RETRY_DELAY_MS = 50;
export const STAGING_PREVIEW_PARENT = resolveConfiguredPath(
  process.env[STAGING_PREVIEW_DIR_ENV],
  join(PRODUCTION_DATA_DIR, "staging-previews"),
);

export interface PreviewTarget {
  prefix: string;
  stagingDir: string;
  basePath: string;
  outDir: string;
  dataDir?: string;
  generationId?: string;
  updatedAtMs: number;
}

interface ActivePreviewManifest {
  version: 1;
  prefix: string;
  generationId: string;
  stagingDir: string;
  publishedAt: string;
}

export function parsePositiveIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

export function parseNonNegativeIntegerEnv(name: string, fallback: number): number {
  const raw = process.env[name]?.trim();
  if (!raw) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value >= 0 ? value : fallback;
}

export function resolveConfiguredPath(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? resolve(PRODUCTION_ROOT, trimmed) : fallback;
}

export function uniqueResolvedPaths(paths: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const candidate of paths) {
    const normalized = resolve(candidate);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

export function listStagingPreviewParents(): string[] {
  return uniqueResolvedPaths([STAGING_PREVIEW_PARENT]);
}

export function buildPreviewPrefix(stagingDir: string): string {
  return basename(stagingDir);
}

/** Returns the staging worktree name a preview prefix maps to, or null when it is not servable. */
export function parsePreviewPrefix(
  prefix: string,
  activeWorktrees?: ReadonlySet<string>,
): string | null {
  if (!isSafePreviewPrefix(prefix)) return null;
  if (activeWorktrees && !activeWorktrees.has(prefix)) return null;
  return prefix;
}

function isSafePreviewPrefix(prefix: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?$/.test(prefix) && !prefix.includes("..");
}

function isSafeGenerationId(generationId: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?$/.test(generationId)
    && !generationId.includes("..");
}

export function escapeSqliteStringLiteral(value: string): string {
  return value.replaceAll("'", "''");
}

export function createPreviewTarget(stagingDir: string): PreviewTarget {
  const prefix = buildPreviewPrefix(stagingDir);
  const outDir = join(STAGING_PREVIEW_PARENT, prefix);
  return {
    prefix,
    stagingDir,
    basePath: `/staging/${prefix}/`,
    outDir,
    updatedAtMs: directoryMtimeMs(outDir),
  };
}

export function createPreviewGenerationTarget(
  stagingDir: string,
  generationId: string,
  previewParent = STAGING_PREVIEW_PARENT,
): PreviewTarget {
  const prefix = buildPreviewPrefix(stagingDir);
  if (!isSafeGenerationId(generationId)) {
    throw new Error(`Invalid staging preview generation id: ${generationId}`);
  }
  const generationDir = join(
    previewParent,
    STAGING_PREVIEW_GENERATIONS_DIRNAME,
    prefix,
    generationId,
  );
  const outDir = join(generationDir, "client");
  return {
    prefix,
    stagingDir,
    basePath: `/staging/${prefix}/`,
    outDir,
    dataDir: join(generationDir, "data"),
    generationId,
    updatedAtMs: directoryMtimeMs(generationDir),
  };
}

function activePreviewManifestPath(prefix: string, previewParent: string): string {
  return join(previewParent, STAGING_PREVIEW_ACTIVE_DIRNAME, `${prefix}.json`);
}

export function publishPreviewGeneration(
  target: PreviewTarget,
  previewParent = STAGING_PREVIEW_PARENT,
): void {
  if (!target.generationId || !target.dataDir) {
    throw new Error(`Cannot publish legacy staging preview target: ${target.prefix}`);
  }
  if (!existsSync(join(target.outDir, "index.html"))) {
    throw new Error(`Staging preview generation is missing index.html: ${target.outDir}`);
  }
  if (!existsSync(join(target.dataDir, "bridge.db"))) {
    throw new Error(`Staging preview generation is missing bridge.db: ${target.dataDir}`);
  }

  const manifestPath = activePreviewManifestPath(target.prefix, previewParent);
  mkdirSync(join(previewParent, STAGING_PREVIEW_ACTIVE_DIRNAME), { recursive: true });
  const tempPath = `${manifestPath}.${process.pid}.${Date.now()}.tmp`;
  const manifest: ActivePreviewManifest = {
    version: 1,
    prefix: target.prefix,
    generationId: target.generationId,
    stagingDir: target.stagingDir,
    publishedAt: new Date().toISOString(),
  };
  try {
    writeFileSync(tempPath, JSON.stringify(manifest, null, 2), "utf8");
    renameSync(tempPath, manifestPath);
  } finally {
    rmSync(tempPath, { force: true });
  }
}

export function readActivePreviewTarget(
  prefix: string,
  previewParent = STAGING_PREVIEW_PARENT,
  stagingParent?: string,
): PreviewTarget | null {
  if (!parsePreviewPrefix(prefix)) return null;
  const manifestPath = activePreviewManifestPath(prefix, previewParent);
  if (!existsSync(manifestPath)) return null;

  try {
    const parsed = JSON.parse(readFileSync(manifestPath, "utf8")) as Partial<ActivePreviewManifest>;
    if (
      parsed.version !== 1
      || parsed.prefix !== prefix
      || typeof parsed.generationId !== "string"
      || !isSafeGenerationId(parsed.generationId)
      || typeof parsed.stagingDir !== "string"
      || buildPreviewPrefix(parsed.stagingDir) !== prefix
      || (
        stagingParent !== undefined
        && resolve(dirname(parsed.stagingDir)) !== resolve(stagingParent)
      )
    ) {
      return null;
    }
    const target = createPreviewGenerationTarget(
      parsed.stagingDir,
      parsed.generationId,
      previewParent,
    );
    if (
      !existsSync(join(target.outDir, "index.html"))
      || !target.dataDir
      || !existsSync(join(target.dataDir, "bridge.db"))
    ) {
      return null;
    }
    return {
      ...target,
      updatedAtMs: Math.max(
        directoryMtimeMs(manifestPath),
        directoryMtimeMs(dirname(target.outDir)),
      ),
    };
  } catch {
    return null;
  }
}

export function listActivePreviewTargets(
  previewParent = STAGING_PREVIEW_PARENT,
  stagingParent?: string,
): PreviewTarget[] {
  const activeDir = join(previewParent, STAGING_PREVIEW_ACTIVE_DIRNAME);
  if (!existsSync(activeDir)) return [];
  const targets: PreviewTarget[] = [];
  for (const entry of readdirSync(activeDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const prefix = entry.name.slice(0, -".json".length);
    const target = readActivePreviewTarget(prefix, previewParent, stagingParent);
    if (target) targets.push(target);
  }
  return targets;
}

export function removePreviewGeneration(target: PreviewTarget): void {
  if (!target.generationId) return;
  removeDirectoryWithRetries(dirname(target.outDir));
}

export function prunePreviewGenerations(
  prefix: string,
  keepGenerationId: string,
  previewParent = STAGING_PREVIEW_PARENT,
): number {
  const generationsDir = join(
    previewParent,
    STAGING_PREVIEW_GENERATIONS_DIRNAME,
    prefix,
  );
  if (!existsSync(generationsDir)) return 0;
  let removed = 0;
  for (const entry of readdirSync(generationsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name === keepGenerationId) continue;
    removeDirectoryWithRetries(join(generationsDir, entry.name));
    removed++;
  }
  return removed;
}

export function removePublishedPreview(
  prefix: string,
  previewParent = STAGING_PREVIEW_PARENT,
): void {
  rmSync(activePreviewManifestPath(prefix, previewParent), { force: true });
  const generationsDir = join(
    previewParent,
    STAGING_PREVIEW_GENERATIONS_DIRNAME,
    prefix,
  );
  if (existsSync(generationsDir)) removeDirectoryWithRetries(generationsDir);

  const legacyDistDir = join(previewParent, prefix);
  if (existsSync(legacyDistDir)) removeDirectoryWithRetries(legacyDistDir);
}

export function shouldManageStagingArtifacts(
  env: NodeJS.ProcessEnv = process.env,
  rootDir = PRODUCTION_ROOT,
): boolean {
  return isBridgeSourceManagementAvailable(env, rootDir);
}

export function directoryMtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

export function previewTargetLastActivityMs(target: PreviewTarget): number {
  return Math.max(
    target.updatedAtMs,
    directoryMtimeMs(target.outDir),
    target.dataDir ? directoryMtimeMs(target.dataDir) : 0,
    directoryMtimeMs(target.stagingDir),
  );
}

export function removePreviewData(dataDir: string): void {
  if (!statPathExists(dataDir)) return;
  if (!statPathExists(join(dataDir, "validation-logs"))) {
    removeDirectoryWithRetries(dataDir);
    return;
  }
  for (const entry of readdirSync(dataDir)) {
    if (entry === "validation-logs") continue;
    removeDirectoryWithRetries(join(dataDir, entry));
  }
}

export function removeDirectoryWithRetries(dir: string): void {
  rmSync(dir, {
    recursive: true,
    force: true,
    maxRetries: STAGING_ARTIFACT_CLEANUP_MAX_RETRIES,
    retryDelay: STAGING_ARTIFACT_CLEANUP_RETRY_DELAY_MS,
  });
}

function statPathExists(path: string): boolean {
  try {
    statSync(path);
    return true;
  } catch {
    return false;
  }
}
