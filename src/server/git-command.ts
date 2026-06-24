import { execFile, execFileSync } from "node:child_process";
import { withNonInteractiveCommandEnv } from "./noninteractive-env.js";

export const LOCAL_GIT_TIMEOUT_MS = 5_000;

export type GitCommandResult =
  | { ok: true; output: string }
  | { ok: false; error: string };

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
  return new Promise((resolve) => {
    execFile(
      "git",
      ["--no-pager", ...args],
      {
        cwd,
        encoding: "utf-8",
        env: withNonInteractiveCommandEnv(),
        timeout: timeoutMs,
      },
      (error, stdout, stderr) => {
        if (error) {
          resolve({
            ok: false,
            error: formatGitError(error, stdout, stderr),
          });
          return;
        }
        resolve({ ok: true, output: stdout.trim() });
      },
    );
  });
}

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
