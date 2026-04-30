// Shared agent-browser helpers with automatic recovery from stale Chrome state.

import { exec, execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { readFileSync, readlinkSync, unlinkSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { homedir, platform } from "node:os";
import { promisify } from "node:util";
import type { TelemetryStore } from "./telemetry-store.js";

const DEFAULT_TIMEOUT = 30_000;
const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const LOCK_FILES = ["SingletonLock", "SingletonSocket", "SingletonCookie"];
const RUNTIME_FILES = [...LOCK_FILES, "DevToolsActivePort", "lockfile"];
const RUNTIME_FILE_NAMES = new Set(RUNTIME_FILES.map((name) => name.toLowerCase()));
const LOCKED_COPY_ERROR_CODES = new Set(["EACCES", "EBUSY", "ENOENT", "EPERM"]);
const RUNTIME_METRICS_FILE_RE = /^(?:CrashpadMetrics|BrowserMetrics).*\.pma$/i;
const SQLITE_RUNTIME_FILE_RE = /(?:-journal|-shm|-wal)$/i;
const COOKIE_STORE_RE = /(?:^|\/)Default\/Network\/Cookies$/i;
const BROWSER_PROCESS_NAMES = new Set([
  "chrome",
  "chrome.exe",
  "chromium",
  "chromium.exe",
  "google-chrome",
  "google-chrome-stable",
  "msedge",
  "msedge.exe",
  "microsoft-edge",
]);
const WEDGE_SIGNATURES = [
  "DevToolsActivePort",
  "Chrome exited early",
  "Broken pipe",
  "broken pipe",
];
const CLONE_ROOT_DIR = "browser-clones";
const STALE_CLONE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const MAX_CLONE_LANES = 5;

const laneQueues = new Map<string, Promise<void>>();
const laneDepths = new Map<string, number>();
const clonePoolStates = new Map<string, { available: number; waiters: Array<() => void> }>();
const persistentCloneProfiles = new Set<string>();

interface BrowserProcessInfo {
  pid: number;
  name: string;
  commandLine: string;
}

export interface BrowserTarget {
  sessionName: string;
  profileDir: string;
}

export interface BrowserLane {
  laneType: "primary" | "clone";
  browserTarget: BrowserTarget;
  cloneId?: string;
}

export interface BrowserCommandOptions {
  telemetryStore?: TelemetryStore;
  toolName?: string;
  browserOpId?: string;
  timeoutMs?: number;
  metadata?: Record<string, unknown>;
  skipRecovery?: boolean;
  attempt?: number;
  browserTarget?: BrowserTarget;
}

export type BrowserCommand = readonly [string, ...string[]];

export function getBridgeBrowserTarget(
  copilotHome = process.env.COPILOT_HOME ?? join(homedir(), ".copilot"),
): BrowserTarget {
  const suffix = createHash("sha1").update(copilotHome).digest("hex").slice(0, 8);
  return {
    sessionName: `copilot-bridge-${suffix}`,
    profileDir: join(copilotHome, "browser-profile"),
  };
}

function browserEnv(target: BrowserTarget): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AGENT_BROWSER_SESSION: target.sessionName,
    AGENT_BROWSER_PROFILE: target.profileDir,
  };
}

function cloneRootDir(copilotHome = process.env.COPILOT_HOME ?? join(homedir(), ".copilot")): string {
  return join(copilotHome, CLONE_ROOT_DIR);
}

function logBrowser(event: string, data: Record<string, unknown>): void {
  console.log(`[browser] ${JSON.stringify({ event, ...data })}`);
}

export function safeRecordBrowserSpan(
  telemetryStore: TelemetryStore | undefined,
  name: string,
  duration: number,
  metadata: Record<string, unknown>,
): void {
  try {
    recordBrowserSpan(telemetryStore, name, duration, metadata);
  } catch (err) {
    logBrowser("telemetry.error", {
      name,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

export function recordBrowserSpan(
  telemetryStore: TelemetryStore | undefined,
  name: string,
  duration: number,
  metadata?: Record<string, unknown>,
): void {
  telemetryStore?.recordSpan({ name, duration, metadata, source: "server" });
}

function hostFromCommand(command: BrowserCommand): string | undefined {
  if (command[0] !== "open") return undefined;
  try {
    return new URL(command[1]).host;
  } catch {
    return undefined;
  }
}

function commandSpanName(command: BrowserCommand): string {
  if (command[0] === "open") return "browser.command.open";
  if (command[0] === "wait") return "browser.command.wait";
  if (command[0] === "snapshot") return "browser.command.snapshot";
  if (command[0] === "get" && command[1] === "title") return "browser.command.get_title";
  if (command[0] === "get" && command[1] === "url") return "browser.command.get_url";
  if (command[0] === "get" && command[1] === "cdp-url") return "browser.command.get_cdp_url";
  return "browser.command.other";
}

function failureSignature(output: string): string | null {
  for (const signature of WEDGE_SIGNATURES) {
    if (output.includes(signature)) return signature;
  }
  return null;
}

function failureCode(output: string): string {
  if (output.includes("which:") || output.includes("not found")) return "binary_missing";
  if (output.includes("DevToolsActivePort")) return "launch.devtools_active_port";
  if (output.includes("Broken pipe") || output.includes("broken pipe")) return "transport.broken_pipe";
  if (output.includes("Chrome exited early")) return "launch.chrome_exited_early";
  if (output.toLowerCase().includes("timed out")) return "launch.timeout";
  return "unknown";
}

function isLaunchProfileWedge(output: string): boolean {
  const code = failureCode(output);
  return code === "launch.devtools_active_port" || code === "launch.chrome_exited_early";
}

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"'))
    || (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function looksLikeWindowsPath(value: string): boolean {
  return /^[a-z]:[\\/]/i.test(value) || value.includes("\\");
}

function normalizeComparablePath(value: string): string {
  const stripped = stripWrappingQuotes(value);
  const resolved = looksLikeWindowsPath(stripped) ? stripped : resolve(stripped);
  const normalized = resolved.replaceAll("\\", "/").replace(/\/+$/, "");
  return platform() === "win32" || looksLikeWindowsPath(stripped) ? normalized.toLowerCase() : normalized;
}

function normalizedProfileRelativePath(sourceDir: string, sourcePath: string): string {
  const root = normalizeComparablePath(sourceDir);
  const source = normalizeComparablePath(sourcePath);
  if (source === root) return "";
  const prefix = `${root}/`;
  if (source.startsWith(prefix)) return source.slice(prefix.length);
  return relative(sourceDir, sourcePath).replaceAll("\\", "/");
}

function normalizedPathBasename(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/, "");
  return normalized.split("/").pop() ?? normalized;
}

export function shouldExcludeBrowserProfileCopyPath(sourceDir: string, sourcePath: string): boolean {
  const rel = normalizedProfileRelativePath(sourceDir, sourcePath);
  if (!rel) return false;
  const base = normalizedPathBasename(rel).toLowerCase();
  const relLower = rel.toLowerCase();
  if (RUNTIME_FILE_NAMES.has(base)) return true;
  if (RUNTIME_METRICS_FILE_RE.test(base)) return true;
  if (SQLITE_RUNTIME_FILE_RE.test(base)) return true;
  return relLower === "crashpad" || relLower.startsWith("crashpad/");
}

function isKnownLockableBrowserProfilePath(sourceDir: string, sourcePath: string): boolean {
  if (shouldExcludeBrowserProfileCopyPath(sourceDir, sourcePath)) return true;
  return COOKIE_STORE_RE.test(normalizedProfileRelativePath(sourceDir, sourcePath));
}

function copyErrorPath(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const candidate = (err as { path?: unknown; dest?: unknown }).path ?? (err as { path?: unknown; dest?: unknown }).dest;
  return typeof candidate === "string" ? candidate : undefined;
}

function isSkippableBrowserProfileCopyError(err: unknown, sourceDir: string): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  if (!code || !LOCKED_COPY_ERROR_CODES.has(code)) return false;
  const path = copyErrorPath(err);
  return !!path && isKnownLockableBrowserProfilePath(sourceDir, path);
}

function splitCommandLine(commandLine: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: string | null = null;

  for (let index = 0; index < commandLine.length; index++) {
    const char = commandLine[index];
    if ((char === '"' || char === "'") && (!quote || quote === char)) {
      quote = quote ? null : char;
      continue;
    }
    if (!quote && /\s/.test(char)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (current) parts.push(current);
  return parts;
}

function browserProcessNameMatches(name: string | undefined, commandLine: string): boolean {
  const nameBase = normalizedPathBasename(name ?? "");
  if (nameBase && BROWSER_PROCESS_NAMES.has(nameBase.toLowerCase())) return true;
  const firstArg = splitCommandLine(commandLine)[0];
  const firstArgBase = normalizedPathBasename(firstArg ?? "");
  return !!firstArgBase && BROWSER_PROCESS_NAMES.has(firstArgBase.toLowerCase());
}

function extractUserDataDir(commandLine: string): string | undefined {
  const parts = splitCommandLine(commandLine);
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    if (part === "--user-data-dir") return parts[index + 1];
    if (part.startsWith("--user-data-dir=")) return part.slice("--user-data-dir=".length);
  }
  return undefined;
}

function isBrowserProcessForProfile(processInfo: BrowserProcessInfo, profileDir: string): boolean {
  if (!browserProcessNameMatches(processInfo.name, processInfo.commandLine)) return false;
  const userDataDir = extractUserDataDir(processInfo.commandLine);
  return !!userDataDir && normalizeComparablePath(userDataDir) === normalizeComparablePath(profileDir);
}

function parseWindowsBrowserProcessJson(output: string): BrowserProcessInfo[] {
  const trimmed = output.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed) as unknown;
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const data = row as { ProcessId?: unknown; Name?: unknown; CommandLine?: unknown };
    const pid = Number(data.ProcessId);
    if (!Number.isSafeInteger(pid) || pid <= 0 || typeof data.CommandLine !== "string") return [];
    return [{
      pid,
      name: typeof data.Name === "string" ? data.Name : "",
      commandLine: data.CommandLine,
    }];
  });
}

function parsePosixBrowserProcessList(output: string): BrowserProcessInfo[] {
  const rows: BrowserProcessInfo[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\S+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    rows.push({ pid, name: match[2], commandLine: match[3] });
  }
  return rows;
}

async function listBrowserProcesses(): Promise<BrowserProcessInfo[]> {
  if (platform() === "win32") {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process -Filter \"Name = 'chrome.exe' OR Name = 'msedge.exe'\" | Select-Object ProcessId,Name,CommandLine | ConvertTo-Json -Compress",
    ], { encoding: "utf-8", timeout: 5_000, windowsHide: true });
    return parseWindowsBrowserProcessJson(stdout);
  }

  const { stdout } = await execFileAsync("ps", ["-eo", "pid=,comm=,args="], {
    encoding: "utf-8",
    timeout: 5_000,
  });
  return parsePosixBrowserProcessList(stdout);
}

async function findBrowserProcessesForProfile(profileDir: string): Promise<BrowserProcessInfo[]> {
  const processes = await listBrowserProcesses();
  return processes.filter((processInfo) => isBrowserProcessForProfile(processInfo, profileDir));
}

function readLockOwner(
  profileDir: string,
): { raw: string; pid: number | null; alive: boolean; signalable: boolean } | null {
  try {
    const raw = readlinkSync(join(profileDir, "SingletonLock"));
    const pid = parseInt(raw.split("-").pop() ?? "", 10);
    if (!pid) return { raw, pid: null, alive: false, signalable: false };
    try {
      process.kill(pid, 0);
      return { raw, pid, alive: true, signalable: true };
    } catch (err: any) {
      if (err?.code === "ESRCH") {
        return { raw, pid, alive: false, signalable: false };
      }
      return { raw, pid, alive: true, signalable: false };
    }
  } catch {
    return null;
  }
}

function isLikelyChromeForProfile(pid: number, profileDir: string): boolean {
  try {
    const cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf-8");
    const parts = cmdline.split("\0").filter(Boolean);
    const joined = parts.join(" ");
    const looksLikeChrome = parts.some((part) =>
      /(chrome|chromium|google-chrome|msedge|microsoft-edge)/i.test(part),
    );
    if (!looksLikeChrome) return false;
    const normalizedDir = profileDir.replaceAll("\\", "/");
    return joined.includes(normalizedDir) || joined.includes(`--user-data-dir=${normalizedDir}`);
  } catch {
    return false;
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function withQueuedLane<T>(
  laneKey: string,
  laneType: "primary" | "clone",
  telemetryStore: TelemetryStore | undefined,
  metadata: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = laneQueues.get(laneKey) ?? Promise.resolve();
  const queuedAhead = laneDepths.get(laneKey) ?? 0;
  laneDepths.set(laneKey, queuedAhead + 1);

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const current = previous.catch(() => undefined).then(() => gate);
  laneQueues.set(laneKey, current);

  const enqueuedAt = Date.now();
  await previous.catch(() => undefined);

  try {
    const waitDuration = Date.now() - enqueuedAt;
    safeRecordBrowserSpan(
      telemetryStore,
      laneType === "primary" ? "browser.queue.wait.primary" : "browser.queue.wait.clone",
      waitDuration,
      {
        ...metadata,
        queueKey: laneKey,
        queuedAhead,
      },
    );
    return await fn();
  } finally {
    release();
    const nextDepth = Math.max(0, (laneDepths.get(laneKey) ?? 1) - 1);
    if (nextDepth === 0) laneDepths.delete(laneKey);
    else laneDepths.set(laneKey, nextDepth);
    if (laneQueues.get(laneKey) === current) {
      laneQueues.delete(laneKey);
    }
  }
}

async function withClonePoolSlot<T>(
  poolKey: string,
  telemetryStore: TelemetryStore | undefined,
  metadata: Record<string, unknown>,
  fn: () => Promise<T>,
): Promise<T> {
  const state = clonePoolStates.get(poolKey) ?? { available: MAX_CLONE_LANES, waiters: [] };
  clonePoolStates.set(poolKey, state);

  const queuedAhead = state.waiters.length;
  const activeClonesAtEnqueue = MAX_CLONE_LANES - state.available;
  const enqueuedAt = Date.now();

  if (state.available > 0) {
    state.available -= 1;
  } else {
    await new Promise<void>((resolve) => {
      state.waiters.push(resolve);
    });
  }

  try {
    const waitDuration = Date.now() - enqueuedAt;
    safeRecordBrowserSpan(telemetryStore, "browser.queue.wait.clone", waitDuration, {
      ...metadata,
      queueKey: poolKey,
      queuedAhead,
      activeClonesAtEnqueue,
      clonePoolSize: MAX_CLONE_LANES,
    });
    return await fn();
  } finally {
    const next = state.waiters.shift();
    if (next) {
      next();
    } else {
      state.available = Math.min(MAX_CLONE_LANES, state.available + 1);
    }
    if (state.available === MAX_CLONE_LANES && state.waiters.length === 0) {
      clonePoolStates.delete(poolKey);
    }
  }
}

async function cleanupStaleBrowserClones(copilotHome: string): Promise<void> {
  const root = cloneRootDir(copilotHome);
  try {
    const entries = await readdir(root, { withFileTypes: true });
    const now = Date.now();
    await Promise.all(entries.map(async (entry) => {
      if (!entry.isDirectory()) return;
      const fullPath = join(root, entry.name);
      if (persistentCloneProfiles.has(fullPath)) return;
      try {
        const stats = await stat(fullPath);
        if ((now - stats.mtimeMs) > STALE_CLONE_MAX_AGE_MS) {
          await rm(fullPath, { recursive: true, force: true });
        }
      } catch {
        // ignore cleanup races
      }
    }));
  } catch {
    // no clone root yet
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function copySanitizedProfile(sourceDir: string, targetDir: string): Promise<void> {
  await mkdir(dirname(targetDir), { recursive: true });
  const skippedLockedPaths = new Set<string>();
  const maxAttempts = 10;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await rm(targetDir, { recursive: true, force: true });
    try {
      await cp(sourceDir, targetDir, {
        recursive: true,
        force: false,
        errorOnExist: true,
        filter: (src) => {
          const rel = normalizedProfileRelativePath(sourceDir, src);
          return !skippedLockedPaths.has(rel) && !shouldExcludeBrowserProfileCopyPath(sourceDir, src);
        },
      });
      return;
    } catch (err) {
      if (isSkippableBrowserProfileCopyError(err, sourceDir)) {
        const path = copyErrorPath(err);
        if (path) {
          const rel = normalizedProfileRelativePath(sourceDir, path);
          if (!skippedLockedPaths.has(rel)) {
            skippedLockedPaths.add(rel);
            logBrowser("clone.copy.skip_locked_file", {
              source: rel,
              code: (err as NodeJS.ErrnoException).code,
            });
            continue;
          }
        }
      }
      await rm(targetDir, { recursive: true, force: true });
      throw err;
    }
  }
  await rm(targetDir, { recursive: true, force: true });
  throw new Error(`Failed to copy browser profile after skipping ${skippedLockedPaths.size} locked runtime files.`);
}

async function resolveCloneSourceProfile(primaryTarget: BrowserTarget): Promise<{ profileDir: string; sourceKind: string }> {
  if (await pathExists(primaryTarget.profileDir)) {
    return { profileDir: primaryTarget.profileDir, sourceKind: "context-primary" };
  }

  const defaultTarget = getBridgeBrowserTarget();
  if (defaultTarget.profileDir !== primaryTarget.profileDir && await pathExists(defaultTarget.profileDir)) {
    await withQueuedLane(`${primaryTarget.profileDir}:seed`, "clone", undefined, {}, async () => {
      if (await pathExists(primaryTarget.profileDir)) return;
      await copySanitizedProfile(defaultTarget.profileDir, primaryTarget.profileDir);
    });
    return { profileDir: primaryTarget.profileDir, sourceKind: "context-seeded-from-default" };
  }

  return { profileDir: primaryTarget.profileDir, sourceKind: "missing-primary" };
}

async function resolvePrimaryBrowserTarget(
  copilotHome: string | undefined,
): Promise<{ browserTarget: BrowserTarget; sourceKind: string }> {
  const primaryTarget = getBridgeBrowserTarget(copilotHome);
  if (await pathExists(primaryTarget.profileDir)) {
    return { browserTarget: primaryTarget, sourceKind: "context-primary" };
  }
  return { browserTarget: primaryTarget, sourceKind: "missing-primary" };
}

export async function createPersistentCloneBrowserTarget(
  copilotHome: string | undefined,
  telemetryStore: TelemetryStore | undefined,
  metadata: Record<string, unknown>,
): Promise<{ cloneId: string; browserTarget: BrowserTarget }> {
  const resolvedHome = copilotHome ?? process.env.COPILOT_HOME ?? join(homedir(), ".copilot");
  const primaryTarget = getBridgeBrowserTarget(resolvedHome);
  const clone = await createBrowserClone(primaryTarget, resolvedHome, telemetryStore, metadata);
  persistentCloneProfiles.add(clone.browserTarget.profileDir);
  return clone;
}

async function createBrowserClone(
  primaryTarget: BrowserTarget,
  copilotHome: string,
  telemetryStore: TelemetryStore | undefined,
  metadata: Record<string, unknown>,
): Promise<{ cloneId: string; browserTarget: BrowserTarget }> {
  await cleanupStaleBrowserClones(copilotHome);
  const cloneId = randomUUID().slice(0, 8);
  const root = cloneRootDir(copilotHome);
  const profileDir = join(root, `profile-${cloneId}`);
  const source = await resolveCloneSourceProfile(primaryTarget);
  const browserTarget = {
    sessionName: `${primaryTarget.sessionName}-clone-${cloneId}`,
    profileDir,
  };

  const startedAt = Date.now();
  try {
    await mkdir(root, { recursive: true });
    if (source.sourceKind === "missing-primary") {
      await mkdir(profileDir, { recursive: true });
    } else {
      await copySanitizedProfile(source.profileDir, profileDir);
    }
    safeRecordBrowserSpan(telemetryStore, "browser.clone.create", Date.now() - startedAt, {
      ...metadata,
      cloneId,
      cloneSourceKind: source.sourceKind,
      browserSession: browserTarget.sessionName,
    });
    logBrowser("clone.create", {
      ...metadata,
      cloneId,
      cloneSourceKind: source.sourceKind,
      browserSession: browserTarget.sessionName,
      durationMs: Date.now() - startedAt,
    });
    return { cloneId, browserTarget };
  } catch (err) {
    safeRecordBrowserSpan(telemetryStore, "browser.clone.create.failed", Date.now() - startedAt, {
      ...metadata,
      cloneId,
      cloneSourceKind: source.sourceKind,
    });
    throw err;
  }
}

export async function destroyPersistentCloneBrowserTarget(
  browserTarget: BrowserTarget,
  telemetryStore: TelemetryStore | undefined,
  metadata: Record<string, unknown>,
): Promise<void> {
  persistentCloneProfiles.delete(browserTarget.profileDir);
  await destroyBrowserClone(browserTarget, telemetryStore, metadata);
}

async function destroyBrowserClone(
  browserTarget: BrowserTarget,
  telemetryStore: TelemetryStore | undefined,
  metadata: Record<string, unknown>,
): Promise<void> {
  const startedAt = Date.now();
  let closeErrored = false;
  let removeErrored = false;
  let closeFailure: string | undefined;
  const closeResult = await runFile("agent-browser", ["close"], 10_000, { env: browserEnv(browserTarget) });
  if (!closeResult.ok) {
    closeErrored = true;
    closeFailure = failureCode(closeResult.output);
  }

  try {
    await rm(browserTarget.profileDir, { recursive: true, force: true });
  } catch {
    removeErrored = true;
  }

  const duration = Date.now() - startedAt;
  if (closeErrored || removeErrored) {
    safeRecordBrowserSpan(telemetryStore, "browser.clone.cleanup.failed", duration, {
      ...metadata,
      browserSession: browserTarget.sessionName,
      closeErrored,
      removeErrored,
      closeFailureCode: closeFailure,
    });
    return;
  }

  safeRecordBrowserSpan(telemetryStore, "browser.clone.cleanup", duration, {
    ...metadata,
    browserSession: browserTarget.sessionName,
    closeErrored,
  });
  logBrowser("clone.cleanup", {
    ...metadata,
    browserSession: browserTarget.sessionName,
    durationMs: duration,
    closeErrored,
  });
}

async function runBrowserCommand(
  command: BrowserCommand,
  timeout = DEFAULT_TIMEOUT,
  options: BrowserCommandOptions = {},
): Promise<{ ok: boolean; output: string }> {
  const browserOpId = options.browserOpId ?? randomUUID();
  const browserTarget = options.browserTarget ?? getBridgeBrowserTarget();
  const spanName = commandSpanName(command);
  const metadata = {
    browserOpId,
    toolName: options.toolName,
    attempt: options.attempt ?? 1,
    timeoutMs: options.timeoutMs ?? timeout,
    browserSession: browserTarget.sessionName,
    urlHost: hostFromCommand(command),
    ...options.metadata,
  };

  logBrowser("command.start", { commandName: spanName, ...metadata });
  const startedAt = Date.now();
  const result = await runFile("agent-browser", [...command], timeout, { env: browserEnv(browserTarget) });
  const duration = Date.now() - startedAt;

  recordBrowserSpan(options.telemetryStore, spanName, duration, {
    ...metadata,
    success: result.ok,
    failureCode: result.ok ? undefined : failureCode(result.output),
    signature: result.ok ? undefined : failureSignature(result.output) ?? undefined,
  });
  if (!result.ok) {
    recordBrowserSpan(options.telemetryStore, `${spanName}.failed`, duration, {
      ...metadata,
      failureCode: failureCode(result.output),
      signature: failureSignature(result.output) ?? undefined,
    });
  }

  logBrowser("command.finish", {
    commandName: spanName,
    durationMs: duration,
    success: result.ok,
    failureCode: result.ok ? undefined : failureCode(result.output),
    signature: result.ok ? undefined : failureSignature(result.output) ?? undefined,
    ...metadata,
  });
  return result;
}

export async function run(
  cmd: string,
  timeout = DEFAULT_TIMEOUT,
  execOptions: { env?: NodeJS.ProcessEnv } = {},
): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await execAsync(cmd, {
      encoding: "utf-8",
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      env: execOptions.env,
    });
    const output = stdout || stderr;
    return { ok: true, output: output.trim() };
  } catch (err: any) {
    return { ok: false, output: err.stderr || err.stdout || String(err) };
  }
}

export async function runFile(
  file: string,
  args: string[],
  timeout = DEFAULT_TIMEOUT,
  execOptions: { env?: NodeJS.ProcessEnv } = {},
): Promise<{ ok: boolean; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(file, args, {
      encoding: "utf-8",
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      env: execOptions.env,
      shell: platform() === "win32",
    });
    const output = stdout || stderr;
    return { ok: true, output: output.trim() };
  } catch (err: any) {
    return { ok: false, output: err.stderr || err.stdout || String(err) };
  }
}

export async function isAgentBrowserInstalled(): Promise<boolean> {
  const cmd = platform() === "win32" ? "where.exe agent-browser" : "which agent-browser";
  return (await run(cmd, 5_000)).ok;
}

function clearProfileRuntimeFiles(profileDir: string): number {
  let removed = 0;
  for (const name of RUNTIME_FILES) {
    try {
      unlinkSync(join(profileDir, name));
      removed++;
    } catch {
      // may not exist
    }
  }
  return removed;
}

/** Remove stale Chrome profile runtime files if the owning process is gone. */
function clearStaleLocks(profileDir: string): boolean {
  try {
    const lock = readLockOwner(profileDir);
    if (!lock?.pid || lock.alive) return false;

    clearProfileRuntimeFiles(profileDir);
    return true;
  } catch {
    return false;
  }
}

async function killProfileBoundBrowserProcesses(
  profileDir: string,
  metadata: Record<string, unknown>,
): Promise<number[]> {
  let processes: BrowserProcessInfo[];
  try {
    processes = await findBrowserProcessesForProfile(profileDir);
  } catch (err) {
    logBrowser("recovery.profile_process_discovery_failed", {
      ...metadata,
      error: err instanceof Error ? err.message : String(err),
    });
    return [];
  }

  const killedPids: number[] = [];
  for (const processInfo of processes) {
    try {
      process.kill(processInfo.pid);
      killedPids.push(processInfo.pid);
    } catch (err) {
      logBrowser("recovery.kill_profile_process_failed", {
        ...metadata,
        pid: processInfo.pid,
        processName: processInfo.name,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return killedPids;
}

/**
 * Run an agent-browser command using a bridge-owned session.
 * On Chrome launch failure, clears stale dead locks or kills a live wedged Chrome once and retries.
 */
export async function ab(
  command: BrowserCommand,
  timeout = DEFAULT_TIMEOUT,
  options: BrowserCommandOptions = {},
): Promise<{ ok: boolean; output: string }> {
  const browserOpId = options.browserOpId ?? randomUUID();
  const browserTarget = options.browserTarget ?? getBridgeBrowserTarget();
  const commandName = commandSpanName(command);
  const result = await runBrowserCommand(command, timeout, {
    ...options,
    browserTarget,
    browserOpId,
    attempt: options.attempt ?? 1,
  });
  if (result.ok || options.skipRecovery) return result;

  const signature = failureSignature(result.output);
  if (!signature) return result;

  const lock = readLockOwner(browserTarget.profileDir);
  recordBrowserSpan(options.telemetryStore, "browser.recovery.detected", 0, {
    browserOpId,
    toolName: options.toolName,
    browserSession: browserTarget.sessionName,
    commandName,
    signature,
    failureCode: failureCode(result.output),
    lockPid: lock?.pid ?? undefined,
    lockPidAlive: lock?.alive ?? false,
    lockPidSignalable: lock?.signalable ?? false,
  });

  if (clearStaleLocks(browserTarget.profileDir)) {
    logBrowser("recovery.clear_stale_lock", {
      browserOpId,
      toolName: options.toolName,
      browserSession: browserTarget.sessionName,
      commandName,
      signature,
    });
    recordBrowserSpan(options.telemetryStore, "browser.recovery.clear_stale_lock", 0, {
      browserOpId,
      toolName: options.toolName,
      browserSession: browserTarget.sessionName,
      commandName,
      signature,
    });
    const retryStartedAt = Date.now();
    const retry = await runBrowserCommand(command, timeout, {
      ...options,
      browserTarget,
      browserOpId,
      attempt: 2,
    });
    recordBrowserSpan(options.telemetryStore, "browser.recovery.retry", Date.now() - retryStartedAt, {
      browserOpId,
      toolName: options.toolName,
      browserSession: browserTarget.sessionName,
      commandName,
      signature,
      retryOutcome: retry.ok
        ? "succeeded"
        : failureSignature(retry.output) === signature
          ? "failed_same_signature"
          : "failed_new_signature",
    });
    return retry;
  }

  if (!lock && isLaunchProfileWedge(result.output)) {
    const recoveryMetadata = {
      browserOpId,
      toolName: options.toolName,
      browserSession: browserTarget.sessionName,
      commandName,
      signature,
    };
    logBrowser("recovery.no_lock_file", recoveryMetadata);

    const killStartedAt = Date.now();
    const killedPids = await killProfileBoundBrowserProcesses(browserTarget.profileDir, recoveryMetadata);
    if (killedPids.length > 0) {
      await delay(500);
      const clearedRuntimeFiles = clearProfileRuntimeFiles(browserTarget.profileDir);
      const killDuration = Date.now() - killStartedAt;
      logBrowser("recovery.kill_profile_processes", {
        ...recoveryMetadata,
        killedPids,
        clearedRuntimeFiles,
        durationMs: killDuration,
      });
      recordBrowserSpan(options.telemetryStore, "browser.recovery.kill_profile_processes", killDuration, {
        ...recoveryMetadata,
        killedPids,
        clearedRuntimeFiles,
      });

      const retryStartedAt = Date.now();
      const retry = await runBrowserCommand(command, timeout, {
        ...options,
        browserTarget,
        browserOpId,
        attempt: 2,
      });
      recordBrowserSpan(options.telemetryStore, "browser.recovery.retry", Date.now() - retryStartedAt, {
        ...recoveryMetadata,
        retryOutcome: retry.ok
          ? "succeeded"
          : failureSignature(retry.output) === signature
            ? "failed_same_signature"
            : "failed_new_signature",
      });
      return retry;
    }
    recordBrowserSpan(options.telemetryStore, "browser.recovery.no_profile_processes", Date.now() - killStartedAt, {
      ...recoveryMetadata,
    });
    return result;
  }

  if (lock?.alive && lock.pid) {
    const probeStartedAt = Date.now();
    const probe = await runBrowserCommand(["get", "url"], 5_000, {
      ...options,
      browserTarget,
      browserOpId,
      attempt: 1,
      skipRecovery: true,
      metadata: { ...(options.metadata ?? {}), probeFor: commandName },
    });
    recordBrowserSpan(options.telemetryStore, "browser.health.probe", Date.now() - probeStartedAt, {
      browserOpId,
      toolName: options.toolName,
      browserSession: browserTarget.sessionName,
      commandName,
      signature,
      success: probe.ok,
      lockPid: lock.pid,
      lockPidSignalable: lock.signalable,
    });

    if (!probe.ok && lock.signalable && isLikelyChromeForProfile(lock.pid, browserTarget.profileDir)) {
      const killStartedAt = Date.now();
      try {
        process.kill(lock.pid);
      } catch (err) {
        logBrowser("recovery.kill_lock_owner_failed", {
          browserOpId,
          toolName: options.toolName,
          browserSession: browserTarget.sessionName,
          commandName,
          signature,
          lockPid: lock.pid,
          error: err instanceof Error ? err.message : String(err),
        });
        return result;
      }
      await delay(250);
      clearStaleLocks(browserTarget.profileDir);
      const killDuration = Date.now() - killStartedAt;
      logBrowser("recovery.kill_lock_owner", {
        browserOpId,
        toolName: options.toolName,
        browserSession: browserTarget.sessionName,
        commandName,
        signature,
        lockPid: lock.pid,
        durationMs: killDuration,
      });
      recordBrowserSpan(options.telemetryStore, "browser.recovery.kill_lock_owner", killDuration, {
        browserOpId,
        toolName: options.toolName,
        browserSession: browserTarget.sessionName,
        commandName,
        signature,
        lockPid: lock.pid,
        lockPidSignalable: lock.signalable,
      });
      const retryStartedAt = Date.now();
      const retry = await runBrowserCommand(command, timeout, {
        ...options,
        browserTarget,
        browserOpId,
        attempt: 2,
      });
      recordBrowserSpan(options.telemetryStore, "browser.recovery.retry", Date.now() - retryStartedAt, {
        browserOpId,
        toolName: options.toolName,
        browserSession: browserTarget.sessionName,
        commandName,
        signature,
        retryOutcome: retry.ok
          ? "succeeded"
          : failureSignature(retry.output) === signature
            ? "failed_same_signature"
            : "failed_new_signature",
      });
      return retry;
    }

    if (!probe.ok) {
      logBrowser("recovery.skip_kill_unverified_lock_owner", {
        browserOpId,
        toolName: options.toolName,
        browserSession: browserTarget.sessionName,
        commandName,
        signature,
        lockPid: lock.pid,
      });
      recordBrowserSpan(options.telemetryStore, "browser.recovery.skip_unverified_lock_owner", 0, {
        browserOpId,
        toolName: options.toolName,
        browserSession: browserTarget.sessionName,
        commandName,
        signature,
        lockPid: lock.pid,
        lockPidSignalable: lock.signalable,
      });
    }
  } else if (!lock) {
    logBrowser("recovery.no_lock_file", {
      browserOpId,
      toolName: options.toolName,
      browserSession: browserTarget.sessionName,
      commandName,
      signature,
    });
  }

  return result;
}

export async function withBridgeBrowserSession<T>(
  browserTarget: BrowserTarget,
  fn: () => Promise<T>,
): Promise<T> {
  return withQueuedLane(browserTarget.sessionName, "primary", undefined, {
    browserSession: browserTarget.sessionName,
  }, fn);
}

export async function withPrimaryBrowserLane<T>(
  copilotHome: string | undefined,
  telemetryStore: TelemetryStore | undefined,
  metadata: Record<string, unknown>,
  fn: (lane: BrowserLane) => Promise<T>,
): Promise<T> {
  const { browserTarget, sourceKind } = await resolvePrimaryBrowserTarget(copilotHome);
  return withQueuedLane(browserTarget.sessionName, "primary", telemetryStore, {
    ...metadata,
    browserSession: browserTarget.sessionName,
    primarySourceKind: sourceKind,
  }, async () => fn({ laneType: "primary", browserTarget }));
}

export async function withCloneBrowserLane<T>(
  copilotHome: string | undefined,
  telemetryStore: TelemetryStore | undefined,
  metadata: Record<string, unknown>,
  fn: (lane: BrowserLane) => Promise<T>,
): Promise<T> {
  const resolvedHome = copilotHome ?? process.env.COPILOT_HOME ?? join(homedir(), ".copilot");
  const primaryTarget = getBridgeBrowserTarget(resolvedHome);
  const clonePoolKey = `${primaryTarget.sessionName}:clone-pool`;
  return withClonePoolSlot(clonePoolKey, telemetryStore, {
    ...metadata,
    browserSession: primaryTarget.sessionName,
  }, async () => {
    const { cloneId, browserTarget } = await createBrowserClone(primaryTarget, resolvedHome, telemetryStore, metadata);
    try {
      return await fn({ laneType: "clone", browserTarget, cloneId });
    } finally {
      await destroyBrowserClone(browserTarget, telemetryStore, {
        ...metadata,
        cloneId,
      });
    }
  });
}

export async function shutdownBridgeBrowser(
  browserTarget: BrowserTarget = getBridgeBrowserTarget(),
  telemetryStore?: TelemetryStore,
): Promise<void> {
  await withBridgeBrowserSession(browserTarget, async () => {
    const startedAt = Date.now();
    const result = await runFile("agent-browser", ["close"], 10_000, { env: browserEnv(browserTarget) });
    const duration = Date.now() - startedAt;
    recordBrowserSpan(telemetryStore, "browser.lifecycle.shutdown", duration, {
      session: browserTarget.sessionName,
      success: result.ok,
    });
    logBrowser("lifecycle.shutdown", {
      session: browserTarget.sessionName,
      durationMs: duration,
      success: result.ok,
    });
  });
}
