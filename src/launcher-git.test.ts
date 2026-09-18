import { afterEach, describe, expect, it, vi } from "vitest";

const execFileSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFileSync: execFileSyncMock };
});

const NON_INTERACTIVE_ENV = {
  GIT_PAGER: "cat",
  PAGER: "cat",
  TERM: "dumb",
  GIT_TERMINAL_PROMPT: "0",
};

async function loadLauncherGit() {
  vi.resetModules();
  return import("./launcher-git.js");
}

afterEach(() => {
  execFileSyncMock.mockReset();
  vi.resetModules();
});

describe("runGitSync", () => {
  it("invokes git with --no-pager, the provided cwd, the non-interactive env, and the default timeout", async () => {
    const { runGitSync } = await loadLauncherGit();
    execFileSyncMock.mockReturnValue("  abc123\n");

    const result = runGitSync("/repo", ["rev-parse", "--short", "HEAD"]);

    expect(result).toEqual({ ok: true, output: "abc123" });
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "git",
      ["--no-pager", "rev-parse", "--short", "HEAD"],
      expect.objectContaining({
        cwd: "/repo",
        encoding: "utf-8",
        env: expect.objectContaining(NON_INTERACTIVE_ENV),
        timeout: 5_000,
      }),
    );
  });

  it("honors an explicit timeout override", async () => {
    const { runGitSync } = await loadLauncherGit();
    execFileSyncMock.mockReturnValue("ok");

    runGitSync("/repo", ["log"], 999);

    expect(execFileSyncMock).toHaveBeenCalledWith(
      "git",
      ["--no-pager", "log"],
      expect.objectContaining({ timeout: 999 }),
    );
  });

  it("formats thrown errors via their stderr", async () => {
    const { runGitSync } = await loadLauncherGit();
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error("Command failed"), { stderr: Buffer.from("fatal: bad revision\n") });
    });

    expect(runGitSync("/repo", ["rev-parse", "HEAD"])).toEqual({
      ok: false,
      error: "fatal: bad revision",
    });
  });
});

describe("gitHash", () => {
  it("reads the current short hash through the hardened sync git helper", async () => {
    execFileSyncMock.mockReturnValue("abc1234\n");
    const { gitHash } = await loadLauncherGit();

    expect(gitHash()).toBe("abc1234");
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "git",
      ["--no-pager", "rev-parse", "--short", "HEAD"],
      expect.objectContaining({
        encoding: "utf-8",
        env: expect.objectContaining(NON_INTERACTIVE_ENV),
        timeout: 5_000,
      }),
    );
  });

  it("returns unknown when the current short hash cannot be read or is empty", async () => {
    execFileSyncMock.mockImplementation(() => {
      throw new Error("git unavailable");
    });
    expect((await loadLauncherGit()).gitHash(), "throws").toBe("unknown");

    execFileSyncMock.mockReset();
    execFileSyncMock.mockReturnValue("\n");
    expect((await loadLauncherGit()).gitHash(), "empty output").toBe("unknown");
  });
});
