// How the Bridge starts agent-browser; kept apart so tests can replace it whatever is installed.

import { lstatSync } from "node:fs";
import { platform } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";

export interface AgentBrowserCommand {
  file: string;
  /** A Windows `.cmd` launcher: arguments must be quoted with quoteWindowsShellArgument. */
  shell: boolean;
}

const WINDOWS_EXECUTABLE = "agent-browser-win32-x64.exe";
let resolved: AgentBrowserCommand | undefined;

/** On Windows run the .exe beside npm's launcher script; other layouts fall back to the shell. */
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
