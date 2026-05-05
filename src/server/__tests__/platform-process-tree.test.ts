import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getDeviceHibernateCommand,
  killProcessTree,
  listDescendantPids,
  shouldSpawnDetachedProcessGroup,
  waitForProcessTreeExit,
  type ProcessTreeSnapshot,
} from "../platform.js";

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: vi.fn(),
  };
});

const execFileSyncMock = vi.mocked(execFileSync);
const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
}

function restorePlatform(): void {
  if (originalPlatformDescriptor) {
    Object.defineProperty(process, "platform", originalPlatformDescriptor);
  }
}

function makeErrno(code: string): NodeJS.ErrnoException {
  const err = new Error(code) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

afterEach(() => {
  vi.restoreAllMocks();
  execFileSyncMock.mockReset();
  restorePlatform();
});

describe("process tree platform helpers", () => {
  it("selects shell-safe hibernate commands for supported platforms", () => {
    setPlatform("linux");
    expect(getDeviceHibernateCommand()).toEqual({
      platform: "linux",
      command: "systemctl",
      args: ["hibernate"],
    });

    setPlatform("win32");
    expect(getDeviceHibernateCommand()).toEqual({
      platform: "win32",
      command: "shutdown.exe",
      args: ["/h"],
    });
  });

  it("rejects hibernate on unsupported platforms", () => {
    setPlatform("darwin");
    expect(() => getDeviceHibernateCommand()).toThrow("not supported on macOS");
  });

  it("uses detached process groups for POSIX server children only", () => {
    setPlatform("linux");
    expect(shouldSpawnDetachedProcessGroup()).toBe(true);

    setPlatform("win32");
    expect(shouldSpawnDetachedProcessGroup()).toBe(false);
  });

  it("collects recursive POSIX descendants from ps output", () => {
    setPlatform("linux");
    execFileSyncMock.mockReturnValue([
      "100 1",
      "101 100",
      "102 101",
      "103 1",
      "104 100",
    ].join("\n"));

    expect(listDescendantPids(100)).toEqual([101, 104, 102]);
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "ps",
      ["-eo", "pid=,ppid="],
      expect.objectContaining({ encoding: "utf8" }),
    );
  });

  it("kills POSIX process groups and tracks descendants for verification", () => {
    setPlatform("linux");
    execFileSyncMock.mockReturnValue([
      "100 1",
      "101 100",
      "102 101",
    ].join("\n"));
    const killSpy = vi.spyOn(process, "kill").mockImplementation((() => true) as typeof process.kill);

    const result = killProcessTree(100);

    expect(killSpy).toHaveBeenCalledWith(-100, "SIGKILL");
    expect(killSpy).toHaveBeenCalledWith(102, "SIGKILL");
    expect(killSpy).toHaveBeenCalledWith(101, "SIGKILL");
    expect(killSpy).toHaveBeenCalledWith(100, "SIGKILL");
    expect(result).toMatchObject({
      rootPid: 100,
      descendantPids: [101, 102],
      trackedPids: [100, 101, 102],
      processGroupId: 100,
      killRequested: true,
    });
  });

  it("uses shell-safe taskkill arguments and tracks Windows descendants", () => {
    setPlatform("win32");
    execFileSyncMock.mockImplementation((command: string) => {
      if (command === "wmic") {
        return [
          "ParentProcessId  ProcessId",
          "100              101",
          "101              102",
        ].join("\n");
      }
      return "";
    });
    const killSpy = vi.spyOn(process, "kill").mockImplementation((() => true) as typeof process.kill);

    const result = killProcessTree(100);

    expect(execFileSyncMock).toHaveBeenCalledWith(
      "taskkill",
      ["/T", "/F", "/PID", "100"],
      expect.objectContaining({ stdio: "ignore" }),
    );
    expect(killSpy).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      rootPid: 100,
      descendantPids: [101, 102],
      trackedPids: [100, 101, 102],
      processGroupId: undefined,
      killRequested: true,
    });
  });

  it("waits until tracked PIDs are gone", async () => {
    const snapshot: ProcessTreeSnapshot = {
      rootPid: 100,
      descendantPids: [],
      trackedPids: [100],
    };
    let probes = 0;
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
      if (pid === 100 && signal === 0) {
        probes++;
        if (probes === 1) return true;
        throw makeErrno("ESRCH");
      }
      return true;
    }) as typeof process.kill);

    await expect(waitForProcessTreeExit(snapshot, 50, 1)).resolves.toBe(true);
  });

  it("times out while tracked PIDs remain alive", async () => {
    const snapshot: ProcessTreeSnapshot = {
      rootPid: 100,
      descendantPids: [],
      trackedPids: [100],
    };
    vi.spyOn(process, "kill").mockImplementation(((pid: number, signal?: string | number) => {
      if (pid === 100 && signal === 0) return true;
      return true;
    }) as typeof process.kill);

    await expect(waitForProcessTreeExit(snapshot, 2, 1)).resolves.toBe(false);
  });
});
