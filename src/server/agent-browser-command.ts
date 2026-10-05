// How the Bridge starts the agent-browser CLI on this machine. Kept apart so that tests replace
// it (see src/test-support/vitest-setup.ts) and run the same way whatever their host has installed.

import { lstatSync } from "node:fs";
import { platform } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";

export interface AgentBrowserCommand {
  file: string;
  /**
   * The command is a Windows `.cmd` launcher, which only the command shell can run. Arguments
   * then have to be quoted for that shell: see quoteWindowsShellArgument.
   */
  shell: boolean;
}

const WINDOWS_EXECUTABLE = "agent-browser-win32-x64.exe";
let resolved: AgentBrowserCommand | undefined;

/**
 * On Windows `agent-browser` on PATH is npm's launcher script. The program it starts is looked
 * for beside it, so that it can be run directly; only an install laid out some other way is left
 * to the shell.
 */
export function getAgentBrowserCommand(): AgentBrowserCommand {
  if (resolved) return resolved;
  if (platform() !== "win32") {
    resolved = { file: "agent-browser", shell: false };
    return resolved;
  }

  for (const pathDirectory of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidates = [
      join(pathDirectory, "node_modules", "agent-browser", "bin", WINDOWS_EXECUTABLE),
      ...(basename(pathDirectory).toLowerCase() === ".bin"
        ? [join(dirname(pathDirectory), "agent-browser", "bin", WINDOWS_EXECUTABLE)]
        : []),
    ];
    for (const candidate of candidates) {
      try {
        lstatSync(candidate);
        resolved = { file: candidate, shell: false };
        return resolved;
      } catch {
        // Keep searching the executable PATH.
      }
    }
  }

  resolved = { file: "agent-browser", shell: true };
  return resolved;
}
