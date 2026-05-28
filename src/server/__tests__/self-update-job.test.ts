import { afterEach, describe, expect, it, vi } from "vitest";
import { join } from "node:path";
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
const runValidationCommandMock = vi.hoisted(() => vi.fn(async (options: { command: string }) => {
  switch (options.command) {
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

describe("runSelfUpdateJob active-release drift", () => {
  afterEach(() => {
    activeReleaseMock.value = null;
    reusableReleaseMock.value = null;
    prepareReleaseSlotMock.mockReset();
    writeRestartSignalFileMock.mockReset();
    removeRollbackCheckpointMock.mockReset();
    runValidationCommandMock.mockClear();
    vi.resetModules();
  });

  it("activates HEAD when the checkout is unchanged but active release is older", async () => {
    const oldSha = "1111111111111111111111111111111111111111";
    const headSha = "2222222222222222222222222222222222222222";
    const dataDir = makeTestDir("self-update-drift");
    activeReleaseMock.value = manifest(oldSha, dataDir);
    reusableReleaseMock.value = manifest(headSha, dataDir);

    const { runSelfUpdateJob } = await import("../self-update-job.js");
    const result = await runSelfUpdateJob({}, {
      controlRoot: process.cwd(),
      runtimePaths: {
        dataDir,
        docsDir: join(dataDir, "docs"),
        env: process.env,
      },
      log: () => {},
    }) as any;

    expect(result.success).toBe(true);
    expect(result.activeReleaseDrift).toBe(true);
    expect(result.reusedReleaseSlot).toBe(true);
    expect(prepareReleaseSlotMock).not.toHaveBeenCalled();
    expect(writeRestartSignalFileMock).toHaveBeenCalledWith(
      expect.stringContaining("restart.signal"),
      expect.objectContaining({
        validationMode: "deploy",
        source: "self_update",
        releaseCandidate: expect.objectContaining({ commitSha: headSha }),
      }),
    );
  });

  it("fails drift activation when active release is not an ancestor of HEAD", async () => {
    const oldSha = "1111111111111111111111111111111111111111";
    const dataDir = makeTestDir("self-update-drift-failure");
    activeReleaseMock.value = manifest(oldSha, dataDir);
    runValidationCommandMock.mockImplementation(async (options: { command: string }) => {
      if (options.command.startsWith("git merge-base --is-ancestor")) return { ok: false, output: "" };
      return {
        ok: true,
        output: options.command === "git rev-parse --short HEAD"
          ? "22222222\n"
          : options.command === "git rev-parse --abbrev-ref HEAD"
            ? "main\n"
            : options.command === "git pull --rebase origin main"
              ? "Already up to date.\n"
              : "2222222222222222222222222222222222222222\n",
      };
    });

    const { runSelfUpdateJob } = await import("../self-update-job.js");
    const result = await runSelfUpdateJob({}, {
      controlRoot: process.cwd(),
      runtimePaths: {
        dataDir,
        docsDir: join(dataDir, "docs"),
        env: process.env,
      },
      log: () => {},
    }) as any;

    expect(result.resultType).toBe("failure");
    expect(result.textResultForLlm).toContain("Manual recovery is required");
    expect(writeRestartSignalFileMock).not.toHaveBeenCalled();
  });
});
