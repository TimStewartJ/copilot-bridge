import { getProcessHost } from "./process-host.js";
import { withNonInteractiveCommandEnv } from "./noninteractive-env.js";
import { commandLine, type CommandLine } from "./shell-command.js";

export const LOCAL_GIT_TIMEOUT_MS = 5_000;

export type GitCommandResult =
  | { ok: true; output: string }
  | { ok: false; error: string };

export type GitCommandInvocation = CommandLine;

export function createGitCommand(args: readonly string[]): GitCommandInvocation {
  return commandLine("git", args);
}

export function createGitPullRebaseCommand(branch: string): GitCommandInvocation {
  return createGitCommand(["pull", "--rebase", "origin", branch]);
}

export function normalizeStreamOutput(output: unknown): string {
  if (typeof output === "string") return output.trim();
  if (Buffer.isBuffer(output)) return output.toString("utf-8").trim();
  return "";
}

export function formatGitError(error: unknown, stdout?: unknown, stderr?: unknown): string {
  const stderrText = normalizeStreamOutput(stderr ?? (error as { stderr?: unknown } | null)?.stderr);
  if (stderrText) return stderrText;
  const stdoutText = normalizeStreamOutput(stdout ?? (error as { stdout?: unknown } | null)?.stdout);
  if (stdoutText) return stdoutText;
  return error instanceof Error ? error.message : String(error);
}

export function runGit(cwd: string, args: string[], timeoutMs = LOCAL_GIT_TIMEOUT_MS): Promise<GitCommandResult> {
  return getProcessHost().execFile("git", ["--no-pager", ...args], {
    cwd,
    encoding: "utf-8",
    env: withNonInteractiveCommandEnv(),
    timeout: timeoutMs,
  }).then(
    ({ stdout }): GitCommandResult => ({ ok: true, output: stdout.trim() }),
    (error): GitCommandResult => ({ ok: false, error: formatGitError(error) }),
  );
}
