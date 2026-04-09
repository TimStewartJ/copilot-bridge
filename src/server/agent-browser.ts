// Shared agent-browser helpers with automatic recovery from stale Chrome state.

import { execSync } from "node:child_process";
import { unlinkSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const DEFAULT_TIMEOUT = 30_000;

const PROFILE_DIR = join(homedir(), ".copilot", "browser-profile");
const LOCK_FILES = ["SingletonLock", "SingletonSocket", "SingletonCookie"];

export function run(
  cmd: string,
  timeout = DEFAULT_TIMEOUT,
): { ok: boolean; output: string } {
  try {
    const output = execSync(cmd, { encoding: "utf-8", timeout });
    return { ok: true, output: output.trim() };
  } catch (err: any) {
    return { ok: false, output: err.stderr || err.stdout || String(err) };
  }
}

/** Remove stale Chrome profile lock files if the owning process is gone. */
function clearStaleLocks(): boolean {
  try {
    const lock = readlinkSync(join(PROFILE_DIR, "SingletonLock"));
    // Lock symlink target is "<hostname>-<pid>"
    const pid = parseInt(lock.split("-").pop() ?? "", 10);
    if (!pid) return false;

    // Check if the process is still alive
    try {
      process.kill(pid, 0);
      return false; // still alive — don't touch locks
    } catch {
      // Process is dead — safe to remove locks
    }

    for (const name of LOCK_FILES) {
      try {
        unlinkSync(join(PROFILE_DIR, name));
      } catch {
        // may not exist
      }
    }
    return true;
  } catch {
    return false; // no lock file or unreadable
  }
}

/**
 * Run an agent-browser command using the default session.
 * On Chrome launch failure (stale lock), clears the lock and retries once.
 */
export function ab(command: string, timeout = DEFAULT_TIMEOUT): { ok: boolean; output: string } {
  const result = run(`agent-browser ${command}`, timeout);
  if (result.ok) return result;

  // Detect stale-lock failure and retry once
  if (result.output.includes("Chrome exited early") && clearStaleLocks()) {
    return run(`agent-browser ${command}`, timeout);
  }

  return result;
}
