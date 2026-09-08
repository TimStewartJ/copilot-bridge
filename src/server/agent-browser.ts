// Shared agent-browser helpers with automatic recovery from stale Chrome state.

import { exec, execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync, unlinkSync } from "node:fs";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { homedir, platform } from "node:os";
import { promisify } from "node:util";
import type { TelemetryStore } from "./telemetry-store.js";

const DEFAULT_TIMEOUT = 30_000;
const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
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

function browserEnv(target: BrowserTarget): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGENT_BROWSER_NAMESPACE: "copilot-bridge",
    AGENT_BROWSER_SESSION: target.sessionName,
    AGENT_BROWSER_PROFILE: target.profileDir,
    ...(target.executablePath ? { AGENT_BROWSER_EXECUTABLE_PATH: target.executablePath } : {}),
  };
  if (target.headed) {
    env.AGENT_BROWSER_HEADED = "true";
  } else {
    delete env.AGENT_BROWSER_HEADED;
  }
  return env;
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

async function runAgentBrowserJsonCommand(
  command: BrowserCommand,
  timeout: number,
  env: NodeJS.ProcessEnv,
): Promise<{ ok: boolean; output: string }> {
  return new Promise((resolve) => {
    let child: ReturnType<typeof execFile> | undefined;
    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: { ok: boolean; output: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child?.kill();
      } catch {
        // The short-lived CLI client may already have exited.
      }
      resolve(result);
    };

    const parseCompleteJson = (): boolean => {
      const trimmed = stdout.trim();
      if (!trimmed) return false;
      try {
        const envelope = JSON.parse(trimmed) as AgentBrowserJsonEnvelope;
        if (typeof envelope.success !== "boolean") return false;
        finish({
          ok: envelope.success,
          output: agentBrowserJsonOutput(command, envelope),
        });
        return true;
      } catch {
        return false;
      }
    };

    const timer = setTimeout(() => {
      finish({
        ok: false,
        output: stderr.trim() || stdout.trim() || `agent-browser command timed out after ${timeout}ms`,
      });
    }, timeout);

    try {
      const agentBrowserCommand = getAgentBrowserCommand();
      child = execFile(
        agentBrowserCommand.file,
        [...command, "--json"],
        {
          encoding: "utf-8",
          maxBuffer: 10 * 1024 * 1024,
          env,
          shell: agentBrowserCommand.shell,
        },
        (error, stdoutValue, stderrValue) => {
          if (settled) return;
          const mockedResult = stdoutValue && typeof stdoutValue === "object"
            ? stdoutValue as { stdout?: unknown; stderr?: unknown }
            : undefined;
          stdout ||= mockedResult?.stdout?.toString() ?? stdoutValue?.toString() ?? "";
          stderr ||= mockedResult?.stderr?.toString() ?? stderrValue?.toString() ?? "";
          if (parseCompleteJson()) return;
          if (error) {
            const commandError = error as Error & { stderr?: unknown; stdout?: unknown };
            finish({
              ok: false,
              output: commandError.stderr?.toString().trim()
                || commandError.stdout?.toString().trim()
                || stderr.trim()
                || stdout.trim()
                || String(error),
            });
            return;
          }
          finish({
            ok: true,
            output: (stdout || stderr).trim(),
          });
        },
      );
      child.stdout?.on("data", (chunk) => {
        stdout += chunk.toString();
        parseCompleteJson();
      });
      child.stderr?.on("data", (chunk) => {
        stderr += chunk.toString();
      });
      child.on("error", (error) => {
        finish({
          ok: false,
          output: stderr.trim() || stdout.trim() || String(error),
        });
      });
    } catch (error) {
      finish({
        ok: false,
        output: error instanceof Error ? error.message : String(error),
      });
    }
  });
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

async function killProfileBoundBrowserProcesses(
  profileDir: string,
  metadata: Record<string, unknown>,
): Promise<{ terminatedPids: number[]; killedPids: number[]; remainingPids: number[] }> {
  let processes: BrowserProcessInfo[];
  try {
    processes = await findBrowserProcessesForProfile(profileDir);
  } catch (err) {
    logBrowser("recovery.profile_process_discovery_failed", {
      ...metadata,
      error: err instanceof Error ? err.message : String(err),
    });
    return { terminatedPids: [], killedPids: [], remainingPids: [] };
  }

  const terminatedPids: number[] = [];
  for (const processInfo of processes) {
    try {
      process.kill(processInfo.pid, "SIGTERM");
      terminatedPids.push(processInfo.pid);
    } catch (err) {
      logBrowser("recovery.kill_profile_process_failed", {
        ...metadata,
        pid: processInfo.pid,
        processName: processInfo.name,
        signal: "SIGTERM",
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (terminatedPids.length > 0) await delay(BROWSER_PROFILE_SIGTERM_GRACE_MS);

  const killedPids: number[] = [];
  const remainingPids: number[] = [];
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
  return { terminatedPids, killedPids, remainingPids };
}

async function forceCloseProfileBoundBrowserProcesses(
  profileDir: string,
  telemetryStore: TelemetryStore | undefined,
  metadata: Record<string, unknown>,
): Promise<BrowserProcessCleanupResult> {
  const startedAt = Date.now();
  const result = await killProfileBoundBrowserProcesses(profileDir, metadata);
  const clearedRuntimeFiles = result.terminatedPids.length > 0 || result.killedPids.length > 0
    ? clearProfileRuntimeFiles(profileDir)
    : 0;
  const duration = Date.now() - startedAt;
  if (result.terminatedPids.length > 0 || result.killedPids.length > 0 || result.remainingPids.length > 0) {
    logBrowser("cleanup.kill_profile_processes", {
      ...metadata,
      ...result,
      clearedRuntimeFiles,
      durationMs: duration,
    });
    safeRecordBrowserSpan(telemetryStore, "browser.cleanup.kill_profile_processes", duration, {
      ...metadata,
      ...result,
      clearedRuntimeFiles,
    });
  }
  return { ...result, clearedRuntimeFiles };
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
    const killResult = await killProfileBoundBrowserProcesses(browserTarget.profileDir, recoveryMetadata);
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
    const closeResult = await runAgentBrowserJsonCommand(["close"], 10_000, browserEnv(browserTarget));
    const forceCloseResult = await forceCloseProfileBoundBrowserProcesses(browserTarget.profileDir, telemetryStore, {
      browserSession: browserTarget.sessionName,
      ...(!closeResult.ok ? { closeFailureCode: failureCode(closeResult.output) } : {}),
      cleanupPhase: "primary_shutdown",
    });
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
