// Shared agent-browser helpers with automatic recovery from stale Chrome state.

import { exec, execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync, readlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";
import type { TelemetryStore } from "./telemetry-store.js";

const DEFAULT_TIMEOUT = 30_000;
const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);
const LOCK_FILES = ["SingletonLock", "SingletonSocket", "SingletonCookie"];
const WEDGE_SIGNATURES = [
  "DevToolsActivePort",
  "Chrome exited early",
  "Broken pipe",
  "broken pipe",
];

const sessionQueues = new Map<string, Promise<void>>();

export interface BrowserTarget {
  sessionName: string;
  profileDir: string;
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

function logBrowser(event: string, data: Record<string, unknown>): void {
  console.log(`[browser] ${JSON.stringify({ event, ...data })}`);
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
    return joined.includes(profileDir) || joined.includes(`--user-data-dir=${profileDir}`);
  } catch {
    return false;
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
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
    });
    const output = stdout || stderr;
    return { ok: true, output: output.trim() };
  } catch (err: any) {
    return { ok: false, output: err.stderr || err.stdout || String(err) };
  }
}

/** Remove stale Chrome profile lock files if the owning process is gone. */
function clearStaleLocks(profileDir: string): boolean {
  try {
    const lock = readLockOwner(profileDir);
    if (!lock?.pid || lock.alive) return false;

    for (const name of LOCK_FILES) {
      try {
        unlinkSync(join(profileDir, name));
      } catch {
        // may not exist
      }
    }
    return true;
  } catch {
    return false;
  }
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
  const previous = sessionQueues.get(browserTarget.sessionName) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const current = previous.catch(() => undefined).then(() => gate);
  sessionQueues.set(browserTarget.sessionName, current);
  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (sessionQueues.get(browserTarget.sessionName) === current) {
      sessionQueues.delete(browserTarget.sessionName);
    }
  }
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
