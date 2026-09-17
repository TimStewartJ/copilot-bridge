// Platform abstraction — encapsulates OS-specific operations behind a unified API.
// Windows uses one CIM snapshot + one taskkill + one verification snapshot.

import { execFile, type ExecFileOptions } from "node:child_process";
import { existsSync, lstatSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve, win32 } from "node:path";
import {
  capDeadline,
  deadlineBefore,
  deadlineExpired,
  remainingMs,
  sleepUntilDeadline,
  type Deadline,
} from "./deadline.js";

function execFileAsync(
  command: string,
  args: readonly string[],
  options: ExecFileOptions,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(command, [...args], options, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({
        stdout: Buffer.isBuffer(stdout) ? stdout.toString("utf8") : String(stdout ?? ""),
        stderr: Buffer.isBuffer(stderr) ? stderr.toString("utf8") : String(stderr ?? ""),
      });
    });
  });
}

// A loaded Windows host (~900 processes) has needed more than 8s for one CIM snapshot.
export const PROCESS_TABLE_READ_TIMEOUT_MS = 20_000;
const PROCESS_IDENTITY_READ_TIMEOUT_MS = PROCESS_TABLE_READ_TIMEOUT_MS;
const PROCESS_TABLE_MAX_BUFFER = 16 * 1024 * 1024;
const TASKKILL_TIMEOUT_MS = 5_000;
const PROCESS_TREE_DEADLINE_OVERHEAD_MS = 3_000;
const PROCESS_TABLE_VERIFICATION_RESERVE_MS = PROCESS_TABLE_READ_TIMEOUT_MS;
// Initial snapshot, taskkill, and verification snapshot, plus process spawn overhead.
export const PROCESS_TREE_TERMINATION_BUDGET_MS =
  (PROCESS_TABLE_READ_TIMEOUT_MS * 2) + TASKKILL_TIMEOUT_MS + PROCESS_TREE_DEADLINE_OVERHEAD_MS;
const WINDOWS_PROCESS_TABLE_COMMAND = [
  // Fetch only the parsed properties. Materializing every Win32_Process
  // property is roughly twice as slow and pushes loaded machines past the
  // snapshot timeout.
  "Get-CimInstance Win32_Process -Property ProcessId,ParentProcessId,CreationDate |",
  "ForEach-Object {",
  "$t = '';",
  "if ($_.CreationDate) { try { $t = $_.CreationDate.ToUniversalTime().Ticks } catch { $t = '' } }",
  "\"$($_.ProcessId) $($_.ParentProcessId) $t\"",
  "}",
].join(" ");

type ProcessTableEntry = { ppid: number; startMarker: string };
type ProcessTableReadResult =
  | { ok: true; table: Map<number, ProcessTableEntry> }
  | { ok: false; error: string };

export type ProcessTreeSnapshot = {
  root: ProcessIdentity;
  descendants: ProcessIdentity[];
};

export type ProcessIdentity = Readonly<{
  pid: number;
  startMarker: string;
}>;

export type ProcessTreeTerminationResult =
  | {
      ok: true;
      status: "already-exited" | "identity-replaced" | "terminated";
      root: ProcessIdentity;
      snapshot?: ProcessTreeSnapshot;
      commandError?: string;
    }
  | {
      ok: false;
      status:
        | "invalid-identity"
        | "snapshot-unavailable"
        | "identity-unavailable"
        | "deadline-exceeded"
        | "kill-failed"
        | "survivors";
      root: ProcessIdentity;
      snapshot?: ProcessTreeSnapshot;
      survivors?: ProcessIdentity[];
      error?: string;
      /** The kill command ran out of time before it finished; the captured tree may be partly terminated. */
      commandTimedOut?: boolean;
    };

export interface ProcessTreeTerminationObservation {
  phase: "snapshot" | "terminate" | "verify";
  durationMs: number;
  outcome: "completed" | "failed";
  pid?: number;
  error?: string;
}

export type ProcessIdentityStatus = "alive" | "exited" | "replaced" | "unknown";

export type DeviceHibernateCommand = {
  platform: NodeJS.Platform;
  command: string;
  args: string[];
};

function isWindows(): boolean {
  return process.platform === "win32";
}

export function getDeviceHibernateCommand(platform: NodeJS.Platform = process.platform): DeviceHibernateCommand {
  switch (platform) {
    case "win32":
      return { platform, command: "shutdown.exe", args: ["/h"] };
    case "linux":
      return { platform, command: "systemctl", args: ["hibernate"] };
    case "darwin":
      throw new Error("Device hibernation is not supported on macOS by Copilot Bridge.");
    default:
      throw new Error(`Device hibernation is not supported on ${platform}.`);
  }
}

function stringifyProcessOutput(value: unknown): string {
  if (Buffer.isBuffer(value)) return value.toString("utf8").trim();
  return typeof value === "string" ? value.trim() : "";
}

function formatExecFileError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const output = [
    stringifyProcessOutput((error as NodeJS.ErrnoException & { stderr?: unknown }).stderr),
    stringifyProcessOutput((error as NodeJS.ErrnoException & { stdout?: unknown }).stdout),
  ].filter(Boolean);
  return output.length > 0 ? `${error.message}: ${output.join(" ")}` : error.message;
}

export async function requestDeviceHibernate(
  hibernateCommand: DeviceHibernateCommand = getDeviceHibernateCommand(),
): Promise<DeviceHibernateCommand> {
  try {
    await execFileAsync(hibernateCommand.command, hibernateCommand.args, {
      timeout: 10_000,
      windowsHide: true,
    });
    return hibernateCommand;
  } catch (error) {
    throw new Error(
      `Failed to request device hibernation via ${hibernateCommand.command}: ${formatExecFileError(error)}`,
    );
  }
}

function isValidPid(pid: number): boolean {
  return Number.isSafeInteger(pid) && pid > 0;
}

function assertValidPid(pid: number): number {
  if (!isValidPid(pid)) {
    throw new RangeError(`Invalid process id: ${pid}`);
  }
  return pid;
}

function parseWindowsProcessTable(output: string): Map<number, ProcessTableEntry> {
  const table = new Map<number, ProcessTableEntry>();
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/);
    if (parts.length < 2) continue;
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    if (!isValidPid(pid) || !Number.isSafeInteger(ppid) || ppid < 0) continue;
    // Windows CreationDate ticks are 18-digit values that exceed Number.MAX_SAFE_INTEGER,
    // so the marker is kept as a string and only compared numerically via BigInt.
    const startMarker = parts[2] && /^\d+$/.test(parts[2]) ? parts[2] : "";
    table.set(pid, { ppid, startMarker });
  }
  return table;
}

function parsePosixProcessTable(output: string): Map<number, ProcessTableEntry> {
  const table = new Map<number, ProcessTableEntry>();
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const ppid = Number(match[2]);
    if (!isValidPid(pid) || !Number.isSafeInteger(ppid) || ppid < 0) continue;
    table.set(pid, { ppid, startMarker: match[3]?.trim() ?? "" });
  }
  return table;
}

function commandError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** execFile sets `killed` when it terminated the command itself, which it does only on timeout or output overflow. */
function wasKilledByTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const failure = error as Error & { code?: unknown; killed?: unknown };
  return failure.killed === true && failure.code !== "ERR_CHILD_PROCESS_STDIO_MAXBUFFER";
}

/**
 * execFile's own message is just "Command failed: <full command line>", which
 * hides why a process command failed. Name the operation and the reason instead.
 */
function describeProcessCommandFailure(label: string, error: unknown, timeoutMs: number): string {
  if (!(error instanceof Error)) return `${label} failed: ${String(error)}`;
  const failure = error as Error & { code?: unknown; killed?: unknown; signal?: unknown; stderr?: unknown };
  const reason = failure.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
    ? "exceeded its output buffer"
    : wasKilledByTimeout(error)
      ? `timed out after ${timeoutMs}ms`
      : typeof failure.code === "number"
        ? `exited with code ${failure.code}`
        : typeof failure.code === "string"
          ? `failed to start (${failure.code})`
          : typeof failure.signal === "string"
            ? `was terminated by ${failure.signal}`
            : `failed: ${failure.message.split(/\r?\n/)[0]}`;
  const stderr = stringifyProcessOutput(failure.stderr);
  return stderr ? `${label} ${reason}: ${stderr}` : `${label} ${reason}`;
}

async function readWindowsProcessTable(
  deadline: Deadline,
  timeoutCapMs = PROCESS_TABLE_READ_TIMEOUT_MS,
): Promise<ProcessTableReadResult> {
  const timeoutMs = remainingMs(deadline, timeoutCapMs);
  if (timeoutMs <= 0) return { ok: false, error: "deadline exceeded before CIM snapshot" };
  try {
    const { stdout } = await execFileAsync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROCESS_TABLE_COMMAND],
      {
        encoding: "utf8",
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: PROCESS_TABLE_MAX_BUFFER,
      },
    );
    return { ok: true, table: parseWindowsProcessTable(String(stdout)) };
  } catch (error) {
    return { ok: false, error: describeProcessCommandFailure("CIM process snapshot", error, timeoutMs) };
  }
}

async function readPosixProcessTable(
  deadline: Deadline,
  timeoutCapMs = PROCESS_TABLE_READ_TIMEOUT_MS,
): Promise<ProcessTableReadResult> {
  const timeoutMs = remainingMs(deadline, timeoutCapMs);
  if (timeoutMs <= 0) return { ok: false, error: "deadline exceeded before ps snapshot" };
  try {
    const { stdout } = await execFileAsync(
      "ps",
      ["-eo", "pid=,ppid=,lstart="],
      {
        encoding: "utf8",
        timeout: timeoutMs,
        maxBuffer: PROCESS_TABLE_MAX_BUFFER,
        env: { ...process.env, LC_ALL: "C", TZ: "UTC" },
      },
    );
    return { ok: true, table: parsePosixProcessTable(String(stdout)) };
  } catch (error) {
    return { ok: false, error: describeProcessCommandFailure("ps process snapshot", error, timeoutMs) };
  }
}

function readProcessTable(
  deadline: Deadline,
  timeoutCapMs = PROCESS_TABLE_READ_TIMEOUT_MS,
): Promise<ProcessTableReadResult> {
  return isWindows()
    ? readWindowsProcessTable(deadline, timeoutCapMs)
    : readPosixProcessTable(deadline, timeoutCapMs);
}

// Drop child-before-parent edges. They indicate that a recycled PID, not the
// captured parent, owns the relationship represented by this snapshot.
function collectDescendantIdentities(
  rootPid: number,
  table: Map<number, ProcessTableEntry>,
): { descendants: ProcessIdentity[]; missingMarker: boolean } {
  const childrenByParent = new Map<number, number[]>();
  for (const [pid, entry] of table) {
    if (pid === entry.ppid) continue;
    const parent = table.get(entry.ppid);
    if (parent && entry.startMarker && parent.startMarker) {
      try {
        if (BigInt(entry.startMarker) < BigInt(parent.startMarker)) continue;
      } catch { /* non-numeric marker — keep the edge */ }
    }
    const children = childrenByParent.get(entry.ppid) ?? [];
    children.push(pid);
    childrenByParent.set(entry.ppid, children);
  }

  const descendants: ProcessIdentity[] = [];
  let missingMarker = false;
  const seen = new Set<number>([rootPid]);
  const queue = [...(childrenByParent.get(rootPid) ?? [])];
  while (queue.length > 0) {
    const pid = queue.shift();
    if (pid === undefined || seen.has(pid)) continue;
    seen.add(pid);
    const entry = table.get(pid);
    if (!entry?.startMarker) {
      missingMarker = true;
    } else {
      descendants.push({ pid, startMarker: entry.startMarker });
    }
    queue.push(...(childrenByParent.get(pid) ?? []));
  }
  return { descendants, missingMarker };
}

export function shouldSpawnDetachedProcessGroup(): boolean {
  return !isWindows();
}

/**
 * Concise process-tree sampling helper for telemetry.
 *
 * Reads exactly one bounded process-table snapshot, resolves the root
 * identity from that snapshot, and returns a {@link ProcessTreeSnapshot}
 * containing the root and all reachable descendants with valid start markers.
 * Returns null when the deadline is expired, the snapshot cannot be read, or
 * the root PID is absent or has no start marker in the snapshot.
 */
export async function sampleProcessTree(
  rootPid: number,
  deadline: Deadline,
): Promise<ProcessTreeSnapshot | null> {
  if (!isValidPid(rootPid) || deadlineExpired(deadline)) return null;
  const result = await readProcessTable(capDeadline(deadline, PROCESS_TABLE_READ_TIMEOUT_MS));
  if (!result.ok) return null;
  const rootEntry = result.table.get(rootPid);
  if (!rootEntry?.startMarker) return null;
  const root: ProcessIdentity = { pid: rootPid, startMarker: rootEntry.startMarker };
  const { descendants } = collectDescendantIdentities(rootPid, result.table);
  return { root, descendants };
}

export async function captureProcessIdentity(
  pid: number,
  deadline: Deadline,
): Promise<ProcessIdentity | null> {
  if (!isValidPid(pid) || deadlineExpired(deadline)) return null;
  const result = await readProcessTable(deadline, PROCESS_IDENTITY_READ_TIMEOUT_MS);
  if (!result.ok) return null;
  const entry = result.table.get(pid);
  return entry?.startMarker ? { pid, startMarker: entry.startMarker } : null;
}

export async function getProcessIdentityStatuses(
  identities: readonly ProcessIdentity[],
  deadline: Deadline,
): Promise<ReadonlyMap<ProcessIdentity, ProcessIdentityStatus>> {
  const statuses = new Map<ProcessIdentity, ProcessIdentityStatus>(identities.map((identity) => [identity, "unknown"]));
  if (identities.length === 0 || deadlineExpired(deadline)) return statuses;
  const result = await readProcessTable(deadline, PROCESS_IDENTITY_READ_TIMEOUT_MS);
  if (!result.ok) return statuses;
  for (const identity of identities) {
    if (!isValidPid(identity.pid) || !identity.startMarker) continue;
    const entry = result.table.get(identity.pid);
    statuses.set(identity, !entry ? "exited" : !entry.startMarker ? "unknown"
      : entry.startMarker === identity.startMarker ? "alive" : "replaced");
  }
  return statuses;
}

export async function getProcessIdentityStatus(
  identity: ProcessIdentity,
  deadline: Deadline,
): Promise<ProcessIdentityStatus> {
  return (await getProcessIdentityStatuses([identity], deadline)).get(identity) ?? "unknown";
}

function parseProcessStartMarkerMs(
  startMarker: string,
  platform: NodeJS.Platform = process.platform,
): number | undefined {
  if (!startMarker) return undefined;
  if (platform === "win32") {
    try {
      const ticks = BigInt(startMarker);
      const unixEpochTicks = 621_355_968_000_000_000n;
      if (ticks < unixEpochTicks) return undefined;
      const milliseconds = Number((ticks - unixEpochTicks) / 10_000n);
      return Number.isSafeInteger(milliseconds) ? milliseconds : undefined;
    } catch {
      return undefined;
    }
  }
  const milliseconds = Date.parse(`${startMarker} UTC`);
  return Number.isFinite(milliseconds) ? milliseconds : undefined;
}

/**
 * Read process start times with one bounded process-table snapshot. Callers can
 * pair these with PID-bearing files to reject stale files after PID reuse.
 */
export async function captureProcessStartTimes(
  pids: readonly number[],
  deadline: Deadline,
): Promise<Map<number, number> | null> {
  const requested = new Set(pids.filter(isValidPid));
  if (requested.size === 0) return new Map();
  if (deadlineExpired(deadline)) return null;

  const result = await readProcessTable(deadline, PROCESS_IDENTITY_READ_TIMEOUT_MS);
  if (!result.ok) return null;

  const startTimes = new Map<number, number>();
  for (const pid of requested) {
    const marker = result.table.get(pid)?.startMarker;
    if (!marker) continue;
    const startTimeMs = parseProcessStartMarkerMs(marker);
    if (startTimeMs !== undefined) startTimes.set(pid, startTimeMs);
  }
  return startTimes;
}

function identityMatches(table: Map<number, ProcessTableEntry>, identity: ProcessIdentity): boolean {
  return table.get(identity.pid)?.startMarker === identity.startMarker;
}

function matchingIdentities(
  table: Map<number, ProcessTableEntry>,
  identities: ProcessIdentity[],
): ProcessIdentity[] {
  return identities.filter((identity) => identityMatches(table, identity));
}

type TreeKillOutcome = {
  error?: string;
  /** The command did not get, or did not finish within, its share of the deadline. */
  timedOut: boolean;
};

async function requestWindowsTreeKill(
  identity: ProcessIdentity,
  deadline: Deadline,
): Promise<TreeKillOutcome> {
  const budgetMs = remainingMs(deadline);
  const verificationReserveMs = budgetMs > PROCESS_TABLE_VERIFICATION_RESERVE_MS
    ? PROCESS_TABLE_VERIFICATION_RESERVE_MS
    : Math.floor(budgetMs / 2);
  const killDeadline = deadlineBefore(deadline, verificationReserveMs);
  const timeoutMs = remainingMs(killDeadline, TASKKILL_TIMEOUT_MS);
  if (timeoutMs <= 0) return { error: "deadline exceeded before taskkill", timedOut: true };
  try {
    await execFileAsync("taskkill", ["/T", "/F", "/PID", String(identity.pid)], {
      windowsHide: true,
      timeout: timeoutMs,
    });
    return { timedOut: false };
  } catch (error) {
    return { error: describeProcessCommandFailure("taskkill", error, timeoutMs), timedOut: wasKilledByTimeout(error) };
  }
}

function requestPosixTreeKill(snapshot: ProcessTreeSnapshot): string | undefined {
  const errors: string[] = [];
  for (const identity of [...snapshot.descendants].reverse().concat(snapshot.root)) {
    try {
      process.kill(identity.pid, "SIGKILL");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ESRCH") errors.push(`${identity.pid}: ${commandError(error)}`);
    }
  }
  return errors.length > 0 ? errors.join("; ") : undefined;
}

/**
 * Identity-safe, bounded process-tree termination.
 *
 * Windows performs exactly one pre-kill CIM snapshot, one taskkill /T /F, and
 * one verification CIM snapshot. It has no WMIC, per-PID PowerShell, or
 * bare-PID fallback path.
 */
export async function terminateProcessTree(
  root: ProcessIdentity,
  deadline: Deadline,
  onPhase?: (observation: ProcessTreeTerminationObservation) => void,
): Promise<ProcessTreeTerminationResult> {
  if (!isValidPid(root.pid) || !root.startMarker) {
    return { ok: false, status: "invalid-identity", root };
  }
  if (deadlineExpired(deadline)) {
    return { ok: false, status: "deadline-exceeded", root };
  }

  const snapshotStartedAt = performance.now();
  const initial = await readProcessTable(capDeadline(deadline, PROCESS_TABLE_READ_TIMEOUT_MS));
  onPhase?.({ phase: "snapshot", durationMs: performance.now() - snapshotStartedAt,
    outcome: initial.ok ? "completed" : "failed", pid: root.pid, ...(!initial.ok ? { error: initial.error } : {}) });
  if (!initial.ok) {
    return {
      ok: false,
      status: deadlineExpired(deadline) ? "deadline-exceeded" : "snapshot-unavailable",
      root,
      error: initial.error,
    };
  }

  const currentRoot = initial.table.get(root.pid);
  if (!currentRoot) return { ok: true, status: "already-exited", root };
  if (!currentRoot.startMarker) {
    return { ok: false, status: "identity-unavailable", root, error: "The root process did not have a creation marker." };
  }
  if (currentRoot.startMarker !== root.startMarker) {
    return { ok: true, status: "identity-replaced", root };
  }

  const { descendants, missingMarker } = collectDescendantIdentities(root.pid, initial.table);
  if (!currentRoot.startMarker || missingMarker) {
    return {
      ok: false,
      status: "identity-unavailable",
      root,
      error: "A process in the captured tree did not have a creation marker.",
    };
  }
  const snapshot: ProcessTreeSnapshot = { root, descendants };
  const terminationStartedAt = performance.now();
  const kill: TreeKillOutcome = isWindows()
    ? await requestWindowsTreeKill(root, deadline)
    : { error: requestPosixTreeKill(snapshot), timedOut: false };
  const commandFailure = kill.error;
  onPhase?.({ phase: "terminate", durationMs: performance.now() - terminationStartedAt,
    outcome: commandFailure ? "failed" : "completed", pid: root.pid, ...(commandFailure ? { error: commandFailure } : {}) });

  if (deadlineExpired(deadline)) {
    return {
      ok: false,
      status: "deadline-exceeded",
      root,
      snapshot,
      error: commandFailure,
    };
  }

  if (!isWindows()) {
    await sleepUntilDeadline(25, deadline);
  }
  const verificationStartedAt = performance.now();
  const verification = await readProcessTable(deadline);
  if (!verification.ok) {
    onPhase?.({ phase: "verify", durationMs: performance.now() - verificationStartedAt,
      outcome: "failed", pid: root.pid, error: verification.error });
    return {
      ok: false,
      status: deadlineExpired(deadline) ? "deadline-exceeded" : "snapshot-unavailable",
      root,
      snapshot,
      error: verification.error,
    };
  }

  const uncertain = [root, ...descendants].find((identity) => {
    const entry = verification.table.get(identity.pid);
    return entry && !entry.startMarker;
  });
  if (uncertain) {
    const error = `Cannot verify process identity for PID ${uncertain.pid}.`;
    onPhase?.({ phase: "verify", durationMs: performance.now() - verificationStartedAt,
      outcome: "failed", pid: root.pid, error });
    return { ok: false, status: "identity-unavailable", root, snapshot, error };
  }
  const survivors = matchingIdentities(verification.table, [root, ...descendants]);
  onPhase?.({ phase: "verify", durationMs: performance.now() - verificationStartedAt,
    outcome: survivors.length === 0 ? "completed" : "failed", pid: root.pid,
    ...(survivors.length > 0 ? { error: `${survivors.length} owned process(es) still alive` } : {}) });
  if (survivors.length === 0) {
    return {
      ok: true,
      status: "terminated",
      root,
      snapshot,
      ...(commandFailure ? { commandError: commandFailure } : {}),
    };
  }
  return {
    ok: false,
    status: commandFailure ? "kill-failed" : "survivors",
    root,
    snapshot,
    survivors,
    ...(commandFailure ? { error: commandFailure } : {}),
    ...(kill.timedOut ? { commandTimedOut: true } : {}),
  };
}

/**
 * Create a directory junction (Windows) or symlink (Linux).
 * Both allow sharing node_modules without copying.
 */
export function createDirectoryLink(
  linkPath: string,
  targetPath: string,
  cwd: string,
): { ok: boolean; output: string } {
  try {
    symlinkSync(resolve(cwd, targetPath), resolve(cwd, linkPath), isWindows() ? "junction" : "dir");
    return { ok: true, output: "" };
  } catch (err: any) {
    return { ok: false, output: err.stderr || err.stdout || String(err) };
  }
}

/**
 * Remove a directory junction (Windows) or symlink (Linux)
 * without recursing into the target directory.
 * Refuses to delete real directories — callers that need recursive
 * deletion should use rmSync directly.
 */
export function removeDirectoryLink(
  linkPath: string,
  _cwd: string,
): { ok: boolean; output: string } {
  try {
    const stat = lstatSync(linkPath);
    if (stat.isSymbolicLink()) {
      rmSync(linkPath);
      return { ok: true, output: "" };
    } else if (stat.isDirectory()) {
      return { ok: false, output: `Refusing to delete real directory: ${linkPath}` };
    }
    // Exists but is neither a link nor a directory (e.g. a regular file):
    // nothing was removed, so reporting success would mask a no-op.
    return { ok: false, output: `Refusing to delete non-link path: ${linkPath}` };
  } catch (err: any) {
    if (err.code === "ENOENT") return { ok: true, output: "already removed" };
    return { ok: false, output: String(err) };
  }
}

interface WindowsSchedulingApi {
  getCurrentProcess(): unknown;
  setProcessPowerThrottling(process: unknown, state: { Version: number; ControlMask: number; StateMask: number }): number;
  setPriorityClass(process: unknown, priorityClass: number): number;
}

async function loadWindowsSchedulingApi(): Promise<WindowsSchedulingApi> {
  const imported = await import("koffi");
  const koffi = (imported as { default?: unknown }).default ?? imported;
  const api = koffi as {
    load(name: string): { func(signature: string): (...args: unknown[]) => unknown };
    struct(name: string, fields: Record<string, string>): unknown;
  };
  const kernel32 = api.load("kernel32.dll");
  api.struct("BRIDGE_PROCESS_POWER_THROTTLING_STATE", { Version: "uint32", ControlMask: "uint32", StateMask: "uint32" });
  const getCurrentProcess = kernel32.func("void* __stdcall GetCurrentProcess()");
  const setProcessInformation = kernel32.func(
    "int __stdcall SetProcessInformation(void* hProcess, int infoClass, BRIDGE_PROCESS_POWER_THROTTLING_STATE* info, uint32 size)",
  );
  const setPriorityClass = kernel32.func("int __stdcall SetPriorityClass(void* hProcess, uint32 priorityClass)");
  return {
    getCurrentProcess: () => getCurrentProcess(),
    setProcessPowerThrottling: (process, state) => Number(setProcessInformation(process, 4, state, 12)),
    setPriorityClass: (process, priorityClass) => Number(setPriorityClass(process, priorityClass)),
  };
}

const PROCESS_POWER_THROTTLING_EXECUTION_SPEED = 0x1;
const ABOVE_NORMAL_PRIORITY_CLASS = 0x8000;

/**
 * The OS tar binary used to unpack runtime-downloaded archives. Windows ships bsdtar in
 * System32 (gzip and bzip2 support); prefer it over any GNU tar earlier on PATH, which
 * misreads drive-letter paths as remote hosts.
 */
export function resolveTarCommand(options: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  exists?: (path: string) => boolean;
} = {}): string {
  const platform = options.platform ?? process.platform;
  if (platform !== "win32") return "tar";
  const env = options.env ?? process.env;
  const systemRoot = env.SystemRoot || env.SYSTEMROOT || env.windir || "C:\\Windows";
  const candidate = win32.join(systemRoot, "System32", "tar.exe");
  return (options.exists ?? existsSync)(candidate) ? candidate : "tar";
}

/**
 * Opts the current process out of Windows EcoQoS so latency-sensitive native inference
 * runs on performance cores. Hidden background processes are otherwise scheduled onto
 * efficiency cores, which made local speech models 3-10x slower on hybrid CPUs.
 */
export async function preferHighPerformanceScheduling(options: {
  platform?: NodeJS.Platform;
  loadApi?: () => Promise<WindowsSchedulingApi>;
} = {}): Promise<{ applied: boolean; detail?: string }> {
  if ((options.platform ?? process.platform) !== "win32") return { applied: false, detail: "not windows" };
  try {
    const api = await (options.loadApi ?? loadWindowsSchedulingApi)();
    const handle = api.getCurrentProcess();
    const qos = api.setProcessPowerThrottling(handle, {
      Version: 1,
      ControlMask: PROCESS_POWER_THROTTLING_EXECUTION_SPEED,
      StateMask: 0,
    });
    const priority = api.setPriorityClass(handle, ABOVE_NORMAL_PRIORITY_CLASS);
    return { applied: qos !== 0, detail: `highQoS=${qos !== 0} aboveNormal=${priority !== 0}` };
  } catch (error) {
    return { applied: false, detail: error instanceof Error ? error.message : String(error) };
  }
}
