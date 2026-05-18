import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());
const realpathMock = vi.hoisted(() => vi.fn<(path: string) => Promise<string>>());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: execFileMock,
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    realpath: realpathMock,
  };
});

function gitArgsKey(args: readonly string[]): string {
  const normalizedArgs = args[0] === "--no-pager" ? args.slice(1) : args;
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

async function loadGitWorktreeStatusModule() {
  vi.resetModules();
  return import("../git-worktree-status.js");
}

beforeEach(() => {
  execFileMock.mockReset();
  realpathMock.mockReset();
  realpathMock.mockImplementation(async (filePath) => filePath);
});

afterEach(() => {
  vi.resetModules();
});

type ExecFileResult =
  | string
  | Error
  | {
    error?: Error | null;
    stdout?: unknown;
    stderr?: unknown;
  };

function mockExecFileImplementation(
  implementation: (args: readonly string[]) => ExecFileResult,
) {
  execFileMock.mockImplementation((
    _command: string,
    args: readonly string[],
    _options: unknown,
    callback: (error: Error | null, stdout: unknown, stderr: unknown) => void,
  ) => {
    const result = implementation(args);
    if (result instanceof Error) {
      callback(result, "", "");
      return;
    }
    if (typeof result === "string") {
      callback(null, result, "");
      return;
    }
    callback(result.error ?? null, result.stdout ?? "", result.stderr ?? "");
  });
}

function mockLinkedWorktreeGitCommands() {
  mockExecFileImplementation((args) => {
    const key = gitArgsKey(args);
    if (key === gitArgsKey(["rev-parse", "--show-toplevel"])) {
      return "/workspace/feature-worktree";
    }
    if (key === gitArgsKey(["status", "--porcelain=v1", "--branch"])) {
      return [
        "## feature/live-status...origin/feature/live-status [ahead 1]",
        "M  staged.ts",
        " M modified.ts",
        "MM both.ts",
        "?? new-file.ts",
      ].join("\r\n");
    }
    if (key === gitArgsKey(["rev-parse", "--path-format=absolute", "--git-common-dir"])) {
      return "/workspace/copilot-bridge/.git";
    }
    if (key === gitArgsKey(["worktree", "list", "--porcelain"])) {
      return [
        "worktree /workspace/copilot-bridge",
        "HEAD aaaaaaa11111111111111111111111111111111",
        "branch refs/heads/main",
        "",
        "worktree /workspace/feature-worktree",
        "HEAD bbbbbbb22222222222222222222222222222222",
        "branch refs/heads/feature/live-status",
        "",
        "worktree /workspace/detached-worktree",
        "HEAD ccccccc33333333333333333333333333333333",
        "detached",
      ].join("\n");
    }
    throw new Error(`Unexpected git args: ${args.join(" ")}`);
  });
}

function mockLinkedWorktreeGitCommandsWithOverrides(
  overrides: Partial<Record<string, ExecFileResult>>,
) {
  mockExecFileImplementation((args) => {
    const key = gitArgsKey(args);
    if (key in overrides) {
      return overrides[key] as ExecFileResult;
    }
    if (key === gitArgsKey(["rev-parse", "--show-toplevel"])) {
      return "/workspace/feature-worktree";
    }
    if (key === gitArgsKey(["status", "--porcelain=v1", "--branch"])) {
      return [
        "## feature/live-status...origin/feature/live-status [ahead 1]",
        "M  staged.ts",
        " M modified.ts",
        "MM both.ts",
        "?? new-file.ts",
      ].join("\r\n");
    }
    if (key === gitArgsKey(["rev-parse", "--path-format=absolute", "--git-common-dir"])) {
      return "/workspace/copilot-bridge/.git";
    }
    if (key === gitArgsKey(["worktree", "list", "--porcelain"])) {
      return [
        "worktree /workspace/copilot-bridge",
        "HEAD aaaaaaa11111111111111111111111111111111",
        "branch refs/heads/main",
        "",
        "worktree /workspace/feature-worktree",
        "HEAD bbbbbbb22222222222222222222222222222222",
        "branch refs/heads/feature/live-status",
        "",
        "worktree /workspace/detached-worktree",
        "HEAD ccccccc33333333333333333333333333333333",
        "detached",
      ].join("\n");
    }
    throw new Error(`Unexpected git args: ${args.join(" ")}`);
  });
}

describe("readGitWorktreeStatus", () => {
  it("returns main-worktree metadata, dirty counts, and sibling worktrees", async () => {
    mockExecFileImplementation((args) => {
      const key = gitArgsKey(args);
      if (key === gitArgsKey(["rev-parse", "--show-toplevel"])) {
        return "/workspace/copilot-bridge";
      }
      if (key === gitArgsKey(["status", "--porcelain=v1", "--branch"])) {
        return "## main";
      }
      if (key === gitArgsKey(["rev-parse", "--path-format=absolute", "--git-common-dir"])) {
        return "/workspace/copilot-bridge/.git";
      }
      if (key === gitArgsKey(["worktree", "list", "--porcelain"])) {
        return [
          "worktree /workspace/copilot-bridge",
          "HEAD aaaaaaa11111111111111111111111111111111",
          "branch refs/heads/main",
          "",
          "worktree /workspace/copilot-bridge-feature",
          "HEAD bbbbbbb22222222222222222222222222222222",
          "branch refs/heads/feature/live-status",
        ].join("\n");
      }
      throw new Error(`Unexpected git args: ${args.join(" ")}`);
    });

    const { readGitWorktreeStatus } = await loadGitWorktreeStatusModule();
    const result = await readGitWorktreeStatus("/workspace/copilot-bridge");

    expectNonInteractiveGitCalls();
    expect(result).toEqual({
      status: "ok",
      cwd: "/workspace/copilot-bridge",
      repoRoot: "/workspace/copilot-bridge",
      repoName: "copilot-bridge",
      worktreePath: "/workspace/copilot-bridge",
      workspaceKind: "main",
      head: { kind: "branch", name: "main" },
      dirty: {
        clean: true,
        staged: 0,
        modified: 0,
        untracked: 0,
        conflicts: 0,
      },
      siblingWorktrees: [
        {
          worktreePath: "/workspace/copilot-bridge-feature",
          workspaceKind: "linked",
          head: { kind: "branch", name: "feature/live-status" },
        },
      ],
      branch: "main",
      clean: true,
      staged: 0,
      modified: 0,
      untracked: 0,
      conflicts: 0,
    });
  });

  it("returns linked-worktree metadata using the main checkout as repoRoot", async () => {
    mockLinkedWorktreeGitCommands();

    const { readGitWorktreeStatus } = await loadGitWorktreeStatusModule();
    const result = await readGitWorktreeStatus("/workspace/feature-worktree/src/server");

    expect(result).toEqual({
      status: "ok",
      cwd: "/workspace/feature-worktree/src/server",
      repoRoot: "/workspace/copilot-bridge",
      repoName: "copilot-bridge",
      worktreePath: "/workspace/feature-worktree",
      workspaceKind: "linked",
      head: { kind: "branch", name: "feature/live-status" },
      dirty: {
        clean: false,
        staged: 2,
        modified: 2,
        untracked: 1,
        conflicts: 0,
      },
      siblingWorktrees: [
        {
          worktreePath: "/workspace/copilot-bridge",
          workspaceKind: "main",
          head: { kind: "branch", name: "main" },
        },
        {
          worktreePath: "/workspace/detached-worktree",
          workspaceKind: "linked",
          head: { kind: "detached", shortSha: "ccccccc" },
        },
      ],
      branch: "feature/live-status",
      clean: false,
      staged: 2,
      modified: 2,
      untracked: 1,
      conflicts: 0,
    });
  });

  it("surfaces detached HEAD explicitly and preserves conflict counts", async () => {
    mockExecFileImplementation((args) => {
      const key = gitArgsKey(args);
      if (key === gitArgsKey(["rev-parse", "--show-toplevel"])) {
        return "/workspace/detached-worktree";
      }
      if (key === gitArgsKey(["status", "--porcelain=v1", "--branch"])) {
        return [
          "## HEAD (no branch)",
          "UU both-modified.ts",
          "AA both-added.ts",
          "?? new-file.ts",
        ].join("\n");
      }
      if (key === gitArgsKey(["rev-parse", "--path-format=absolute", "--git-common-dir"])) {
        return "/workspace/copilot-bridge/.git";
      }
      if (key === gitArgsKey(["worktree", "list", "--porcelain"])) {
        return [
          "worktree /workspace/copilot-bridge",
          "HEAD aaaaaaa11111111111111111111111111111111",
          "branch refs/heads/main",
          "",
          "worktree /workspace/detached-worktree",
          "HEAD ccccccc33333333333333333333333333333333",
          "detached",
        ].join("\n");
      }
      throw new Error(`Unexpected git args: ${args.join(" ")}`);
    });

    const { readGitWorktreeStatus } = await loadGitWorktreeStatusModule();
    const result = await readGitWorktreeStatus("/workspace/detached-worktree");

    expect(result).toEqual({
      status: "ok",
      cwd: "/workspace/detached-worktree",
      repoRoot: "/workspace/copilot-bridge",
      repoName: "copilot-bridge",
      worktreePath: "/workspace/detached-worktree",
      workspaceKind: "linked",
      head: { kind: "detached", shortSha: "ccccccc" },
      dirty: {
        clean: false,
        staged: 0,
        modified: 0,
        untracked: 1,
        conflicts: 2,
      },
      siblingWorktrees: [
        {
          worktreePath: "/workspace/copilot-bridge",
          workspaceKind: "main",
          head: { kind: "branch", name: "main" },
        },
      ],
      branch: null,
      clean: false,
      staged: 0,
      modified: 0,
      untracked: 1,
      conflicts: 2,
    });
  });

  it("matches worktrees safely when git returns Windows-style paths", async () => {
    mockExecFileImplementation((args) => {
      const key = gitArgsKey(args);
      if (key === gitArgsKey(["rev-parse", "--show-toplevel"])) {
        return "C:/workspace/feature-worktree";
      }
      if (key === gitArgsKey(["status", "--porcelain=v1", "--branch"])) {
        return "## feature/windows";
      }
      if (key === gitArgsKey(["rev-parse", "--path-format=absolute", "--git-common-dir"])) {
        return "C:\\workspace\\copilot-bridge\\.git";
      }
      if (key === gitArgsKey(["worktree", "list", "--porcelain"])) {
        return [
          "worktree C:\\workspace\\copilot-bridge",
          "HEAD aaaaaaa11111111111111111111111111111111",
          "branch refs/heads/main",
          "",
          "worktree C:\\workspace\\feature-worktree\\",
          "HEAD bbbbbbb22222222222222222222222222222222",
          "branch refs/heads/feature/windows",
        ].join("\n");
      }
      throw new Error(`Unexpected git args: ${args.join(" ")}`);
    });

    realpathMock.mockImplementation(async (filePath) => filePath.replaceAll("/", "\\"));

    const { readGitWorktreeStatus } = await loadGitWorktreeStatusModule();
    const result = await readGitWorktreeStatus("C:\\workspace\\feature-worktree\\src");

    expect(result).toMatchObject({
      status: "ok",
      repoRoot: "C:\\workspace\\copilot-bridge",
      worktreePath: "C:\\workspace\\feature-worktree\\",
      workspaceKind: "linked",
      head: { kind: "branch", name: "feature/windows" },
      branch: "feature/windows",
    });
  });

  it("returns not_repo when the cwd is outside a git worktree", async () => {
    mockExecFileImplementation((args) => {
      if (gitArgsKey(args) === gitArgsKey(["rev-parse", "--show-toplevel"])) {
        return new Error("fatal: not a git repository (or any of the parent directories): .git");
      }
      throw new Error(`Unexpected git args: ${args.join(" ")}`);
    });

    const { readGitWorktreeStatus } = await loadGitWorktreeStatusModule();
    const result = await readGitWorktreeStatus("/workspace/not-a-repo");

    expect(result).toEqual({
      status: "not_repo",
      cwd: "/workspace/not-a-repo",
    });
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("prefers stderr output when git commands fail", async () => {
    mockExecFileImplementation((args) => {
      if (gitArgsKey(args) === gitArgsKey(["rev-parse", "--show-toplevel"])) {
        return {
          error: new Error("spawn git ENOENT"),
          stderr: Buffer.from("fatal: git is unavailable\n"),
        };
      }
      throw new Error(`Unexpected git args: ${args.join(" ")}`);
    });

    const { readGitWorktreeStatus } = await loadGitWorktreeStatusModule();
    const result = await readGitWorktreeStatus("/workspace/copilot-bridge");

    expect(result).toEqual({
      status: "unavailable",
      cwd: "/workspace/copilot-bridge",
      error: "fatal: git is unavailable",
    });
  });

  it("returns unavailable when git status cannot be read safely", async () => {
    mockLinkedWorktreeGitCommandsWithOverrides({
      [gitArgsKey(["status", "--porcelain=v1", "--branch"])]: new Error("spawn git ENOENT"),
    });

    const { readGitWorktreeStatus } = await loadGitWorktreeStatusModule();
    const result = await readGitWorktreeStatus("/workspace/feature-worktree");

    expect(result).toEqual({
      status: "unavailable",
      cwd: "/workspace/feature-worktree",
      error: "spawn git ENOENT",
    });
  });

  it("returns unavailable when worktree metadata cannot be parsed", async () => {
    mockExecFileImplementation((args) => {
      const key = gitArgsKey(args);
      if (key === gitArgsKey(["rev-parse", "--show-toplevel"])) {
        return "/workspace/copilot-bridge";
      }
      if (key === gitArgsKey(["status", "--porcelain=v1", "--branch"])) {
        return "## main";
      }
      if (key === gitArgsKey(["rev-parse", "--path-format=absolute", "--git-common-dir"])) {
        return "/workspace/copilot-bridge/.git";
      }
      if (key === gitArgsKey(["worktree", "list", "--porcelain"])) {
        return "worktree /workspace/copilot-bridge";
      }
      throw new Error(`Unexpected git args: ${args.join(" ")}`);
    });

    const { readGitWorktreeStatus } = await loadGitWorktreeStatusModule();
    const result = await readGitWorktreeStatus("/workspace/copilot-bridge");

    expect(result).toEqual({
      status: "unavailable",
      cwd: "/workspace/copilot-bridge",
      error: "Unable to parse git worktree list.",
    });
  });
});

describe("readCachedGitWorktreeStatus", () => {
  it("reuses fresh cached status for the same cwd", async () => {
    mockLinkedWorktreeGitCommands();
    let nowMs = 0;

    const { readCachedGitWorktreeStatus } = await loadGitWorktreeStatusModule();
    const first = await readCachedGitWorktreeStatus("/workspace/feature-worktree", { now: () => nowMs });
    expect(execFileMock).toHaveBeenCalledTimes(4);

    nowMs = 30_000;
    const second = await readCachedGitWorktreeStatus("/workspace/feature-worktree", { now: () => nowMs });

    expect(second).toEqual(first);
    expect(execFileMock).toHaveBeenCalledTimes(4);
  });

  it("coalesces concurrent cache misses for the same cwd", async () => {
    mockLinkedWorktreeGitCommands();

    const { readCachedGitWorktreeStatus } = await loadGitWorktreeStatusModule();
    const first = readCachedGitWorktreeStatus("/workspace/feature-worktree", { now: () => 0 });
    const second = readCachedGitWorktreeStatus("/workspace/feature-worktree", { now: () => 0 });
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(secondResult).toEqual(firstResult);
    expect(execFileMock).toHaveBeenCalledTimes(4);
  });

  it("force-refreshes even when cached status is still fresh", async () => {
    let dirty = false;
    let nowMs = 0;
    mockExecFileImplementation((args) => {
      const key = gitArgsKey(args);
      if (key === gitArgsKey(["rev-parse", "--show-toplevel"])) {
        return "/workspace/copilot-bridge";
      }
      if (key === gitArgsKey(["status", "--porcelain=v1", "--branch"])) {
        return dirty
          ? ["## main", " M modified.ts"].join("\n")
          : "## main";
      }
      if (key === gitArgsKey(["rev-parse", "--path-format=absolute", "--git-common-dir"])) {
        return "/workspace/copilot-bridge/.git";
      }
      if (key === gitArgsKey(["worktree", "list", "--porcelain"])) {
        return [
          "worktree /workspace/copilot-bridge",
          "HEAD aaaaaaa11111111111111111111111111111111",
          "branch refs/heads/main",
        ].join("\n");
      }
      throw new Error(`Unexpected git args: ${args.join(" ")}`);
    });

    const { readCachedGitWorktreeStatus } = await loadGitWorktreeStatusModule();
    const first = await readCachedGitWorktreeStatus("/workspace/copilot-bridge", { now: () => nowMs });
    expect(first).toMatchObject({ status: "ok", clean: true, modified: 0 });

    dirty = true;
    nowMs = 30_000;
    const refreshed = await readCachedGitWorktreeStatus("/workspace/copilot-bridge", {
      forceRefresh: true,
      now: () => nowMs,
    });

    expect(refreshed).toMatchObject({ status: "ok", clean: false, modified: 1 });
    expect(execFileMock).toHaveBeenCalledTimes(8);
  });

  it("runs a follow-up refresh when force-refresh is requested during an in-flight read", async () => {
    let statusReads = 0;
    mockExecFileImplementation((args) => {
      const key = gitArgsKey(args);
      if (key === gitArgsKey(["rev-parse", "--show-toplevel"])) {
        return "/workspace/copilot-bridge";
      }
      if (key === gitArgsKey(["status", "--porcelain=v1", "--branch"])) {
        statusReads += 1;
        return statusReads > 1
          ? ["## main", " M modified.ts"].join("\n")
          : "## main";
      }
      if (key === gitArgsKey(["rev-parse", "--path-format=absolute", "--git-common-dir"])) {
        return "/workspace/copilot-bridge/.git";
      }
      if (key === gitArgsKey(["worktree", "list", "--porcelain"])) {
        return [
          "worktree /workspace/copilot-bridge",
          "HEAD aaaaaaa11111111111111111111111111111111",
          "branch refs/heads/main",
        ].join("\n");
      }
      throw new Error(`Unexpected git args: ${args.join(" ")}`);
    });

    const { readCachedGitWorktreeStatus } = await loadGitWorktreeStatusModule();
    const initial = readCachedGitWorktreeStatus("/workspace/copilot-bridge", { now: () => 0 });
    const forced = readCachedGitWorktreeStatus("/workspace/copilot-bridge", {
      forceRefresh: true,
      now: () => 0,
    });
    const [initialResult, forcedResult] = await Promise.all([initial, forced]);

    expect(initialResult).toMatchObject({ status: "ok", clean: true, modified: 0 });
    expect(forcedResult).toMatchObject({ status: "ok", clean: false, modified: 1 });
    expect(statusReads).toBe(2);
    expect(execFileMock).toHaveBeenCalledTimes(8);
  });

  it("returns stale status while refreshing expired cache entries", async () => {
    let dirty = false;
    let nowMs = 0;
    mockExecFileImplementation((args) => {
      const key = gitArgsKey(args);
      if (key === gitArgsKey(["rev-parse", "--show-toplevel"])) {
        return "/workspace/copilot-bridge";
      }
      if (key === gitArgsKey(["status", "--porcelain=v1", "--branch"])) {
        return dirty
          ? ["## main", " M modified.ts"].join("\n")
          : "## main";
      }
      if (key === gitArgsKey(["rev-parse", "--path-format=absolute", "--git-common-dir"])) {
        return "/workspace/copilot-bridge/.git";
      }
      if (key === gitArgsKey(["worktree", "list", "--porcelain"])) {
        return [
          "worktree /workspace/copilot-bridge",
          "HEAD aaaaaaa11111111111111111111111111111111",
          "branch refs/heads/main",
        ].join("\n");
      }
      throw new Error(`Unexpected git args: ${args.join(" ")}`);
    });

    const { readCachedGitWorktreeStatus } = await loadGitWorktreeStatusModule();
    const first = await readCachedGitWorktreeStatus("/workspace/copilot-bridge", { now: () => nowMs });
    expect(first).toMatchObject({ status: "ok", clean: true, modified: 0 });

    dirty = true;
    nowMs = 61_000;
    const stale = await readCachedGitWorktreeStatus("/workspace/copilot-bridge", { now: () => nowMs });
    expect(stale).toMatchObject({ status: "ok", clean: true, modified: 0 });

    await new Promise<void>((resolve) => setImmediate(resolve));
    nowMs = 62_000;
    const refreshed = await readCachedGitWorktreeStatus("/workspace/copilot-bridge", { now: () => nowMs });
    expect(refreshed).toMatchObject({ status: "ok", clean: false, modified: 1 });
  });
});
