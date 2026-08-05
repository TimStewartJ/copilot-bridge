import { describe, expect, it, vi } from "vitest";
import { existsSync, readFileSync, readdirSync, writeSync } from "node:fs";
import { join } from "node:path";
import { runSyncCommand } from "../sync-command-runner.js";
import { makeTestDir } from "./helpers.js";

type MockSpawnOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  shell?: boolean;
  stdio?: unknown[];
  timeout?: number;
  windowsHide?: boolean;
};

type MockSpawnResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: NodeJS.ErrnoException;
};

const spawnSyncMock = vi.hoisted(() =>
  vi.fn((_command: string, _argsOrOptions?: readonly string[] | MockSpawnOptions, _options?: MockSpawnOptions): MockSpawnResult => ({
    status: 0,
    signal: null,
  })),
);

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawnSync: spawnSyncMock,
  };
});

function writeToStdioFd(options: MockSpawnOptions | undefined, index: number, value: string): void {
  const fd = options?.stdio?.[index];
  if (typeof fd !== "number") throw new Error(`Expected stdio fd at index ${index}`);
  writeSync(fd, value);
}

function callOptions(
  argsOrOptions: readonly string[] | MockSpawnOptions | undefined,
  options: MockSpawnOptions | undefined,
): MockSpawnOptions | undefined {
  return Array.isArray(argsOrOptions) ? options : argsOrOptions as MockSpawnOptions | undefined;
}

function runFakeCommand(rootDir: string) {
  return runSyncCommand({
    rootDir,
    source: "test",
    command: "fake command",
    cwd: rootDir,
    env: process.env,
    timeoutMs: 1_000,
  });
}

describe("runSyncCommand", () => {
  it("returns large stdout without using child_process output buffers", () => {
    const rootDir = makeTestDir("sync-command-runner-large");
    const largeOutput = "x".repeat(1_200_000);
    spawnSyncMock.mockImplementation((_command, argsOrOptions, options) => {
      writeToStdioFd(callOptions(argsOrOptions, options), 1, largeOutput);
      return { status: 0, signal: null };
    });

    const result = runFakeCommand(rootDir);

    expect(result).toEqual({ ok: true, output: largeOutput });
    expect(spawnSyncMock).toHaveBeenCalledWith("fake command", expect.objectContaining({
      cwd: rootDir,
      shell: true,
      timeout: 1_000,
      windowsHide: true,
    }));
    expect(readdirSync(join(rootDir, "data", "validation-logs", ".tmp"))).toEqual([]);
  });

  it("keeps stdout and stderr details when persisting a failure log", () => {
    const rootDir = makeTestDir("sync-command-runner-failure");
    spawnSyncMock.mockImplementation((_command, argsOrOptions, options) => {
      const spawnOptions = callOptions(argsOrOptions, options);
      writeToStdioFd(spawnOptions, 1, "normal output\n");
      writeToStdioFd(spawnOptions, 2, "warning output\n");
      return { status: 2, signal: null };
    });

    const result = runFakeCommand(rootDir);

    expect(result.ok).toBe(false);
    expect(result.output).toContain("stderr:\nwarning output");
    expect(result.output).toContain("stdout:\nnormal output");
    const logPath = result.validationLogPath;
    expect(logPath).toBeTruthy();
    if (!logPath) throw new Error("expected validation log path");
    expect(existsSync(logPath)).toBe(true);
    const log = readFileSync(logPath, "utf-8");
    expect(log).toContain("stderr:\nwarning output");
    expect(log).toContain("stdout:\nnormal output");
  });


  it("reports spawnSync timeout failures consistently", () => {
    const rootDir = makeTestDir("sync-command-runner-timeout");
    spawnSyncMock.mockImplementation((_command, argsOrOptions, options) => {
      writeToStdioFd(callOptions(argsOrOptions, options), 2, "still running\n");
      const error = Object.assign(new Error("spawnSync fake timeout"), { code: "ETIMEDOUT" });
      return { status: null, signal: null, error };
    });

    const result = runFakeCommand(rootDir);

    expect(result.ok).toBe(false);
    expect(result.output).toContain("stderr:\nstill running");
    expect(result.output).toContain("Command timed out after 1 seconds.");
    expect(result.validationLogPath).toContain("validation-logs");
  });

  it("reports signal failures without treating them as timeouts", () => {
    const rootDir = makeTestDir("sync-command-runner-signal");
    spawnSyncMock.mockImplementation(() => ({ status: null, signal: "SIGKILL" }));

    const result = runFakeCommand(rootDir);

    expect(result.ok).toBe(false);
    expect(result.output).toContain("Command exited with signal SIGKILL.");
    expect(result.output).not.toContain("Command timed out");
  });

  it("includes spawn errors in failure output", () => {
    const rootDir = makeTestDir("sync-command-runner-spawn-error");
    spawnSyncMock.mockImplementation(() => ({
      status: null,
      signal: null,
      error: Object.assign(new Error("spawn fake ENOENT"), { code: "ENOENT" }),
    }));

    const result = runFakeCommand(rootDir);

    expect(result.ok).toBe(false);
    expect(result.output).toContain("error:\nspawn fake ENOENT");
    expect(result.validationLogPath).toContain("validation-logs");
  });

  it("passes argv literally with the shell disabled", () => {
    const rootDir = makeTestDir("sync-command-runner-argv");
    const branch = "release/$rc with space;next";
    spawnSyncMock.mockReturnValue({ status: 0, signal: null });

    const result = runSyncCommand({
      rootDir,
      source: "test",
      command: "git",
      args: ["pull", "--rebase", "origin", branch],
      displayCommand: "git pull --rebase origin <branch>",
      cwd: rootDir,
      env: process.env,
      timeoutMs: 1_000,
    });

    expect(result.ok).toBe(true);
    expect(spawnSyncMock).toHaveBeenCalledWith(
      "git",
      ["pull", "--rebase", "origin", branch],
      expect.objectContaining({
        cwd: rootDir,
        shell: false,
        timeout: 1_000,
        windowsHide: true,
      }),
    );
  });
});
