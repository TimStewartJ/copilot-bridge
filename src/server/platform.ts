// Platform abstraction — encapsulates OS-specific operations behind a unified API.
// Windows uses one CIM snapshot + one taskkill + one verification snapshot.

import { execFile, type ExecFileOptions } from "node:child_process";
import { lstatSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
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

const PROCESS_TABLE_READ_TIMEOUT_MS = 8_000;
const PROCESS_IDENTITY_READ_TIMEOUT_MS = 10_000;
const PROCESS_TABLE_MAX_BUFFER = 16 * 1024 * 1024;
const TASKKILL_TIMEOUT_MS = 5_000;
const PROCESS_TABLE_VERIFICATION_RESERVE_MS = PROCESS_TABLE_READ_TIMEOUT_MS;
export const PROCESS_TREE_TERMINATION_BUDGET_MS = 25_000;
const WINDOWS_PROCESS_TABLE_COMMAND = [
  "Get-CimInstance Win32_Process |",
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
        | "survivors"
        | "unverified";
      root: ProcessIdentity;
      snapshot?: ProcessTreeSnapshot;
      survivors?: ProcessIdentity[];
      error?: string;
    };

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
    return { ok: false, error: commandError(error) };
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
      { encoding: "utf8", timeout: timeoutMs, maxBuffer: PROCESS_TABLE_MAX_BUFFER },
    );
    return { ok: true, table: parsePosixProcessTable(String(stdout)) };
  } catch (error) {
    return { ok: false, error: commandError(error) };
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

function identityMatches(table: Map<number, ProcessTableEntry>, identity: ProcessIdentity): boolean {
  return table.get(identity.pid)?.startMarker === identity.startMarker;
}

function matchingIdentities(
  table: Map<number, ProcessTableEntry>,
  identities: ProcessIdentity[],
): ProcessIdentity[] {
  return identities.filter((identity) => identityMatches(table, identity));
}

function matchingProcessTrees(
  table: Map<number, ProcessTableEntry>,
  identities: ProcessIdentity[],
): { survivors: ProcessIdentity[]; missingMarker: boolean } {
  const survivors = new Map<string, ProcessIdentity>();
  let missingMarker = false;
  for (const identity of matchingIdentities(table, identities)) {
    survivors.set(`${identity.pid}:${identity.startMarker}`, identity);
    const collected = collectDescendantIdentities(identity.pid, table);
    missingMarker ||= collected.missingMarker;
    for (const descendant of collected.descendants) {
      survivors.set(`${descendant.pid}:${descendant.startMarker}`, descendant);
    }
  }
  return { survivors: [...survivors.values()], missingMarker };
}

async function requestWindowsTreeKill(
  identity: ProcessIdentity,
  deadline: Deadline,
): Promise<string | undefined> {
  const killDeadline = deadlineBefore(deadline, PROCESS_TABLE_VERIFICATION_RESERVE_MS);
  const timeoutMs = remainingMs(killDeadline, TASKKILL_TIMEOUT_MS);
  if (timeoutMs <= 0) return "deadline exceeded before taskkill";
  try {
    await execFileAsync("taskkill", ["/T", "/F", "/PID", String(identity.pid)], {
      windowsHide: true,
      timeout: timeoutMs,
    });
    return undefined;
  } catch (error) {
    return commandError(error);
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
): Promise<ProcessTreeTerminationResult> {
  if (!isValidPid(root.pid) || !root.startMarker) {
    return { ok: false, status: "invalid-identity", root };
  }
  if (deadlineExpired(deadline)) {
    return { ok: false, status: "deadline-exceeded", root };
  }

  const initial = await readProcessTable(capDeadline(deadline, PROCESS_TABLE_READ_TIMEOUT_MS));
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
  const commandFailure = isWindows()
    ? await requestWindowsTreeKill(root, deadline)
    : requestPosixTreeKill(snapshot);

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
  const verification = await readProcessTable(deadline);
  if (!verification.ok) {
    return {
      ok: false,
      status: deadlineExpired(deadline) ? "deadline-exceeded" : "snapshot-unavailable",
      root,
      snapshot,
      error: verification.error,
    };
  }

  const {
    survivors,
    missingMarker: survivorMissingMarker,
  } = matchingProcessTrees(verification.table, [root, ...descendants]);
  if (survivorMissingMarker) {
    return {
      ok: false,
      status: "identity-unavailable",
      root,
      snapshot,
      survivors,
      error: "A surviving process in the captured tree did not have a creation marker.",
    };
  }
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
    return { ok: true, output: "" };
  } catch (err: any) {
    if (err.code === "ENOENT") return { ok: true, output: "already removed" };
    return { ok: false, output: String(err) };
  }
}
