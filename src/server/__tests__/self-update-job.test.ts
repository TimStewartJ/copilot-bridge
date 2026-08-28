import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import type { PrepareReleaseSlotOptions } from "../release-slots.js";
import { makeTestDir } from "./helpers.js";

const activeReleaseMock = vi.hoisted(() => ({
  value: null as any,
}));
const reusableReleaseMock = vi.hoisted(() => ({
  value: null as any,
}));
const prepareReleaseSlotMock = vi.hoisted(() => vi.fn());
const writeRestartSignalFileMock = vi.hoisted(() => vi.fn());
const removeRollbackCheckpointMock = vi.hoisted(() => vi.fn());
type ValidationCommandOptions = {
  command: string;
  args?: readonly string[];
  displayCommand?: string;
  env?: NodeJS.ProcessEnv;
};
const renderedCommand = (options: ValidationCommandOptions) =>
  options.displayCommand ?? [options.command, ...(options.args ?? [])].join(" ");
const runValidationCommandMock = vi.hoisted(() => vi.fn(async (options: ValidationCommandOptions) => {
  switch (renderedCommand(options)) {
    case "git rev-parse --abbrev-ref HEAD":
      return { ok: true, output: "main\n" };
    case "git rev-parse HEAD":
      return { ok: true, output: "2222222222222222222222222222222222222222\n" };
    case "git pull --rebase origin main":
      return { ok: true, output: "Already up to date.\n" };
    case "git rev-parse --short HEAD":
      return { ok: true, output: "22222222\n" };
    case "git merge-base --is-ancestor \"1111111111111111111111111111111111111111\" \"2222222222222222222222222222222222222222\"":
      return { ok: true, output: "" };
    default:
      throw new Error(`Unexpected command: ${options.command}`);
  }
}));

vi.mock("../validation-command-runner.js", () => ({
  runValidationCommand: runValidationCommandMock,
}));

vi.mock("../release-slots.js", () => ({
  readActiveRelease: () => activeReleaseMock.value,
  findReleaseSlotByCommit: () => reusableReleaseMock.value,
  prepareReleaseSlot: prepareReleaseSlotMock,
}));

vi.mock("../restart-controller.js", () => ({
  beginRestartPending: () => ({ requestId: "restart-request-test", waitingSessions: 0 }),
  isRestartPending: () => false,
  triggerRestartPending: () => 0,
  clearRestartPending: vi.fn(),
}));

vi.mock("../restart-signal.js", () => ({
  writeRestartSignalFile: writeRestartSignalFileMock,
}));

vi.mock("../pre-deploy-checkpoint.js", () => ({
  preserveOrCreateRollbackCheckpoint: (_path: string, sha: string) => ({ sha, createdByCurrentOperation: true }),
  removeRollbackCheckpointIfCreated: removeRollbackCheckpointMock,
}));

function manifest(commitSha: string, dataDir: string) {
  return {
    version: 1,
    id: `slot-${commitSha.slice(0, 8)}`,
    root: join(dataDir, "release-slots", `slot-${commitSha.slice(0, 8)}`),
    commitSha,
    source: "self_update",
    dependencyHash: "hash",
    createdAt: "2026-05-18T20:00:00.000Z",
    validationMode: "deploy",
  };
}

function sourceManagedEnv(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    BRIDGE_DISTRIBUTION_MODE: "development",
    BRIDGE_CONTROL_DISTRIBUTION_MODE: "development",
  };
}

describe("runSelfUpdateJob active-release drift", () => {
  afterEach(() => {
    activeReleaseMock.value = null;
    reusableReleaseMock.value = null;
    prepareReleaseSlotMock.mockReset();
    writeRestartSignalFileMock.mockReset();
    removeRollbackCheckpointMock.mockReset();
    runValidationCommandMock.mockClear();
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  it("activates HEAD when drift is detected and fails when active release is not an ancestor of HEAD", async () => {
    // Successful drift activation
    vi.stubEnv("BRIDGE_DISTRIBUTION_MODE", "development");
    const oldSha = "1111111111111111111111111111111111111111";
    const headSha = "2222222222222222222222222222222222222222";
    const dataDir1 = makeTestDir("self-update-drift");
    activeReleaseMock.value = manifest(oldSha, dataDir1);
    reusableReleaseMock.value = manifest(headSha, dataDir1);
    vi.stubEnv("BRIDGE_DISTRIBUTION_MODE", "development");
    vi.stubEnv("BRIDGE_CONTROL_DISTRIBUTION_MODE", "development");

    const { runSelfUpdateJob } = await import("../self-update-job.js");
    const result1 = await runSelfUpdateJob({}, {
      controlRoot: process.cwd(),
      runtimePaths: {
        dataDir: dataDir1,
        docsDir: join(dataDir1, "docs"),
        env: sourceManagedEnv(),
      },
      log: () => {},
    }) as any;

    expect(result1.success).toBe(true);
    expect(result1.activeReleaseDrift).toBe(true);
    expect(result1.reusedReleaseSlot).toBe(true);
    expect(runValidationCommandMock).toHaveBeenCalledWith(expect.objectContaining({
      command: "git",
      args: ["pull", "--rebase", "origin", "main"],
      shell: false,
    }));
    expect(prepareReleaseSlotMock).not.toHaveBeenCalled();
    expect(writeRestartSignalFileMock).toHaveBeenCalledWith(
      expect.stringContaining("restart.signal"),
      expect.objectContaining({
        validationMode: "deploy",
        requestId: "restart-request-test",
        source: "self_update",
        releaseCandidate: expect.objectContaining({ commitSha: headSha }),
      }),
    );

    // Failed drift activation when active release is not an ancestor
    vi.resetModules();
    activeReleaseMock.value = null;
    reusableReleaseMock.value = null;
    prepareReleaseSlotMock.mockReset();
    writeRestartSignalFileMock.mockReset();
    runValidationCommandMock.mockClear();

    vi.stubEnv("BRIDGE_DISTRIBUTION_MODE", "development");
    const dataDir2 = makeTestDir("self-update-drift-failure");
    activeReleaseMock.value = manifest(oldSha, dataDir2);
    vi.stubEnv("BRIDGE_DISTRIBUTION_MODE", "development");
    vi.stubEnv("BRIDGE_CONTROL_DISTRIBUTION_MODE", "development");
    runValidationCommandMock.mockImplementation(async (options: ValidationCommandOptions) => {
      const command = renderedCommand(options);
      if (command.startsWith("git merge-base --is-ancestor")) return { ok: false, output: "" };
      return {
        ok: true,
        output: command === "git rev-parse --short HEAD"
          ? "22222222\n"
          : command === "git rev-parse --abbrev-ref HEAD"
            ? "main\n"
            : command === "git pull --rebase origin main"
              ? "Already up to date.\n"
              : "2222222222222222222222222222222222222222\n",
      };
    });

    const { runSelfUpdateJob: runSelfUpdateJob2 } = await import("../self-update-job.js");
    const result2 = await runSelfUpdateJob2({}, {
      controlRoot: process.cwd(),
      runtimePaths: {
        dataDir: dataDir2,
        docsDir: join(dataDir2, "docs"),
        env: sourceManagedEnv(),
      },
      log: () => {},
    }) as any;

    expect(result2.resultType).toBe("failure");
    expect(result2.textResultForLlm).toContain("Manual recovery is required");
    expect(writeRestartSignalFileMock).not.toHaveBeenCalled();
  });

  it("isolates release-slot validation from the running Bridge environment", async () => {
    const oldSha = "1111111111111111111111111111111111111111";
    const headSha = "2222222222222222222222222222222222222222";
    const dataDir = makeTestDir("self-update-isolation");
    const liveDataDir = makeTestDir("self-update-live-data");
    activeReleaseMock.value = manifest(oldSha, dataDir);
    vi.stubEnv("BRIDGE_DATA_DIR", liveDataDir);
    vi.stubEnv("BRIDGE_DISTRIBUTION_MODE", "development");
    vi.stubEnv("BRIDGE_CONTROL_DISTRIBUTION_MODE", "development");
    prepareReleaseSlotMock.mockImplementation(async (options: PrepareReleaseSlotOptions) => {
      const result = await options.run("npm run check:deploy", options.sourceDir, {
        timeoutMs: 600_000,
        isolateRuntimeEnv: true,
      });
      expect(result.ok).toBe(true);
      return { ok: true, manifest: manifest(headSha, dataDir) };
    });
    runValidationCommandMock.mockImplementation(async (options: ValidationCommandOptions) => {
      const command = renderedCommand(options);
      if (command === "npm run check:deploy") {
        expect(options.env?.BRIDGE_DATA_DIR).toBeTruthy();
        expect(options.env?.BRIDGE_DATA_DIR).not.toBe(liveDataDir);
        return { ok: true, output: "" };
      }
      if (command.startsWith("git merge-base --is-ancestor")) {
        return { ok: true, output: "" };
      }
      return {
        ok: true,
        output: command === "git rev-parse --short HEAD"
          ? "22222222\n"
          : command === "git rev-parse --abbrev-ref HEAD"
            ? "main\n"
            : command === "git pull --rebase origin main"
              ? "Already up to date.\n"
              : `${headSha}\n`,
      };
    });

    const { runSelfUpdateJob } = await import("../self-update-job.js");
    const result = await runSelfUpdateJob({}, {
      controlRoot: process.cwd(),
      runtimePaths: {
        dataDir,
        docsDir: join(dataDir, "docs"),
        env: sourceManagedEnv(),
      },
      log: () => {},
    }) as any;

    expect(result.success).toBe(true);
    expect(prepareReleaseSlotMock).toHaveBeenCalledOnce();
    expect(runValidationCommandMock).toHaveBeenCalledWith(
      expect.objectContaining({ command: "npm run check:deploy" }),
    );
  });
});
