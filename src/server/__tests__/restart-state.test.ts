import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { basename, dirname, join } from "node:path";

const {
  mkdirMock,
  readFileMock,
  renameMock,
  rmMock,
  writeFileMock,
  randomUUIDMock,
  readFileSyncMock,
  statSyncMock,
} = vi.hoisted(() => ({
  mkdirMock: vi.fn(),
  readFileMock: vi.fn(),
  renameMock: vi.fn(),
  rmMock: vi.fn(),
  writeFileMock: vi.fn(),
  randomUUIDMock: vi.fn(() => "restart-state-test"),
  readFileSyncMock: vi.fn(),
  statSyncMock: vi.fn(),
}));

vi.mock("node:crypto", () => ({
  randomUUID: randomUUIDMock,
}));

vi.mock("node:fs/promises", () => ({
  mkdir: mkdirMock,
  readFile: readFileMock,
  rename: renameMock,
  rm: rmMock,
  writeFile: writeFileMock,
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: readFileSyncMock,
    statSync: statSyncMock,
  };
});

import {
  DEFAULT_RESTART_STATE,
  __setRestartStateFsRetrySleepForTests,
  __setRestartStateFsRetrySleepSyncForTests,
  buildRestartStateWithReleaseFailure,
  clearRestartState,
  isDeployBatchRestartUpdateWindowOpen,
  isRestartAlreadyInFlight,
  readRestartState,
  readRestartStateSync,
  writeRestartState,
  type ReleaseFailureState,
  type RestartState,
} from "../restart-state.js";

const statePath = join("repo", "data", "restart-state.json");
const tempPath = join(dirname(statePath), `.${basename(statePath)}.restart-state-test.tmp`);

const activeState: RestartState = {
  requestId: "req-123",
  phase: "waiting-for-sessions",
  requestedAt: "2026-04-24T12:00:00.000Z",
  waitingSessions: 3,
  launcherHeartbeatAt: "2026-04-24T12:00:05.000Z",
  releaseFailure: null,
};

const releaseFailure: ReleaseFailureState = {
  event: "launcher-manual-intervention-required",
  phase: "rollback",
  failedAt: "2026-04-24T12:05:00.000Z",
  message: "Rollback failed — manual intervention required.",
  command: "npx vite build",
  validationLogPath: "/repo/data/validation-logs/restart.log",
  commitSha: "abc1234",
  rollbackTarget: "def5678",
};

describe("restart-state", () => {
  beforeEach(() => {
    mkdirMock.mockReset();
    readFileMock.mockReset();
    renameMock.mockReset();
    rmMock.mockReset();
    writeFileMock.mockReset();
    randomUUIDMock.mockClear();
    readFileSyncMock.mockReset();
    statSyncMock.mockReset();

    mkdirMock.mockResolvedValue(undefined);
    readFileMock.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
    renameMock.mockResolvedValue(undefined);
    rmMock.mockResolvedValue(undefined);
    writeFileMock.mockResolvedValue(undefined);
    readFileSyncMock.mockImplementation(() => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    statSyncMock.mockImplementation(() => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    __setRestartStateFsRetrySleepSyncForTests(() => {});
  });

  it("returns the default state when no persisted file exists", async () => {
    await expect(readRestartState(statePath)).resolves.toEqual(DEFAULT_RESTART_STATE);
    expect(readFileMock).toHaveBeenCalledWith(statePath, "utf8");
  });

  it("normalizes persisted JSON into the shared restart shape", async () => {
    readFileMock.mockResolvedValue(JSON.stringify({
      requestId: "req-123",
      phase: "waiting-for-sessions",
      requestedAt: "2026-04-24T12:00:00.000Z",
      waitingSessions: 3.8,
      launcherHeartbeatAt: "",
      releaseFailure: {
        event: "launcher-manual-intervention-required",
        phase: "rollback",
        failedAt: "2026-04-24T12:05:00.000Z",
        message: "",
        command: "npx vite build",
        validationLogPath: "/repo/data/validation-logs/restart.log",
        commitSha: "abc1234",
        rollbackTarget: "def5678",
      },
    }));

    await expect(readRestartState(statePath)).resolves.toEqual({
      requestId: "req-123",
      phase: "waiting-for-sessions",
      requestedAt: "2026-04-24T12:00:00.000Z",
      waitingSessions: 3,
      launcherHeartbeatAt: null,
      releaseFailure: {
        event: "launcher-manual-intervention-required",
        phase: "rollback",
        failedAt: "2026-04-24T12:05:00.000Z",
        message: null,
        command: "npx vite build",
        validationLogPath: "/repo/data/validation-logs/restart.log",
        commitSha: "abc1234",
        rollbackTarget: "def5678",
      },
    });
  });

  it("rejects malformed JSON instead of treating it as idle", async () => {
    readFileMock.mockResolvedValue("{");

    await expect(readRestartState(statePath)).rejects.toThrow();
  });

  it("writes through a temp file before renaming into place", async () => {
    await expect(writeRestartState(statePath, activeState)).resolves.toEqual(activeState);

    expect(mkdirMock).toHaveBeenCalledWith(dirname(statePath), { recursive: true });
    expect(writeFileMock).toHaveBeenCalledWith(
      tempPath,
      `${JSON.stringify(activeState, null, 2)}\n`,
      "utf8",
    );
    expect(renameMock).toHaveBeenCalledWith(tempPath, statePath);
    expect(writeFileMock).not.toHaveBeenCalledWith(statePath, expect.anything(), expect.anything());
  });

  it("retries transient rename, read, and clear failures before succeeding", async () => {
    // Transient rename failure on write
    renameMock
      .mockRejectedValueOnce(Object.assign(new Error("state file locked"), { code: "EPERM" }))
      .mockResolvedValueOnce(undefined);

    await expect(writeRestartState(statePath, activeState)).resolves.toEqual(activeState);

    expect(renameMock).toHaveBeenCalledTimes(2);
    expect(renameMock).toHaveBeenNthCalledWith(1, tempPath, statePath);
    expect(renameMock).toHaveBeenNthCalledWith(2, tempPath, statePath);
    expect(rmMock).not.toHaveBeenCalled();

    // Transient read failure falls back gracefully
    renameMock.mockResolvedValue(undefined);
    readFileMock.mockReset();
    readFileMock
      .mockRejectedValueOnce(Object.assign(new Error("state file locked"), { code: "EBUSY" }))
      .mockResolvedValueOnce(JSON.stringify(activeState));

    await expect(readRestartState(statePath)).resolves.toEqual(activeState);
    expect(readFileMock).toHaveBeenCalledTimes(2);

    // Transient clear failure retries
    rmMock.mockReset();
    rmMock
      .mockRejectedValueOnce(Object.assign(new Error("state file locked"), { code: "EACCES" }))
      .mockResolvedValueOnce(undefined);

    await clearRestartState(statePath);

    expect(rmMock).toHaveBeenCalledTimes(2);
    expect(rmMock).toHaveBeenNthCalledWith(1, statePath, { force: true });
    expect(rmMock).toHaveBeenNthCalledWith(2, statePath, { force: true });
  });

  it("cleans up the temp file if rename fails", async () => {
    renameMock.mockRejectedValueOnce(new Error("rename failed"));

    await expect(writeRestartState(statePath, activeState)).rejects.toThrow("rename failed");
    expect(rmMock).toHaveBeenCalledWith(tempPath, { force: true });
  });

  it("clears the persisted state file", async () => {
    await clearRestartState(statePath);

    expect(rmMock).toHaveBeenCalledWith(statePath, { force: true });
  });

  it("builds an idle restart state that preserves release failure metadata", () => {
    expect(buildRestartStateWithReleaseFailure(activeState, releaseFailure)).toEqual({
      ...activeState,
      phase: "idle",
      waitingSessions: 0,
      releaseFailure,
    });
  });

  it("opens deploy admission only while a deploy-batch restart is queued or waiting", () => {
    const dataDir = join("repo", "data");
    readFileSyncMock.mockImplementation((path: string) => {
      if (path === join(dataDir, "restart-state.json")) return JSON.stringify(activeState);
      if (path === join(dataDir, "restart-in-progress.json")) {
        return JSON.stringify({
          requestedAt: activeState.requestedAt,
          requestId: activeState.requestId,
          validationMode: "deploy",
          source: "staging_deploy_batch",
          releaseCandidate: {
            id: "release-1",
            root: "release-1",
            commitSha: "commit-1",
            source: "staging_deploy",
            dependencyHash: "deps-1",
          },
        });
      }
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });

    expect(isDeployBatchRestartUpdateWindowOpen(dataDir)).toBe(true);

    readFileSyncMock.mockImplementation((path: string) => {
      if (path === join(dataDir, "restart-state.json")) {
        return JSON.stringify({ ...activeState, phase: "restarting" });
      }
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    expect(isDeployBatchRestartUpdateWindowOpen(dataDir)).toBe(false);
  });

  it("round-trips queued, restarting, and idle phase states", async () => {
    const queued: RestartState = {
      requestId: "req-queued",
      phase: "queued",
      requestedAt: "2026-04-24T13:00:00.000Z",
      waitingSessions: 0,
      launcherHeartbeatAt: null,
      releaseFailure: null,
    };

    const written1 = await writeRestartState(statePath, queued);
    expect(written1).toEqual(queued);
    readFileMock.mockResolvedValueOnce(JSON.stringify(written1));
    expect(await readRestartState(statePath)).toEqual(queued);

    const restarting: RestartState = {
      requestId: "req-restarting",
      phase: "restarting",
      requestedAt: "2026-04-24T14:00:00.000Z",
      waitingSessions: 2,
      launcherHeartbeatAt: "2026-04-24T14:00:10.000Z",
      releaseFailure: null,
    };

    const written2 = await writeRestartState(statePath, restarting);
    expect(written2).toEqual(restarting);
    readFileMock.mockResolvedValueOnce(JSON.stringify(written2));
    expect(await readRestartState(statePath)).toEqual(restarting);

    const idle: RestartState = {
      requestId: null,
      phase: "idle",
      requestedAt: null,
      waitingSessions: 0,
      launcherHeartbeatAt: null,
      releaseFailure: null,
    };

    const written3 = await writeRestartState(statePath, idle);
    expect(written3).toEqual(idle);
    expect(written3).toEqual(DEFAULT_RESTART_STATE);
  });

  it("rejects an unknown phase instead of normalizing it to idle", async () => {
    readFileMock.mockResolvedValueOnce(JSON.stringify({
      requestId: "req-bad",
      phase: "launching",
      requestedAt: "2026-04-24T15:00:00.000Z",
      waitingSessions: 1,
    }));

    await expect(readRestartState(statePath)).rejects.toThrow("invalid phase");
  });

  it("clamps negative waitingSessions to zero", async () => {
    readFileMock.mockResolvedValueOnce(JSON.stringify({
      requestId: "req-neg",
      phase: "restarting",
      requestedAt: "2026-04-24T15:00:00.000Z",
      waitingSessions: -5,
    }));

    const result = await readRestartState(statePath);
    expect(result.waitingSessions).toBe(0);
  });

  it("surfaces exhausted unreadable-state errors instead of treating them as missing", async () => {
    __setRestartStateFsRetrySleepForTests(() => Promise.resolve());
    readFileMock.mockRejectedValue(Object.assign(new Error("permission denied"), { code: "EACCES" }));

    await expect(readRestartState(statePath)).rejects.toThrow("permission denied");
    expect(readFileMock).toHaveBeenCalledTimes(6);
  });

  it("retries transient synchronous reads and fails closed on corrupt state", () => {
    readFileSyncMock
      .mockImplementationOnce(() => {
        throw Object.assign(new Error("state file busy"), { code: "EBUSY" });
      })
      .mockReturnValueOnce(JSON.stringify({ phase: "idle" }));

    expect(readRestartStateSync(statePath)).toEqual(DEFAULT_RESTART_STATE);
    expect(readFileSyncMock).toHaveBeenCalledTimes(2);

    readFileSyncMock.mockReset();
    readFileSyncMock.mockReturnValue("{");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    expect(isRestartAlreadyInFlight(dirname(statePath))).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("treating the lifecycle as busy"),
      expect.any(SyntaxError),
    );
    errorSpy.mockRestore();
  });

});

describe("restart-state transient FS retry under fake timers", () => {
  beforeEach(() => {
    mkdirMock.mockReset();
    readFileMock.mockReset();
    renameMock.mockReset();
    rmMock.mockReset();
    writeFileMock.mockReset();
    randomUUIDMock.mockClear();

    mkdirMock.mockResolvedValue(undefined);
    rmMock.mockResolvedValue(undefined);
    writeFileMock.mockResolvedValue(undefined);

    vi.useFakeTimers();
  });

  afterEach(() => {
    __setRestartStateFsRetrySleepForTests();
    __setRestartStateFsRetrySleepSyncForTests();
    vi.useRealTimers();
  });

  it("retries and resolves under fake timers without manual timer advancement", async () => {
    // Regression guard: the default retry backoff is bound to the real timer at
    // module load (restart-state.ts), so a transient FS error still retries and
    // resolves even though the suite installed fake timers — no manual
    // advanceTimers needed. If the backoff is ever rebound to the faked timer,
    // this hangs and fails, reproducing the original parallel-load flake.
    renameMock
      .mockRejectedValueOnce(Object.assign(new Error("locked"), { code: "EBUSY" }))
      .mockResolvedValueOnce(undefined);

    await expect(writeRestartState(statePath, activeState)).resolves.toEqual(activeState);
    expect(renameMock).toHaveBeenCalledTimes(2);
  });

  it("honors an injected instant retry sleep via the test seam", async () => {
    // The seam lets a suite make the backoff instant/deterministic when desired.
    __setRestartStateFsRetrySleepForTests(() => Promise.resolve());

    readFileMock
      .mockRejectedValueOnce(Object.assign(new Error("locked"), { code: "EACCES" }))
      .mockResolvedValueOnce(JSON.stringify(activeState));

    await expect(readRestartState(statePath)).resolves.toEqual(activeState);
    expect(readFileMock).toHaveBeenCalledTimes(2);
  });
});
