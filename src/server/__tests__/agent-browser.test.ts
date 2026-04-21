import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { normalizePath, pathBasename, testCopilotHome } from "./test-paths.js";

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
    expect(unlinkSyncMock).toHaveBeenCalledTimes(3);
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

    const one = mod.withBridgeBrowserSession(target, async () => {
      order.push("one:start");
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push("one:end");
    });
    const two = mod.withBridgeBrowserSession(target, async () => {
      order.push("two:start");
      order.push("two:end");
    });

    await Promise.all([one, two]);
    expect(order).toEqual(["one:start", "one:end", "two:start", "two:end"]);
  });

  it("creates and cleans up sanitized clone lanes", async () => {
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
    expect(options.filter(join(BROWSER_PROFILE, "Default", "Cookies"))).toBe(true);
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

    const one = mod.withPrimaryBrowserLane(COPILOT_HOME, telemetryStore as any, {}, async () => {
      order.push("one:start");
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push("one:end");
    });
    const two = mod.withPrimaryBrowserLane(COPILOT_HOME, telemetryStore as any, {}, async () => {
      order.push("two:start");
      order.push("two:end");
    });

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

    await new Promise((resolve) => setTimeout(resolve, 20));
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
