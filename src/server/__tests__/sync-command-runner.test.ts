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
  vi.fn<(command: string, options?: MockSpawnOptions) => MockSpawnResult>(() => ({
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
    spawnSyncMock.mockImplementation((_command, options) => {
      writeToStdioFd(options, 1, largeOutput);
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
    spawnSyncMock.mockImplementation((_command, options) => {
      writeToStdioFd(options, 1, "normal output\n");
      writeToStdioFd(options, 2, "warning output\n");
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

  it("does not mislabel ENOBUFS SIGTERM failures as timeouts", () => {
    const rootDir = makeTestDir("sync-command-runner-enobufs");
    spawnSyncMock.mockImplementation((_command, options) => {
      writeToStdioFd(options, 1, "buffered output\n");
      const error = Object.assign(new Error("spawnSync fake ENOBUFS"), { code: "ENOBUFS" });
      return { status: null, signal: "SIGTERM", error };
    });

    const result = runFakeCommand(rootDir);

    expect(result.ok).toBe(false);
    expect(result.output).toContain("Command exited with signal SIGTERM");
    expect(result.output).not.toContain("Command timed out");
  });
});
