import { afterEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());
const execFileSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: execFileMock,
    execFileSync: execFileSyncMock,
  };
});

const HEAD_LOG_ARGS = ["log", "-1", "--format=%H%n%h%n%s", "HEAD"];
const UPSTREAM_ARGS = ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"];
const REMOTE_LOG_ARGS = ["log", "-1", "--format=%H%n%h%n%s", "origin/main"];
const FETCH_REMOTE_ARGS = ["fetch", "--quiet", "--no-tags", "origin", "+refs/heads/main:refs/remotes/origin/main"];

function commitOutput(sha: string, shortSha: string, message: string): string {
  return `${sha}\n${shortSha}\n${message}`;
}

function comparisonOutput(ahead: number, behind: number): string {
  return `${ahead}\t${behind}`;
}

function gitArgsKey(args: readonly string[]): string {
  return args.join("\u0000");
}

async function loadGitRevisionModule() {
  vi.resetModules();
  return import("../git-revisions.js");
}

afterEach(() => {
  execFileMock.mockReset();
  execFileSyncMock.mockReset();
  vi.resetModules();
});

function mockExecFileImplementation(
  implementation: (args: readonly string[]) => string | Error,
) {
  execFileMock.mockImplementation((
    _command: string,
    args: readonly string[],
    _options: unknown,
    callback: (error: Error | null, stdout: string, stderr: string) => void,
  ) => {
    const result = implementation(args);
    if (result instanceof Error) {
      callback(result, "", "");
      return;
    }
    callback(null, result, "");
  });
}

describe("createBridgeGitRevisionReader", () => {
  it("captures the running commit at reader creation time while returning current local and remote commits", async () => {
    const runningSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const localSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const remoteSha = "cccccccccccccccccccccccccccccccccccccccc";
    execFileSyncMock.mockImplementation((_command: string, args: readonly string[]) => {
      if (gitArgsKey(args) === gitArgsKey(HEAD_LOG_ARGS)) {
        return commitOutput(runningSha, "aaaaaaa", "Running bridge commit");
      }
      throw new Error(`Unexpected sync git args: ${args.join(" ")}`);
    });
    mockExecFileImplementation((args) => {
      const key = gitArgsKey(args);
      if (key === gitArgsKey(HEAD_LOG_ARGS)) {
        return commitOutput(localSha, "bbbbbbb", "Latest local commit");
      }
      if (key === gitArgsKey(UPSTREAM_ARGS)) return "origin/main";
      if (key === gitArgsKey(FETCH_REMOTE_ARGS)) return "";
      if (key === gitArgsKey(REMOTE_LOG_ARGS)) {
        return commitOutput(remoteSha, "ccccccc", "Latest remote commit");
      }
      if (args[0] === "rev-list" && args[1] === "--left-right" && args[2] === "--count") {
        if (args[3] === `${localSha}...${remoteSha}`) return comparisonOutput(0, 1);
        if (args[3] === `${runningSha}...${localSha}`) return comparisonOutput(0, 1);
      }
      throw new Error(`Unexpected async git args: ${args.join(" ")}`);
    });

    const revisions = await loadGitRevisionModule();
    const readRevisions = revisions.createBridgeGitRevisionReader();
    const result = await readRevisions({ forceRefresh: true });

    expect(result).toEqual({
      local: {
        status: "ok",
        ref: "HEAD",
        sha: localSha,
        shortSha: "bbbbbbb",
        message: "Latest local commit",
      },
      remote: {
        status: "ok",
        ref: "origin/main",
        sha: remoteSha,
        shortSha: "ccccccc",
        message: "Latest remote commit",
      },
      running: {
        status: "ok",
        ref: "HEAD @ server start",
        sha: runningSha,
        shortSha: "aaaaaaa",
        message: "Running bridge commit",
      },
      comparisons: {
        localVsRemote: {
          status: "ok",
          ahead: 0,
          behind: 1,
        },
        runningVsLocal: {
          status: "ok",
          ahead: 0,
          behind: 1,
        },
      },
    });
  });

  it("reports missing upstream configuration explicitly", async () => {
    const runningSha = "dddddddddddddddddddddddddddddddddddddddd";
    const localSha = "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
    execFileSyncMock.mockImplementation((_command: string, args: readonly string[]) => {
      if (gitArgsKey(args) === gitArgsKey(HEAD_LOG_ARGS)) {
        return commitOutput(runningSha, "ddddddd", "Running commit");
      }
      throw new Error(`Unexpected sync git args: ${args.join(" ")}`);
    });
    mockExecFileImplementation((args) => {
      const key = gitArgsKey(args);
      if (key === gitArgsKey(HEAD_LOG_ARGS)) {
        return commitOutput(localSha, "eeeeeee", "Local commit");
      }
      if (key === gitArgsKey(UPSTREAM_ARGS)) {
        return new Error("fatal: no upstream configured");
      }
      if (args[0] === "rev-list" && args[1] === "--left-right" && args[2] === "--count" && args[3] === `${runningSha}...${localSha}`) {
        return comparisonOutput(0, 1);
      }
      throw new Error(`Unexpected async git args: ${args.join(" ")}`);
    });

    const revisions = await loadGitRevisionModule();
    const readRevisions = revisions.createBridgeGitRevisionReader();
    const result = await readRevisions({ forceRefresh: true });

    expect(result.local).toMatchObject({
      status: "ok",
      ref: "HEAD",
    });
    expect(result.running).toMatchObject({
      status: "ok",
      ref: "HEAD @ server start",
    });
    expect(result.remote).toEqual({
      status: "unavailable",
      ref: "upstream",
      error: "fatal: no upstream configured",
    });
    expect(result.comparisons).toEqual({
      localVsRemote: {
        status: "unavailable",
        error: "fatal: no upstream configured",
      },
      runningVsLocal: {
        status: "ok",
        ahead: 0,
        behind: 1,
      },
    });
  });

  it("reuses a cached remote result until forced to refresh", async () => {
    let fetchCalls = 0;
    execFileSyncMock.mockImplementation((_command: string, args: readonly string[]) => {
      if (gitArgsKey(args) === gitArgsKey(HEAD_LOG_ARGS)) {
        return commitOutput("ffffffffffffffffffffffffffffffffffffffff", "fffffff", "Running commit");
      }
      throw new Error(`Unexpected sync git args: ${args.join(" ")}`);
    });
    mockExecFileImplementation((args) => {
      const key = gitArgsKey(args);
      if (key === gitArgsKey(HEAD_LOG_ARGS)) {
        return commitOutput("9999999999999999999999999999999999999999", "9999999", "Local commit");
      }
      if (key === gitArgsKey(UPSTREAM_ARGS)) return "origin/main";
      if (key === gitArgsKey(FETCH_REMOTE_ARGS)) {
        fetchCalls += 1;
        return "";
      }
      if (key === gitArgsKey(REMOTE_LOG_ARGS)) {
        return commitOutput("abababababababababababababababababababab", "abababa", "Remote commit");
      }
      if (args[0] === "rev-list" && args[1] === "--left-right" && args[2] === "--count") {
        return comparisonOutput(0, 1);
      }
      throw new Error(`Unexpected async git args: ${args.join(" ")}`);
    });

    const revisions = await loadGitRevisionModule();
    const readRevisions = revisions.createBridgeGitRevisionReader();
    const first = await readRevisions();
    const second = await readRevisions();
    const refreshed = await readRevisions({ forceRefresh: true });

    expect(fetchCalls).toBe(2);
    expect(first.remote).toEqual(second.remote);
    expect(refreshed.remote).toEqual(first.remote);
  });
});
