// Platform abstraction — encapsulates OS-specific operations behind a unified API.
// Windows uses taskkill/wmic/CIM; POSIX uses process signals and ps. Filesystem links use Node APIs.

import { execFile, execFileSync } from "node:child_process";
import { lstatSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

type ProcessRow = { pid: number; ppid: number };
const execFileAsync = promisify(execFile);

// Bounds for the Windows batch process-table snapshot. A single PowerShell/CIM
// call replaces the previous per-PID fan-out so force-kill stays bounded even
// when hundreds of PIDs are tracked.
const PROCESS_TABLE_READ_TIMEOUT_MS = 4_000;
const PROCESS_TABLE_MAX_BUFFER = 16 * 1024 * 1024;
const TASKKILL_TIMEOUT_MS = 5_000;
const WINDOWS_PROCESS_TABLE_COMMAND = [
  "Get-CimInstance Win32_Process |",
  "ForEach-Object {",
  "$t = '';",
  "if ($_.CreationDate) { try { $t = $_.CreationDate.ToUniversalTime().Ticks } catch { $t = '' } }",
  "\"$($_.ProcessId) $($_.ParentProcessId) $t\"",
  "}",
].join(" ");

type ProcessTableEntry = { ppid: number; startMarker: string };

export type ProcessTreeSnapshot = {
  rootPid: number;
  descendantPids: number[];
  trackedPids: number[];
  trackedIdentities?: ProcessIdentity[];
  processGroupId?: number;
};

export type ProcessTreeKillResult = ProcessTreeSnapshot & {
  killRequested: boolean;
};

export type ProcessIdentity = {
  pid: number;
  startMarker: string;
};

export type DeviceHibernateCommand = {
  platform: NodeJS.Platform;
  command: string;
  args: string[];
};

function isWindows(): boolean {
  return process.platform === "win32";
}

export function getProcessIdentity(pid: number): ProcessIdentity | null {
  if (!isValidPid(pid)) return null;
  try {
    let startMarker: string;
    if (isWindows()) {
      startMarker = execFileSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `(Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}").CreationDate.ToUniversalTime().Ticks`,
          ],
          { encoding: "utf8", timeout: 5_000, windowsHide: true },
        ).trim();
    } else if (process.platform === "linux") {
      try {
        const stat = readFileSync(join("/proc", String(pid), "stat"), "utf8");
        const fieldsAfterCommand = stat.slice(stat.lastIndexOf(") ") + 2).trim().split(/\s+/);
        const kernelStartTicks = fieldsAfterCommand[19];
        startMarker = kernelStartTicks ? `proc:${kernelStartTicks}` : "";
      } catch {
        startMarker = execFileSync(
          "ps",
          ["-o", "lstart=", "-p", String(pid)],
          { encoding: "utf8", timeout: 5_000 },
        ).trim();
      }
    } else {
      startMarker = execFileSync(
          "ps",
          ["-o", "lstart=", "-p", String(pid)],
          { encoding: "utf8", timeout: 5_000 },
        ).trim();
    }
    return startMarker ? { pid, startMarker } : null;
  } catch {
    return null;
  }
}

export function isProcessIdentityCurrent(identity: ProcessIdentity): boolean {
  const current = getProcessIdentity(identity.pid);
  return current !== null && current.startMarker === identity.startMarker;
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

function uniquePids(pids: number[]): number[] {
  return [...new Set(pids.filter(isValidPid))];
}

function parseProcessRows(output: string, order: "pid-ppid" | "ppid-pid"): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of output.split(/\r?\n/)) {
    const values = line.match(/\d+/g);
    if (!values || values.length < 2) continue;

    const first = Number(values[0]);
    const second = Number(values[1]);
    if (!isValidPid(first) || !isValidPid(second)) continue;

    rows.push(order === "pid-ppid"
      ? { pid: first, ppid: second }
      : { pid: second, ppid: first });
  }
  return rows;
}

function collectDescendantPids(rootPid: number, rows: ProcessRow[]): number[] {
  const childrenByParent = new Map<number, number[]>();
  for (const row of rows) {
    const children = childrenByParent.get(row.ppid) ?? [];
    children.push(row.pid);
    childrenByParent.set(row.ppid, children);
  }

  const descendants: number[] = [];
  const seen = new Set<number>([rootPid]);
  const queue = [...(childrenByParent.get(rootPid) ?? [])];
  while (queue.length > 0) {
    const pid = queue.shift();
    if (!pid || seen.has(pid)) continue;
    seen.add(pid);
    descendants.push(pid);
    queue.push(...(childrenByParent.get(pid) ?? []));
  }
  return descendants;
}

function readPosixProcessRows(): ProcessRow[] {
  const output = execFileSync("ps", ["-eo", "pid=,ppid="], {
    encoding: "utf8",
    timeout: 5_000,
  });
  return parseProcessRows(output, "pid-ppid");
}

function readWindowsProcessRows(): ProcessRow[] {
  try {
    const output = execFileSync("wmic", ["process", "get", "ParentProcessId,ProcessId"], {
      encoding: "utf8",
      timeout: 5_000,
      windowsHide: true,
    });
    return parseProcessRows(output, "ppid-pid");
  } catch {
    try {
      const output = execFileSync(
        "powershell.exe",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-CimInstance Win32_Process | Select-Object -Property ParentProcessId,ProcessId | Format-Table -HideTableHeaders",
        ],
        { encoding: "utf8", timeout: 5_000, windowsHide: true },
      );
      return parseProcessRows(output, "ppid-pid");
    } catch {
      return [];
    }
  }
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

// Capture every process's PID, PPID, and creation marker in ONE bounded batch
// call. This replaces the per-PID PowerShell/CIM fan-out that previously blocked
// force-kill for minutes when hundreds of PIDs were tracked.
function readWindowsProcessTable(timeoutMs: number): Map<number, ProcessTableEntry> | null {
  const bounded = Math.max(1, Math.min(timeoutMs, PROCESS_TABLE_READ_TIMEOUT_MS));
  try {
    const output = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", WINDOWS_PROCESS_TABLE_COMMAND],
      { encoding: "utf8", timeout: bounded, windowsHide: true, maxBuffer: PROCESS_TABLE_MAX_BUFFER },
    );
    return parseWindowsProcessTable(output);
  } catch {
    // Degraded fallback: PID/PPID only (no creation markers) so a kill can still
    // proceed. Callers must treat the absence of markers as "identity unknown",
    // never as "process exited".
    try {
      const output = execFileSync(
        "wmic",
        ["process", "get", "ParentProcessId,ProcessId"],
        { encoding: "utf8", timeout: bounded, windowsHide: true, maxBuffer: PROCESS_TABLE_MAX_BUFFER },
      );
      const table = new Map<number, ProcessTableEntry>();
      for (const row of parseProcessRows(output, "ppid-pid")) {
        table.set(row.pid, { ppid: row.ppid, startMarker: "" });
      }
      return table;
    } catch {
      return null;
    }
  }
}

// Build the descendant set in memory from a single point-in-time snapshot. Edges
// where the child was provably created before its parent are dropped, which
// protects against PID/PPID reuse without any extra OS calls.
function collectWindowsDescendantPids(
  rootPid: number,
  table: Map<number, ProcessTableEntry>,
): number[] {
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

  const descendants: number[] = [];
  const seen = new Set<number>([rootPid]);
  const queue = [...(childrenByParent.get(rootPid) ?? [])];
  while (queue.length > 0) {
    const pid = queue.shift();
    if (pid === undefined || seen.has(pid)) continue;
    seen.add(pid);
    descendants.push(pid);
    queue.push(...(childrenByParent.get(pid) ?? []));
  }
  return descendants;
}

function getWindowsProcessTreeSnapshot(rootPid: number): ProcessTreeSnapshot {
  const table = readWindowsProcessTable(PROCESS_TABLE_READ_TIMEOUT_MS);
  if (!table) {
    const descendantPids = listDescendantPids(rootPid);
    return {
      rootPid,
      descendantPids,
      trackedPids: uniquePids([rootPid, ...descendantPids]),
      processGroupId: undefined,
    };
  }
  const descendantPids = collectWindowsDescendantPids(rootPid, table);
  const trackedPids = uniquePids([rootPid, ...descendantPids]);
  const identities: ProcessIdentity[] = [];
  for (const pid of trackedPids) {
    const entry = table.get(pid);
    if (entry && entry.startMarker) identities.push({ pid, startMarker: entry.startMarker });
  }
  return {
    rootPid,
    descendantPids,
    trackedPids,
    // Keep the identities we captured (a partial set is fine): the root's identity
    // stays available for killProcessTree's identity guard, and isWindowsProcessTreeAlive
    // treats any tracked PID without a marker as alive-if-present, so a markerless
    // descendant never suppresses the kill or reports a live tree as exited.
    trackedIdentities: identities.length > 0 ? identities : undefined,
    processGroupId: undefined,
  };
}

// One batched liveness probe for Windows, reused by waitForProcessTreeExit's
// polling loop so each poll is a single bounded call instead of one per PID.
function isWindowsProcessTreeAlive(snapshot: ProcessTreeSnapshot, timeoutMs: number): boolean {
  const table = readWindowsProcessTable(timeoutMs);
  const markers = new Map<number, string>(
    (snapshot.trackedIdentities ?? []).map((identity) => [identity.pid, identity.startMarker]),
  );
  for (const pid of snapshot.trackedPids) {
    if (!table) {
      // Batch read failed — fall back to a cheap per-PID existence probe.
      if (isProcessAlive(pid)) return true;
      continue;
    }
    const entry = table.get(pid);
    if (!entry) continue; // PID no longer present — gone.
    const marker = markers.get(pid);
    if (marker === undefined) return true; // present, no identity baseline — assume alive.
    // present with a matching (or unknown) creation marker — alive.
    // A differing marker means the PID was reused, so treat it as gone.
    if (entry.startMarker === "" || entry.startMarker === marker) return true;
  }
  return false;
}

export function shouldSpawnDetachedProcessGroup(): boolean {
  return !isWindows();
}

export function listDescendantPids(pid: number): number[] {
  const rootPid = assertValidPid(pid);
  try {
    const rows = isWindows() ? readWindowsProcessRows() : readPosixProcessRows();
    return collectDescendantPids(rootPid, rows);
  } catch {
    return [];
  }
}

export function getProcessTreeSnapshot(pid: number): ProcessTreeSnapshot {
  const rootPid = assertValidPid(pid);
  if (isWindows()) return getWindowsProcessTreeSnapshot(rootPid);
  const descendantPids = listDescendantPids(rootPid);
  const trackedPids = uniquePids([rootPid, ...descendantPids]);
  return {
    rootPid,
    descendantPids,
    trackedPids,
    trackedIdentities: trackedPids
      .map(getProcessIdentity)
      .filter((identity): identity is ProcessIdentity => identity !== null),
    processGroupId: shouldSpawnDetachedProcessGroup() ? rootPid : undefined,
  };
}

export function isProcessAlive(pid: number): boolean {
  if (!isValidPid(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function isProcessGroupAlive(processGroupId: number | undefined): boolean {
  if (!processGroupId || !isValidPid(processGroupId)) return false;
  try {
    process.kill(-processGroupId, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

function killSingleProcess(pid: number): boolean {
  if (!isValidPid(pid)) return false;
  try {
    process.kill(pid, "SIGKILL");
    return true;
  } catch {
    return false;
  }
}

function killTrackedPids(snapshot: ProcessTreeSnapshot): boolean {
  let killRequested = false;
  if (snapshot.trackedIdentities) {
    const identities = new Map(snapshot.trackedIdentities.map((identity) => [identity.pid, identity]));
    for (const pid of [...snapshot.descendantPids].reverse()) {
      const identity = identities.get(pid);
      if (identity && isProcessIdentityCurrent(identity)) {
        killRequested = killSingleProcess(pid) || killRequested;
      }
    }
    const rootIdentity = identities.get(snapshot.rootPid);
    return (
      (rootIdentity && isProcessIdentityCurrent(rootIdentity)
        ? killSingleProcess(snapshot.rootPid)
        : false)
      || killRequested
    );
  }
  for (const pid of [...snapshot.descendantPids].reverse()) {
    killRequested = killSingleProcess(pid) || killRequested;
  }
  return killSingleProcess(snapshot.rootPid) || killRequested;
}

/**
 * Kill a process and its entire process tree.
 * Falls back to proc.kill() if the OS command fails.
 */
export function killProcessTree(pid: number): ProcessTreeKillResult;
export function killProcessTree(pid: number, expectedIdentity: ProcessIdentity): ProcessTreeKillResult | null;
export function killProcessTree(
  pid: number,
  expectedIdentity?: ProcessIdentity,
): ProcessTreeKillResult | null {
  if (expectedIdentity && !isProcessIdentityCurrent(expectedIdentity)) {
    return null;
  }
  const snapshot = getProcessTreeSnapshot(pid);
  if (expectedIdentity) {
    const capturedRoot = snapshot.trackedIdentities?.find(({ pid: trackedPid }) => trackedPid === pid);
    if (
      !capturedRoot
      || capturedRoot.startMarker !== expectedIdentity.startMarker
    ) {
      return null;
    }
  }
  let killRequested = false;
  try {
    if (isWindows()) {
      execFileSync("taskkill", ["/T", "/F", "/PID", String(snapshot.rootPid)], {
        stdio: "ignore",
        windowsHide: true,
        timeout: TASKKILL_TIMEOUT_MS,
      });
      killRequested = true;
    } else {
      // Negative PID sends signal to the entire process group
      try {
        process.kill(-snapshot.rootPid, "SIGKILL");
        killRequested = true;
      } catch { /* fall back to killing tracked PIDs below */ }
      killRequested = killTrackedPids(snapshot) || killRequested;
    }
  } catch {
    killRequested = killTrackedPids(snapshot);
  }
  return { ...snapshot, killRequested };
}

export function isProcessTreeAlive(
  snapshot: ProcessTreeSnapshot,
  timeoutMs: number = PROCESS_TABLE_READ_TIMEOUT_MS,
): boolean {
  if (isWindows()) return isWindowsProcessTreeAlive(snapshot, timeoutMs);
  if (snapshot.trackedIdentities) {
    return snapshot.trackedIdentities.some(isProcessIdentityCurrent);
  }
  if (isProcessGroupAlive(snapshot.processGroupId)) return true;
  return snapshot.trackedPids.some((pid) => isProcessAlive(pid));
}

export async function waitForProcessTreeExit(
  snapshot: ProcessTreeSnapshot | null,
  timeoutMs: number,
  pollIntervalMs = 100,
): Promise<boolean> {
  if (!snapshot) return true;
  const clampBudget = (value: number): number =>
    Math.max(1, Math.min(value, PROCESS_TABLE_READ_TIMEOUT_MS));
  let alive = isProcessTreeAlive(snapshot, clampBudget(timeoutMs));
  if (!alive) return true;
  if (timeoutMs <= 0) return false;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    alive = isProcessTreeAlive(snapshot, clampBudget(remaining));
    if (!alive) return true;
  }
  return !alive;
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
