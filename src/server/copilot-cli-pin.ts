// Bridge-owned Copilot CLI channel.
//
// Bridge always launches the exact Copilot CLI build pinned by the repo:
//
//   copilot-cli.lock.json   -> { source: "github-release", version, assets: { <platform>: { name, sha256 } } }
//   <cacheDir>/<version>/    -> the extracted release tarball (package/ contents),
//                              valid only once `.bridge-copilot-cli.json` exists
//
// The cache lives under the data dir (default `<dataDir>/copilot-cli`), outside
// node_modules and the release slots, so `npm install`, slot pruning, and the
// CLI's own self-updater cannot disturb it. Every consumer reads the lock from
// the code root it runs from (checkout, release slot, or staging worktree), so
// a pin travels with the commit that introduced it and rolls back with it.
//
// Resolution is fail-closed: a missing or broken pinned build is a startup
// error. Bridge never launches a CLI version other than the one the lock names.

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { fileURLToPath } from "node:url";

export const COPILOT_CLI_LOCK_FILENAME = "copilot-cli.lock.json";
export const BRIDGE_COPILOT_CLI_CACHE_DIR_ENV = "BRIDGE_COPILOT_CLI_CACHE_DIR";
/** Read by `copilot-cli-wrapper.js`: absolute directory holding app.js + index.js. */
export const BRIDGE_COPILOT_APP_DIR_ENV = "BRIDGE_COPILOT_APP_DIR";
export const PINNED_COPILOT_CLI_MARKER = ".bridge-copilot-cli.json";
export const COPILOT_CLI_RELEASE_REPO = "github/copilot-cli";

const COPILOT_CLI_CACHE_DIRNAME = "copilot-cli";
const RELEASE_TARBALL_ROOT = "package";
const DEFAULT_ENSURE_TIMEOUT_MS = 180_000;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const ASSET_NAME_PATTERN = /^[A-Za-z0-9._-]+\.tgz$/;
export const COPILOT_CLI_PLATFORM_KEYS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
  "linuxmusl-arm64",
  "linuxmusl-x64",
  "win32-arm64",
  "win32-x64",
] as const;
export type CopilotCliPlatformKey = typeof COPILOT_CLI_PLATFORM_KEYS[number];

const __dirname = dirname(fileURLToPath(import.meta.url));
/** Root of the code tree this module runs from (checkout, release slot, or worktree). */
export const COPILOT_CLI_CODE_ROOT = resolve(__dirname, "..", "..");

export interface CopilotCliLockAsset {
  name: string;
  sha256: string;
}

export interface CopilotCliLock {
  source: "github-release";
  version: string;
  assets: Partial<Record<CopilotCliPlatformKey, CopilotCliLockAsset>>;
}

export class CopilotCliLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CopilotCliLockError";
  }
}

export interface PinnedCopilotCliMarker {
  version: string;
  asset: string;
  sha256: string;
  installedAt: string;
}

/** The pinned CLI build a launch uses. */
export interface CopilotCliResolution {
  version: string;
  /** Directory holding app.js/index.js. */
  appDir: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isCopilotCliPlatformKey(value: unknown): value is CopilotCliPlatformKey {
  return typeof value === "string" && (COPILOT_CLI_PLATFORM_KEYS as readonly string[]).includes(value);
}

export function resolveCopilotCliCacheDir(
  env: NodeJS.ProcessEnv,
  dataDir: string,
): string {
  const configured = env[BRIDGE_COPILOT_CLI_CACHE_DIR_ENV]?.trim();
  return configured ? resolve(configured) : join(dataDir, COPILOT_CLI_CACHE_DIRNAME);
}

export function getCopilotCliPlatformKey(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  options: { musl?: boolean } = {},
): CopilotCliPlatformKey {
  const variant = platform === "linux" && options.musl ? "linuxmusl" : platform;
  const key = `${variant}-${arch}`;
  if (!isCopilotCliPlatformKey(key)) {
    throw new CopilotCliLockError(`Unsupported Copilot CLI platform ${key}`);
  }
  return key;
}

export function parseCopilotCliLock(text: string): CopilotCliLock {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new CopilotCliLockError(`${COPILOT_CLI_LOCK_FILENAME} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(raw)) throw new CopilotCliLockError(`${COPILOT_CLI_LOCK_FILENAME} must be a JSON object`);
  if (raw.source !== "github-release") {
    throw new CopilotCliLockError(`${COPILOT_CLI_LOCK_FILENAME} source must be "github-release"`);
  }
  if (typeof raw.version !== "string" || !VERSION_PATTERN.test(raw.version)) {
    throw new CopilotCliLockError(`${COPILOT_CLI_LOCK_FILENAME} version must be a semver string like 1.0.81-6`);
  }
  if (!isRecord(raw.assets) || Object.keys(raw.assets).length === 0) {
    throw new CopilotCliLockError(`${COPILOT_CLI_LOCK_FILENAME} assets must map platform keys to { name, sha256 }`);
  }
  const assets: Partial<Record<CopilotCliPlatformKey, CopilotCliLockAsset>> = {};
  for (const [key, value] of Object.entries(raw.assets)) {
    if (!isCopilotCliPlatformKey(key)) {
      throw new CopilotCliLockError(`${COPILOT_CLI_LOCK_FILENAME} has unknown platform key "${key}"`);
    }
    if (!isRecord(value) || typeof value.name !== "string" || !ASSET_NAME_PATTERN.test(value.name)) {
      throw new CopilotCliLockError(`${COPILOT_CLI_LOCK_FILENAME} asset "${key}" needs a .tgz name`);
    }
    if (typeof value.sha256 !== "string" || !SHA256_PATTERN.test(value.sha256)) {
      throw new CopilotCliLockError(`${COPILOT_CLI_LOCK_FILENAME} asset "${key}" needs a lowercase hex sha256`);
    }
    assets[key] = { name: value.name, sha256: value.sha256 };
  }
  return { source: "github-release", version: raw.version, assets };
}

/** The lock is committed with the code; a missing or invalid lock throws. */
export function readCopilotCliLock(rootDir: string = COPILOT_CLI_CODE_ROOT): CopilotCliLock {
  const path = join(rootDir, COPILOT_CLI_LOCK_FILENAME);
  if (!existsSync(path)) throw new CopilotCliLockError(`${COPILOT_CLI_LOCK_FILENAME} is missing from ${rootDir}`);
  return parseCopilotCliLock(readFileSync(path, "utf-8"));
}

export function getPinnedCopilotCliDir(cacheDir: string, version: string): string {
  if (!VERSION_PATTERN.test(version)) throw new CopilotCliLockError(`Invalid Copilot CLI version "${version}"`);
  return join(cacheDir, version);
}

export function readPinnedCopilotCliMarker(appDir: string): PinnedCopilotCliMarker | null {
  const path = join(appDir, PINNED_COPILOT_CLI_MARKER);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (
      !isRecord(raw)
      || typeof raw.version !== "string"
      || typeof raw.asset !== "string"
      || typeof raw.sha256 !== "string"
      || typeof raw.installedAt !== "string"
    ) {
      return null;
    }
    return { version: raw.version, asset: raw.asset, sha256: raw.sha256, installedAt: raw.installedAt };
  } catch {
    return null;
  }
}

function readPackageVersion(dir: string): string | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as unknown;
    return isRecord(parsed) && typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

/** A pinned directory is usable only when fully extracted, marked, and version-consistent. */
export function checkPinnedCopilotCliDir(
  appDir: string,
  expectedVersion: string,
): { ready: true } | { ready: false; reason: string } {
  if (!existsSync(appDir)) return { ready: false, reason: "not downloaded" };
  const marker = readPinnedCopilotCliMarker(appDir);
  if (!marker) return { ready: false, reason: "extraction incomplete (no marker)" };
  if (marker.version !== expectedVersion) {
    return { ready: false, reason: `marker version ${marker.version} does not match ${expectedVersion}` };
  }
  for (const file of ["app.js", "index.js"]) {
    if (!existsSync(join(appDir, file))) return { ready: false, reason: `${file} missing` };
  }
  const packageVersion = readPackageVersion(appDir);
  if (packageVersion !== expectedVersion) {
    return { ready: false, reason: `package.json version ${packageVersion ?? "unknown"} does not match ${expectedVersion}` };
  }
  return { ready: true };
}

/**
 * Synchronous launch-time decision used by `buildCopilotClientOptions`. Never
 * touches the network: the build must already be in the cache, otherwise this
 * throws with the reason.
 */
export function resolveCopilotCliForLaunch(options: {
  rootDir?: string;
  cacheDir: string;
  platformKey?: CopilotCliPlatformKey;
}): CopilotCliResolution {
  const lock = readCopilotCliLock(options.rootDir ?? COPILOT_CLI_CODE_ROOT);
  const platformKey = options.platformKey ?? getCopilotCliPlatformKey();
  if (!lock.assets[platformKey]) {
    throw new CopilotCliLockError(`${COPILOT_CLI_LOCK_FILENAME} has no asset for ${platformKey}`);
  }
  const appDir = getPinnedCopilotCliDir(options.cacheDir, lock.version);
  const check = checkPinnedCopilotCliDir(appDir, lock.version);
  if (!check.ready) {
    throw new Error(`pinned Copilot CLI ${lock.version} is not ready at ${appDir}: ${check.reason}`);
  }
  return { version: lock.version, appDir };
}

export function getCopilotCliReleaseAssetUrl(version: string, assetName: string): string {
  return `https://github.com/${COPILOT_CLI_RELEASE_REPO}/releases/download/v${version}/${assetName}`;
}

export type CopilotCliDownloader = (url: string, signal: AbortSignal) => Promise<Readable>;

async function defaultDownloader(url: string, signal: AbortSignal): Promise<Readable> {
  const response = await fetch(url, { redirect: "follow", signal });
  if (!response.ok || !response.body) {
    throw new Error(`download failed: HTTP ${response.status} ${response.statusText}`);
  }
  return Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
}

export type CopilotCliExtractor = (tarball: string, targetDir: string, signal: AbortSignal) => Promise<void>;

/** System tar (bsdtar on Windows 10+, GNU/bsd tar elsewhere) keeps the dependency surface flat. */
async function defaultExtractor(tarball: string, targetDir: string, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolvePromise, reject) => {
    execFile("tar", ["-xzf", tarball, "-C", targetDir], { signal, windowsHide: true }, (error, _stdout, stderr) => {
      if (error) {
        const detail = typeof stderr === "string" && stderr.trim() ? `: ${stderr.trim().slice(-400)}` : "";
        reject(new Error(`tar extraction failed (${error.message})${detail}`));
        return;
      }
      resolvePromise();
    });
  });
}

async function downloadToFile(
  url: string,
  destination: string,
  downloader: CopilotCliDownloader,
  signal: AbortSignal,
): Promise<string> {
  const hash = createHash("sha256");
  const hashing = new Transform({
    transform(chunk, _encoding, callback) {
      hash.update(chunk as Buffer);
      callback(null, chunk);
    },
  });
  const source = await downloader(url, signal);
  await pipeline(source, hashing, createWriteStream(destination), { signal });
  return hash.digest("hex");
}

function removeQuietly(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  } catch {
    // Leftovers are swept by the next ensure run.
  }
}

export interface EnsurePinnedCopilotCliOptions {
  rootDir?: string;
  cacheDir: string;
  platformKey?: CopilotCliPlatformKey;
  log?: (message: string) => void;
  timeoutMs?: number;
  downloader?: CopilotCliDownloader;
  extractor?: CopilotCliExtractor;
  now?: () => Date;
}

const inflightEnsures = new Map<string, Promise<CopilotCliResolution>>();
let lastEnsureResult: CopilotCliResolution | null = null;

/** Result of the most recent `ensurePinnedCopilotCli` in this process, for health reporting. */
export function getCopilotCliRuntimeStatus(): CopilotCliResolution | null {
  return lastEnsureResult;
}

/** Test hook. */
export function resetCopilotCliRuntimeStatusForTests(): void {
  lastEnsureResult = null;
  inflightEnsures.clear();
}

/**
 * Make the lock's pinned build available in the cache (download + verify +
 * extract) and return the launch resolution. Idempotent and safe to run from
 * several processes at once: each process extracts into its own temp dir and
 * the first rename into place wins. Throws when the build cannot be made ready.
 */
export async function ensurePinnedCopilotCli(options: EnsurePinnedCopilotCliOptions): Promise<CopilotCliResolution> {
  const rootDir = options.rootDir ?? COPILOT_CLI_CODE_ROOT;
  const key = `${rootDir}\0${options.cacheDir}`;
  const existing = inflightEnsures.get(key);
  if (existing) return existing;
  const run = ensurePinnedCopilotCliOnce({ ...options, rootDir })
    .then((result) => {
      lastEnsureResult = result;
      return result;
    })
    .finally(() => {
      if (inflightEnsures.get(key) === run) inflightEnsures.delete(key);
    });
  inflightEnsures.set(key, run);
  return run;
}

async function ensurePinnedCopilotCliOnce(
  options: EnsurePinnedCopilotCliOptions & { rootDir: string },
): Promise<CopilotCliResolution> {
  const log = options.log ?? (() => {});
  const lock = readCopilotCliLock(options.rootDir);
  const platformKey = options.platformKey ?? getCopilotCliPlatformKey();
  const asset = lock.assets[platformKey];
  if (!asset) throw new CopilotCliLockError(`${COPILOT_CLI_LOCK_FILENAME} has no asset for ${platformKey}`);

  const appDir = getPinnedCopilotCliDir(options.cacheDir, lock.version);
  if (checkPinnedCopilotCliDir(appDir, lock.version).ready) {
    return { version: lock.version, appDir };
  }

  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_ENSURE_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs);
  const workRoot = join(options.cacheDir, `.work-${lock.version}-${process.pid}-${Date.now()}`);
  const tarballPath = join(workRoot, asset.name);
  const extractDir = join(workRoot, "extract");
  try {
    mkdirSync(extractDir, { recursive: true });
    const url = getCopilotCliReleaseAssetUrl(lock.version, asset.name);
    log(`Downloading pinned Copilot CLI ${lock.version} (${asset.name})...`);
    const digest = await downloadToFile(url, tarballPath, options.downloader ?? defaultDownloader, controller.signal);
    if (digest !== asset.sha256) {
      throw new Error(`sha256 mismatch for ${asset.name}: expected ${asset.sha256}, got ${digest}`);
    }
    log(`Verified ${asset.name} sha256; extracting...`);
    await (options.extractor ?? defaultExtractor)(tarballPath, extractDir, controller.signal);
    const extractedRoot = join(extractDir, RELEASE_TARBALL_ROOT);
    const extractedVersion = readPackageVersion(extractedRoot);
    if (extractedVersion !== lock.version) {
      throw new Error(`extracted package.json version ${extractedVersion ?? "unknown"} does not match ${lock.version}`);
    }
    for (const file of ["app.js", "index.js"]) {
      if (!existsSync(join(extractedRoot, file))) throw new Error(`extracted tarball is missing ${file}`);
    }
    const marker: PinnedCopilotCliMarker = {
      version: lock.version,
      asset: asset.name,
      sha256: asset.sha256,
      installedAt: (options.now ?? (() => new Date()))().toISOString(),
    };
    writeFileSync(join(extractedRoot, PINNED_COPILOT_CLI_MARKER), `${JSON.stringify(marker, null, 2)}\n`);
    mkdirSync(dirname(appDir), { recursive: true });
    try {
      renameSync(extractedRoot, appDir);
    } catch (error) {
      // Another process may have installed the same version first.
      const check = checkPinnedCopilotCliDir(appDir, lock.version);
      if (!check.ready) throw error;
    }
    log(`Pinned Copilot CLI ${lock.version} ready at ${appDir}`);
    return { version: lock.version, appDir };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`pinned Copilot CLI ${lock.version} unavailable: ${reason}`, { cause: error });
  } finally {
    clearTimeout(timer);
    removeQuietly(workRoot);
  }
}

/**
 * Remove leftover work dirs and, optionally, cached versions that are neither
 * referenced by `keepVersions` nor newer than `minAgeMs`. Returns removed paths.
 */
export function prunePinnedCopilotCliCache(
  cacheDir: string,
  options: { keepVersions?: Iterable<string>; minAgeMs?: number; now?: () => number } = {},
): string[] {
  if (!existsSync(cacheDir)) return [];
  const keep = new Set(options.keepVersions ?? []);
  const now = (options.now ?? Date.now)();
  const removed: string[] = [];
  for (const entry of readdirSync(cacheDir, { withFileTypes: true })) {
    const path = join(cacheDir, entry.name);
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".work-")) {
      let stale = true;
      try {
        stale = now - statSync(path).mtimeMs > 60 * 60_000;
      } catch {
        stale = true;
      }
      if (stale) {
        removeQuietly(path);
        removed.push(path);
      }
      continue;
    }
    if (options.minAgeMs === undefined || keep.has(entry.name)) continue;
    const marker = readPinnedCopilotCliMarker(path);
    const installedAtMs = marker ? Date.parse(marker.installedAt) : Number.NaN;
    if (!Number.isFinite(installedAtMs) || now - installedAtMs >= options.minAgeMs) {
      removeQuietly(path);
      removed.push(path);
    }
  }
  return removed;
}

export function describeCopilotCliResolution(resolution: CopilotCliResolution): string {
  return `pinned ${resolution.version} (${resolution.appDir})`;
}
