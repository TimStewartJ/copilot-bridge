import { execFile, execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveBridgeControlRoot } from "./control-root.js";
import { withNonInteractiveCommandEnv } from "./noninteractive-env.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolveBridgeControlRoot(join(__dirname, "..", ".."));
const LOCAL_GIT_TIMEOUT_MS = 5_000;
const REMOTE_GIT_TIMEOUT_MS = 10_000;
const REMOTE_CACHE_TTL_MS = 30_000;
const COMMIT_FORMAT = "%H%n%h%n%s";

export interface GitCommitSnapshotOk {
  status: "ok";
  ref: string;
  sha: string;
  shortSha: string;
  message: string;
}

export interface GitCommitSnapshotUnavailable {
  status: "unavailable";
  ref: string;
  error: string;
}

export type GitCommitSnapshot = GitCommitSnapshotOk | GitCommitSnapshotUnavailable;

export interface GitCommitComparisonOk {
  status: "ok";
  ahead: number;
  behind: number;
}

export interface GitCommitComparisonUnavailable {
  status: "unavailable";
  error: string;
}

export type GitCommitComparison = GitCommitComparisonOk | GitCommitComparisonUnavailable;

export interface BridgeGitRevisions {
  local: GitCommitSnapshot;
  remote: GitCommitSnapshot;
  running: GitCommitSnapshot;
  comparisons: {
    localVsRemote: GitCommitComparison;
    runningVsLocal: GitCommitComparison;
  };
}

export type BridgeGitRevisionReader = (options?: { forceRefresh?: boolean }) => Promise<BridgeGitRevisions>;

type GitCommandResult =
  | { ok: true; output: string }
  | { ok: false; error: string };

type RemoteTarget =
  | { ok: true; remoteName: string; remoteBranch: string; ref: string }
  | { ok: false; ref: string; error: string };

let cachedRemoteCommit:
  | {
      fetchedAt: number;
      ref: string;
      snapshot: GitCommitSnapshot;
    }
  | null = null;

function formatGitError(error: unknown, stdout?: unknown, stderr?: unknown): string {
  const stderrText = normalizeStreamOutput(stderr ?? (error as { stderr?: unknown } | null)?.stderr);
  if (stderrText) return stderrText;
  const stdoutText = normalizeStreamOutput(stdout ?? (error as { stdout?: unknown } | null)?.stdout);
  if (stdoutText) return stdoutText;
  if (error && typeof error === "object") {
    return error instanceof Error ? error.message : String(error);
  }
  return error instanceof Error ? error.message : String(error);
}

function normalizeStreamOutput(output: unknown): string {
  if (typeof output === "string") return output.trim();
  if (Buffer.isBuffer(output)) return output.toString("utf-8").trim();
  return "";
}

function runGitSync(args: string[], timeoutMs = LOCAL_GIT_TIMEOUT_MS): GitCommandResult {
  try {
    return {
      ok: true,
      output: execFileSync("git", ["--no-pager", ...args], {
        cwd: ROOT,
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
  const result = runGitSync(["rev-parse", "--short", "HEAD"]);
  return result.ok && result.output ? result.output : "unknown";
}

function runGit(args: string[], timeoutMs = LOCAL_GIT_TIMEOUT_MS): Promise<GitCommandResult> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["--no-pager", ...args],
      {
        cwd: ROOT,
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

function parseCommitSnapshot(output: string, ref: string): GitCommitSnapshot {
  const [sha = "", shortSha = "", message = ""] = output.split(/\r?\n/, 3);
  if (!sha || !shortSha || !message) {
    return {
      status: "unavailable",
      ref,
      error: `Unable to parse git commit details for ${ref}.`,
    };
  }
  return {
    status: "ok",
    ref,
    sha,
    shortSha,
    message,
  };
}

function readCommitAtRefSync(gitRef: string, refLabel = gitRef): GitCommitSnapshot {
  const result = runGitSync(["log", "-1", `--format=${COMMIT_FORMAT}`, gitRef]);
  if (!result.ok) {
    return {
      status: "unavailable",
      ref: refLabel,
      error: result.error,
    };
  }
  return parseCommitSnapshot(result.output, refLabel);
}

async function readCommitAtRef(gitRef: string, refLabel = gitRef): Promise<GitCommitSnapshot> {
  const result = await runGit(["log", "-1", `--format=${COMMIT_FORMAT}`, gitRef]);
  if (!result.ok) {
    return {
      status: "unavailable",
      ref: refLabel,
      error: result.error,
    };
  }
  return parseCommitSnapshot(result.output, refLabel);
}

async function resolveRemoteTarget(): Promise<RemoteTarget> {
  const upstream = await runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]);
  if (upstream.ok && upstream.output) {
    const slashIndex = upstream.output.indexOf("/");
    if (slashIndex > 0 && slashIndex < upstream.output.length - 1) {
      return {
        ok: true,
        remoteName: upstream.output.slice(0, slashIndex),
        remoteBranch: upstream.output.slice(slashIndex + 1),
        ref: upstream.output,
      };
    }
    return {
      ok: false,
      ref: upstream.output,
      error: `Unsupported upstream ref: ${upstream.output}`,
    };
  }

  return {
    ok: false,
    ref: "upstream",
    error: upstream.ok ? "Current branch has no upstream configured." : upstream.error,
  };
}

async function readRemoteCommit(forceRefresh = false): Promise<GitCommitSnapshot> {
  const target = await resolveRemoteTarget();
  if (!target.ok) {
    return {
      status: "unavailable",
      ref: target.ref,
      error: target.error,
    };
  }

  if (
    !forceRefresh
    && cachedRemoteCommit
    && cachedRemoteCommit.ref === target.ref
    && Date.now() - cachedRemoteCommit.fetchedAt < REMOTE_CACHE_TTL_MS
  ) {
    return cachedRemoteCommit.snapshot;
  }

  const fetchResult = await runGit(
    [
      "fetch",
      "--quiet",
      "--no-tags",
      target.remoteName,
      `+refs/heads/${target.remoteBranch}:refs/remotes/${target.ref}`,
    ],
    REMOTE_GIT_TIMEOUT_MS,
  );
  const snapshot = fetchResult.ok
    ? await readCommitAtRef(target.ref, target.ref)
    : {
        status: "unavailable" as const,
        ref: target.ref,
        error: fetchResult.error,
      };

  cachedRemoteCommit = {
    fetchedAt: Date.now(),
    ref: target.ref,
    snapshot,
  };
  return snapshot;
}

function parseCommitComparison(output: string, leftRef: string, rightRef: string): GitCommitComparison {
  const [aheadText = "", behindText = ""] = output.trim().split(/\s+/, 2);
  const ahead = Number.parseInt(aheadText, 10);
  const behind = Number.parseInt(behindText, 10);
  if (!Number.isInteger(ahead) || !Number.isInteger(behind)) {
    return {
      status: "unavailable",
      error: `Unable to compare git revisions for ${leftRef} and ${rightRef}.`,
    };
  }
  return {
    status: "ok",
    ahead,
    behind,
  };
}

async function compareCommitSnapshots(left: GitCommitSnapshot, right: GitCommitSnapshot): Promise<GitCommitComparison> {
  if (left.status !== "ok") {
    return {
      status: "unavailable",
      error: left.error,
    };
  }
  if (right.status !== "ok") {
    return {
      status: "unavailable",
      error: right.error,
    };
  }
  if (left.sha === right.sha) {
    return {
      status: "ok",
      ahead: 0,
      behind: 0,
    };
  }

  const result = await runGit(["rev-list", "--left-right", "--count", `${left.sha}...${right.sha}`]);
  if (!result.ok) {
    return {
      status: "unavailable",
      error: result.error,
    };
  }

  return parseCommitComparison(result.output, left.ref, right.ref);
}

export function createBridgeGitRevisionReader(): BridgeGitRevisionReader {
  const runningCommit = readCommitAtRefSync("HEAD", "HEAD @ server start");

  return async (options = {}) => {
    const [local, remote] = await Promise.all([
      readCommitAtRef("HEAD", "HEAD"),
      readRemoteCommit(options.forceRefresh === true),
    ]);
    const [localVsRemote, runningVsLocal] = await Promise.all([
      compareCommitSnapshots(local, remote),
      compareCommitSnapshots(runningCommit, local),
    ]);

    return {
      local,
      remote,
      running: runningCommit,
      comparisons: {
        localVsRemote,
        runningVsLocal,
      },
    };
  };
}
