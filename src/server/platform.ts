// Platform abstraction — encapsulates OS-specific operations behind a unified API.
// Windows uses taskkill/wmic/CIM; POSIX uses process signals and ps. Filesystem links use Node APIs.

import { execFile, execFileSync } from "node:child_process";
import { lstatSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

type ProcessRow = { pid: number; ppid: number };
const execFileAsync = promisify(execFile);

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

export function isProcessTreeAlive(snapshot: ProcessTreeSnapshot): boolean {
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
  if (!isProcessTreeAlive(snapshot)) return true;
  if (timeoutMs <= 0) return false;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
    if (!isProcessTreeAlive(snapshot)) return true;
  }
  return !isProcessTreeAlive(snapshot);
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
