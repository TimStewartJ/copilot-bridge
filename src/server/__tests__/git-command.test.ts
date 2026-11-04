import { afterEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFile: execFileMock,
  };
});

const NON_INTERACTIVE_ENV = {
  GIT_PAGER: "cat",
  PAGER: "cat",
  TERM: "dumb",
  GIT_TERMINAL_PROMPT: "0",
};

async function loadGitCommandModule() {
  vi.resetModules();
  return import("../git-command.js");
}

afterEach(() => {
  execFileMock.mockReset();
  vi.resetModules();
});

describe("createGitPullRebaseCommand", () => {
  it('keeps branch "branch with space" as one literal argv entry', async () => {
    const branch = "branch with space";
    const { createGitPullRebaseCommand } = await loadGitCommandModule();

    const invocation = createGitPullRebaseCommand(branch);

    expect(invocation.command).toBe("git");
    expect(invocation.args).toEqual(["pull", "--rebase", "origin", branch]);
    expect(invocation.displayCommand).toContain("git pull --rebase origin");
  });
});

describe("formatGitError", () => {
  it("reads stderr/stdout from the error object when not passed explicitly", async () => {
    const { formatGitError } = await loadGitCommandModule();
    expect(formatGitError({ stdout: "ignored", stderr: Buffer.from("from error stderr\n") })).toBe("from error stderr");
    expect(formatGitError({ stdout: "from error stdout" })).toBe("from error stdout");
  });

  it("uses the Error message when no stream output is present", async () => {
    const { formatGitError } = await loadGitCommandModule();
    expect(formatGitError(new Error("boom"))).toBe("boom");
  });
});

describe("runGit", () => {
  it("invokes git with --no-pager, the provided cwd, the non-interactive env, and the default or explicit timeout", async () => {
    const { runGit } = await loadGitCommandModule();
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      callback(null, "  on output\n", "");
    });

    expect(await runGit("/work/dir", ["status", "--branch"])).toEqual({ ok: true, output: "on output" });
    await runGit("/work/dir", ["fetch"], 1_234);

    expect(execFileMock.mock.calls.map(([command, args, options]) => [command, args, options])).toEqual([
      ["git", ["--no-pager", "status", "--branch"], expect.objectContaining({
        cwd: "/work/dir",
        encoding: "utf-8",
        env: expect.objectContaining(NON_INTERACTIVE_ENV),
        timeout: 5_000,
      })],
      ["git", ["--no-pager", "fetch"], expect.objectContaining({ timeout: 1_234 })],
    ]);
  });

  it("formats errors from stderr", async () => {
    const { runGit } = await loadGitCommandModule();
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      callback(new Error("Command failed"), "", "fatal: not a git repository\n");
    });

    const result = await runGit("/work/dir", ["status"]);

    expect(result).toEqual({ ok: false, error: "fatal: not a git repository" });
  });
});
