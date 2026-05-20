import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BrowserTarget } from "../agent-browser.js";
import { normalizePath, pathBasename, testCopilotHome, testExecutablePath, testPath } from "./test-paths.js";

const COPILOT_HOME = testCopilotHome();
const BROWSER_PROFILE = join(COPILOT_HOME, "browser-profile");
const BROWSER_CLONES = join(COPILOT_HOME, "browser-clones");

const execMock = vi.fn();
const execFileMock = vi.fn();
const cpMock = vi.fn();
const mkdirMock = vi.fn();
const readdirMock = vi.fn();
const rmMock = vi.fn();
const statMock = vi.fn();
const readlinkSyncMock = vi.fn();
const readFileSyncMock = vi.fn();
const unlinkSyncMock = vi.fn();
const killMock = vi.spyOn(process, "kill");
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

async function flushMicrotasks(iterations = 5): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    await Promise.resolve();
  }
}

async function flushUntil(predicate: () => boolean, label: string, iterations = 50): Promise<void> {
  for (let index = 0; index < iterations; index += 1) {
    if (predicate()) return;
    await flushMicrotasks();
  }
  throw new Error(`Condition was not met after deterministic flushes: ${label}`);
}

vi.mock("node:child_process", () => ({
  exec: execMock,
  execFile: execFileMock,
}));

vi.mock("node:fs/promises", () => ({
  cp: cpMock,
  mkdir: mkdirMock,
  readdir: readdirMock,
  rm: rmMock,
  stat: statMock,
}));

vi.mock("node:fs", () => ({
  readFileSync: readFileSyncMock,
  readlinkSync: readlinkSyncMock,
  unlinkSync: unlinkSyncMock,
}));

describe("agent-browser wrapper", () => {
  beforeEach(() => {
    vi.resetModules();
    execMock.mockReset();
    execFileMock.mockReset();
    cpMock.mockReset();
    mkdirMock.mockReset();
    readdirMock.mockReset();
    rmMock.mockReset();
    statMock.mockReset();
    readlinkSyncMock.mockReset();
    readFileSyncMock.mockReset();
    unlinkSyncMock.mockReset();
    killMock.mockReset();
    killMock.mockImplementation(((pid: number, signal?: number | NodeJS.Signals) => {
      if (signal === 0) return true as never;
      return true as never;
    }) as any);
    cpMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
    readdirMock.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
    rmMock.mockResolvedValue(undefined);
    statMock.mockResolvedValue({ mtimeMs: Date.now() });
  });

  afterEach(() => {
    restorePlatform();
    vi.unstubAllEnvs();
  });

  it("passes explicit bridge session env to browser commands", async () => {
    execFileMock.mockImplementation((_file: string, _args: string[], _options: any, cb: (err: any, result: { stdout: string; stderr: string }) => void) => {
      cb(null, { stdout: "ok", stderr: "" });
      return {} as any;
    });
    const mod = await import("../agent-browser.js");
    const target = mod.getBridgeBrowserTarget(COPILOT_HOME);

    await mod.ab(["open", "https://example.com"], undefined, { browserTarget: target });

    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [, , options] = execFileMock.mock.calls[0];
    expect(options.env.AGENT_BROWSER_SESSION).toMatch(/^copilot-bridge-/);
    expect(normalizePath(options.env.AGENT_BROWSER_PROFILE)).toContain(normalizePath(BROWSER_PROFILE));
  });

  it("applies configured browser paths and headed launches to browser command env", async () => {
    execFileMock.mockImplementation((_file: string, _args: string[], _options: any, cb: (err: any, result: { stdout: string; stderr: string }) => void) => {
      cb(null, { stdout: "ok", stderr: "" });
      return {} as any;
    });
    const mod = await import("../agent-browser.js");
    const executablePath = testExecutablePath("chrome");
    const profileDir = testPath("browser-master-profile");
    const target = mod.getBridgeBrowserTarget(COPILOT_HOME, {
      executablePath,
      masterProfileDirectory: profileDir,
      headed: true,
    });

    await mod.ab(["open", "about:blank"], undefined, { browserTarget: target });

    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [, , options] = execFileMock.mock.calls[0];
    expect(normalizePath(options.env.AGENT_BROWSER_EXECUTABLE_PATH)).toBe(normalizePath(executablePath));
    expect(normalizePath(options.env.AGENT_BROWSER_PROFILE)).toBe(normalizePath(profileDir));
    expect(options.env.AGENT_BROWSER_HEADED).toBe("true");
  });

  it("does not leak inherited headed browser env when the target is not headed", async () => {
    vi.stubEnv("AGENT_BROWSER_HEADED", "true");
    execFileMock.mockImplementation((_file: string, _args: string[], _options: any, cb: (err: any, result: { stdout: string; stderr: string }) => void) => {
      cb(null, { stdout: "ok", stderr: "" });
      return {} as any;
    });

    const mod = await import("../agent-browser.js");
    const target = mod.getBridgeBrowserTarget(COPILOT_HOME);

    await mod.ab(["open", "about:blank"], undefined, { browserTarget: target });

    const [, , options] = execFileMock.mock.calls[0];
    expect(options.env.AGENT_BROWSER_HEADED).toBeUndefined();
  });

  it("inherits headed mode for clone browser targets", async () => {
    execFileMock.mockImplementation((_file: string, _args: string[], _options: any, cb: (err: any, result: { stdout: string; stderr: string }) => void) => {
      cb(null, { stdout: "ok", stderr: "" });
      return {} as any;
    });
    const mod = await import("../agent-browser.js");
    let cloneTarget: BrowserTarget | undefined;

    await mod.withCloneBrowserLane(COPILOT_HOME, undefined, {}, async (lane) => {
      cloneTarget = lane.browserTarget;
    }, { headed: true });

    expect(cloneTarget?.headed).toBe(true);
    const closeCall = execFileMock.mock.calls.find(([, args]) => args[0] === "close");
    expect(closeCall?.[2].env.AGENT_BROWSER_HEADED).toBe("true");
  });

  it("clears stale dead lock owners and retries once", async () => {
    execFileMock
      .mockImplementationOnce((_file: string, _args: string[], _options: any, cb: (err: any) => void) => {
        cb({ stderr: "Chrome exited early" });
        return {} as any;
      })
      .mockImplementationOnce((_file: string, _args: string[], _options: any, cb: (err: any, result: { stdout: string; stderr: string }) => void) => {
        cb(null, { stdout: "ok", stderr: "" });
        return {} as any;
      });

    readlinkSyncMock.mockReturnValue("host-123");
    killMock.mockImplementation(((pid: number, signal?: number | NodeJS.Signals) => {
      if (signal === 0) throw Object.assign(new Error("dead"), { code: "ESRCH" });
      return true as never;
    }) as any);

    const mod = await import("../agent-browser.js");
    const target = mod.getBridgeBrowserTarget(COPILOT_HOME);
    const result = await mod.ab(["open", "https://example.com"], undefined, { browserTarget: target });

    expect(result.ok).toBe(true);
    expect(unlinkSyncMock).toHaveBeenCalledTimes(5);
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it("kills a live wedged Chrome PID and retries once", async () => {
    execFileMock
      .mockImplementationOnce((_file: string, _args: string[], _options: any, cb: (err: any) => void) => {
        cb({ stderr: "Chrome exited early without writing DevToolsActivePort" });
        return {} as any;
      })
      .mockImplementationOnce((_file: string, _args: string[], _options: any, cb: (err: any) => void) => {
        cb({ stderr: "Chrome exited early without writing DevToolsActivePort" });
        return {} as any;
      })
      .mockImplementationOnce((_file: string, _args: string[], _options: any, cb: (err: any, result: { stdout: string; stderr: string }) => void) => {
        cb(null, { stdout: "ok", stderr: "" });
        return {} as any;
      });

    readlinkSyncMock.mockReturnValue("host-123");
    const profilePath = normalizePath(BROWSER_PROFILE);
    readFileSyncMock.mockReturnValue(
      `chrome\0--user-data-dir=${profilePath}\0--profile-directory=Default\0`,
    );
    const killed: number[] = [];
    killMock.mockImplementation(((pid: number, signal?: number | NodeJS.Signals) => {
      if (signal === 0) return true as never;
      killed.push(pid);
      return true as never;
    }) as any);

    const mod = await import("../agent-browser.js");
    const target = mod.getBridgeBrowserTarget(COPILOT_HOME);
    const result = await mod.ab(["open", "https://example.com"], undefined, { browserTarget: target });

    expect(result.ok).toBe(true);
    expect(killed).toEqual([123]);
    expect(execFileMock).toHaveBeenCalledTimes(3);
  });

  it("does not kill an unverified live lock owner", async () => {
    execFileMock
      .mockImplementationOnce((_file: string, _args: string[], _options: any, cb: (err: any) => void) => {
        cb({ stderr: "Chrome exited early without writing DevToolsActivePort" });
        return {} as any;
      })
      .mockImplementationOnce((_file: string, _args: string[], _options: any, cb: (err: any) => void) => {
        cb({ stderr: "Chrome exited early without writing DevToolsActivePort" });
        return {} as any;
      });

    readlinkSyncMock.mockReturnValue("host-123");
    readFileSyncMock.mockReturnValue("node\0some-other-process.js\0");

    const mod = await import("../agent-browser.js");
    const target = mod.getBridgeBrowserTarget(COPILOT_HOME);
    const result = await mod.ab(["open", "https://example.com"], undefined, { browserTarget: target });

    expect(result.ok).toBe(false);
    expect(killMock).toHaveBeenCalledWith(123, 0);
    expect(killMock).not.toHaveBeenCalledWith(123);
    expect(execFileMock).toHaveBeenCalledTimes(2);
  });

  it("does not clear locks when pid exists but is not signalable", async () => {
    execFileMock
      .mockImplementationOnce((_file: string, _args: string[], _options: any, cb: (err: any) => void) => {
        cb({ stderr: "Chrome exited early" });
        return {} as any;
      })
      .mockImplementationOnce((_file: string, _args: string[], _options: any, cb: (err: any) => void) => {
        cb({ stderr: "Chrome exited early" });
        return {} as any;
      });

    readlinkSyncMock.mockReturnValue("host-123");
    killMock.mockImplementation(((pid: number, signal?: number | NodeJS.Signals) => {
      if (signal === 0) throw Object.assign(new Error("not permitted"), { code: "EPERM" });
      return true as never;
    }) as any);

    const mod = await import("../agent-browser.js");
    const target = mod.getBridgeBrowserTarget(COPILOT_HOME);
    const result = await mod.ab(["open", "https://example.com"], undefined, { browserTarget: target });

    expect(result.ok).toBe(false);
    expect(unlinkSyncMock).not.toHaveBeenCalled();
    expect(killMock).toHaveBeenCalledWith(123, 0);
  });

  it("serializes browser flows through the bridge session lock", async () => {
    const mod = await import("../agent-browser.js");
    const target = mod.getBridgeBrowserTarget(COPILOT_HOME);
    const order: string[] = [];
    let releaseOne!: () => void;
    const oneCanFinish = new Promise<void>((resolve) => {
      releaseOne = resolve;
    });

    const one = mod.withBridgeBrowserSession(target, async () => {
      order.push("one:start");
      await oneCanFinish;
      order.push("one:end");
    });
    const two = mod.withBridgeBrowserSession(target, async () => {
      order.push("two:start");
      order.push("two:end");
    });

    await flushUntil(() => order.includes("one:start"), "bridge browser session one started");
    expect(order).toEqual(["one:start"]);
    releaseOne();

    await Promise.all([one, two]);
    expect(order).toEqual(["one:start", "one:end", "two:start", "two:end"]);
  });

  it("creates and cleans up sanitized clone lanes", async () => {
    setPlatform("win32");
    execFileMock.mockImplementation((_file: string, _args: string[], _options: any, cb: (err: any, result: { stdout: string; stderr: string }) => void) => {
      cb(null, { stdout: "ok", stderr: "" });
      return {} as any;
    });

    const mod = await import("../agent-browser.js");
    const result = await mod.withCloneBrowserLane(COPILOT_HOME, undefined, { toolName: "web_search" }, async (lane) => {
      expect(lane.laneType).toBe("clone");
      expect(lane.cloneId).toBeTruthy();
      expect(normalizePath(lane.browserTarget.profileDir)).toContain(normalizePath(BROWSER_CLONES) + "/profile-");
      expect(lane.browserTarget.sessionName).toContain("-clone-");
      return lane.browserTarget.sessionName;
    });

    expect(result).toContain("-clone-");
    expect(mkdirMock).toHaveBeenCalled();
    expect(cpMock).toHaveBeenCalledTimes(1);
    const [, , options] = cpMock.mock.calls[0];
    expect(options.filter(join(BROWSER_PROFILE, "SingletonLock"))).toBe(false);
    expect(options.filter(join(BROWSER_PROFILE, "DevToolsActivePort"))).toBe(false);
    expect(options.filter(join(BROWSER_PROFILE, "CrashpadMetrics-active.pma"))).toBe(false);
    expect(options.filter(join(BROWSER_PROFILE, "Crashpad", "reports"))).toBe(false);
    expect(options.filter(join(BROWSER_PROFILE, "Default", "Network", "Cookies-wal"))).toBe(false);
    expect(options.filter(join(BROWSER_PROFILE, "Default", "Cookies"))).toBe(true);
    expect(options.filter(join(BROWSER_PROFILE, "Default", "Network", "Cookies"))).toBe(true);
    expect(execFileMock).toHaveBeenCalledWith(
      "agent-browser",
      ["close"],
      expect.objectContaining({
        env: expect.objectContaining({
          AGENT_BROWSER_SESSION: expect.stringContaining("-clone-"),
          AGENT_BROWSER_PROFILE: expect.stringContaining("browser-clones"),
        }),
      }),
      expect.any(Function),
    );
    expect(rmMock).toHaveBeenCalledWith(expect.stringContaining("browser-clones"), {
      recursive: true,
      force: true,
    });
  });

  it("kills exact profile-bound clone processes when clone close fails", async () => {
    setPlatform("linux");
    let cloneProfile = "";
    const signals: Array<{ pid: number; signal?: number | NodeJS.Signals }> = [];
    const terminated = new Set<number>();
    execFileMock.mockImplementation((file: string, _args: string[], _options: any, cb: (err: any, result?: { stdout: string; stderr: string }) => void) => {
      if (file === "agent-browser") {
        cb({ stderr: "close failed" });
        return {} as any;
      }
      if (file === "ps") {
        const normalizedProfile = normalizePath(cloneProfile);
        cb(null, {
          stdout: [
            `4242 chrome chrome --user-data-dir=${normalizedProfile}`,
            `4343 chrome chrome --user-data-dir=${normalizedProfile}-other`,
          ].join("\n"),
          stderr: "",
        });
        return {} as any;
      }
      throw new Error(`Unexpected execFile command: ${file}`);
    });
    killMock.mockImplementation(((pid: number, signal?: number | NodeJS.Signals) => {
      if (signal === 0) {
        if (terminated.has(pid)) throw Object.assign(new Error("dead"), { code: "ESRCH" });
        return true as never;
      }
      signals.push({ pid, signal });
      if (signal === "SIGTERM") terminated.add(pid);
      return true as never;
    }) as any);

    const mod = await import("../agent-browser.js");
    await mod.withCloneBrowserLane(COPILOT_HOME, undefined, { toolName: "browser_exec" }, async (lane) => {
      cloneProfile = lane.browserTarget.profileDir;
      return "ok";
    });

    expect(signals).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
    expect(unlinkSyncMock).toHaveBeenCalledWith(join(cloneProfile, "DevToolsActivePort"));
    expect(rmMock).toHaveBeenCalledWith(cloneProfile, {
      recursive: true,
      force: true,
    });
  });

  it("sweeps exact profile-bound clone processes even when clone close succeeds", async () => {
    setPlatform("linux");
    let cloneProfile = "";
    const signals: Array<{ pid: number; signal?: number | NodeJS.Signals }> = [];
    const terminated = new Set<number>();
    execFileMock.mockImplementation((file: string, _args: string[], _options: any, cb: (err: any, result?: { stdout: string; stderr: string }) => void) => {
      if (file === "agent-browser") {
        cb(null, { stdout: "ok", stderr: "" });
        return {} as any;
      }
      if (file === "ps") {
        const normalizedProfile = normalizePath(cloneProfile);
        cb(null, {
          stdout: [
            `4242 chrome chrome --user-data-dir=${normalizedProfile}`,
            `4343 chrome chrome --user-data-dir=${normalizedProfile}-other`,
          ].join("\n"),
          stderr: "",
        });
        return {} as any;
      }
      throw new Error(`Unexpected execFile command: ${file}`);
    });
    killMock.mockImplementation(((pid: number, signal?: number | NodeJS.Signals) => {
      if (signal === 0) {
        if (terminated.has(pid)) throw Object.assign(new Error("dead"), { code: "ESRCH" });
        return true as never;
      }
      signals.push({ pid, signal });
      if (signal === "SIGTERM") terminated.add(pid);
      return true as never;
    }) as any);

    const mod = await import("../agent-browser.js");
    await mod.withCloneBrowserLane(COPILOT_HOME, undefined, { toolName: "browser_exec" }, async (lane) => {
      cloneProfile = lane.browserTarget.profileDir;
      return "ok";
    });

    expect(signals).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
    expect(rmMock).toHaveBeenCalledWith(cloneProfile, {
      recursive: true,
      force: true,
    });
  });

  it("retries clone copy while skipping locked cookie stores", async () => {
    const lockedCookies = join(BROWSER_PROFILE, "Default", "Network", "Cookies");
    cpMock
      .mockRejectedValueOnce(Object.assign(new Error("busy"), {
        code: "EBUSY",
        path: lockedCookies,
      }))
      .mockResolvedValueOnce(undefined);
    execFileMock.mockImplementation((_file: string, _args: string[], _options: any, cb: (err: any, result: { stdout: string; stderr: string }) => void) => {
      cb(null, { stdout: "ok", stderr: "" });
      return {} as any;
    });

    const mod = await import("../agent-browser.js");
    await mod.withCloneBrowserLane(COPILOT_HOME, undefined, { toolName: "web_search" }, async () => "ok");

    expect(cpMock).toHaveBeenCalledTimes(2);
    const secondFilter = cpMock.mock.calls[1][2].filter;
    expect(secondFilter(lockedCookies)).toBe(false);
    expect(secondFilter(join(BROWSER_PROFILE, "Default", "Network", "Cookies2"))).toBe(true);
  });

  it("kills exact profile-bound Windows browser processes without a lock and retries", async () => {
    setPlatform("win32");
    const normalizedProfile = normalizePath(BROWSER_PROFILE);
    const killed: Array<{ pid: number; signal?: number | NodeJS.Signals }> = [];
    const terminated = new Set<number>();
    execFileMock
      .mockImplementationOnce((_file: string, _args: string[], _options: any, cb: (err: any) => void) => {
        cb({ stderr: "Chrome exited early (exit code: 21) without writing DevToolsActivePort" });
        return {} as any;
      })
      .mockImplementationOnce((_file: string, args: string[], _options: any, cb: (err: any, result: { stdout: string; stderr: string }) => void) => {
        expect(args[0]).toBe("-NoProfile");
        cb(null, {
          stdout: JSON.stringify([
            {
              ProcessId: 4242,
              Name: "msedge.exe",
              CommandLine: `"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" --user-data-dir="${normalizedProfile}"`,
            },
            {
              ProcessId: 4343,
              Name: "msedge.exe",
              CommandLine: `"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" --user-data-dir="${normalizedProfile}-other"`,
            },
            {
              ProcessId: 4444,
              Name: "notedge.exe",
              CommandLine: `"notedge.exe" --user-data-dir="${normalizedProfile}"`,
            },
          ]),
          stderr: "",
        });
        return {} as any;
      })
      .mockImplementationOnce((_file: string, _args: string[], _options: any, cb: (err: any, result: { stdout: string; stderr: string }) => void) => {
        cb(null, { stdout: "ok", stderr: "" });
        return {} as any;
      });
    readlinkSyncMock.mockImplementation(() => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    killMock.mockImplementation(((pid: number, signal?: number | NodeJS.Signals) => {
      if (signal === 0) {
        if (terminated.has(pid)) throw Object.assign(new Error("dead"), { code: "ESRCH" });
        return true as never;
      }
      killed.push({ pid, signal });
      if (signal === "SIGTERM") terminated.add(pid);
      return true as never;
    }) as any);

    const mod = await import("../agent-browser.js");
    const target = mod.getBridgeBrowserTarget(COPILOT_HOME);
    const result = await mod.ab(["open", "https://example.com"], undefined, { browserTarget: target });

    expect(result.ok).toBe(true);
    expect(killed).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
    expect(unlinkSyncMock).toHaveBeenCalledWith(join(BROWSER_PROFILE, "DevToolsActivePort"));
    expect(execFileMock).toHaveBeenCalledTimes(3);
  });

  it("sweeps exact profile-bound primary processes after shutdown close succeeds", async () => {
    setPlatform("linux");
    const normalizedProfile = normalizePath(BROWSER_PROFILE);
    const signals: Array<{ pid: number; signal?: number | NodeJS.Signals }> = [];
    const terminated = new Set<number>();
    execFileMock.mockImplementation((file: string, _args: string[], _options: any, cb: (err: any, result?: { stdout: string; stderr: string }) => void) => {
      if (file === "agent-browser") {
        cb(null, { stdout: "ok", stderr: "" });
        return {} as any;
      }
      if (file === "ps") {
        cb(null, {
          stdout: [
            `4242 chrome chrome --user-data-dir=${normalizedProfile}`,
            `4343 chrome chrome --user-data-dir=${normalizedProfile}-other`,
          ].join("\n"),
          stderr: "",
        });
        return {} as any;
      }
      throw new Error(`Unexpected execFile command: ${file}`);
    });
    killMock.mockImplementation(((pid: number, signal?: number | NodeJS.Signals) => {
      if (signal === 0) {
        if (terminated.has(pid)) throw Object.assign(new Error("dead"), { code: "ESRCH" });
        return true as never;
      }
      signals.push({ pid, signal });
      if (signal === "SIGTERM") terminated.add(pid);
      return true as never;
    }) as any);

    const telemetryStore = { recordSpan: vi.fn() };
    const mod = await import("../agent-browser.js");
    const target = mod.getBridgeBrowserTarget(COPILOT_HOME);
    const result = await mod.shutdownBridgeBrowser(target, telemetryStore as any);

    expect(result).toMatchObject({
      ok: true,
      closeOk: true,
      terminatedPids: [4242],
      killedPids: [],
      remainingPids: [],
      clearedRuntimeFiles: 5,
    });
    expect(signals).toEqual([{ pid: 4242, signal: "SIGTERM" }]);
    expect(telemetryStore.recordSpan).toHaveBeenCalledWith(expect.objectContaining({
      name: "browser.lifecycle.shutdown",
      metadata: expect.objectContaining({
        success: true,
        terminatedPids: [4242],
        remainingPids: [],
      }),
    }));
  });

  it("returns shutdown failure details when agent-browser close fails", async () => {
    setPlatform("linux");
    execFileMock.mockImplementation((file: string, _args: string[], _options: any, cb: (err: any, result?: { stdout: string; stderr: string }) => void) => {
      if (file === "agent-browser") {
        cb({ stderr: `timed out closing ${BROWSER_PROFILE}` });
        return {} as any;
      }
      if (file === "ps") {
        cb(null, { stdout: "", stderr: "" });
        return {} as any;
      }
      throw new Error(`Unexpected execFile command: ${file}`);
    });

    const telemetryStore = { recordSpan: vi.fn() };
    const mod = await import("../agent-browser.js");
    const target = mod.getBridgeBrowserTarget(COPILOT_HOME);
    const result = await mod.shutdownBridgeBrowser(target, telemetryStore as any);

    expect(result).toMatchObject({
      ok: false,
      closeOk: false,
      failureCode: "launch.timeout",
      closeFailureCode: "launch.timeout",
      remainingPids: [],
    });
    expect(result.closeOutputSummary).toContain("<browser-profile>");
    expect(result.closeOutputSummary).not.toContain(BROWSER_PROFILE);
    expect(telemetryStore.recordSpan).toHaveBeenCalledWith(expect.objectContaining({
      name: "browser.lifecycle.shutdown",
      metadata: expect.objectContaining({
        success: false,
        closeOk: false,
        failureCode: "launch.timeout",
        closeFailureCode: "launch.timeout",
        remainingPids: [],
      }),
    }));
  });

  it("returns shutdown failure details when profile-bound processes remain", async () => {
    setPlatform("linux");
    const normalizedProfile = normalizePath(BROWSER_PROFILE);
    execFileMock.mockImplementation((file: string, _args: string[], _options: any, cb: (err: any, result?: { stdout: string; stderr: string }) => void) => {
      if (file === "agent-browser") {
        cb(null, { stdout: "ok", stderr: "" });
        return {} as any;
      }
      if (file === "ps") {
        cb(null, {
          stdout: `4242 chrome chrome --user-data-dir=${normalizedProfile}`,
          stderr: "",
        });
        return {} as any;
      }
      throw new Error(`Unexpected execFile command: ${file}`);
    });
    killMock.mockImplementation(((pid: number, signal?: number | NodeJS.Signals) => {
      if (pid !== 4242) throw Object.assign(new Error("unexpected pid"), { code: "ESRCH" });
      if (signal === "SIGKILL") throw Object.assign(new Error("permission denied"), { code: "EPERM" });
      return true as never;
    }) as any);

    const telemetryStore = { recordSpan: vi.fn() };
    const mod = await import("../agent-browser.js");
    const target = mod.getBridgeBrowserTarget(COPILOT_HOME);
    const result = await mod.shutdownBridgeBrowser(target, telemetryStore as any);

    expect(result).toMatchObject({
      ok: false,
      closeOk: true,
      failureCode: "profile_processes_remaining",
      terminatedPids: [4242],
      killedPids: [],
      remainingPids: [4242],
      clearedRuntimeFiles: 5,
    });
    expect(telemetryStore.recordSpan).toHaveBeenCalledWith(expect.objectContaining({
      name: "browser.lifecycle.shutdown",
      metadata: expect.objectContaining({
        success: false,
        closeOk: true,
        failureCode: "profile_processes_remaining",
        remainingPids: [4242],
      }),
    }));
  });

  it("keeps the primary lane pinned to the caller copilotHome", async () => {
    const normalizedProfile = normalizePath(BROWSER_PROFILE);
    statMock.mockImplementation(async (path: string) => {
      if (normalizePath(path).includes(normalizedProfile)) {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
      return { mtimeMs: Date.now() };
    });

    const mod = await import("../agent-browser.js");
    const profileDir = await mod.withPrimaryBrowserLane(COPILOT_HOME, undefined, {}, async (lane) => (
      lane.browserTarget.profileDir
    ));

    expect(normalizePath(profileDir)).toContain(normalizedProfile);
  });

  it("still removes clone profiles when browser close fails", async () => {
    execFileMock.mockImplementation((_file: string, _args: string[], _options: any, cb: (err: any) => void) => {
      cb({ stderr: "close failed" });
      return {} as any;
    });

    const mod = await import("../agent-browser.js");
    await mod.withCloneBrowserLane(COPILOT_HOME, undefined, { toolName: "web_search" }, async () => "ok");

    expect(rmMock).toHaveBeenCalledWith(expect.stringContaining("browser-clones"), {
      recursive: true,
      force: true,
    });
  });

  it("seeds a missing local clone source profile before cloning", async () => {
    const normalizedProfile = normalizePath(BROWSER_PROFILE);
    statMock.mockImplementation(async (path: string) => {
      if (normalizePath(path) === normalizedProfile) {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
      return { mtimeMs: Date.now() };
    });
    execFileMock.mockImplementation((_file: string, _args: string[], _options: any, cb: (err: any, result: { stdout: string; stderr: string }) => void) => {
      cb(null, { stdout: "ok", stderr: "" });
      return {} as any;
    });

    const mod = await import("../agent-browser.js");
    await mod.withCloneBrowserLane(COPILOT_HOME, undefined, { toolName: "web_search" }, async () => "ok");

    expect(cpMock).toHaveBeenCalledTimes(2);
    expect(normalizePath(cpMock.mock.calls[0][0])).toContain("/.copilot/browser-profile");
    expect(normalizePath(cpMock.mock.calls[0][1])).toBe(normalizedProfile);
    expect(normalizePath(cpMock.mock.calls[1][0])).toBe(normalizedProfile);
    expect(normalizePath(cpMock.mock.calls[1][1])).toContain(normalizePath(BROWSER_CLONES) + "/profile-");
  });

  it("starts a persistent clone from an empty profile when no primary profile exists yet", async () => {
    statMock.mockImplementation(async (path: string) => {
      if (normalizePath(path).includes("browser-profile")) {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
      return { mtimeMs: Date.now() };
    });

    const mod = await import("../agent-browser.js");
    const clone = await mod.createPersistentCloneBrowserTarget(COPILOT_HOME, undefined, {});

    expect(clone.browserTarget.sessionName).toContain("-clone-");
    expect(cpMock).not.toHaveBeenCalled();
    expect(mkdirMock).toHaveBeenCalledWith(expect.stringContaining("browser-clones"), {
      recursive: true,
    });
  });

  it("does not delete registered persistent clone profiles during stale cleanup", async () => {
    statMock.mockImplementation(async (path: string) => {
      if (normalizePath(path).includes("browser-profile")) {
        return { mtimeMs: Date.now() };
      }
      return { mtimeMs: Date.now() - (7 * 60 * 60 * 1000) };
    });
    readdirMock.mockResolvedValueOnce([]);

    const mod = await import("../agent-browser.js");
    const activeClone = await mod.createPersistentCloneBrowserTarget(COPILOT_HOME, undefined, {});
    const activeCloneDir = pathBasename(activeClone.browserTarget.profileDir);

    readdirMock.mockResolvedValueOnce([
      { name: activeCloneDir, isDirectory: () => true },
      { name: "profile-stale", isDirectory: () => true },
    ]);

    await mod.createPersistentCloneBrowserTarget(COPILOT_HOME, undefined, {});

    const removedPaths = rmMock.mock.calls.map(([path]: any[]) => normalizePath(String(path)));
    const activePath = normalizePath(activeClone.browserTarget.profileDir);
    expect(removedPaths).toContain(normalizePath(join(BROWSER_CLONES, "profile-stale")));
    expect(removedPaths.filter((path: string) => path === activePath)).toHaveLength(1);
  });

  it("does not let queue telemetry break primary-lane progress", async () => {
    const telemetryStore = {
      recordSpan: vi.fn((span: { name: string }) => {
        if (span.name === "browser.queue.wait.primary") throw new Error("db offline");
      }),
    };
    const mod = await import("../agent-browser.js");
    const order: string[] = [];
    let releaseOne!: () => void;
    const oneCanFinish = new Promise<void>((resolve) => {
      releaseOne = resolve;
    });

    const one = mod.withPrimaryBrowserLane(COPILOT_HOME, telemetryStore as any, {}, async () => {
      order.push("one:start");
      await oneCanFinish;
      order.push("one:end");
    });
    const two = mod.withPrimaryBrowserLane(COPILOT_HOME, telemetryStore as any, {}, async () => {
      order.push("two:start");
      order.push("two:end");
    });

    await flushUntil(() => order.includes("one:start"), "primary browser lane one started");
    expect(order).toEqual(["one:start"]);
    releaseOne();

    await Promise.all([one, two]);
    expect(order).toEqual(["one:start", "one:end", "two:start", "two:end"]);
  });

  it("does not let queue telemetry leak clone-pool slots", async () => {
    execFileMock.mockImplementation((_file: string, _args: string[], _options: any, cb: (err: any, result: { stdout: string; stderr: string }) => void) => {
      cb(null, { stdout: "ok", stderr: "" });
      return {} as any;
    });

    const telemetryStore = {
      recordSpan: vi.fn((span: { name: string }) => {
        if (span.name === "browser.queue.wait.clone") throw new Error("db offline");
      }),
    };
    const mod = await import("../agent-browser.js");
    const started: string[] = [];
    let releaseResolve!: () => void;
    const release = new Promise<void>((resolve) => {
      releaseResolve = resolve;
    });
    const makeLane = (toolName: string, hold: boolean) =>
      mod.withCloneBrowserLane(COPILOT_HOME, telemetryStore as any, { toolName }, async (lane) => {
        started.push(toolName);
        if (hold) await release;
        return lane.cloneId;
      });

    const resultsPromise = Promise.all([
      makeLane("a", true),
      makeLane("b", true),
      makeLane("c", true),
      makeLane("d", true),
      makeLane("e", true),
      makeLane("f", false),
    ]);

    await flushUntil(() => started.length === 5, "first five clone lanes started");
    expect(started).toEqual(["a", "b", "c", "d", "e"]);
    releaseResolve();

    const results = await resultsPromise;
    expect(started).toContain("f");
    expect(results).toHaveLength(6);
    expect(results.every(Boolean)).toBe(true);
  });

  it("does not let clone lifecycle telemetry fail successful clone work", async () => {
    execFileMock.mockImplementation((_file: string, _args: string[], _options: any, cb: (err: any, result: { stdout: string; stderr: string }) => void) => {
      cb(null, { stdout: "ok", stderr: "" });
      return {} as any;
    });

    const telemetryStore = {
      recordSpan: vi.fn((span: { name: string }) => {
        if (span.name.startsWith("browser.clone.")) throw new Error("db offline");
      }),
    };
    const mod = await import("../agent-browser.js");

    const result = await mod.withCloneBrowserLane(COPILOT_HOME, telemetryStore as any, { toolName: "web_search" }, async (lane) => lane.cloneId);

    expect(result).toBeTruthy();
    expect(rmMock).toHaveBeenCalledWith(expect.stringContaining("browser-clones"), {
      recursive: true,
      force: true,
    });
  });
});
