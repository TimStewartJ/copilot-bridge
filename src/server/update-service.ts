import { createPublicKey, randomUUID, verify } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RuntimePaths } from "./runtime-paths.js";

export type UpdateChannel = "stable" | "preview";
export type UpdateCheckStatus =
  | "disabled"
  | "not_configured"
  | "error"
  | "up_to_date"
  | "update_available";

export interface CurrentUpdateInfo {
  version: string;
  channel: string;
  platform: string;
  sourceCommit?: string;
  distributionMode: string;
}

export interface UpdatePackageInfo {
  name: string;
  url: string;
  sha256: string;
  sizeBytes: number;
}

export interface UpdateManifest {
  schemaVersion: 1;
  appId: "copilot-bridge";
  keyId?: string;
  version: string;
  channel: UpdateChannel;
  platform: string;
  sourceCommit: string;
  publishedAt: string;
  releaseUrl?: string;
  releaseNotesUrl?: string;
  package: UpdatePackageInfo;
}

export interface UpdateCheckResponse {
  status: UpdateCheckStatus;
  configured: boolean;
  enabled: boolean;
  channel: UpdateChannel;
  manifestUrl?: string;
  signatureUrl?: string;
  current: CurrentUpdateInfo;
  update?: UpdateManifest;
  checkedAt: string;
  error?: string;
}

export type UpdateInstallPhase =
  | "started"
  | "downloading"
  | "verifying"
  | "staging"
  | "stopping"
  | "installing"
  | "starting"
  | "succeeded"
  | "failed";

export interface UpdateInstallStatus {
  id: string;
  phase: UpdateInstallPhase;
  channel: UpdateChannel;
  fromVersion: string;
  toVersion: string;
  sourceCommit?: string;
  packageUrl: string;
  packageSha256: string;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
  rollbackAttempted?: boolean;
  logPath?: string;
}

export interface UpdateInstallStatusResponse {
  status: UpdateInstallStatus | null;
}

export interface UpdateInstallStartResponse {
  status: "started";
  install: UpdateInstallStatus;
}

export interface CheckForUpdateOptions {
  channel?: UpdateChannel;
  env?: NodeJS.ProcessEnv;
  runtimePaths?: RuntimePaths;
  appRoot?: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  timeoutMs?: number;
  maxManifestBytes?: number;
}

export interface StartUpdateInstallOptions extends CheckForUpdateOptions {
  spawnImpl?: SpawnImpl;
  powerShellCommand?: string;
}

type SpawnImpl = (command: string, args: string[], options: Parameters<typeof spawn>[2]) => ChildProcess;

export class UpdateInstallError extends Error {
  constructor(message: string, readonly statusCode = 409) {
    super(message);
    this.name = "UpdateInstallError";
  }
}

const DEFAULT_REPOSITORY = "timstewartj/copilot-bridge";
const DEFAULT_PLATFORM = process.platform === "win32" && process.arch === "x64" ? "win-x64" : `${process.platform}-${process.arch}`;
const DEFAULT_FETCH_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_MANIFEST_BYTES = 64 * 1024;
const ACTIVE_INSTALL_STALE_MS = 30 * 60 * 1000;

function getInstalledAppRoot(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return join(moduleDir, "..", "..");
}

function readJsonFile(path: string): any | null {
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJsonFile(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function assertUpdateChannel(value: string | undefined): UpdateChannel {
  if (value === "preview" || value === "stable") return value;
  if (!value) return "stable";
  throw new Error(`Unsupported update channel "${value}". Expected "stable" or "preview".`);
}

function getUpdateStatusPath(runtimePaths: RuntimePaths): string {
  return join(runtimePaths.dataDir, "update-status.json");
}

function getUpdateLogPath(runtimePaths: RuntimePaths, installId: string): string {
  return join(runtimePaths.dataDir, "logs", `update-${installId}.log`);
}

export function readUpdateInstallStatus(options: { runtimePaths: RuntimePaths }): UpdateInstallStatusResponse {
  const statusPath = getUpdateStatusPath(options.runtimePaths);
  if (!existsSync(statusPath)) {
    return { status: null };
  }
  return { status: readJsonFile(statusPath) as UpdateInstallStatus };
}

function writeUpdateInstallStatus(runtimePaths: RuntimePaths, status: UpdateInstallStatus): void {
  writeJsonFile(getUpdateStatusPath(runtimePaths), status);
}

export function resolveCurrentUpdateInfo(options: CheckForUpdateOptions = {}): CurrentUpdateInfo {
  const env = options.env ?? process.env;
  const appRoot = options.appRoot ?? getInstalledAppRoot();
  const releaseManifest = readJsonFile(join(appRoot, ".bridge-release.json"));
  const packageJson = readJsonFile(join(appRoot, "package.json"));
  const distributionMode = options.runtimePaths?.distributionMode ?? env.BRIDGE_DISTRIBUTION_MODE ?? "development";
  const channel = env.BRIDGE_UPDATE_CHANNEL
    ?? stringValue(releaseManifest?.channel)
    ?? (distributionMode === "release" ? "stable" : "development");

  return {
    version: env.BRIDGE_APP_VERSION
      ?? stringValue(releaseManifest?.version)
      ?? stringValue(packageJson?.version)
      ?? "unknown",
    channel,
    platform: stringValue(releaseManifest?.platform) ?? DEFAULT_PLATFORM,
    sourceCommit: stringValue(releaseManifest?.sourceCommit),
    distributionMode,
  };
}

function readTrustedPublicKeyPem(env: NodeJS.ProcessEnv, appRoot: string): string | undefined {
  if (env.BRIDGE_UPDATE_MANIFEST_PUBLIC_KEY_PEM?.trim()) {
    return env.BRIDGE_UPDATE_MANIFEST_PUBLIC_KEY_PEM;
  }
  if (env.BRIDGE_UPDATE_MANIFEST_PUBLIC_KEY_BASE64?.trim()) {
    return Buffer.from(env.BRIDGE_UPDATE_MANIFEST_PUBLIC_KEY_BASE64.trim(), "base64").toString("utf8");
  }
  if (env.BRIDGE_UPDATE_MANIFEST_PUBLIC_KEY_PATH?.trim()) {
    return readFileSync(env.BRIDGE_UPDATE_MANIFEST_PUBLIC_KEY_PATH.trim(), "utf8");
  }
  const packagedKeyPath = join(appRoot, "update-manifest-public-key.pem");
  if (existsSync(packagedKeyPath)) {
    return readFileSync(packagedKeyPath, "utf8");
  }
  return undefined;
}

function defaultManifestUrl(channel: UpdateChannel, platform: string): string {
  if (channel === "preview") {
    return `https://github.com/${DEFAULT_REPOSITORY}/releases/download/latest-preview/preview-${platform}.manifest.json`;
  }
  return `https://github.com/${DEFAULT_REPOSITORY}/releases/latest/download/stable-${platform}.manifest.json`;
}

function envNameFor(channel: UpdateChannel, suffix: string): string {
  return `BRIDGE_UPDATE_MANIFEST_${channel.toUpperCase()}_${suffix}`;
}

function requireHttpsUrl(label: string, value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:") {
    throw new Error(`${label} must be an HTTPS URL.`);
  }
  return url.toString();
}

function resolveManifestUrls(env: NodeJS.ProcessEnv, channel: UpdateChannel, platform: string) {
  const manifestUrl = env[envNameFor(channel, "URL")] ?? defaultManifestUrl(channel, platform);
  const signatureUrl = env[envNameFor(channel, "SIGNATURE_URL")] ?? `${manifestUrl}.sig`;
  return {
    manifestUrl: requireHttpsUrl("Update manifest URL", manifestUrl),
    signatureUrl: requireHttpsUrl("Update manifest signature URL", signatureUrl),
  };
}

async function fetchTextWithLimit(
  fetchImpl: typeof fetch,
  url: string,
  timeoutMs: number,
  maxBytes: number,
): Promise<string> {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) {
    throw new Error(`Fetch failed for ${url}: ${response.status} ${response.statusText}`);
  }
  if (response.url) {
    requireHttpsUrl("Update manifest response URL", response.url);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (buffer.byteLength > maxBytes) {
    throw new Error(`Fetch failed for ${url}: response exceeded ${maxBytes} bytes.`);
  }
  return buffer.toString("utf8");
}

function parseSignature(signatureText: string): Buffer {
  const trimmed = signatureText.trim();
  if (!trimmed) {
    throw new Error("Update manifest signature is empty.");
  }
  return Buffer.from(trimmed, "base64");
}

function verifyManifestSignature(manifestText: string, signatureText: string, publicKeyPem: string): void {
  const ok = verify(
    null,
    Buffer.from(manifestText, "utf8"),
    createPublicKey(publicKeyPem),
    parseSignature(signatureText),
  );
  if (!ok) {
    throw new Error("Update manifest signature verification failed.");
  }
}

function validateSha256(value: unknown): string {
  const sha = stringValue(value);
  if (!sha || !/^[a-f0-9]{64}$/i.test(sha)) {
    throw new Error("Update manifest package SHA256 is invalid.");
  }
  return sha.toLowerCase();
}

function validateManifest(raw: unknown, expected: { channel: UpdateChannel; platform: string }): UpdateManifest {
  if (typeof raw !== "object" || raw === null) {
    throw new Error("Update manifest must be an object.");
  }
  const manifest = raw as Record<string, any>;
  if (manifest.schemaVersion !== 1) throw new Error("Unsupported update manifest schemaVersion.");
  if (manifest.appId !== "copilot-bridge") throw new Error("Update manifest appId does not match.");
  if (manifest.channel !== expected.channel) throw new Error("Update manifest channel does not match.");
  if (manifest.platform !== expected.platform) throw new Error("Update manifest platform does not match.");
  if (typeof manifest.package !== "object" || manifest.package === null) {
    throw new Error("Update manifest package is missing.");
  }

  const packageInfo = manifest.package as Record<string, unknown>;
  const packageUrl = requireHttpsUrl("Update package URL", stringValue(packageInfo.url) ?? "");
  const releaseUrl = manifest.releaseUrl ? requireHttpsUrl("Release URL", String(manifest.releaseUrl)) : undefined;
  const releaseNotesUrl = manifest.releaseNotesUrl
    ? requireHttpsUrl("Release notes URL", String(manifest.releaseNotesUrl))
    : undefined;

  return {
    schemaVersion: 1,
    appId: "copilot-bridge",
    keyId: stringValue(manifest.keyId),
    version: stringValue(manifest.version) ?? fail("Update manifest version is missing."),
    channel: expected.channel,
    platform: expected.platform,
    sourceCommit: stringValue(manifest.sourceCommit) ?? fail("Update manifest sourceCommit is missing."),
    publishedAt: stringValue(manifest.publishedAt) ?? fail("Update manifest publishedAt is missing."),
    ...(releaseUrl ? { releaseUrl } : {}),
    ...(releaseNotesUrl ? { releaseNotesUrl } : {}),
    package: {
      name: stringValue(packageInfo.name) ?? fail("Update manifest package name is missing."),
      url: packageUrl,
      sha256: validateSha256(packageInfo.sha256),
      sizeBytes: typeof packageInfo.sizeBytes === "number" && packageInfo.sizeBytes > 0
        ? packageInfo.sizeBytes
        : fail("Update manifest package sizeBytes is invalid."),
    },
  };
}

function fail(message: string): never {
  throw new Error(message);
}

interface ParsedVersion {
  major: number;
  minor: number;
  patch: number;
  prerelease: string[];
}

function parseVersion(value: string): ParsedVersion | null {
  const match = value.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4]?.split(".") ?? [],
  };
}

function compareIdentifier(left: string, right: string): number {
  const leftNumber = /^\d+$/.test(left) ? Number(left) : null;
  const rightNumber = /^\d+$/.test(right) ? Number(right) : null;
  if (leftNumber !== null && rightNumber !== null) return leftNumber - rightNumber;
  if (leftNumber !== null) return -1;
  if (rightNumber !== null) return 1;
  return left.localeCompare(right);
}

export function compareVersions(left: string, right: string): number {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a && !b) return left.localeCompare(right);
  if (!a) return -1;
  if (!b) return 1;
  for (const key of ["major", "minor", "patch"] as const) {
    if (a[key] !== b[key]) return a[key] - b[key];
  }
  if (a.prerelease.length === 0 && b.prerelease.length === 0) return 0;
  if (a.prerelease.length === 0) return 1;
  if (b.prerelease.length === 0) return -1;
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < length; i += 1) {
    const leftId = a.prerelease[i];
    const rightId = b.prerelease[i];
    if (leftId === undefined) return -1;
    if (rightId === undefined) return 1;
    const result = compareIdentifier(leftId, rightId);
    if (result !== 0) return result;
  }
  return 0;
}

export async function checkForUpdate(options: CheckForUpdateOptions = {}): Promise<UpdateCheckResponse> {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date());
  const appRoot = options.appRoot ?? getInstalledAppRoot();
  const current = resolveCurrentUpdateInfo({ ...options, env, appRoot });
  const channel = options.channel ?? assertUpdateChannel(env.BRIDGE_UPDATE_CHANNEL);
  const checkedAt = now().toISOString();

  if (current.distributionMode !== "release") {
    return {
      status: "disabled",
      configured: false,
      enabled: false,
      channel,
      current,
      checkedAt,
      error: "Update checks are available only in packaged release mode.",
    };
  }

  let manifestUrl: string;
  let signatureUrl: string;
  let publicKeyPem: string | undefined;
  try {
    ({ manifestUrl, signatureUrl } = resolveManifestUrls(env, channel, current.platform));
    publicKeyPem = readTrustedPublicKeyPem(env, appRoot);
  } catch (error) {
    return {
      status: "not_configured",
      configured: false,
      enabled: false,
      channel,
      current,
      checkedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  if (!publicKeyPem) {
    return {
      status: "not_configured",
      configured: false,
      enabled: false,
      channel,
      manifestUrl,
      signatureUrl,
      current,
      checkedAt,
      error: "Update manifest public key is not configured.",
    };
  }

  try {
    const fetchImpl = options.fetchImpl ?? fetch;
    const timeoutMs = options.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
    const maxManifestBytes = options.maxManifestBytes ?? DEFAULT_MAX_MANIFEST_BYTES;
    const [manifestText, signatureText] = await Promise.all([
      fetchTextWithLimit(fetchImpl, manifestUrl, timeoutMs, maxManifestBytes),
      fetchTextWithLimit(fetchImpl, signatureUrl, timeoutMs, 8 * 1024),
    ]);
    verifyManifestSignature(manifestText, signatureText, publicKeyPem);
    const manifest = validateManifest(JSON.parse(manifestText), { channel, platform: current.platform });
    const hasUpdate = compareVersions(manifest.version, current.version) > 0;
    return {
      status: hasUpdate ? "update_available" : "up_to_date",
      configured: true,
      enabled: true,
      channel,
      manifestUrl,
      signatureUrl,
      current,
      checkedAt,
      ...(hasUpdate ? { update: manifest } : {}),
    };
  } catch (error) {
    return {
      status: "error",
      configured: true,
      enabled: true,
      channel,
      manifestUrl,
      signatureUrl,
      current,
      checkedAt,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

function isActiveInstall(status: UpdateInstallStatus | null, now: Date): boolean {
  if (!status) return false;
  if (status.phase === "succeeded" || status.phase === "failed") return false;
  const updatedAt = new Date(status.updatedAt).getTime();
  if (!Number.isFinite(updatedAt)) return true;
  return now.getTime() - updatedAt < ACTIVE_INSTALL_STALE_MS;
}

function resolvePowerShellCommand(env: NodeJS.ProcessEnv, explicit?: string): string {
  const configured = explicit ?? stringValue(env.BRIDGE_UPDATE_POWERSHELL_PATH);
  if (configured) return configured;
  return process.platform === "win32" ? "pwsh.exe" : "pwsh";
}

function releaseStateRootArg(env: NodeJS.ProcessEnv, runtimePaths: RuntimePaths): string | undefined {
  const explicit = stringValue(env.BRIDGE_STATE_ROOT);
  if (explicit) return explicit;
  return basename(runtimePaths.dataDir).toLowerCase() === "data" ? dirname(runtimePaths.dataDir) : undefined;
}

function openUpdateLog(logPath: string): { stdoutFd: number; stderrFd: number; close: () => void } {
  mkdirSync(dirname(logPath), { recursive: true });
  const stdoutFd = openSync(logPath, "a");
  const stderrFd = openSync(logPath, "a");
  return {
    stdoutFd,
    stderrFd,
    close: () => {
      closeSync(stdoutFd);
      closeSync(stderrFd);
    },
  };
}

export async function startUpdateInstall(options: StartUpdateInstallOptions): Promise<UpdateInstallStartResponse> {
  const env = options.env ?? process.env;
  const runtimePaths = options.runtimePaths ?? fail("runtimePaths is required to install updates.");
  const now = options.now ?? (() => new Date());
  const appRoot = options.appRoot ?? getInstalledAppRoot();
  const current = resolveCurrentUpdateInfo({ ...options, env, appRoot, runtimePaths });
  const channel = options.channel ?? assertUpdateChannel(env.BRIDGE_UPDATE_CHANNEL);
  const timestamp = now().toISOString();

  if (current.distributionMode !== "release") {
    throw new UpdateInstallError("Update installation is available only in packaged release mode.");
  }
  if (current.platform !== "win-x64") {
    throw new UpdateInstallError(`Update installation is not supported for platform "${current.platform}".`);
  }

  const existing = readUpdateInstallStatus({ runtimePaths }).status;
  if (isActiveInstall(existing, now())) {
    throw new UpdateInstallError(`Update installation is already in progress for ${existing?.toVersion ?? "another version"}.`);
  }

  const check = await checkForUpdate({ ...options, env, runtimePaths, appRoot, channel });
  if (check.status !== "update_available" || !check.update) {
    throw new UpdateInstallError(check.error ?? `No newer ${channel} update is available.`);
  }

  const releaseRoot = dirname(appRoot);
  const updateScript = join(releaseRoot, "update.ps1");
  if (!existsSync(updateScript)) {
    throw new UpdateInstallError(`Packaged update script was not found at ${updateScript}.`);
  }

  const installId = randomUUID();
  const logPath = getUpdateLogPath(runtimePaths, installId);
  const installStatus: UpdateInstallStatus = {
    id: installId,
    phase: "started",
    channel,
    fromVersion: current.version,
    toVersion: check.update.version,
    sourceCommit: check.update.sourceCommit,
    packageUrl: check.update.package.url,
    packageSha256: check.update.package.sha256,
    startedAt: timestamp,
    updatedAt: timestamp,
    logPath,
  };
  writeUpdateInstallStatus(runtimePaths, installStatus);

  const args = [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    updateScript,
    "-DownloadUrl",
    check.update.package.url,
    "-ExpectedSha256",
    check.update.package.sha256,
    "-InstallId",
    installId,
    "-FromVersion",
    current.version,
    "-TargetVersion",
    check.update.version,
    "-Channel",
    channel,
    "-SourceCommit",
    check.update.sourceCommit,
    "-StatusPath",
    getUpdateStatusPath(runtimePaths),
    "-LogPath",
    logPath,
  ];
  const stateRoot = releaseStateRootArg(env, runtimePaths);
  if (stateRoot) {
    args.push("-StateRoot", stateRoot);
  }

  const log = openUpdateLog(logPath);
  let child: ChildProcess;
  try {
    child = (options.spawnImpl ?? spawn)(
      resolvePowerShellCommand(env, options.powerShellCommand),
      args,
      {
        cwd: releaseRoot,
        detached: true,
        stdio: ["ignore", log.stdoutFd, log.stderrFd],
        windowsHide: true,
        env: {
          ...process.env,
          ...runtimePaths.env,
          BRIDGE_UPDATE_INSTALL_STATUS_PATH: getUpdateStatusPath(runtimePaths),
          BRIDGE_UPDATE_INSTALL_LOG_PATH: logPath,
        },
      },
    );
  } catch (error) {
    const failedAt = now().toISOString();
    writeUpdateInstallStatus(runtimePaths, {
      ...installStatus,
      phase: "failed",
      updatedAt: failedAt,
      completedAt: failedAt,
      error: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    log.close();
  }

  child.once?.("error", (error) => {
    const failedAt = new Date().toISOString();
    writeUpdateInstallStatus(runtimePaths, {
      ...installStatus,
      phase: "failed",
      updatedAt: failedAt,
      completedAt: failedAt,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  child.once?.("exit", (code) => {
    if (code === 0 || code === null) return;
    const failedAt = new Date().toISOString();
    writeUpdateInstallStatus(runtimePaths, {
      ...installStatus,
      phase: "failed",
      updatedAt: failedAt,
      completedAt: failedAt,
      error: `Updater exited with code ${code}.`,
    });
  });
  child.unref?.();

  return { status: "started", install: installStatus };
}
