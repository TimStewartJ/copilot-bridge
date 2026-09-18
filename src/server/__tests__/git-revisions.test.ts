import { afterEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: execFileMock,
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

function normalizeGitArgs(args: readonly string[]): readonly string[] {
  return args[0] === "--no-pager" ? args.slice(1) : args;
}

function gitArgsKey(args: readonly string[]): string {
  const normalizedArgs = normalizeGitArgs(args);
  return normalizedArgs.join("\u0000");
}

function expectNonInteractiveGitCalls(): void {
  for (const [, args, options] of execFileMock.mock.calls) {
    expect(args[0]).toBe("--no-pager");
    expect(options).toMatchObject({
      env: {
        GIT_PAGER: "cat",
        PAGER: "cat",
        TERM: "dumb",
        GIT_TERMINAL_PROMPT: "0",
      },
    });
  }
}

async function loadGitRevisionModule() {
  vi.resetModules();
  return import("../git-revisions.js");
}

afterEach(() => {
  execFileMock.mockReset();
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

/**
 * The running commit is read once, when the first reader is created, with the same `git log`
 * arguments as every later read of the live checkout. Order tells them apart.
 */
function headReads(running: string, local: string): () => string {
  let reads = 0;
  return () => (reads++ === 0 ? running : local);
}

describe("createBridgeGitRevisionReader", () => {
  it("captures the running commit at reader creation time while returning current local and remote commits", async () => {
    const runningSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const localSha = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
    const remoteSha = "cccccccccccccccccccccccccccccccccccccccc";
    const readHead = headReads(commitOutput(runningSha, "aaaaaaa", "Running bridge commit"), commitOutput(localSha, "bbbbbbb", "Latest local commit"));
    mockExecFileImplementation((args) => {
      const normalizedArgs = normalizeGitArgs(args);
      const key = gitArgsKey(args);
      if (key === gitArgsKey(HEAD_LOG_ARGS)) return readHead();
      if (key === gitArgsKey(UPSTREAM_ARGS)) return "origin/main";
      if (key === gitArgsKey(FETCH_REMOTE_ARGS)) return "";
      if (key === gitArgsKey(REMOTE_LOG_ARGS)) {
        return commitOutput(remoteSha, "ccccccc", "Latest remote commit");
      }
      if (normalizedArgs[0] === "rev-list" && normalizedArgs[1] === "--left-right" && normalizedArgs[2] === "--count") {
        if (normalizedArgs[3] === `${localSha}...${remoteSha}`) return comparisonOutput(0, 1);
        if (normalizedArgs[3] === `${runningSha}...${localSha}`) return comparisonOutput(0, 1);
      }
      throw new Error(`Unexpected async git args: ${args.join(" ")}`);
    });

    const revisions = await loadGitRevisionModule();
    const readRevisions = revisions.createBridgeGitRevisionReader();
    const result = await readRevisions({ forceRefresh: true });

    expectNonInteractiveGitCalls();
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
    const readHead = headReads(commitOutput(runningSha, "ddddddd", "Running commit"), commitOutput(localSha, "eeeeeee", "Local commit"));
    mockExecFileImplementation((args) => {
      const normalizedArgs = normalizeGitArgs(args);
      const key = gitArgsKey(args);
      if (key === gitArgsKey(HEAD_LOG_ARGS)) return readHead();
      if (key === gitArgsKey(UPSTREAM_ARGS)) {
        return new Error("fatal: no upstream configured");
      }
      if (normalizedArgs[0] === "rev-list" && normalizedArgs[1] === "--left-right" && normalizedArgs[2] === "--count" && normalizedArgs[3] === `${runningSha}...${localSha}`) {
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
    const readHead = headReads(commitOutput("ffffffffffffffffffffffffffffffffffffffff", "fffffff", "Running commit"), commitOutput("9999999999999999999999999999999999999999", "9999999", "Local commit"));
    mockExecFileImplementation((args) => {
      const normalizedArgs = normalizeGitArgs(args);
      const key = gitArgsKey(args);
      if (key === gitArgsKey(HEAD_LOG_ARGS)) return readHead();
      if (key === gitArgsKey(UPSTREAM_ARGS)) return "origin/main";
      if (key === gitArgsKey(FETCH_REMOTE_ARGS)) {
        fetchCalls += 1;
        return "";
      }
      if (key === gitArgsKey(REMOTE_LOG_ARGS)) {
        return commitOutput("abababababababababababababababababababab", "abababa", "Remote commit");
      }
      if (normalizedArgs[0] === "rev-list" && normalizedArgs[1] === "--left-right" && normalizedArgs[2] === "--count") {
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

  it("reads the running commit once per process instead of once per reader", async () => {
    const runningSha = "dddddddddddddddddddddddddddddddddddddddd";
    const readHead = headReads(commitOutput(runningSha, "ddddddd", "Running bridge commit"), commitOutput(runningSha, "ddddddd", "Running bridge commit"));
    mockExecFileImplementation((args) => {
      const key = gitArgsKey(args);
      if (key === gitArgsKey(HEAD_LOG_ARGS)) return readHead();
      if (key === gitArgsKey(UPSTREAM_ARGS)) return new Error("no upstream");
      throw new Error(`Unexpected async git args: ${args.join(" ")}`);
    });

    const revisions = await loadGitRevisionModule();
    // Each reader call reads the live checkout once. Only the first reader adds the boot read.
    const first = await revisions.createBridgeGitRevisionReader()();
    const second = await revisions.createBridgeGitRevisionReader()();

    const headLogReads = execFileMock.mock.calls.filter(([, args]) => gitArgsKey(args) === gitArgsKey(HEAD_LOG_ARGS));
    expect(headLogReads).toHaveLength(3);
    expect(first.running).toEqual(second.running);
    expect(first.running).toMatchObject({ status: "ok", ref: "HEAD @ server start", sha: runningSha });
  });
});
