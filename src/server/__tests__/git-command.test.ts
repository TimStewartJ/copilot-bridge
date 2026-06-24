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
  execFileSyncMock.mockReset();
  vi.resetModules();
});

describe("normalizeStreamOutput", () => {
  it("trims string output", async () => {
    const { normalizeStreamOutput } = await loadGitCommandModule();
    expect(normalizeStreamOutput("  hello world  ")).toBe("hello world");
  });

  it("decodes and trims Buffer output", async () => {
    const { normalizeStreamOutput } = await loadGitCommandModule();
    expect(normalizeStreamOutput(Buffer.from("  buffered  "))).toBe("buffered");
  });

  it("returns an empty string for non-string, non-Buffer input", async () => {
    const { normalizeStreamOutput } = await loadGitCommandModule();
    expect(normalizeStreamOutput(undefined)).toBe("");
    expect(normalizeStreamOutput(null)).toBe("");
    expect(normalizeStreamOutput(42)).toBe("");
    expect(normalizeStreamOutput({})).toBe("");
  });
});

describe("formatGitError", () => {
  it("prefers explicit stderr over stdout and the error", async () => {
    const { formatGitError } = await loadGitCommandModule();
    expect(formatGitError(new Error("ignored"), "out text", "  err text  ")).toBe("err text");
  });

  it("falls back to explicit stdout when stderr is empty", async () => {
    const { formatGitError } = await loadGitCommandModule();
    expect(formatGitError(new Error("ignored"), "  out text  ", "")).toBe("out text");
  });

  it("reads stderr/stdout from the error object when not passed explicitly", async () => {
    const { formatGitError } = await loadGitCommandModule();
    expect(formatGitError({ stderr: "from error stderr" })).toBe("from error stderr");
    expect(formatGitError({ stdout: "from error stdout" })).toBe("from error stdout");
  });

  it("decodes Buffer stderr from the error object", async () => {
    const { formatGitError } = await loadGitCommandModule();
    expect(formatGitError({ stderr: Buffer.from("buffered fatal\n") })).toBe("buffered fatal");
  });

  it("uses the Error message when no stream output is present", async () => {
    const { formatGitError } = await loadGitCommandModule();
    expect(formatGitError(new Error("boom"))).toBe("boom");
  });

  it("stringifies non-Error fallbacks", async () => {
    const { formatGitError } = await loadGitCommandModule();
    expect(formatGitError("plain string error")).toBe("plain string error");
    expect(formatGitError(42)).toBe("42");
  });
});

describe("runGit", () => {
  it("invokes git with --no-pager, the provided cwd, the non-interactive env, and the default timeout", async () => {
    const { runGit, LOCAL_GIT_TIMEOUT_MS } = await loadGitCommandModule();
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      callback(null, "  on output\n", "");
    });

    const result = await runGit("/work/dir", ["status", "--branch"]);

    expect(result).toEqual({ ok: true, output: "on output" });
    expect(LOCAL_GIT_TIMEOUT_MS).toBe(5_000);
    expect(execFileMock).toHaveBeenCalledWith(
      "git",
      ["--no-pager", "status", "--branch"],
      expect.objectContaining({
        cwd: "/work/dir",
        encoding: "utf-8",
        env: expect.objectContaining(NON_INTERACTIVE_ENV),
        timeout: 5_000,
      }),
      expect.any(Function),
    );
  });

  it("honors an explicit timeout override", async () => {
    const { runGit } = await loadGitCommandModule();
    execFileMock.mockImplementation((_command, _args, _options, callback) => {
      callback(null, "ok", "");
    });

    await runGit("/work/dir", ["fetch"], 1_234);

    expect(execFileMock).toHaveBeenCalledWith(
      "git",
      ["--no-pager", "fetch"],
      expect.objectContaining({ timeout: 1_234 }),
      expect.any(Function),
    );
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

describe("runGitSync", () => {
  it("invokes git with --no-pager, the provided cwd, the non-interactive env, and the default timeout", async () => {
    const { runGitSync } = await loadGitCommandModule();
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
    const { runGitSync } = await loadGitCommandModule();
    execFileSyncMock.mockReturnValue("ok");

    runGitSync("/repo", ["log"], 999);

    expect(execFileSyncMock).toHaveBeenCalledWith(
      "git",
      ["--no-pager", "log"],
      expect.objectContaining({ timeout: 999 }),
    );
  });

  it("formats thrown errors via their stderr", async () => {
    const { runGitSync } = await loadGitCommandModule();
    execFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error("Command failed"), { stderr: Buffer.from("fatal: bad revision\n") });
    });

    expect(runGitSync("/repo", ["rev-parse", "HEAD"])).toEqual({
      ok: false,
      error: "fatal: bad revision",
    });
  });
});
