import { beforeEach, describe, expect, it, vi } from "vitest";

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
    const target = mod.getBridgeBrowserTarget("/tmp/test-copilot");

    await mod.ab(["open", "https://example.com"], undefined, { browserTarget: target });

    expect(execFileMock).toHaveBeenCalledTimes(1);
    const [, , options] = execFileMock.mock.calls[0];
    expect(options.env.AGENT_BROWSER_SESSION).toMatch(/^copilot-bridge-/);
    expect(options.env.AGENT_BROWSER_PROFILE.replaceAll("\\", "/")).toContain("/tmp/test-copilot/browser-profile");
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
    const target = mod.getBridgeBrowserTarget("/tmp/test-copilot");
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
    readFileSyncMock.mockReturnValue(
      "chrome\0--user-data-dir=/tmp/test-copilot/browser-profile\0--profile-directory=Default\0",
    );
    const killed: number[] = [];
    killMock.mockImplementation(((pid: number, signal?: number | NodeJS.Signals) => {
      if (signal === 0) return true as never;
      killed.push(pid);
      return true as never;
    }) as any);

    const mod = await import("../agent-browser.js");
    const target = mod.getBridgeBrowserTarget("/tmp/test-copilot");
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
    const target = mod.getBridgeBrowserTarget("/tmp/test-copilot");
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
    const target = mod.getBridgeBrowserTarget("/tmp/test-copilot");
    const result = await mod.ab(["open", "https://example.com"], undefined, { browserTarget: target });

    expect(result.ok).toBe(false);
    expect(unlinkSyncMock).not.toHaveBeenCalled();
    expect(killMock).toHaveBeenCalledWith(123, 0);
  });

  it("serializes browser flows through the bridge session lock", async () => {
    const mod = await import("../agent-browser.js");
    const target = mod.getBridgeBrowserTarget("/tmp/test-copilot");
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
    const result = await mod.withCloneBrowserLane("/tmp/test-copilot", undefined, { toolName: "web_search" }, async (lane) => {
      expect(lane.laneType).toBe("clone");
      expect(lane.cloneId).toBeTruthy();
      expect(lane.browserTarget.profileDir.replaceAll("\\", "/")).toContain("/tmp/test-copilot/browser-clones/profile-");
      expect(lane.browserTarget.sessionName).toContain("-clone-");
      return lane.browserTarget.sessionName;
    });

    expect(result).toContain("-clone-");
    expect(mkdirMock).toHaveBeenCalled();
    expect(cpMock).toHaveBeenCalledTimes(1);
    const [, , options] = cpMock.mock.calls[0];
    expect(options.filter("/tmp/test-copilot/browser-profile/SingletonLock")).toBe(false);
    expect(options.filter("/tmp/test-copilot/browser-profile/Default/Cookies")).toBe(true);
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
    statMock.mockImplementation(async (path: string) => {
      if (path.includes("/tmp/test-copilot/browser-profile")) {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
      return { mtimeMs: Date.now() };
    });

    const mod = await import("../agent-browser.js");
    const profileDir = await mod.withPrimaryBrowserLane("/tmp/test-copilot", undefined, {}, async (lane) => (
      lane.browserTarget.profileDir
    ));

    expect(profileDir.replaceAll("\\", "/")).toContain("/tmp/test-copilot/browser-profile");
  });

  it("still removes clone profiles when browser close fails", async () => {
    execFileMock.mockImplementation((_file: string, _args: string[], _options: any, cb: (err: any) => void) => {
      cb({ stderr: "close failed" });
      return {} as any;
    });

    const mod = await import("../agent-browser.js");
    await mod.withCloneBrowserLane("/tmp/test-copilot", undefined, { toolName: "web_search" }, async () => "ok");

    expect(rmMock).toHaveBeenCalledWith(expect.stringContaining("browser-clones"), {
      recursive: true,
      force: true,
    });
  });

  it("seeds a missing local clone source profile before cloning", async () => {
    statMock.mockImplementation(async (path: string) => {
      if (path === "/tmp/test-copilot/browser-profile") {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
      return { mtimeMs: Date.now() };
    });
    execFileMock.mockImplementation((_file: string, _args: string[], _options: any, cb: (err: any, result: { stdout: string; stderr: string }) => void) => {
      cb(null, { stdout: "ok", stderr: "" });
      return {} as any;
    });

    const mod = await import("../agent-browser.js");
    await mod.withCloneBrowserLane("/tmp/test-copilot", undefined, { toolName: "web_search" }, async () => "ok");

    expect(cpMock).toHaveBeenCalledTimes(2);
    expect(cpMock.mock.calls[0][0].replaceAll("\\", "/")).toContain("/.copilot/browser-profile");
    expect(cpMock.mock.calls[0][1].replaceAll("\\", "/")).toBe("/tmp/test-copilot/browser-profile");
    expect(cpMock.mock.calls[1][0].replaceAll("\\", "/")).toBe("/tmp/test-copilot/browser-profile");
    expect(cpMock.mock.calls[1][1].replaceAll("\\", "/")).toContain("/tmp/test-copilot/browser-clones/profile-");
  });

  it("starts a persistent clone from an empty profile when no primary profile exists yet", async () => {
    statMock.mockImplementation(async (path: string) => {
      if (path.includes("browser-profile")) {
        throw Object.assign(new Error("missing"), { code: "ENOENT" });
      }
      return { mtimeMs: Date.now() };
    });

    const mod = await import("../agent-browser.js");
    const clone = await mod.createPersistentCloneBrowserTarget("/tmp/test-copilot", undefined, {});

    expect(clone.browserTarget.sessionName).toContain("-clone-");
    expect(cpMock).not.toHaveBeenCalled();
    expect(mkdirMock).toHaveBeenCalledWith(expect.stringContaining("/tmp/test-copilot/browser-clones/profile-"), {
      recursive: true,
    });
  });

  it("does not delete registered persistent clone profiles during stale cleanup", async () => {
    statMock.mockImplementation(async (path: string) => {
      if (path.includes("browser-profile")) {
        return { mtimeMs: Date.now() };
      }
      return { mtimeMs: Date.now() - (7 * 60 * 60 * 1000) };
    });
    readdirMock.mockResolvedValueOnce([]);

    const mod = await import("../agent-browser.js");
    const activeClone = await mod.createPersistentCloneBrowserTarget("/tmp/test-copilot", undefined, {});
    const activeCloneDir = activeClone.browserTarget.profileDir.replaceAll("\\", "/").split("/").at(-1)!;

    readdirMock.mockResolvedValueOnce([
      { name: activeCloneDir, isDirectory: () => true },
      { name: "profile-stale", isDirectory: () => true },
    ]);

    await mod.createPersistentCloneBrowserTarget("/tmp/test-copilot", undefined, {});

    const removedPaths = rmMock.mock.calls.map(([path]) => String(path).replaceAll("\\", "/"));
    const activePath = activeClone.browserTarget.profileDir.replaceAll("\\", "/");
    expect(removedPaths).toContain("/tmp/test-copilot/browser-clones/profile-stale");
    expect(removedPaths.filter((path) => path === activePath)).toHaveLength(1);
  });

  it("does not let queue telemetry break primary-lane progress", async () => {
    const telemetryStore = {
      recordSpan: vi.fn((span: { name: string }) => {
        if (span.name === "browser.queue.wait.primary") throw new Error("db offline");
      }),
    };
    const mod = await import("../agent-browser.js");
    const order: string[] = [];

    const one = mod.withPrimaryBrowserLane("/tmp/test-copilot", telemetryStore as any, {}, async () => {
      order.push("one:start");
      await new Promise((resolve) => setTimeout(resolve, 30));
      order.push("one:end");
    });
    const two = mod.withPrimaryBrowserLane("/tmp/test-copilot", telemetryStore as any, {}, async () => {
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
      mod.withCloneBrowserLane("/tmp/test-copilot", telemetryStore as any, { toolName }, async (lane) => {
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

    const result = await mod.withCloneBrowserLane("/tmp/test-copilot", telemetryStore as any, { toolName: "web_search" }, async (lane) => lane.cloneId);

    expect(result).toBeTruthy();
    expect(rmMock).toHaveBeenCalledWith(expect.stringContaining("browser-clones"), {
      recursive: true,
      force: true,
    });
  });
});
