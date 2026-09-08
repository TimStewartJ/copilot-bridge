import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { join } from "node:path";
import { normalizePath, testCopilotHome, testExecutablePath } from "./test-paths.js";

const COPILOT_HOME = testCopilotHome();
const BROWSER_PROFILE = join(COPILOT_HOME, "browser-profile");

const execMock = vi.fn();
const execFileMock = vi.fn();
const readlinkSyncMock = vi.fn();
const readFileSyncMock = vi.fn();
const unlinkSyncMock = vi.fn();
const lstatSyncMock = vi.fn();
const killMock = vi.spyOn(process, "kill");

vi.mock("node:child_process", () => ({
  exec: execMock,
  execFile: execFileMock,
}));

vi.mock("node:fs", () => ({
  lstatSync: lstatSyncMock,
  readFileSync: readFileSyncMock,
  readlinkSync: readlinkSyncMock,
  unlinkSync: unlinkSyncMock,
}));

function callbackSuccess(stdout = "ok") {
  return (
    _file: string,
    _args: string[],
    _options: any,
    cb: (error: unknown, result?: { stdout: string; stderr: string }) => void,
  ) => {
    cb(null, { stdout, stderr: "" });
    return {} as any;
  };
}

describe("agent-browser wrapper", () => {
  beforeEach(() => {
    vi.resetModules();
    execMock.mockReset();
    execFileMock.mockReset();
    readlinkSyncMock.mockReset();
    readFileSyncMock.mockReset();
    unlinkSyncMock.mockReset();
    lstatSyncMock.mockReset();
    killMock.mockReset();
    killMock.mockImplementation((() => true) as any);
    execMock.mockImplementation(callbackSuccess("agent-browser\n"));
    execFileMock.mockImplementation(callbackSuccess());
    lstatSyncMock.mockImplementation(() => {
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
  });

  it("builds a stable authenticated target from settings", async () => {
    const mod = await import("../agent-browser.js");
    const executablePath = testExecutablePath("chrome");
    const profileDir = join(COPILOT_HOME, "authenticated");

    const first = mod.getBridgeBrowserTarget(COPILOT_HOME, {
      executablePath,
      masterProfileDirectory: profileDir,
      headed: true,
    });
    const second = mod.getBridgeBrowserTarget(COPILOT_HOME, {
      executablePath,
      masterProfileDirectory: profileDir,
      headed: true,
    });

    expect(first).toEqual(second);
    expect(first).toMatchObject({
      profileDir,
      executablePath,
      headed: true,
    });
    expect(first.sessionName).toMatch(/^copilot-bridge-[a-f0-9]{8}$/);
  });

  it("passes the broker namespace, session, profile, executable, and headed mode", async () => {
    const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
    execFileMock.mockImplementation((
      _file: string,
      args: string[],
      options: any,
      cb: (error: unknown, result?: { stdout: string; stderr: string }) => void,
    ) => {
      calls.push({ args, env: options.env });
      cb(null, { stdout: "opened", stderr: "" });
      return {} as any;
    });
    const mod = await import("../agent-browser.js");
    const executablePath = testExecutablePath("chrome");
    const profileDir = join(COPILOT_HOME, "authenticated");
    const target = mod.getBridgeBrowserTarget(COPILOT_HOME, {
      executablePath,
      masterProfileDirectory: profileDir,
      headed: true,
    });

    await mod.ab(["open", "https://example.com"], 5_000, { browserTarget: target });

    expect(calls).toHaveLength(1);
    expect(calls[0].args).toEqual(["open", "https://example.com", "--json"]);
    expect(calls[0].env).toMatchObject({
      AGENT_BROWSER_NAMESPACE: "copilot-bridge",
      AGENT_BROWSER_SESSION: target.sessionName,
      AGENT_BROWSER_PROFILE: profileDir,
      AGENT_BROWSER_EXECUTABLE_PATH: executablePath,
      AGENT_BROWSER_HEADED: "true",
    });
  });

  it("does not leak inherited headed mode into a headless target", async () => {
    vi.stubEnv("AGENT_BROWSER_HEADED", "true");
    let commandEnv: NodeJS.ProcessEnv | undefined;
    execFileMock.mockImplementation((
      _file: string,
      _args: string[],
      options: any,
      cb: (error: unknown, result?: { stdout: string; stderr: string }) => void,
    ) => {
      commandEnv = options.env;
      cb(null, { stdout: "ok", stderr: "" });
      return {} as any;
    });
    const mod = await import("../agent-browser.js");

    await mod.ab(["get", "url"], 5_000, {
      browserTarget: mod.getBridgeBrowserTarget(COPILOT_HOME),
    });

    expect(commandEnv?.AGENT_BROWSER_HEADED).toBeUndefined();
    vi.unstubAllEnvs();
  });

  it("returns as soon as a complete JSON result arrives from a cold CLI client", async () => {
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = stdout;
    child.stderr = stderr;
    child.kill = vi.fn();
    execFileMock.mockImplementation(() => {
      queueMicrotask(() => {
        stdout.write(JSON.stringify({
          success: true,
          data: {
            title: "Example Domain",
            url: "https://example.com/",
          },
          error: null,
        }));
      });
      return child as any;
    });
    const mod = await import("../agent-browser.js");

    const result = await mod.ab(["open", "https://example.com"], 5_000, {
      browserTarget: mod.getBridgeBrowserTarget(COPILOT_HOME),
    });

    expect(result).toEqual({
      ok: true,
      output: "Example Domain\nhttps://example.com/",
    });
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  it("extracts get text output from the JSON transport", async () => {
    const stdout = new PassThrough();
    const child = new EventEmitter() as EventEmitter & {
      stdout: PassThrough;
      stderr: PassThrough;
      kill: ReturnType<typeof vi.fn>;
    };
    child.stdout = stdout;
    child.stderr = new PassThrough();
    child.kill = vi.fn();
    execFileMock.mockImplementation(() => {
      queueMicrotask(() => {
        stdout.write(JSON.stringify({
          success: true,
          data: { text: "Hello" },
          error: null,
        }));
      });
      return child as any;
    });
    const mod = await import("../agent-browser.js");

    const result = await mod.ab(["get", "text", "@e1"], 5_000, {
      browserTarget: mod.getBridgeBrowserTarget(COPILOT_HOME),
    });

    expect(result).toEqual({ ok: true, output: "Hello" });
  });

  it("clears stale lock files and retries a launch once", async () => {
    execFileMock
      .mockImplementationOnce((
        _file: string,
        _args: string[],
        _options: any,
        cb: (error: unknown) => void,
      ) => {
        cb({ stderr: "DevToolsActivePort missing" });
        return {} as any;
      })
      .mockImplementationOnce(callbackSuccess("opened"));
    readlinkSyncMock.mockReturnValue("host-999999");
    killMock.mockImplementation(((pid: number, signal?: number | NodeJS.Signals) => {
      if (pid === 999999 && signal === 0) {
        throw Object.assign(new Error("gone"), { code: "ESRCH" });
      }
      return true as never;
    }) as any);
    const mod = await import("../agent-browser.js");

    const result = await mod.ab(["open", "https://example.com"], 5_000, {
      browserTarget: mod.getBridgeBrowserTarget(COPILOT_HOME),
    });

    expect(result.ok).toBe(true);
    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(unlinkSyncMock).toHaveBeenCalledWith(join(BROWSER_PROFILE, "SingletonLock"));
  });

  it("retries connection-refused failures before profile recovery", async () => {
    execFileMock
      .mockImplementationOnce((
        _file: string,
        _args: string[],
        _options: any,
        cb: (error: unknown) => void,
      ) => {
        cb({ stderr: "Failed to connect: Connection refused" });
        return {} as any;
      })
      .mockImplementationOnce(callbackSuccess("ready"));
    const mod = await import("../agent-browser.js");

    const result = await mod.ab(["get", "url"], 5_000, {
      browserTarget: mod.getBridgeBrowserTarget(COPILOT_HOME),
    });

    expect(result).toEqual({ ok: true, output: "ready" });
    expect(execFileMock).toHaveBeenCalledTimes(2);
    expect(readFileSyncMock).not.toHaveBeenCalled();
  });

  it("serializes work that targets the same browser session", async () => {
    const mod = await import("../agent-browser.js");
    const target = mod.getBridgeBrowserTarget(COPILOT_HOME);
    const order: string[] = [];
    let releaseFirst!: () => void;

    const first = mod.withBridgeBrowserSession(target, async () => {
      order.push("first-start");
      await new Promise<void>((resolve) => {
        releaseFirst = resolve;
      });
      order.push("first-end");
    });
    const second = mod.withBridgeBrowserSession(target, async () => {
      order.push("second");
    });

    await vi.waitFor(() => expect(order).toEqual(["first-start"]));
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });

  it("reports shutdown command failures without exposing the raw profile path", async () => {
    execFileMock.mockImplementation((
      file: string,
      args: string[],
      _options: any,
      cb: (error: unknown, result?: { stdout: string; stderr: string }) => void,
    ) => {
      if (file === "agent-browser" && args[0] === "close") {
        cb({ stderr: `timed out closing ${BROWSER_PROFILE}` });
      } else {
        cb(null, { stdout: "", stderr: "" });
      }
      return {} as any;
    });
    const mod = await import("../agent-browser.js");

    const result = await mod.shutdownBridgeBrowser(mod.getBridgeBrowserTarget(COPILOT_HOME));

    expect(result).toMatchObject({
      ok: false,
      failureCode: "launch.timeout",
      closeFailureCode: "launch.timeout",
      remainingPids: [],
    });
    expect(result.outputSummary).toContain("<browser-profile>");
    expect(result.outputSummary).not.toContain(normalizePath(BROWSER_PROFILE));
  });
});
