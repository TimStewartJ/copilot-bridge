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
  clearRestartState,
  readRestartState,
  writeRestartState,
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
    }));

    await expect(readRestartState(statePath)).resolves.toEqual({
      requestId: "req-123",
      phase: "waiting-for-sessions",
      requestedAt: "2026-04-24T12:00:00.000Z",
      waitingSessions: 3,
      launcherHeartbeatAt: null,
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

  it("cleans up the temp file if rename fails", async () => {
    renameMock.mockRejectedValueOnce(new Error("rename failed"));

    await expect(writeRestartState(statePath, activeState)).rejects.toThrow("rename failed");
    expect(rmMock).toHaveBeenCalledWith(tempPath, { force: true });
  });

  it("clears the persisted state file", async () => {
    await clearRestartState(statePath);

    expect(rmMock).toHaveBeenCalledWith(statePath, { force: true });
  });
});
