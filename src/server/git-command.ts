import { getProcessHost } from "./process-host.js";
import { withNonInteractiveCommandEnv } from "./noninteractive-env.js";

export const LOCAL_GIT_TIMEOUT_MS = 5_000;

export type GitCommandResult =
  | { ok: true; output: string }
  | { ok: false; error: string };

export interface GitCommandInvocation {
  command: "git";
  args: string[];
  displayCommand: string;
}

function formatDisplayArg(arg: string): string {
  return /^[A-Za-z0-9_./:@+-]+$/.test(arg) ? arg : JSON.stringify(arg);
}

export function createGitCommand(args: readonly string[]): GitCommandInvocation {
  const commandArgs = [...args];
  return {
    command: "git",
    args: commandArgs,
    displayCommand: ["git", ...commandArgs.map(formatDisplayArg)].join(" "),
  };
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
