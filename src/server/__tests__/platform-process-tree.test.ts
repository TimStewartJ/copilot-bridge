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
  captureProcessStartTimes,
  createDirectoryLink,
  getDeviceHibernateCommand,
  getProcessIdentityStatus,
  getProcessIdentityStatuses,
  PROCESS_TABLE_READ_TIMEOUT_MS,
  PROCESS_TREE_TERMINATION_BUDGET_MS,
  removeDirectoryLink,
  sampleProcessTree,
  shouldSpawnDetachedProcessGroup,
  terminateProcessTree,
} from "../platform.js";
import { makeTestDir } from "./helpers.js";

const execFileMock = vi.hoisted(() => vi.fn());
const windowsSnapshotMock = vi.hoisted(() => vi.fn());

vi.mock("../windows-process-table.js", () => ({ readNativeWindowsProcessTable: windowsSnapshotMock }));
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
  windowsSnapshotMock.mockImplementation((timeout: number) => new Promise((resolve, reject) => {
    execFileMock("mock-native-process-snapshot", [], { timeout }, (error: Error | null, output: string) => {
      if (error) { reject(error); return; }
      resolve(output.split(/\r?\n/).filter((line) => line.trim()).map((line) => {
        const [pid, ppid, startMarker = ""] = line.trim().split(/\s+/);
        return { pid: Number(pid), ppid: Number(ppid), startMarker };
      }));
    });
  }));
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
  windowsSnapshotMock.mockReset();
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

  it("captures a mandatory Windows identity with one native snapshot", async () => {
    setPlatform("win32");
    mockExec((command, _args, _options, callback) => {
      expect(command).toBe("mock-native-process-snapshot");
      callback(null, ["100 1 1000", "101 100 1001"].join("\n"), "");
    });

    await expect(captureProcessIdentity(100, createDeadline(5_000))).resolves.toEqual({
      pid: 100,
      startMarker: "1000",
    });
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { expected: "alive", table: "100 1 1000", error: null },
    { expected: "exited", table: "101 1 1001", error: null },
    { expected: "replaced", table: "100 1 2000", error: null },
    { expected: "unknown", table: "", error: new Error("Process table unavailable") },
  ] as const)("reports $expected launch-owner identity without treating unknown as dead", async ({ expected, table, error }) => {
    setPlatform("win32");
    mockExec((_command, _args, _options, callback) => callback(error, table, ""));
    await expect(getProcessIdentityStatus({ pid: 100, startMarker: "1000" }, createDeadline(5_000))).resolves.toBe(expected);
  });

  it("checks multiple survivor identities with one snapshot, including recycled PIDs", async () => {
    setPlatform("win32");
    const first = { pid: 100, startMarker: "1000" };
    const recycled = { pid: 100, startMarker: "900" };
    const exited = { pid: 200, startMarker: "1001" };
    const unknown = { pid: 300, startMarker: "1002" };
    mockExec((_command, _args, _options, callback) => callback(null, "100 1 1000\r\n300 1", ""));
    expect(await getProcessIdentityStatuses([first, recycled, exited, unknown], createDeadline(5_000)))
      .toEqual(new Map([[first, "alive"], [recycled, "replaced"], [exited, "exited"], [unknown, "unknown"]]));
    expect(execFileMock).toHaveBeenCalledOnce();
  });

  it("does not treat an unreadable survivor snapshot as proof of exit", async () => {
    setPlatform("win32");
    const identity = { pid: 100, startMarker: "1000" };
    mockExec((_command, _args, _options, callback) => callback(new Error("native snapshot unavailable"), "", ""));
    expect((await getProcessIdentityStatuses([identity], createDeadline(5_000))).get(identity)).toBe("unknown");
  });

  it("captures Windows process start times from .NET ticks with one native snapshot", async () => {
    setPlatform("win32");
    const unixEpochTicks = 621_355_968_000_000_000n;
    const firstStart = (unixEpochTicks + 1_000n * 10_000n).toString();
    const secondStart = (unixEpochTicks + 2_000n * 10_000n).toString();
    mockExec((command, _args, _options, callback) => {
      expect(command).toBe("mock-native-process-snapshot");
      callback(null, [`100 1 ${firstStart}`, `101 100 ${secondStart}`].join("\n"), "");
    });

    await expect(captureProcessStartTimes([100, 101, 999], createDeadline(5_000))).resolves.toEqual(
      new Map([[100, 1_000], [101, 2_000]]),
    );
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it("captures POSIX process start times from ps output", async () => {
    setPlatform("linux");
    mockExec((command, _args, _options, callback) => {
      expect(command).toBe("ps");
      callback(null, "  3000     1 Mon Jan  1 00:00:00 2024", "");
    });

    await expect(captureProcessStartTimes([3000], createDeadline(5_000))).resolves.toEqual(
      new Map([[3000, Date.parse("Mon Jan  1 00:00:00 2024 UTC")]]),
    );
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
      if (command === "mock-native-process-snapshot") {
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

  it("leaves time for both taskkill and verification within a short retirement fence budget", async () => {
    setPlatform("win32");
    let snapshots = 0;
    mockExec((command, args, options, callback) => {
      if (command === "mock-native-process-snapshot") {
        snapshots++;
        callback(null, snapshots === 1 ? "100 1 1000\r\n101 100 1001" : "", "");
        return;
      }
      expect(command).toBe("taskkill");
      expect(args).toEqual(["/T", "/F", "/PID", "100"]);
      expect(options.timeout).toBeGreaterThan(0);
      expect(options.timeout).toBeLessThanOrEqual(1_500);
      callback(null, "", "");
    });

    await expect(terminateProcessTree(
      { pid: 100, startMarker: "1000" }, createDeadline(3_000),
    )).resolves.toMatchObject({ ok: true, status: "terminated" });
    expect(snapshots).toBe(2);
    expect(execFileMock).toHaveBeenCalledTimes(3);
  });

  it("drops child-before-parent PID reuse edges and never runs destructive commands when root PID is reused", async () => {
    // Child-before-parent edge dropping
    setPlatform("win32");
    let snapshots = 0;
    mockExec((command, _args, _options, callback) => {
      if (command === "mock-native-process-snapshot") {
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

    const result1 = await terminateProcessTree(
      { pid: 100, startMarker: "2000" },
      createDeadline(15_000),
    );
    expect(result1.snapshot?.descendants).toEqual([{ pid: 300, startMarker: "2500" }]);

    // No destructive command when root PID was reused
    execFileMock.mockReset();
    mockExec((command, _args, _options, callback) => {
      expect(command).toBe("mock-native-process-snapshot");
      callback(null, "100 1 2222", "");
    });

    await expect(terminateProcessTree(
      { pid: 100, startMarker: "1111" },
      createDeadline(5_000),
    )).resolves.toMatchObject({ ok: true, status: "identity-replaced" });
    expect(execFileMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { label: "a captured descendant", table: "100 1 1000\n101 100" },
    { label: "the root process", table: "100 1" },
  ])("fails closed without signalling when $label stays unqueryable through the snapshot budget", async ({ table }) => {
    setPlatform("win32");
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    try {
      mockExec((command, _args, _options, callback) => {
        expect(command).toBe("mock-native-process-snapshot");
        callback(null, table, "");
      });
      const result = terminateProcessTree({ pid: 100, startMarker: "1000" }, createDeadline(200));
      await vi.advanceTimersByTimeAsync(200);
      await expect(result).resolves.toMatchObject({ ok: false, status: "identity-unavailable" });
      expect(execFileMock.mock.calls.some(([command]) => command === "taskkill")).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for a complete pre-kill identity snapshot instead of signalling through a churning unreadable edge", async () => {
    setPlatform("win32");
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    try {
      let snapshots = 0;
      mockExec((command, _args, _options, callback) => {
        if (command === "mock-native-process-snapshot") {
          snapshots++;
          callback(null, snapshots === 1 ? "100 1 1000\n101 100" : snapshots === 2 ? "100 1 1000\n101 100 1001" : "", "");
        } else callback(null, "", "");
      });
      const result = terminateProcessTree({ pid: 100, startMarker: "1000" }, createDeadline(200));
      await vi.advanceTimersByTimeAsync(0);
      expect(execFileMock.mock.calls.some(([command]) => command === "taskkill")).toBe(false);
      await vi.advanceTimersByTimeAsync(25);
      await expect(result).resolves.toMatchObject({ ok: true, status: "terminated" });
      expect(snapshots).toBe(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not acknowledge termination if a captured birth marker remains unavailable through the verification budget", async () => {
    setPlatform("win32");
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    try {
      let snapshots = 0;
      mockExec((command, _args, _options, callback) => {
        if (command === "mock-native-process-snapshot") {
          snapshots++;
          callback(null, snapshots === 1 ? "100 1 1000\r\n101 100 1001" : "101 1", "");
        } else callback(null, "", "");
      });
      const result = terminateProcessTree({ pid: 100, startMarker: "1000" }, createDeadline(200));
      await vi.advanceTimersByTimeAsync(200);
      await expect(result).resolves.toMatchObject({ ok: false, status: "identity-unavailable", error: expect.stringContaining("101") });
      expect(snapshots).toBeGreaterThan(2);
      expect(execFileMock.mock.calls.filter(([command]) => command === "taskkill")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rechecks a just-terminated unqueryable entry and acknowledges only its observed disappearance", async () => {
    setPlatform("win32");
    vi.useFakeTimers({ toFake: ["Date", "performance", "setTimeout", "clearTimeout"] });
    try {
      let snapshots = 0;
      mockExec((command, _args, _options, callback) => {
        if (command === "mock-native-process-snapshot") {
          snapshots++;
          callback(null, snapshots === 1 ? "100 1 1000\r\n101 100 1001" : snapshots === 2 ? "101 1" : "", "");
        } else callback(null, "", "");
      });
      const result = terminateProcessTree({ pid: 100, startMarker: "1000" }, createDeadline(200));
      await vi.advanceTimersByTimeAsync(25);
      await expect(result).resolves.toMatchObject({ ok: true, status: "terminated" });
      expect(snapshots).toBe(3);
      expect(execFileMock.mock.calls.filter(([command]) => command === "taskkill")).toHaveLength(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports phase timings and surviving processes without changing verification semantics", async () => {
    setPlatform("win32");
    const onPhase = vi.fn();
    mockExec((command, _args, _options, callback) => {
      if (command === "mock-native-process-snapshot") callback(null, "100 1 1000", "");
      else callback(new Error("access denied"), "", "");
    });
    expect(await terminateProcessTree({ pid: 100, startMarker: "1000" }, createDeadline(15_000), onPhase))
      .toMatchObject({ ok: false, status: "kill-failed" });
    expect(onPhase.mock.calls.map(([phase]) => [phase.phase, phase.outcome])).toEqual([
      ["snapshot", "completed"], ["terminate", "failed"], ["verify", "failed"],
    ]);
    for (const [phase] of onPhase.mock.calls) expect(phase.durationMs).toBeGreaterThanOrEqual(0);
    expect(execFileMock).toHaveBeenCalledTimes(3);
  });

  it("accepts a raced taskkill error only when verification proves the original tree is gone", async () => {
    setPlatform("win32");
    let snapshots = 0;
    mockExec((command, _args, _options, callback) => {
      if (command === "mock-native-process-snapshot") {
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
      if (command === "mock-native-process-snapshot") {
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

  it("threads the remaining aggregate deadline through taskkill without a fallback", async () => {
    setPlatform("win32");
    let taskkillTimeoutMs = Number.POSITIVE_INFINITY;
    mockExec((command, _args, options, callback) => {
      if (command === "mock-native-process-snapshot") {
        callback(null, "100 1 1000", "");
        return;
      }
      taskkillTimeoutMs = Number(options.timeout);
      callback(new Error("timed out"), "", "");
    });

    const result = await terminateProcessTree(
      { pid: 100, startMarker: "1000" },
      createDeadline(PROCESS_TABLE_READ_TIMEOUT_MS + 50),
    );

    expect(result).toMatchObject({ ok: false, status: "kill-failed" });
    expect(result).not.toHaveProperty("commandTimedOut");
    expect(taskkillTimeoutMs).toBeGreaterThan(0);
    expect(taskkillTimeoutMs).toBeLessThanOrEqual(50);
    expect(execFileMock.mock.calls.filter(([command]) => command === "taskkill")).toHaveLength(1);
    expect(execFileMock.mock.calls.some(([command]) => command === "wmic")).toBe(false);
  });

  it("flags a taskkill that ran out of time so callers can retry the survivors", async () => {
    setPlatform("win32");
    let snapshots = 0;
    mockExec((command, _args, options, callback) => {
      if (command === "mock-native-process-snapshot") {
        snapshots++;
        callback(null, snapshots === 1 ? "100 1 1000\r\n101 100 1001" : "101 100 1001", "");
        return;
      }
      callback(Object.assign(new Error("Command failed: taskkill /T /F /PID 100"), {
        killed: true, signal: "SIGTERM", code: null,
      }), "", "");
      expect(Number(options.timeout)).toBeGreaterThan(0);
    });

    expect(await terminateProcessTree({ pid: 100, startMarker: "1000" }, createDeadline(PROCESS_TREE_TERMINATION_BUDGET_MS)))
      .toMatchObject({
        ok: false,
        status: "kill-failed",
        commandTimedOut: true,
        survivors: [{ pid: 101, startMarker: "1001" }],
        error: expect.stringMatching(/^taskkill timed out after \d+ms$/),
      });
  });

  it("allows a delayed native snapshot within the unchanged observation deadline", async () => {
    setPlatform("win32");
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance", "Date"] });
    try {
      const latencyMs = 11_000;
      const snapshotTimeouts: number[] = [];
      mockExec((command, _args, options, callback) => {
        if (command !== "mock-native-process-snapshot") {
          callback(null, "", "");
          return;
        }
        const timeoutMs = Number(options.timeout);
        snapshotTimeouts.push(timeoutMs);
        const first = snapshotTimeouts.length === 1;
        setTimeout(() => {
          if (latencyMs > timeoutMs) {
            callback(Object.assign(new Error("Command failed: powershell.exe"), { killed: true, signal: "SIGTERM" }), "", "");
          } else {
            callback(null, first ? "100 1 1000\r\n101 100 1001" : "", "");
          }
        }, Math.min(latencyMs, timeoutMs));
      });

      const result = terminateProcessTree(
        { pid: 100, startMarker: "1000" },
        createDeadline(PROCESS_TREE_TERMINATION_BUDGET_MS),
      );
      await vi.advanceTimersByTimeAsync(2 * latencyMs);
      await expect(result).resolves.toMatchObject({ ok: true, status: "terminated" });
      expect(snapshotTimeouts).toHaveLength(2);
      expect(Math.min(...snapshotTimeouts)).toBeGreaterThan(latencyMs);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports a native snapshot timeout or enumeration error without treating it as exit", async () => {
    setPlatform("win32");
    mockExec((_command, _args, _options, callback) => callback(
      new Error("Native Windows process snapshot timed out after 20000ms"), "", "",
    ));
    expect(await terminateProcessTree({ pid: 100, startMarker: "1000" }, createDeadline(PROCESS_TREE_TERMINATION_BUDGET_MS)))
      .toMatchObject({
        ok: false,
        status: "snapshot-unavailable",
        error: "Native Windows process snapshot failed: Native Windows process snapshot timed out after 20000ms",
      });

    mockExec((_command, _args, _options, callback) => callback(
      new Error("Process32 enumeration failed with Windows error 5"), "", "",
    ));
    expect(await terminateProcessTree({ pid: 100, startMarker: "1000" }, createDeadline(PROCESS_TREE_TERMINATION_BUDGET_MS)))
      .toMatchObject({ ok: false, status: "snapshot-unavailable", error: "Native Windows process snapshot failed: Process32 enumeration failed with Windows error 5" });
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
      expect(command).toBe("mock-native-process-snapshot");
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

  it("returns null when the root PID is absent, has no start marker, or the snapshot fails", async () => {
    // Root PID absent from snapshot
    setPlatform("win32");
    mockExec((_command, _args, _options, callback) => {
      callback(null, "9999 1 5000", "");
    });
    expect(await sampleProcessTree(1234, createDeadline(5_000)), "absent root").toBeNull();

    // Root PID has no start marker (POSIX — line won't match the regex)
    execFileMock.mockReset();
    setPlatform("linux");
    mockExec((_command, _args, _options, callback) => {
      callback(null, "  4000     1", "");
    });
    expect(await sampleProcessTree(4000, createDeadline(5_000)), "no start marker").toBeNull();

    // Snapshot command fails
    execFileMock.mockReset();
    setPlatform("linux");
    mockExec((_command, _args, _options, callback) => {
      callback(new Error("ps: command not found"), "", "");
    });
    expect(await sampleProcessTree(5000, createDeadline(5_000)), "snapshot fails").toBeNull();
  });

  it("issues exactly one snapshot read and no side-effecting commands", async () => {
    setPlatform("win32");
    mockExec((_command, _args, _options, callback) => {
      callback(null, "6000 1 7000\n6001 6000 7001", "");
    });

    await sampleProcessTree(6000, createDeadline(5_000));
    expect(execFileMock).toHaveBeenCalledTimes(1);
    expect(execFileMock.mock.calls.every(([cmd]) => cmd === "mock-native-process-snapshot")).toBe(true);
  });
});
