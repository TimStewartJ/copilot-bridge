import { beforeEach, describe, expect, it, vi } from "vitest";
import { basename, dirname, join } from "node:path";

const {
  mkdirMock,
  readFileMock,
  renameMock,
  rmMock,
  writeFileMock,
  randomUUIDMock,
} = vi.hoisted(() => ({
  mkdirMock: vi.fn(),
  readFileMock: vi.fn(),
  renameMock: vi.fn(),
  rmMock: vi.fn(),
  writeFileMock: vi.fn(),
  randomUUIDMock: vi.fn(() => "restart-state-test"),
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

import {
  DEFAULT_RESTART_STATE,
  buildRestartStateWithReleaseFailure,
  clearRestartState,
  readRestartState,
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

    mkdirMock.mockResolvedValue(undefined);
    readFileMock.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
    renameMock.mockResolvedValue(undefined);
    rmMock.mockResolvedValue(undefined);
    writeFileMock.mockResolvedValue(undefined);
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

  it("falls back to the default state for malformed JSON", async () => {
    readFileMock.mockResolvedValue("{");

    await expect(readRestartState(statePath)).resolves.toEqual(DEFAULT_RESTART_STATE);
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

  it("retries transient rename failures before succeeding", async () => {
    renameMock
      .mockRejectedValueOnce(Object.assign(new Error("state file locked"), { code: "EPERM" }))
      .mockResolvedValueOnce(undefined);

    await expect(writeRestartState(statePath, activeState)).resolves.toEqual(activeState);

    expect(renameMock).toHaveBeenCalledTimes(2);
    expect(renameMock).toHaveBeenNthCalledWith(1, tempPath, statePath);
    expect(renameMock).toHaveBeenNthCalledWith(2, tempPath, statePath);
    expect(rmMock).not.toHaveBeenCalled();
  });

  it("cleans up the temp file if rename fails", async () => {
    renameMock.mockRejectedValueOnce(new Error("rename failed"));

    await expect(writeRestartState(statePath, activeState)).rejects.toThrow("rename failed");
    expect(rmMock).toHaveBeenCalledWith(tempPath, { force: true });
  });

  it("retries transient read failures before falling back to default state", async () => {
    readFileMock
      .mockRejectedValueOnce(Object.assign(new Error("state file locked"), { code: "EBUSY" }))
      .mockResolvedValueOnce(JSON.stringify(activeState));

    await expect(readRestartState(statePath)).resolves.toEqual(activeState);
    expect(readFileMock).toHaveBeenCalledTimes(2);
  });

  it("clears the persisted state file", async () => {
    await clearRestartState(statePath);

    expect(rmMock).toHaveBeenCalledWith(statePath, { force: true });
  });

  it("retries transient clear failures before succeeding", async () => {
    rmMock
      .mockRejectedValueOnce(Object.assign(new Error("state file locked"), { code: "EACCES" }))
      .mockResolvedValueOnce(undefined);

    await clearRestartState(statePath);

    expect(rmMock).toHaveBeenCalledTimes(2);
    expect(rmMock).toHaveBeenNthCalledWith(1, statePath, { force: true });
    expect(rmMock).toHaveBeenNthCalledWith(2, statePath, { force: true });
  });

  it("builds an idle restart state that preserves release failure metadata", () => {
    expect(buildRestartStateWithReleaseFailure(activeState, releaseFailure)).toEqual({
      ...activeState,
      phase: "idle",
      waitingSessions: 0,
      releaseFailure,
    });
  });

  it("round-trips a queued phase state", async () => {
    const queued: RestartState = {
      requestId: "req-queued",
      phase: "queued",
      requestedAt: "2026-04-24T13:00:00.000Z",
      waitingSessions: 0,
      launcherHeartbeatAt: null,
      releaseFailure: null,
    };

    const written = await writeRestartState(statePath, queued);
    expect(written).toEqual(queued);

    readFileMock.mockResolvedValueOnce(JSON.stringify(written));
    const read = await readRestartState(statePath);
    expect(read).toEqual(queued);
  });

  it("round-trips a restarting phase state with waitingSessions", async () => {
    const restarting: RestartState = {
      requestId: "req-restarting",
      phase: "restarting",
      requestedAt: "2026-04-24T14:00:00.000Z",
      waitingSessions: 2,
      launcherHeartbeatAt: "2026-04-24T14:00:10.000Z",
      releaseFailure: null,
    };

    const written = await writeRestartState(statePath, restarting);
    expect(written).toEqual(restarting);

    readFileMock.mockResolvedValueOnce(JSON.stringify(written));
    const read = await readRestartState(statePath);
    expect(read).toEqual(restarting);
  });

  it("round-trips an idle phase state matching DEFAULT_RESTART_STATE", async () => {
    const idle: RestartState = {
      requestId: null,
      phase: "idle",
      requestedAt: null,
      waitingSessions: 0,
      launcherHeartbeatAt: null,
      releaseFailure: null,
    };

    const written = await writeRestartState(statePath, idle);
    expect(written).toEqual(idle);
    expect(written).toEqual(DEFAULT_RESTART_STATE);
  });

  it("normalizes an unknown phase to idle", async () => {
    readFileMock.mockResolvedValueOnce(JSON.stringify({
      requestId: "req-bad",
      phase: "launching",
      requestedAt: "2026-04-24T15:00:00.000Z",
      waitingSessions: 1,
    }));

    const result = await readRestartState(statePath);
    expect(result.phase).toBe("idle");
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

  it("returns DEFAULT_RESTART_STATE after clear when the file no longer exists", async () => {
    await clearRestartState(statePath);
    // Default beforeEach mock already returns ENOENT — simulates missing file after clear
    const result = await readRestartState(statePath);
    expect(result).toEqual(DEFAULT_RESTART_STATE);
    expect(result.phase).toBe("idle");
    expect(result.requestId).toBeNull();
    expect(result.waitingSessions).toBe(0);
  });
});
