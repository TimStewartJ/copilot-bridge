import { EventEmitter } from "node:events";
import { readFileSync, rmSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTestDir } from "./helpers.js";

const spawnMock = vi.hoisted(() => vi.fn());
const killProcessTreeMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    spawn: spawnMock,
  };
});

vi.mock("../platform.js", () => ({
  killProcessTree: killProcessTreeMock,
}));

type MockSpawnResult = {
  stdout?: string;
  stderr?: string;
  code?: number | null;
  signal?: NodeJS.Signals | null;
  error?: Error;
};

const tempDirs: string[] = [];

function createTempDir(): string {
  const dir = makeTestDir("deploy-check");
  tempDirs.push(dir);
  return dir;
}

function mockSpawnResult(result: MockSpawnResult): void {
  spawnMock.mockImplementationOnce(() => {
    const child = new EventEmitter() as EventEmitter & {
      pid: number;
      kill: ReturnType<typeof vi.fn>;
      stdout: EventEmitter;
      stderr: EventEmitter;
    };
    child.pid = 12345;
    child.kill = vi.fn();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();

    queueMicrotask(() => {
      if (result.error) {
        child.emit("error", result.error);
        return;
      }
      if (result.stdout) child.stdout.emit("data", result.stdout);
      if (result.stderr) child.stderr.emit("data", result.stderr);
      child.emit("close", result.code ?? 0, result.signal ?? null);
    });

    return child;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  spawnMock.mockReset();
  killProcessTreeMock.mockReset();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  vi.doUnmock("node:fs");
  vi.unstubAllEnvs();
});

describe("deploy check contract", () => {
  it("does not run coverage during interactive deploy validation", async () => {
    const { DEPLOY_CHECK_STEPS } = await import("../deploy-check.js");
    const commands = DEPLOY_CHECK_STEPS.map((step) => step.join(" "));

    expect(commands).toEqual([
      "npm run check:pr",
    ]);
    expect(commands).not.toContain("npm run test:coverage");
    expect(commands).not.toContain("npm run preview:smoke");
  });

  it("keeps production deploy checks separate from staging-only smoke", async () => {
    const { DEPLOY_CHECK_STEPS } = await import("../deploy-check.js");
    const { DEPLOY_GATE, STAGING_DEPLOY_GATE } = await import("../validation-pipeline.js");
    const deployCommands = DEPLOY_CHECK_STEPS.map((step) => step.join(" "));

    expect(DEPLOY_GATE.steps.map((step) => step.command)).toEqual(["npm run check:deploy"]);
    expect(deployCommands).toEqual(["npm run check:pr"]);
    expect(STAGING_DEPLOY_GATE.steps.map((step) => step.command)).toEqual([
      "npm run check:pr",
      "npm run preview:smoke",
    ]);
  });

  it("falls back to captured output when a failed step log disappears", async () => {
    vi.resetModules();
    const logDir = makeTestDir("deploy-check-missing-log");
    vi.stubEnv("BRIDGE_VALIDATION_LOG_DIR", logDir);
    vi.doMock("node:fs", async (importOriginal) => {
      const actual = await importOriginal<typeof import("node:fs")>();
      return {
        ...actual,
        statSync: (path: Parameters<typeof actual.statSync>[0], ...args: unknown[]) => {
          if (String(path).includes("-deploy-check-")) {
            const error = new Error("mocked missing log") as NodeJS.ErrnoException;
            error.code = "ENOENT";
            throw error;
          }
          return actual.statSync(path, ...(args as []));
        },
      };
    });
    mockSpawnResult({ stdout: "real smoke failure marker\n", code: 7 });
    const { DEPLOY_CHECK_STEPS, runDeployChecks } = await import("../deploy-check.js");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    try {
      await expect(runDeployChecks([DEPLOY_CHECK_STEPS[0]])).rejects.toThrow("failed");
      const stderr = errorSpy.mock.calls.map((args) => args.join(" ")).join("\n");
      expect(stderr).toContain("unable to read log tail");
      expect(stderr).toContain("real smoke failure marker");
    } finally {
      errorSpy.mockRestore();
      vi.doUnmock("node:fs");
      vi.resetModules();
      vi.unstubAllEnvs();
    }
  });

  it("streams each deploy step to a validation log", async () => {
    const cwd = createTempDir();
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    vi.spyOn(console, "log").mockImplementation(() => {});
    mockSpawnResult({ stdout: "pr ok\n" });
    const { runDeployChecks } = await import("../deploy-check.js");

    const results = await runDeployChecks();

    expect(results).toHaveLength(1);
    expect(results[0].logPath).toContain("validation-logs");
    expect(readFileSync(results[0].logPath, "utf-8")).toBe("pr ok\n");
    expect(spawnMock).toHaveBeenCalledWith(
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["run", "check:pr"],
      expect.objectContaining({
        cwd,
        shell: process.platform === "win32",
        windowsHide: true,
      }),
    );
  });

  it("prints the shared validation log tail when a step fails", async () => {
    const cwd = createTempDir();
    vi.spyOn(process, "cwd").mockReturnValue(cwd);
    vi.spyOn(console, "log").mockImplementation(() => {});
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    mockSpawnResult({ stdout: "normal output\n", stderr: "deploy failed\n", code: 2 });
    const { DEPLOY_CHECK_STEPS, runDeployChecks } = await import("../deploy-check.js");

    await expect(runDeployChecks([DEPLOY_CHECK_STEPS[0]])).rejects.toThrow(
      "npm run check:pr failed (exit code 2)",
    );

    const errors = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(errors).toContain("[check:deploy] full log:");
    expect(errors).toContain("normal output");
    expect(errors).toContain("deploy failed");
    expect(errors).toContain("failed after");
    expect(errors).not.toContain("ss (exit code 2)");
  });
});
