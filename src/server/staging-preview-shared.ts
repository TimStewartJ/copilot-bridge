import { readdirSync, rmSync, statSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isBridgeReleaseMode } from "./distribution-mode.js";
import { resolveBridgeControlRoot } from "./control-root.js";
import { resolveRuntimePaths } from "./runtime-paths.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const PRODUCTION_ROOT = resolveBridgeControlRoot(join(__dirname, "..", ".."));
export const STAGING_PARENT = join(PRODUCTION_ROOT, "..", "bridge-staging");
export const PRODUCTION_RUNTIME_PATHS = resolveRuntimePaths(process.env);
export const PRODUCTION_DATA_DIR = PRODUCTION_RUNTIME_PATHS.dataDir;
export const SIGNAL_FILE = join(PRODUCTION_DATA_DIR, "restart.signal");
export const PRE_DEPLOY_SHA_FILE = join(PRODUCTION_DATA_DIR, "pre-deploy-sha");
export const LEGACY_STAGING_DIST_PARENT = join(PRODUCTION_ROOT, "dist", "staging");
export const STAGING_PREVIEW_DIR_ENV = "BRIDGE_STAGING_PREVIEW_DIR";
export const FAILURE_DETAIL_OUTPUT_LIMIT = 500;
export const FAILURE_SESSION_LOG_OUTPUT_LIMIT = 4_000;
export const DEFAULT_COMMAND_TIMEOUT_MS = 120_000;
export const COMMAND_OUTPUT_CAPTURE_LIMIT = 1024 * 1024;
export const STAGING_INSTALL_COMMAND = "npm install --no-audit --no-fund --include=dev";
export const STAGING_INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
export const STAGING_PREVIEW_MODEL = "claude-haiku-4.5";
export const STAGING_BACKEND_STARTUP_TIMEOUT_MS = 30_000;
export const STAGING_BACKEND_SHUTDOWN_TIMEOUT_MS = 5_000;
export const STAGING_BACKEND_PROCESS_TREE_EXIT_TIMEOUT_MS = 1_000;
export const STAGING_BACKEND_REQUEST_START_WAIT_MS = 2_000;
export const STAGING_BACKEND_FAILURE_BACKOFF_BASE_MS = 30_000;
export const STAGING_BACKEND_FAILURE_BACKOFF_MAX_MS = 5 * 60_000;
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

export type StagingPreviewProfile = "clone";

export interface PreviewTarget {
  prefix: string;
  profile: StagingPreviewProfile;
  stagingDir: string;
  basePath: string;
  outDir: string;
  updatedAtMs: number;
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
  return uniqueResolvedPaths([STAGING_PREVIEW_PARENT, LEGACY_STAGING_DIST_PARENT]);
}

export function resolvePreviewProfile(_value?: string): StagingPreviewProfile {
  return "clone";
}

export function buildPreviewPrefix(stagingDir: string, _profile: StagingPreviewProfile = "clone"): string {
  return basename(stagingDir);
}

export function parsePreviewPrefix(
  prefix: string,
  activeWorktrees?: ReadonlySet<string>,
): { stagingName: string; profile: StagingPreviewProfile } | null {
  if (!isSafePreviewPrefix(prefix)) {
    return null;
  }

  if (activeWorktrees?.has(prefix)) {
    return { stagingName: prefix, profile: "clone" };
  }

  if (activeWorktrees && !activeWorktrees.has(prefix)) {
    return null;
  }

  return { stagingName: prefix, profile: "clone" };
}

function isSafePreviewPrefix(prefix: string): boolean {
  return /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9_-])?$/.test(prefix) && !prefix.includes("..");
}

export function escapeSqliteStringLiteral(value: string): string {
  return value.replaceAll("'", "''");
}

export function createPreviewTarget(stagingDir: string, profile: StagingPreviewProfile = "clone"): PreviewTarget {
  const prefix = buildPreviewPrefix(stagingDir, profile);
  const outDir = join(STAGING_PREVIEW_PARENT, prefix);
  return {
    prefix,
    profile,
    stagingDir,
    basePath: `/staging/${prefix}/`,
    outDir,
    updatedAtMs: directoryMtimeMs(outDir),
  };
}

export function listPreviewTargetsForStagingDir(stagingDir: string): PreviewTarget[] {
  return [createPreviewTarget(stagingDir)];
}

export function shouldManageStagingArtifacts(): boolean {
  return !isBridgeReleaseMode(process.env, PRODUCTION_ROOT);
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
