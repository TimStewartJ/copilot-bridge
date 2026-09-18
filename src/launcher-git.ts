// Synchronous git helpers for the launcher only. The launcher is a supervisor whose event loop
// serves no requests, so a blocking read is acceptable there. The server runtime must never
// import this module: it goes through the process host (see server/git-command.ts).

import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBridgeControlRoot } from "./server/control-root.js";
import { formatGitError, LOCAL_GIT_TIMEOUT_MS, type GitCommandResult } from "./server/git-command.js";
import { withNonInteractiveCommandEnv } from "./server/noninteractive-env.js";

const ROOT = resolveBridgeControlRoot(join(dirname(fileURLToPath(import.meta.url)), ".."));

export function runGitSync(cwd: string, args: string[], timeoutMs = LOCAL_GIT_TIMEOUT_MS): GitCommandResult {
  try {
    return {
      ok: true,
      output: execFileSync("git", ["--no-pager", ...args], {
        cwd,
        encoding: "utf-8",
        env: withNonInteractiveCommandEnv(),
        timeout: timeoutMs,
      }).trim(),
    };
  } catch (error) {
    return { ok: false, error: formatGitError(error) };
  }
}

export function gitHash(): string {
  const result = runGitSync(ROOT, ["rev-parse", "--short", "HEAD"]);
  return result.ok && result.output ? result.output : "unknown";
}
