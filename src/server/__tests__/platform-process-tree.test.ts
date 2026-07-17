import type { ChildProcess, ExecFileOptions } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createDeadline } from "../deadline.js";
import {
  captureProcessIdentity,
  createDirectoryLink,
  getDeviceHibernateCommand,
  removeDirectoryLink,
  sampleProcessTree,
  shouldSpawnDetachedProcessGroup,
  terminateProcessTree,
} from "../platform.js";
import { makeTestDir } from "./helpers.js";

const execFileMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, execFile: execFileMock };
});

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;
type ExecHandler = (
  command: string,
  args: readonly string[],
  options: ExecFileOptions,
  callback: ExecCallback,
) => void;

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

function restorePlatform(): void {
  if (originalPlatformDescriptor) {
    Object.defineProperty(process, "platform", originalPlatformDescriptor);
  }
}

function mockExec(handler: ExecHandler): void {
  execFileMock.mockImplementation((
    command: string,
    args: readonly string[],
    options: ExecFileOptions,
    callback: ExecCallback,
  ) => {
    handler(command, args, options, callback);
    return {} as ChildProcess;
  });
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
  execFileMock.mockReset();
  restorePlatform();
});

describe("process tree platform helpers", () => {
  it("selects supported hibernate commands and detached process groups", () => {
    setPlatform("linux");
    expect(getDeviceHibernateCommand()).toEqual({
      platform: "linux",
      command: "systemctl",
      args: ["hibernate"],
    });
    expect(shouldSpawnDetachedProcessGroup()).toBe(true);

    setPlatform("win32");
    expect(getDeviceHibernateCommand()).toEqual({
      platform: "win32",
      command: "shutdown.exe",
      args: ["/h"],
    });
    expect(shouldSpawnDetachedProcessGroup()).toBe(false);
  });

  it("captures a mandatory Windows identity with one bulk CIM call", async () => {
    setPlatform("win32");
    mockExec((command, _args, _options, callback) => {
      expect(command).toBe("powershell.exe");
      callback(null, ["100 1 1000", "101 100 1001"].join("\n"), "");
    });

    await expect(captureProcessIdentity(100, createDeadline(5_000))).resolves.toEqual({
      pid: 100,
      startMarker: "1000",
    });
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("terminates 400 descendants with one initial snapshot, one taskkill, and one verification snapshot", async () => {
    setPlatform("win32");
    const rows = ["100 1 1000"];
    for (let pid = 101; pid <= 500; pid++) {
      rows.push(`${pid} ${pid - 1} ${1000 + pid}`);
    }
    let snapshotCalls = 0;
    mockExec((command, args, _options, callback) => {
      if (command === "powershell.exe") {
        snapshotCalls++;
        callback(null, snapshotCalls === 1 ? rows.join("\n") : "", "");
        return;
      }
      expect(command).toBe("taskkill");
      expect(args).toEqual(["/T", "/F", "/PID", "100"]);
      callback(null, "", "");
    });

    const result = await terminateProcessTree(
      { pid: 100, startMarker: "1000" },
      createDeadline(15_000),
    );

    expect(result.ok).toBe(true);
    expect(result.status).toBe("terminated");
    expect(result.snapshot?.descendants).toHaveLength(400);
    expect(snapshotCalls).toBe(2);
    expect(execFileMock).toHaveBeenCalledTimes(3);
    expect(execFileMock.mock.calls.some(([command]) => command === "wmic")).toBe(false);
  });

  it("drops child-before-parent PID reuse edges from the captured tree", async () => {
    setPlatform("win32");
    let snapshots = 0;
    mockExec((command, _args, _options, callback) => {
      if (command === "powershell.exe") {
        snapshots++;
        callback(
          null,
          snapshots === 1
            ? ["100 1 2000", "200 100 1500", "300 100 2500"].join("\n")
            : "",
          "",
        );
        return;
      }
      callback(null, "", "");
    });

    const result = await terminateProcessTree(
      { pid: 100, startMarker: "2000" },
      createDeadline(15_000),
    );

    expect(result.snapshot?.descendants).toEqual([{ pid: 300, startMarker: "2500" }]);
  });

  it("never runs a destructive command when the root PID was reused", async () => {
    setPlatform("win32");
    mockExec((command, _args, _options, callback) => {
      expect(command).toBe("powershell.exe");
      callback(null, "100 1 2222", "");
    });

    await expect(terminateProcessTree(
      { pid: 100, startMarker: "1111" },
      createDeadline(5_000),
    )).resolves.toMatchObject({ ok: true, status: "identity-replaced" });
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("fails closed when a captured descendant has no birth marker", async () => {
    setPlatform("win32");
    mockExec((command, _args, _options, callback) => {
      expect(command).toBe("powershell.exe");
      callback(null, ["100 1 1000", "101 100 "].join("\n"), "");
    });

    await expect(terminateProcessTree(
      { pid: 100, startMarker: "1000" },
      createDeadline(5_000),
    )).resolves.toMatchObject({ ok: false, status: "identity-unavailable" });
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("accepts a raced taskkill error only when verification proves the original tree is gone", async () => {
    setPlatform("win32");
    let snapshots = 0;
    mockExec((command, _args, _options, callback) => {
      if (command === "powershell.exe") {
        snapshots++;
        callback(null, snapshots === 1 ? "100 1 1000" : "", "");
        return;
      }
      callback(new Error("process not found"), "", "");
    });

    const result = await terminateProcessTree(
      { pid: 100, startMarker: "1000" },
      createDeadline(15_000),
    );
    expect(result).toMatchObject({
      ok: true,
      status: "terminated",
      commandError: expect.stringContaining("process not found"),
    });
  });

  it("fails closed after taskkill failure when verification finds a survivor", async () => {
    setPlatform("win32");
    mockExec((command, _args, _options, callback) => {
      if (command === "powershell.exe") {
        callback(null, "100 1 1000", "");
        return;
      }
      callback(new Error("access denied"), "", "");
    });

    const result = await terminateProcessTree(
      { pid: 100, startMarker: "1000" },
      createDeadline(15_000),
    );
    expect(result).toMatchObject({
      ok: false,
      status: "kill-failed",
      survivors: [{ pid: 100, startMarker: "1000" }],
    });
    expect(execFileMock).toHaveBeenCalledTimes(3);
  });

  it("captures descendants created after the initial snapshot as survivors", async () => {
    setPlatform("win32");
    let snapshots = 0;
    mockExec((command, _args, _options, callback) => {
      if (command === "powershell.exe") {
        snapshots++;
        callback(
          null,
          snapshots === 1
            ? "100 1 1000"
            : ["100 1 1000", "101 100 1001"].join("\n"),
          "",
        );
        return;
      }
      callback(null, "", "");
    });

    await expect(terminateProcessTree(
      { pid: 100, startMarker: "1000" },
      createDeadline(15_000),
    )).resolves.toMatchObject({
      ok: false,
      status: "survivors",
      survivors: [
        { pid: 100, startMarker: "1000" },
        { pid: 101, startMarker: "1001" },
      ],
    });
  });

  it("threads the remaining aggregate deadline through taskkill without a fallback", async () => {
    setPlatform("win32");
    let taskkillTimeoutMs = Number.POSITIVE_INFINITY;
    mockExec((command, _args, options, callback) => {
      if (command === "powershell.exe") {
        callback(null, "100 1 1000", "");
        return;
      }
      taskkillTimeoutMs = Number(options.timeout);
      callback(new Error("timed out"), "", "");
    });

    const result = await terminateProcessTree(
      { pid: 100, startMarker: "1000" },
      createDeadline(8_050),
    );

    expect(result).toMatchObject({ ok: false, status: "kill-failed" });
    expect(taskkillTimeoutMs).toBeGreaterThan(0);
    expect(taskkillTimeoutMs).toBeLessThanOrEqual(50);
    expect(execFileMock.mock.calls.filter(([command]) => command === "taskkill")).toHaveLength(1);
    expect(execFileMock.mock.calls.some(([command]) => command === "wmic")).toBe(false);
  });

  it.skipIf(!canCreateDirectoryLinks)("creates and removes directory links with native filesystem APIs", () => {
    const root = makeTestDir("directory-link");
    const target = join(root, "target with spaces & parens");
    const link = join(root, "link with spaces & parens");
    mkdirSync(target);
    writeFileSync(join(target, "marker.txt"), "ok");

    expect(createDirectoryLink(link, target, root)).toEqual({ ok: true, output: "" });
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(existsSync(join(link, "marker.txt"))).toBe(true);
    expect(removeDirectoryLink(link, root)).toEqual({ ok: true, output: "" });
    expect(existsSync(link)).toBe(false);
    expect(existsSync(target)).toBe(true);
  });
});

describe("sampleProcessTree", () => {
  it("returns root identity and all descendants from a Windows snapshot", async () => {
    setPlatform("win32");
    mockExec((command, _args, _options, callback) => {
      expect(command).toBe("powershell.exe");
      callback(
        null,
        ["2000 1 9000", "2001 2000 9001", "2002 2001 9002", "2003 2001 9003"].join("\n"),
        "",
      );
    });

    const result = await sampleProcessTree(2000, createDeadline(5_000));

    expect(result).not.toBeNull();
    expect(result!.root).toEqual({ pid: 2000, startMarker: "9000" });
    expect(result!.descendants).toHaveLength(3);
    expect(result!.descendants.map((d) => d.pid).sort((a, b) => a - b)).toEqual([2001, 2002, 2003]);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("returns root identity and all descendants from a POSIX snapshot", async () => {
    setPlatform("linux");
    mockExec((command, _args, _options, callback) => {
      expect(command).toBe("ps");
      callback(
        null,
        [
          "  3000     1 Mon Jan  1 00:00:00 2024",
          "  3001  3000 Mon Jan  1 00:00:01 2024",
          "  3002  3001 Mon Jan  1 00:00:02 2024",
        ].join("\n"),
        "",
      );
    });

    const result = await sampleProcessTree(3000, createDeadline(5_000));

    expect(result).not.toBeNull();
    expect(result!.root).toEqual({ pid: 3000, startMarker: "Mon Jan  1 00:00:00 2024" });
    expect(result!.descendants).toHaveLength(2);
    expect(result!.descendants.map((d) => d.pid).sort((a, b) => a - b)).toEqual([3001, 3002]);
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("returns null when the root PID is absent from the snapshot", async () => {
    setPlatform("win32");
    mockExec((_command, _args, _options, callback) => {
      callback(null, "9999 1 5000", "");
    });

    const result = await sampleProcessTree(1234, createDeadline(5_000));
    expect(result).toBeNull();
  });

  it("returns null when the root PID has no start marker in the snapshot", async () => {
    setPlatform("linux");
    mockExec((_command, _args, _options, callback) => {
      // Entry for root has no lstart — line won't match the POSIX regex, so
      // the PID is absent from the parsed table.
      callback(null, "  4000     1", "");
    });

    const result = await sampleProcessTree(4000, createDeadline(5_000));
    expect(result).toBeNull();
  });

  it("returns null when the process-table snapshot fails", async () => {
    setPlatform("linux");
    mockExec((_command, _args, _options, callback) => {
      callback(new Error("ps: command not found"), "", "");
    });

    const result = await sampleProcessTree(5000, createDeadline(5_000));
    expect(result).toBeNull();
  });

  it("issues exactly one snapshot read and no side-effecting commands", async () => {
    setPlatform("win32");
    mockExec((_command, _args, _options, callback) => {
      callback(null, "6000 1 7000\n6001 6000 7001", "");
    });

    await sampleProcessTree(6000, createDeadline(5_000));
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls.every(([cmd]) => cmd === "powershell.exe")).toBe(true);
  });
});
