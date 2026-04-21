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
const FETCH_HEAD_ARGS = ["log", "-1", "--format=%H%n%h%n%s", "FETCH_HEAD"];
const FETCH_REMOTE_ARGS = ["fetch", "--quiet", "--no-tags", "--depth=1", "origin", "refs/heads/main"];

function commitOutput(sha: string, shortSha: string, message: string): string {
  return `${sha}\n${shortSha}\n${message}`;
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
    execFileSyncMock.mockImplementation((_command: string, args: readonly string[]) => {
      if (gitArgsKey(args) === gitArgsKey(HEAD_LOG_ARGS)) {
        return commitOutput("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "aaaaaaa", "Running bridge commit");
      }
      throw new Error(`Unexpected sync git args: ${args.join(" ")}`);
    });
    mockExecFileImplementation((args) => {
      const key = gitArgsKey(args);
      if (key === gitArgsKey(HEAD_LOG_ARGS)) {
        return commitOutput("bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb", "bbbbbbb", "Latest local commit");
      }
      if (key === gitArgsKey(UPSTREAM_ARGS)) return "origin/main";
      if (key === gitArgsKey(FETCH_REMOTE_ARGS)) return "";
      if (key === gitArgsKey(FETCH_HEAD_ARGS)) {
        return commitOutput("cccccccccccccccccccccccccccccccccccccccc", "ccccccc", "Latest remote commit");
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
        sha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        shortSha: "bbbbbbb",
        message: "Latest local commit",
      },
      remote: {
        status: "ok",
        ref: "origin/main",
        sha: "cccccccccccccccccccccccccccccccccccccccc",
        shortSha: "ccccccc",
        message: "Latest remote commit",
      },
      running: {
        status: "ok",
        ref: "HEAD @ server start",
        sha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        shortSha: "aaaaaaa",
        message: "Running bridge commit",
      },
    });
  });

  it("reports missing upstream configuration explicitly", async () => {
    execFileSyncMock.mockImplementation((_command: string, args: readonly string[]) => {
      if (gitArgsKey(args) === gitArgsKey(HEAD_LOG_ARGS)) {
        return commitOutput("dddddddddddddddddddddddddddddddddddddddd", "ddddddd", "Running commit");
      }
      throw new Error(`Unexpected sync git args: ${args.join(" ")}`);
    });
    mockExecFileImplementation((args) => {
      const key = gitArgsKey(args);
      if (key === gitArgsKey(HEAD_LOG_ARGS)) {
        return commitOutput("eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee", "eeeeeee", "Local commit");
      }
      if (key === gitArgsKey(UPSTREAM_ARGS)) {
        return new Error("fatal: no upstream configured");
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
      if (key === gitArgsKey(FETCH_HEAD_ARGS)) {
        return commitOutput("abababababababababababababababababababab", "abababa", "Remote commit");
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
