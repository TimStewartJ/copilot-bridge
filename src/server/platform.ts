// Platform abstraction — encapsulates OS-specific operations behind a unified API.
// Windows uses taskkill, wmic, mklink /J; Linux uses kill, pkill, ln -s.

import { execSync } from "node:child_process";

const isWindows = process.platform === "win32";

/**
 * Kill a process and its entire process tree.
 * Falls back to proc.kill() if the OS command fails.
 */
export function killProcessTree(pid: number): void {
  try {
    if (isWindows) {
      execSync(`taskkill /T /F /PID ${pid}`, { stdio: "ignore" });
    } else {
      // Negative PID sends signal to the entire process group
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        process.kill(pid, "SIGKILL");
      }
    }
  } catch {
    try { process.kill(pid, "SIGKILL"); } catch { /* already dead */ }
  }
}

/**
 * Find and kill processes whose command line matches the given pattern.
 * Used for cleaning up orphaned devtunnel processes.
 */
export function killProcessByPattern(pattern: string): void {
  try {
    if (isWindows) {
      execSync(
        `wmic process where "commandline like '%${pattern}%'" call terminate`,
        { timeout: 10_000, stdio: "ignore" },
      );
    } else {
      execSync(`pkill -f '${pattern}'`, { timeout: 10_000, stdio: "ignore" });
    }
  } catch {
    // Process may not exist — that's fine
  }
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
    if (isWindows) {
      const output = execSync(`cmd /c mklink /J "${linkPath}" "${targetPath}"`, {
        cwd,
        encoding: "utf-8",
        timeout: 30_000,
      });
      return { ok: true, output };
    } else {
      const output = execSync(`ln -s "${targetPath}" "${linkPath}"`, {
        cwd,
        encoding: "utf-8",
        timeout: 30_000,
      });
      return { ok: true, output };
    }
  } catch (err: any) {
    return { ok: false, output: err.stderr || err.stdout || String(err) };
  }
}

/**
 * Remove a directory junction (Windows) or symlink (Linux)
 * without recursing into the target directory.
 */
export function removeDirectoryLink(
  linkPath: string,
  cwd: string,
): { ok: boolean; output: string } {
  try {
    if (isWindows) {
      // rmdir removes junction without deleting target contents
      const output = execSync(`cmd /c rmdir "${linkPath}"`, {
        cwd,
        encoding: "utf-8",
        timeout: 30_000,
      });
      return { ok: true, output };
    } else {
      // rm on a symlink removes just the link, not the target
      const output = execSync(`rm -f "${linkPath}"`, {
        cwd,
        encoding: "utf-8",
        timeout: 30_000,
      });
      return { ok: true, output };
    }
  } catch (err: any) {
    return { ok: false, output: err.stderr || err.stdout || String(err) };
  }
}
