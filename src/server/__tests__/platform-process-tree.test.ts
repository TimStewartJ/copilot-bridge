import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { makeTestDir } from "./helpers.js";
import {
  createDirectoryLink,
  getDeviceHibernateCommand,
  getProcessTreeSnapshot,
  isProcessTreeAlive,
  killProcessTree,
  listDescendantPids,
  removeDirectoryLink,
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

function isDirectoryLinkCapabilityError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EPERM"
    || code === "EACCES"
    || code === "ENOSYS"
    || code === "ENOTSUP"
    || code === "EOPNOTSUPP";
}

function probeDirectoryLinkCapability(): boolean {
  const root = mkdtempSync(join(tmpdir(), "bridge-directory-link-probe-")); // xplat-audit-ignore-line
  try {
    const target = join(root, "target");
    const link = join(root, "link");
    mkdirSync(target);
    symlinkSync(target, link, process.platform === "win32" ? "junction" : "dir");
    return true;
  } catch (error) {
    if (isDirectoryLinkCapabilityError(error)) return false;
    throw error;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const canCreateDirectoryLinks = probeDirectoryLinkCapability();

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

  it("captures Windows descendants and identities from one batched snapshot call", () => {
    setPlatform("win32");
    let powershellCalls = 0;
    execFileSyncMock.mockImplementation((command: string) => {
      if (command === "powershell.exe") {
        powershellCalls++;
        return [
          "100 1 1000",
          "101 100 1001",
          "102 101 1002",
          "999 5 900",
        ].join("\n");
      }
      return "";
    });
    const killSpy = vi.spyOn(process, "kill").mockImplementation((() => true) as typeof process.kill);

    const result = killProcessTree(100);

    expect(execFileSyncMock).toHaveBeenCalledWith(
      "taskkill",
      ["/T", "/F", "/PID", "100"],
      expect.objectContaining({ stdio: "ignore", timeout: expect.any(Number) }),
    );
    expect(killSpy).not.toHaveBeenCalled();
    // The whole tree is captured in a single batched call, not one call per PID.
    expect(powershellCalls).toBe(1);
    expect(result).toMatchObject({
      rootPid: 100,
      descendantPids: [101, 102],
      trackedPids: [100, 101, 102],
      processGroupId: undefined,
      killRequested: true,
    });
    expect(result?.trackedIdentities).toEqual([
      { pid: 100, startMarker: "1000" },
      { pid: 101, startMarker: "1001" },
      { pid: 102, startMarker: "1002" },
    ]);
  });

  it("builds hundreds of Windows descendants from a single batched snapshot", () => {
    setPlatform("win32");
    const lines = ["100 1 1000"];
    // A deep chain of 400 descendants: 101<-100, 102<-101, ... each created after its parent.
    for (let pid = 101; pid <= 500; pid++) {
      lines.push(`${pid} ${pid - 1} ${1000 + (pid - 100)}`);
    }
    let powershellCalls = 0;
    execFileSyncMock.mockImplementation((command: string) => {
      if (command === "powershell.exe") {
        powershellCalls++;
        return lines.join("\n");
      }
      return "";
    });

    const snapshot = getProcessTreeSnapshot(100);

    expect(powershellCalls).toBe(1);
    expect(snapshot.descendantPids).toHaveLength(400);
    expect(snapshot.trackedPids).toHaveLength(401);
    expect(snapshot.trackedIdentities).toHaveLength(401);
  });

  it("drops Windows edges whose child was created before its parent (PPID reuse)", () => {
    setPlatform("win32");
    execFileSyncMock.mockImplementation((command: string) => {
      if (command === "powershell.exe") {
        return [
          "100 1 2000",
          // PID 200 claims 100 as parent but was created earlier — a recycled PID.
          "200 100 1500",
          // PID 300 is a legitimate child created after the parent.
          "300 100 2500",
        ].join("\n");
      }
      return "";
    });

    const snapshot = getProcessTreeSnapshot(100);

    expect(snapshot.descendantPids).toEqual([300]);
  });

  it("falls back to PID-presence tracking when Windows creation markers are missing", () => {
    setPlatform("win32");
    execFileSyncMock.mockImplementation((command: string) => {
      if (command === "powershell.exe") throw new Error("CIM unavailable");
      if (command === "wmic") {
        return [
          "ParentProcessId  ProcessId",
          "100              101",
        ].join("\n");
      }
      return "";
    });

    const result = killProcessTree(100);

    expect(execFileSyncMock).toHaveBeenCalledWith(
      "taskkill",
      ["/T", "/F", "/PID", "100"],
      expect.objectContaining({ stdio: "ignore" }),
    );
    expect(result).toMatchObject({
      rootPid: 100,
      descendantPids: [101],
      trackedPids: [100, 101],
      killRequested: true,
    });
    // Without reliable creation markers, identities are not authoritative.
    expect(result?.trackedIdentities).toBeUndefined();
  });

  it("still force-kills the verified root when a Windows descendant lacks a creation marker", () => {
    setPlatform("win32");
    execFileSyncMock.mockImplementation((command: string, args?: readonly string[]) => {
      if (command === "powershell.exe") {
        const joined = Array.isArray(args) ? args.join(" ") : "";
        // Single-PID identity precheck for the root.
        if (joined.includes("ProcessId = 100")) return "1000";
        // Batched table: descendant 101 has no creation marker.
        return ["100 1 1000", "101 100 "].join("\n");
      }
      return "";
    });

    const result = killProcessTree(100, { pid: 100, startMarker: "1000" });

    expect(result).not.toBeNull();
    expect(execFileSyncMock).toHaveBeenCalledWith(
      "taskkill",
      ["/T", "/F", "/PID", "100"],
      expect.objectContaining({ stdio: "ignore" }),
    );
    expect(result?.descendantPids).toEqual([101]);
    // The root identity survives even though a descendant is markerless.
    expect(result?.trackedIdentities).toEqual([{ pid: 100, startMarker: "1000" }]);
  });

  it("does not terminate a Windows process whose PID was reused", () => {
    setPlatform("win32");
    execFileSyncMock.mockImplementation((command: string) => {
      if (command === "powershell.exe") return "222222";
      throw new Error(`Unexpected command: ${command}`);
    });
    const killSpy = vi.spyOn(process, "kill").mockImplementation((() => true) as typeof process.kill);

    const result = killProcessTree(100, { pid: 100, startMarker: "111111" });

    expect(result).toBeNull();
    expect(execFileSyncMock).not.toHaveBeenCalledWith(
      "taskkill",
      expect.anything(),
      expect.anything(),
    );
    expect(killSpy).not.toHaveBeenCalled();
  });

  it("treats Windows liveness as a single batched probe and detects PID reuse", () => {
    setPlatform("win32");
    const snapshot: ProcessTreeSnapshot = {
      rootPid: 100,
      descendantPids: [101],
      trackedPids: [100, 101],
      trackedIdentities: [
        { pid: 100, startMarker: "1000" },
        { pid: 101, startMarker: "1001" },
      ],
    };

    // Root still alive with the same creation marker → tree is alive.
    let calls = 0;
    execFileSyncMock.mockImplementation((command: string) => {
      if (command === "powershell.exe") {
        calls++;
        return ["100 1 1000"].join("\n");
      }
      return "";
    });
    expect(isProcessTreeAlive(snapshot)).toBe(true);
    expect(calls).toBe(1);

    // Same PIDs present but with different creation markers → all reused → gone.
    execFileSyncMock.mockImplementation((command: string) => {
      if (command === "powershell.exe") return ["100 1 9999", "101 100 8888"].join("\n");
      return "";
    });
    expect(isProcessTreeAlive(snapshot)).toBe(false);

    // No tracked PIDs present at all → exited, no throw.
    execFileSyncMock.mockImplementation((command: string) => {
      if (command === "powershell.exe") return "";
      return "";
    });
    expect(isProcessTreeAlive(snapshot)).toBe(false);
  });

  it("returns promptly from a bounded Windows force-kill once the tree exits", async () => {
    setPlatform("win32");
    const snapshot: ProcessTreeSnapshot = {
      rootPid: 100,
      descendantPids: [101, 102],
      trackedPids: [100, 101, 102],
      trackedIdentities: [
        { pid: 100, startMarker: "1000" },
        { pid: 101, startMarker: "1001" },
        { pid: 102, startMarker: "1002" },
      ],
    };
    // Process table read returns no rows → every tracked PID is gone.
    execFileSyncMock.mockReturnValue("");

    await expect(waitForProcessTreeExit(snapshot, 5_000, 1)).resolves.toBe(true);
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

  it.skipIf(!canCreateDirectoryLinks)("creates and removes directory links with native filesystem APIs", () => {
    const root = makeTestDir("directory-link");
    const target = join(root, "target with spaces & parens");
    const link = join(root, "link with spaces & parens");
    mkdirSync(target);
    writeFileSync(join(target, "marker.txt"), "ok");

    const result = createDirectoryLink(link, target, root);

    expect(result).toEqual({ ok: true, output: "" });
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(existsSync(join(link, "marker.txt"))).toBe(true);
    expect(removeDirectoryLink(link, root)).toEqual({ ok: true, output: "" });
    expect(existsSync(link)).toBe(false);
    expect(existsSync(target)).toBe(true);
  });
});
