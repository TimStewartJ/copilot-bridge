// Shared agent-browser helpers with automatic recovery from stale Chrome state.

import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, unlinkSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { homedir, platform } from "node:os";
import { getProcessHost, type HostExecOptions } from "./process-host.js";
import type { TelemetryStore } from "./telemetry-store.js";

const DEFAULT_TIMEOUT = 30_000;
const execAsync = (command: string, options: HostExecOptions) => getProcessHost().exec(command, options);
const execFileAsync = (file: string, args: readonly string[], options: HostExecOptions) =>
  getProcessHost().execFile(file, args, options);
const LOCK_FILES = ["SingletonLock", "SingletonSocket", "SingletonCookie"];
const RUNTIME_FILES = [...LOCK_FILES, "DevToolsActivePort", "lockfile"];

export const BROWSER_RUNTIME_FILES: readonly string[] = RUNTIME_FILES;

export function hasBrowserRuntimeActivity(profileDir: string): boolean {
  try {
    lstatSync(profileDir);
  } catch {
    return false;
  }
  for (const name of RUNTIME_FILES) {
    try {
      lstatSync(join(profileDir, name));
      return true;
    } catch {
      // missing or unreadable; keep scanning
    }
  }
  return false;
}
const SHUTDOWN_OUTPUT_SUMMARY_MAX_LENGTH = 500;
export const BROWSER_PROFILE_SIGTERM_GRACE_MS = 500;
export const BROWSER_LOCK_OWNER_KILL_GRACE_MS = 250;
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
  "Failed to connect",
  "actively refused",
  "Connection refused",
];
const laneQueues = new Map<string, Promise<void>>();
const laneDepths = new Map<string, number>();
let resolvedAgentBrowserCommand: { file: string; shell: boolean } | undefined;

interface BrowserProcessInfo {
  pid: number;
  name: string;
  commandLine: string;
  parentPid?: number;
  /** Only read on Windows, where a dead parent's id stays on its children and can be reused. */
  createdAtMs?: number;
}

interface AgentBrowserJsonEnvelope {
  success: boolean;
  data?: Record<string, unknown> | null;
  error?: unknown;
}

export interface BrowserTarget {
  sessionName: string;
  profileDir: string;
  executablePath?: string;
  headed?: boolean;
  /**
   * How long the session's agent-browser daemon may go without a command before it closes its
   * browser and exits by itself. It counts from the last command it received, so it has to be
   * longer than any single command.
   */
  idleTimeoutMs?: number;
  /**
   * The session name and profile are used once and thrown away. Shutting such a target down
   * also stops its agent-browser daemon when the daemon does not close the browser itself.
   */
  disposable?: boolean;
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

export interface BrowserLaunchConfig {
  executablePath?: string;
  masterProfileDirectory?: string;
  headed?: boolean;
}

export type BrowserExecutablePathSource = "settings" | "environment" | "auto-detect";

export type BrowserCommand = readonly [string, ...string[]];
export type BrowserCommandFailureCode =
  | "binary_missing"
  | "launch.devtools_active_port"
  | "transport.broken_pipe"
  | "transport.connection_refused"
  | "launch.chrome_exited_early"
  | "launch.timeout"
  | "unknown";
export type BrowserShutdownFailureCode = BrowserCommandFailureCode | "profile_processes_remaining";

export interface BrowserProcessCleanupResult {
  terminatedPids: number[];
  killedPids: number[];
  remainingPids: number[];
  clearedRuntimeFiles: number;
  /** agent-browser daemons stopped because they owned the profile's browser. */
  stoppedDaemonPids?: number[];
}

export interface BrowserShutdownResult extends BrowserProcessCleanupResult {
  ok: boolean;
  failureCode?: BrowserShutdownFailureCode;
  outputSummary?: string;
  closeOk: boolean;
  closeFailureCode?: BrowserCommandFailureCode;
  closeFailureSignature?: string;
  closeOutputSummary?: string;
}

function normalizeConfiguredPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function getBrowserLaunchConfig(settings?: {
  browser?: BrowserLaunchConfig | null;
}): BrowserLaunchConfig {
  const executablePath = normalizeConfiguredPath(settings?.browser?.executablePath);
  const masterProfileDirectory = normalizeConfiguredPath(settings?.browser?.masterProfileDirectory);
  const headed = settings?.browser?.headed === true;
  return {
    ...(executablePath ? { executablePath } : {}),
    ...(masterProfileDirectory ? { masterProfileDirectory } : {}),
    ...(headed ? { headed } : {}),
  };
}

export function getEffectiveBrowserExecutablePath(
  launchConfig: BrowserLaunchConfig = {},
  env: NodeJS.ProcessEnv = process.env,
): { path?: string; source: BrowserExecutablePathSource } {
  const settingsPath = normalizeConfiguredPath(launchConfig.executablePath);
  if (settingsPath) return { path: settingsPath, source: "settings" };

  const environmentPath = normalizeConfiguredPath(env.AGENT_BROWSER_EXECUTABLE_PATH);
  if (environmentPath) return { path: environmentPath, source: "environment" };

  return { source: "auto-detect" };
}

export function getBridgeBrowserTarget(
  copilotHome = process.env.COPILOT_HOME ?? join(homedir(), ".copilot"),
  launchConfig: BrowserLaunchConfig = {},
): BrowserTarget {
  const executablePath = normalizeConfiguredPath(launchConfig.executablePath);
  const defaultProfileDir = join(copilotHome, "browser-profile");
  const profileDir = normalizeConfiguredPath(launchConfig.masterProfileDirectory) ?? defaultProfileDir;
  const suffixSeed = executablePath || profileDir !== defaultProfileDir
    ? `${copilotHome}\u0000${profileDir}\u0000${executablePath ?? ""}`
    : copilotHome;
  const suffix = createHash("sha1").update(suffixSeed).digest("hex").slice(0, 8);
  return {
    sessionName: `copilot-bridge-${suffix}`,
    profileDir,
    ...(executablePath ? { executablePath } : {}),
    ...(launchConfig.headed ? { headed: true } : {}),
  };
}

const BLANK_START_PAGE = "about:blank";

/**
 * The inherited browser launch arguments plus a blank start page. A browser started without
 * a URL opens its new-tab page. In Edge that is a news feed, which loads on every launch and
 * keeps a processor busy for as long as the tab exists.
 */
export function withBlankStartPage(inheritedArgs: string | undefined): string {
  const inherited = inheritedArgs?.trim();
  if (!inherited) return BLANK_START_PAGE;
  // agent-browser separates arguments by newlines or by commas; keep whichever is in use.
  const separator = inherited.includes("\n") ? "\n" : ",";
  const present = inherited.split(separator).some((arg) => arg.trim() === BLANK_START_PAGE);
  return present ? inherited : `${inherited}${separator}${BLANK_START_PAGE}`;
}

function browserEnv(target: BrowserTarget): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGENT_BROWSER_NAMESPACE: "copilot-bridge",
    AGENT_BROWSER_SESSION: target.sessionName,
    AGENT_BROWSER_PROFILE: target.profileDir,
    AGENT_BROWSER_ARGS: withBlankStartPage(process.env.AGENT_BROWSER_ARGS),
    ...(target.executablePath ? { AGENT_BROWSER_EXECUTABLE_PATH: target.executablePath } : {}),
    ...(target.idleTimeoutMs !== undefined ? { AGENT_BROWSER_IDLE_TIMEOUT_MS: String(target.idleTimeoutMs) } : {}),
  };
  if (target.headed) {
    env.AGENT_BROWSER_HEADED = "true";
  } else {
    delete env.AGENT_BROWSER_HEADED;
  }
  // A blank value, as in a copied .env.example, means no setting rather than a setting of nothing.
  if (!env.AGENT_BROWSER_IDLE_TIMEOUT_MS?.trim()) delete env.AGENT_BROWSER_IDLE_TIMEOUT_MS;
  return env;
}

/** Where agent-browser keeps the socket, port and pid files of its daemons (its `get_socket_dir`). */
function daemonStateDirectory(env: NodeJS.ProcessEnv): string {
  if (env.AGENT_BROWSER_SOCKET_DIR) return env.AGENT_BROWSER_SOCKET_DIR;
  if (env.XDG_RUNTIME_DIR) return join(env.XDG_RUNTIME_DIR, "agent-browser");
  return join(homedir(), ".agent-browser");
}

/**
 * Removes the state files of a daemon that was killed. A daemon removes them itself when it
 * exits, and agent-browser clears them for a session name that is used again, which the name of
 * a disposable target never is.
 */
async function removeDaemonStateFiles(sessionName: string, env: NodeJS.ProcessEnv): Promise<void> {
  const directory = daemonStateDirectory(env);
  try {
    const names = (await readdir(directory)).filter((name) => name.startsWith(`${sessionName}.`));
    await Promise.all(names.map((name) => rm(join(directory, name), { force: true })));
  } catch {
    // Files left behind are small and harmless.
  }
}

function logBrowser(event: string, data: Record<string, unknown>): void {
  console.log(`[browser] ${JSON.stringify({ event, ...data })}`);
}

function getAgentBrowserCommand(): { file: string; shell: boolean } {
  if (resolvedAgentBrowserCommand) return resolvedAgentBrowserCommand;
  if (platform() !== "win32") {
    resolvedAgentBrowserCommand = { file: "agent-browser", shell: false };
    return resolvedAgentBrowserCommand;
  }

  for (const pathDirectory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidates = [
      join(pathDirectory, "node_modules", "agent-browser", "bin", "agent-browser-win32-x64.exe"),
      ...(basename(pathDirectory).toLowerCase() === ".bin"
        ? [join(dirname(pathDirectory), "agent-browser", "bin", "agent-browser-win32-x64.exe")]
        : []),
    ];
    for (const candidate of candidates) {
      try {
        lstatSync(candidate);
        resolvedAgentBrowserCommand = { file: candidate, shell: false };
        return resolvedAgentBrowserCommand;
      } catch {
        // Keep searching the executable PATH.
      }
    }
  }

  resolvedAgentBrowserCommand = { file: "agent-browser", shell: true };
  return resolvedAgentBrowserCommand;
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

function failureCode(output: string): BrowserCommandFailureCode {
  if (output.includes("which:") || output.includes("not found")) return "binary_missing";
  if (output.includes("DevToolsActivePort")) return "launch.devtools_active_port";
  if (output.includes("Broken pipe") || output.includes("broken pipe")) return "transport.broken_pipe";
  if (
    output.includes("Failed to connect")
    || output.includes("actively refused")
    || output.includes("Connection refused")
  ) {
    return "transport.connection_refused";
  }
  if (output.includes("Chrome exited early")) return "launch.chrome_exited_early";
  if (output.toLowerCase().includes("timed out")) return "launch.timeout";
  return "unknown";
}

function summarizeCommandOutput(output: string, profileDir?: string): string | undefined {
  const compact = output.replace(/\s+/g, " ").trim();
  if (!compact) return undefined;
  const bounded = compact.length > SHUTDOWN_OUTPUT_SUMMARY_MAX_LENGTH
    ? `${compact.slice(0, SHUTDOWN_OUTPUT_SUMMARY_MAX_LENGTH)}...`
    : compact;
  if (!profileDir) return bounded;
  const normalizedProfileDir = profileDir.replaceAll("\\", "/");
  return bounded
    .split(profileDir).join("<browser-profile>")
    .split(normalizedProfileDir).join("<browser-profile>");
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

function normalizedPathBasename(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/\/+$/, "");
  return normalized.split("/").pop() ?? normalized;
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

function isAgentBrowserProcess(processInfo: BrowserProcessInfo): boolean {
  return [processInfo.name, splitCommandLine(processInfo.commandLine)[0] ?? ""]
    .some((value) => normalizedPathBasename(stripWrappingQuotes(value)).toLowerCase().startsWith("agent-browser"));
}

/**
 * The agent-browser daemons that started the given browser processes: a daemon is the parent
 * of its browser's main process. The command-line clients share the daemon's executable name
 * but never have a browser as a child.
 */
function findOwningDaemons(
  allProcesses: readonly BrowserProcessInfo[],
  browserProcesses: readonly BrowserProcessInfo[],
): BrowserProcessInfo[] {
  const byPid = new Map(allProcesses.map((processInfo) => [processInfo.pid, processInfo]));
  const daemons = new Map<number, BrowserProcessInfo>();
  for (const child of browserProcesses) {
    const parent = child.parentPid === undefined ? undefined : byPid.get(child.parentPid);
    if (!parent || !isAgentBrowserProcess(parent)) continue;
    // Windows never updates a child's parent id and reuses ids, so the id can name an unrelated,
    // younger process. POSIX hands orphans to another parent instead.
    if (platform() === "win32"
      && !(parent.createdAtMs !== undefined && child.createdAtMs !== undefined && parent.createdAtMs <= child.createdAtMs)) {
      continue;
    }
    daemons.set(parent.pid, parent);
  }
  return [...daemons.values()];
}

function optionalPositiveInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function parseWindowsBrowserProcessJson(output: string): BrowserProcessInfo[] {
  const trimmed = output.trim();
  if (!trimmed) return [];
  const parsed = JSON.parse(trimmed) as unknown;
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  return rows.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const data = row as { ProcessId?: unknown; ParentProcessId?: unknown; Name?: unknown; CommandLine?: unknown; CreatedAtMs?: unknown };
    const pid = Number(data.ProcessId);
    if (!Number.isSafeInteger(pid) || pid <= 0 || typeof data.CommandLine !== "string") return [];
    const parentPid = optionalPositiveInteger(data.ParentProcessId);
    const createdAtMs = optionalPositiveInteger(data.CreatedAtMs);
    return [{
      pid,
      name: typeof data.Name === "string" ? data.Name : "",
      commandLine: data.CommandLine,
      ...(parentPid !== undefined ? { parentPid } : {}),
      ...(createdAtMs !== undefined ? { createdAtMs } : {}),
    }];
  });
}

function parsePosixBrowserProcessList(output: string): BrowserProcessInfo[] {
  const rows: BrowserProcessInfo[] = [];
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    if (!Number.isSafeInteger(pid) || pid <= 0) continue;
    const parentPid = optionalPositiveInteger(match[2]);
    rows.push({ pid, name: match[3], commandLine: match[4], ...(parentPid !== undefined ? { parentPid } : {}) });
  }
  return rows;
}

const WINDOWS_BROWSER_PROCESS_QUERY = [
  "$ErrorActionPreference = 'Stop';",
  "Get-CimInstance Win32_Process -Filter \"Name = 'chrome.exe' OR Name = 'msedge.exe' OR Name LIKE 'agent-browser%'\"",
  "| Select-Object ProcessId,ParentProcessId,Name,CommandLine,",
  "@{Name='CreatedAtMs';Expression={if ($_.CreationDate) { [DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds() }}}",
  "| ConvertTo-Json -Compress",
].join(" ");

/** Browser processes and agent-browser processes, with their parents. */
async function listBrowserProcesses(): Promise<BrowserProcessInfo[]> {
  if (platform() === "win32") {
    const { stdout } = await execFileAsync("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      WINDOWS_BROWSER_PROCESS_QUERY,
    ], { encoding: "utf-8", timeout: 5_000, windowsHide: true });
    return parseWindowsBrowserProcessJson(stdout);
  }

  const { stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid=,comm=,args="], {
    encoding: "utf-8",
    timeout: 5_000,
  });
  return parsePosixBrowserProcessList(stdout);
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
      "browser.queue.wait",
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
  const result = await runAgentBrowserJsonCommand(command, timeout, browserEnv(browserTarget));
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

function agentBrowserJsonOutput(command: BrowserCommand, envelope: AgentBrowserJsonEnvelope): string {
  if (!envelope.success) {
    if (typeof envelope.error === "string") return envelope.error;
    return envelope.error ? JSON.stringify(envelope.error) : "agent-browser command failed";
  }
  const data = envelope.data;
  if (!data) return "";
  if (command[0] === "get" && command[1] === "url" && typeof data.url === "string") return data.url;
  if (command[0] === "get" && command[1] === "title" && typeof data.title === "string") return data.title;
  if (command[0] === "get" && command[1] === "text" && typeof data.text === "string") return data.text;
  if (command[0] === "snapshot" && typeof data.snapshot === "string") return data.snapshot;
  if (command[0] === "open") {
    const title = typeof data.title === "string" ? data.title : "";
    const url = typeof data.url === "string" ? data.url : "";
    return [title, url].filter(Boolean).join("\n");
  }
  if (typeof data.message === "string") return data.message;
  if (typeof data.state === "string") return data.state;
  return "";
}

function parseAgentBrowserEnvelope(stdout: string): AgentBrowserJsonEnvelope | null {
  const trimmed = stdout.trim();
  if (!trimmed) return null;
  try {
    const envelope = JSON.parse(trimmed) as AgentBrowserJsonEnvelope;
    return typeof envelope.success === "boolean" ? envelope : null;
  } catch {
    return null;
  }
}

/**
 * The CLI client can print its JSON result without exiting promptly, so the command completes
 * as soon as stdout holds a complete JSON value and the lingering client is killed.
 */
async function runAgentBrowserJsonCommand(
  command: BrowserCommand,
  timeout: number,
  env: NodeJS.ProcessEnv,
): Promise<{ ok: boolean; output: string }> {
  let stdout = "";
  let stderr = "";
  let failure: unknown;
  try {
    const agentBrowserCommand = getAgentBrowserCommand();
    ({ stdout, stderr } = await getProcessHost().execFile(
      agentBrowserCommand.file,
      [...command, "--json"],
      {
        encoding: "utf-8",
        maxBuffer: 10 * 1024 * 1024,
        env,
        shell: agentBrowserCommand.shell,
        timeout,
        completeWhen: "stdout-json",
      },
    ));
  } catch (error) {
    failure = error;
    const commandError = error as { stdout?: unknown; stderr?: unknown };
    stdout = commandError.stdout?.toString() ?? "";
    stderr = commandError.stderr?.toString() ?? "";
  }

  const envelope = parseAgentBrowserEnvelope(stdout);
  if (envelope) return { ok: envelope.success, output: agentBrowserJsonOutput(command, envelope) };
  if (failure === undefined) return { ok: true, output: (stdout || stderr).trim() };

  const timedOut = (failure as { killed?: boolean }).killed === true;
  return {
    ok: false,
    output: stderr.trim()
      || stdout.trim()
      || (timedOut ? `agent-browser command timed out after ${timeout}ms` : String(failure)),
  };
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
  const command = file === "agent-browser"
    ? getAgentBrowserCommand()
    : { file, shell: platform() === "win32" };
  try {
    const { stdout, stderr } = await execFileAsync(command.file, args, {
      encoding: "utf-8",
      timeout,
      maxBuffer: 10 * 1024 * 1024,
      env: execOptions.env,
      shell: command.shell,
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

/** A process that is already gone needs no report: killing a browser takes its children with it. */
function isAlreadyGone(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | undefined)?.code === "ESRCH";
}

// One look after the first round of kills, for processes that appeared in the meantime.
const DISPOSABLE_PROFILE_KILL_PASSES = 2;

/**
 * Kills the browser processes of a profile. With `stopDaemons`, the agent-browser daemon that
 * owns them is killed first and the profile is looked at once more: a daemon whose browser
 * dies under a command it is still serving starts a new browser on the same profile.
 */
async function killProfileBoundBrowserProcesses(
  profileDir: string,
  metadata: Record<string, unknown>,
  options: { stopDaemons?: boolean } = {},
): Promise<{ terminatedPids: number[]; killedPids: number[]; remainingPids: number[]; stoppedDaemonPids: number[] }> {
  const terminatedPids: number[] = [];
  const killedPids: number[] = [];
  const remainingPids: number[] = [];
  const stoppedDaemonPids: number[] = [];
  // A killed process can stay in the process table for seconds; it must not be handled twice.
  const handledPids = new Set<number>();
  const passes = options.stopDaemons ? DISPOSABLE_PROFILE_KILL_PASSES : 1;

  for (let pass = 1; pass <= passes; pass++) {
    let allProcesses: BrowserProcessInfo[];
    try {
      allProcesses = await listBrowserProcesses();
    } catch (err) {
      logBrowser("recovery.profile_process_discovery_failed", {
        ...metadata,
        error: err instanceof Error ? err.message : String(err),
      });
      break;
    }
    const processes = allProcesses.filter((processInfo) =>
      isBrowserProcessForProfile(processInfo, profileDir) && !handledPids.has(processInfo.pid));
    if (processes.length === 0) break;

    if (options.stopDaemons) {
      for (const daemon of findOwningDaemons(allProcesses, processes)) {
        if (handledPids.has(daemon.pid)) continue;
        handledPids.add(daemon.pid);
        try {
          process.kill(daemon.pid, "SIGKILL");
          stoppedDaemonPids.push(daemon.pid);
        } catch (err) {
          if (isAlreadyGone(err)) continue;
          logBrowser("recovery.kill_profile_daemon_failed", {
            ...metadata,
            pid: daemon.pid,
            processName: daemon.name,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    let terminatedThisPass = 0;
    for (const processInfo of processes) {
      handledPids.add(processInfo.pid);
      try {
        process.kill(processInfo.pid, "SIGTERM");
        terminatedPids.push(processInfo.pid);
        terminatedThisPass += 1;
      } catch (err) {
        if (isAlreadyGone(err)) continue;
        logBrowser("recovery.kill_profile_process_failed", {
          ...metadata,
          pid: processInfo.pid,
          processName: processInfo.name,
          signal: "SIGTERM",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    if (terminatedThisPass > 0) await delay(BROWSER_PROFILE_SIGTERM_GRACE_MS);

    for (const processInfo of processes) {
      try {
        process.kill(processInfo.pid, 0);
      } catch {
        continue;
      }
      try {
        process.kill(processInfo.pid, "SIGKILL");
        killedPids.push(processInfo.pid);
      } catch (err) {
        if (isAlreadyGone(err)) continue;
        remainingPids.push(processInfo.pid);
        logBrowser("recovery.kill_profile_process_failed", {
          ...metadata,
          pid: processInfo.pid,
          processName: processInfo.name,
          signal: "SIGKILL",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }
  return { terminatedPids, killedPids, remainingPids, stoppedDaemonPids };
}

async function forceCloseProfileBoundBrowserProcesses(
  profileDir: string,
  telemetryStore: TelemetryStore | undefined,
  metadata: Record<string, unknown>,
  options: { stopDaemons?: boolean } = {},
): Promise<BrowserProcessCleanupResult> {
  const startedAt = Date.now();
  const { stoppedDaemonPids, ...result } = await killProfileBoundBrowserProcesses(profileDir, metadata, options);
  const stoppedDaemons = stoppedDaemonPids.length > 0 ? { stoppedDaemonPids } : {};
  const clearedRuntimeFiles = result.terminatedPids.length > 0 || result.killedPids.length > 0
    ? clearProfileRuntimeFiles(profileDir)
    : 0;
  const duration = Date.now() - startedAt;
  if (result.terminatedPids.length > 0 || result.killedPids.length > 0 || result.remainingPids.length > 0) {
    logBrowser("cleanup.kill_profile_processes", {
      ...metadata,
      ...result,
      ...stoppedDaemons,
      clearedRuntimeFiles,
      durationMs: duration,
    });
    safeRecordBrowserSpan(telemetryStore, "browser.cleanup.kill_profile_processes", duration, {
      ...metadata,
      ...result,
      ...stoppedDaemons,
      clearedRuntimeFiles,
    });
  }
  return { ...result, ...stoppedDaemons, clearedRuntimeFiles };
}

function buildBrowserShutdownResult(
  closeResult: { ok: boolean; output: string },
  cleanupResult: BrowserProcessCleanupResult,
  profileDir: string,
): BrowserShutdownResult {
  const closeFailureCode = closeResult.ok ? undefined : failureCode(closeResult.output);
  const closeFailureSignature = closeResult.ok ? null : failureSignature(closeResult.output);
  const closeOutputSummary = closeResult.ok ? undefined : summarizeCommandOutput(closeResult.output, profileDir);
  const remainingPids = cleanupResult.remainingPids;
  const failureCodeValue: BrowserShutdownFailureCode | undefined = remainingPids.length > 0
    ? "profile_processes_remaining"
    : closeFailureCode;
  const outputSummary = remainingPids.length > 0
    ? `Profile-bound browser processes remain after shutdown: ${remainingPids.join(", ")}`
    : closeOutputSummary;

  return {
    ok: closeResult.ok && remainingPids.length === 0,
    ...(failureCodeValue ? { failureCode: failureCodeValue } : {}),
    ...(outputSummary ? { outputSummary } : {}),
    closeOk: closeResult.ok,
    ...(closeFailureCode ? { closeFailureCode } : {}),
    ...(closeFailureSignature ? { closeFailureSignature } : {}),
    ...(closeOutputSummary ? { closeOutputSummary } : {}),
    ...cleanupResult,
  };
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

  if (failureCode(result.output) === "transport.connection_refused") {
    await delay(BROWSER_LOCK_OWNER_KILL_GRACE_MS);
    const retryStartedAt = Date.now();
    const retry = await runBrowserCommand(command, timeout, {
      ...options,
      browserTarget,
      browserOpId,
      attempt: 2,
      skipRecovery: true,
    });
    recordBrowserSpan(options.telemetryStore, "browser.recovery.retry", Date.now() - retryStartedAt, {
      browserOpId,
      toolName: options.toolName,
      browserSession: browserTarget.sessionName,
      commandName,
      signature,
      retryOutcome: retry.ok ? "succeeded" : "failed",
    });
    if (retry.ok) return retry;
  }

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
    // The command is retried on the same session, so its daemon stays.
    const { stoppedDaemonPids: _stoppedDaemonPids, ...killResult } =
      await killProfileBoundBrowserProcesses(browserTarget.profileDir, recoveryMetadata);
    if (killResult.terminatedPids.length > 0 || killResult.killedPids.length > 0) {
      const clearedRuntimeFiles = clearProfileRuntimeFiles(browserTarget.profileDir);
      const killDuration = Date.now() - killStartedAt;
      logBrowser("recovery.kill_profile_processes", {
        ...recoveryMetadata,
        ...killResult,
        clearedRuntimeFiles,
        durationMs: killDuration,
      });
      recordBrowserSpan(options.telemetryStore, "browser.recovery.kill_profile_processes", killDuration, {
        ...recoveryMetadata,
        ...killResult,
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
      await delay(BROWSER_LOCK_OWNER_KILL_GRACE_MS);
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
  return withQueuedLane(browserTarget.sessionName, undefined, {
    browserSession: browserTarget.sessionName,
  }, fn);
}

export async function shutdownBridgeBrowser(
  browserTarget: BrowserTarget = getBridgeBrowserTarget(),
  telemetryStore?: TelemetryStore,
): Promise<BrowserShutdownResult> {
  return withBridgeBrowserSession(browserTarget, async () => {
    const startedAt = Date.now();
    const env = browserEnv(browserTarget);
    const closeResult = await runAgentBrowserJsonCommand(["close"], 10_000, env);
    const forceCloseResult = await forceCloseProfileBoundBrowserProcesses(browserTarget.profileDir, telemetryStore, {
      browserSession: browserTarget.sessionName,
      ...(!closeResult.ok ? { closeFailureCode: failureCode(closeResult.output) } : {}),
      cleanupPhase: "primary_shutdown",
    }, { stopDaemons: browserTarget.disposable === true });
    if (forceCloseResult.stoppedDaemonPids?.length) {
      await removeDaemonStateFiles(browserTarget.sessionName, env);
    }
    const shutdownResult = buildBrowserShutdownResult(closeResult, forceCloseResult, browserTarget.profileDir);
    const duration = Date.now() - startedAt;
    recordBrowserSpan(telemetryStore, "browser.lifecycle.shutdown", duration, {
      session: browserTarget.sessionName,
      success: shutdownResult.ok,
      closeOk: shutdownResult.closeOk,
      failureCode: shutdownResult.failureCode,
      closeFailureCode: shutdownResult.closeFailureCode,
      closeFailureSignature: shutdownResult.closeFailureSignature,
      terminatedPids: shutdownResult.terminatedPids,
      killedPids: shutdownResult.killedPids,
      remainingPids: shutdownResult.remainingPids,
      clearedRuntimeFiles: shutdownResult.clearedRuntimeFiles,
    });
    logBrowser("lifecycle.shutdown", {
      session: browserTarget.sessionName,
      durationMs: duration,
      success: shutdownResult.ok,
      closeOk: shutdownResult.closeOk,
      failureCode: shutdownResult.failureCode,
      closeFailureCode: shutdownResult.closeFailureCode,
      closeFailureSignature: shutdownResult.closeFailureSignature,
      terminatedPids: shutdownResult.terminatedPids,
      killedPids: shutdownResult.killedPids,
      remainingPids: shutdownResult.remainingPids,
      clearedRuntimeFiles: shutdownResult.clearedRuntimeFiles,
    });
    return shutdownResult;
  });
}
