import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { homedir } from "node:os";
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
const readdirMock = vi.fn();
const rmMock = vi.fn();
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

vi.mock("node:fs/promises", () => ({
  readdir: readdirMock,
  rm: rmMock,
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
    readdirMock.mockReset();
    readdirMock.mockResolvedValue([]);
    rmMock.mockReset();
    rmMock.mockResolvedValue(undefined);
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

  describe("start page and idle shutdown", () => {
    async function commandEnvFor(target: (mod: typeof import("../agent-browser.js")) => import("../agent-browser.js").BrowserTarget) {
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
      await mod.ab(["get", "url"], 5_000, { browserTarget: target(mod) });
      return commandEnv;
    }

    it("adds a blank start page to the launch arguments", async () => {
      const mod = await import("../agent-browser.js");

      expect(mod.withBlankStartPage(undefined)).toBe("about:blank");
      expect(mod.withBlankStartPage("  ")).toBe("about:blank");
      expect(mod.withBlankStartPage("--no-sandbox")).toBe("--no-sandbox,about:blank");
      expect(mod.withBlankStartPage("--no-sandbox\n--window-size=1280,720")).toBe("--no-sandbox\n--window-size=1280,720\nabout:blank");
      expect(mod.withBlankStartPage("--no-sandbox, about:blank")).toBe("--no-sandbox, about:blank");
    });

    it("starts every browser on a blank page and keeps inherited launch arguments", async () => {
      vi.stubEnv("AGENT_BROWSER_ARGS", "--no-sandbox");
      try {
        const env = await commandEnvFor((mod) => mod.getBridgeBrowserTarget(COPILOT_HOME));
        expect(env?.AGENT_BROWSER_ARGS).toBe("--no-sandbox,about:blank");
      } finally {
        vi.unstubAllEnvs();
      }
    });

    it("gives the daemon an idle limit only for a target that has one", async () => {
      vi.stubEnv("AGENT_BROWSER_IDLE_TIMEOUT_MS", undefined);
      vi.stubEnv("AGENT_BROWSER_ARGS", undefined);
      try {
        const lasting = await commandEnvFor((mod) => mod.getBridgeBrowserTarget(COPILOT_HOME));
        expect(lasting?.AGENT_BROWSER_ARGS).toBe("about:blank");
        expect(lasting?.AGENT_BROWSER_IDLE_TIMEOUT_MS).toBeUndefined();

        const disposable = await commandEnvFor(() => ({
          sessionName: "copilot-bridge-public-1234abcd",
          profileDir: join(COPILOT_HOME, "browser-public", "profile-1234abcd"),
          idleTimeoutMs: 2_700_000,
          disposable: true,
        }));
        expect(disposable?.AGENT_BROWSER_IDLE_TIMEOUT_MS).toBe("2700000");
      } finally {
        vi.unstubAllEnvs();
      }
    });
  });

  describe("shutdown of a disposable browser", () => {
    const WINDOWS_PROFILE = "C:\\Users\\test\\.copilot\\browser-public\\profile-1234abcd";
    const POSIX_PROFILE = "/home/test/.copilot/browser-public/profile-1234abcd";

    interface ListedProcess {
      pid: number;
      parentPid: number;
      name: string;
      commandLine: string;
      createdAtMs: number;
    }

    function windowsBrowser(pid: number, parentPid: number, createdAtMs: number, profileDir = WINDOWS_PROFILE, extra = ""): ListedProcess {
      return {
        pid,
        parentPid,
        createdAtMs,
        name: "msedge.exe",
        commandLine: `"C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" ${extra}--headless=new --user-data-dir=${profileDir} --window-size=1280,720`,
      };
    }

    function windowsDaemon(pid: number, createdAtMs: number): ListedProcess {
      return {
        pid,
        parentPid: 4,
        createdAtMs,
        name: "agent-browser-win32-x64.exe",
        commandLine: "\"\\\\?\\C:\\tools\\node_modules\\agent-browser\\bin\\agent-browser-win32-x64.exe\"",
      };
    }

    function windowsListing(processes: ListedProcess[]): string {
      return JSON.stringify(processes.map((processInfo) => ({
        ProcessId: processInfo.pid,
        ParentProcessId: processInfo.parentPid,
        Name: processInfo.name,
        CommandLine: processInfo.commandLine,
        CreatedAtMs: processInfo.createdAtMs,
      })));
    }

    /** Forces the platform branch; process creation, signals and the file system are mocked already. */
    async function importForPlatform(platformName: NodeJS.Platform) {
      vi.doMock("node:os", async (importOriginal) => ({
        ...(await importOriginal<typeof import("node:os")>()),
        platform: () => platformName,
      }));
      return import("../agent-browser.js");
    }

    /** Fails `close` and answers each process listing with the next entry of `listings`. */
    function mockFailedCloseAndListings(listingCommand: string, listings: string[]) {
      let listingCalls = 0;
      execFileMock.mockImplementation((
        file: string,
        args: string[],
        _options: any,
        cb: (error: unknown, result?: { stdout: string; stderr: string }) => void,
      ) => {
        if (args[0] === "close") {
          cb({ stderr: "agent-browser command timed out after 10000ms" });
        } else if (file === listingCommand) {
          cb(null, { stdout: listings[Math.min(listingCalls, listings.length - 1)], stderr: "" });
          listingCalls += 1;
        } else {
          throw new Error(`Unexpected execFile command: ${file}`);
        }
        return {} as any;
      });
      return { listingCalls: () => listingCalls };
    }

    /** Every signalled process exits at once: a later check finds it gone. */
    function recordSignals() {
      const signals: Array<[number, number | NodeJS.Signals | undefined]> = [];
      killMock.mockImplementation(((pid: number, signal?: number | NodeJS.Signals) => {
        if (signal === 0) throw Object.assign(new Error("gone"), { code: "ESRCH" });
        signals.push([pid, signal]);
        return true as never;
      }) as any);
      return signals;
    }

    afterEach(() => {
      vi.doUnmock("node:os");
      vi.unstubAllEnvs();
    });

    it("stops the daemon first, then the browser, and catches a browser started meanwhile", async () => {
      vi.stubEnv("AGENT_BROWSER_SOCKET_DIR", undefined);
      vi.stubEnv("XDG_RUNTIME_DIR", undefined);
      readdirMock.mockResolvedValue([
        "browsers",
        "copilot-bridge-public-1234abcd.pid",
        "copilot-bridge-public-1234abcd.port",
        "copilot-bridge-public-1234abcdef.pid",
        "default.pid",
      ]);
      const listings = mockFailedCloseAndListings("powershell.exe", [
        windowsListing([
          windowsDaemon(100, 1_000),
          windowsBrowser(200, 100, 2_000),
          windowsBrowser(201, 200, 2_100, WINDOWS_PROFILE, "--type=renderer "),
          windowsDaemon(300, 1_500),
          windowsBrowser(400, 300, 2_500, "C:\\Users\\test\\.copilot\\browser-public\\profile-other"),
        ]),
        // The first browser is still in the process table, and a new one has appeared.
        windowsListing([
          windowsBrowser(200, 100, 2_000),
          windowsBrowser(500, 100, 3_000),
          windowsDaemon(300, 1_500),
          windowsBrowser(400, 300, 2_500, "C:\\Users\\test\\.copilot\\browser-public\\profile-other"),
        ]),
      ]);
      const signals = recordSignals();
      const mod = await importForPlatform("win32");

      const result = await mod.shutdownBridgeBrowser({
        sessionName: "copilot-bridge-public-1234abcd",
        profileDir: WINDOWS_PROFILE,
        disposable: true,
      });

      expect(signals).toEqual([
        [100, "SIGKILL"],
        [200, "SIGTERM"],
        [201, "SIGTERM"],
        [500, "SIGTERM"],
      ]);
      expect(listings.listingCalls()).toBe(2);
      expect(result).toMatchObject({
        ok: false,
        closeOk: false,
        failureCode: "launch.timeout",
        stoppedDaemonPids: [100],
        terminatedPids: [200, 201, 500],
        killedPids: [],
        remainingPids: [],
      });
      // The killed daemon could not remove its own state files; other sessions' files stay.
      const stateDirectory = join(homedir(), ".agent-browser");
      expect(readdirMock).toHaveBeenCalledWith(stateDirectory);
      expect(rmMock.mock.calls).toEqual([
        [join(stateDirectory, "copilot-bridge-public-1234abcd.pid"), { force: true }],
        [join(stateDirectory, "copilot-bridge-public-1234abcd.port"), { force: true }],
      ]);
    });

    it("finds the daemon through the parent id on POSIX", async () => {
      vi.stubEnv("AGENT_BROWSER_SOCKET_DIR", undefined);
      vi.stubEnv("XDG_RUNTIME_DIR", "/run/user/1000");
      mockFailedCloseAndListings("ps", [
        [
          "  100     1 agent-browser-l /usr/lib/node_modules/agent-browser/bin/agent-browser-linux-x64",
          `  200   100 chrome          /opt/google/chrome/chrome --headless=new --user-data-dir=${POSIX_PROFILE} about:blank`,
          `  201   200 chrome          /opt/google/chrome/chrome --type=renderer --user-data-dir=${POSIX_PROFILE}`,
          "  300     1 agent-browser-l /usr/lib/node_modules/agent-browser/bin/agent-browser-linux-x64",
          "  400   300 chrome          /opt/google/chrome/chrome --headless=new --user-data-dir=/home/test/.copilot/browser-public/profile-other",
          "  600   555 agent-browser   agent-browser close --json",
        ].join("\n"),
        "",
      ]);
      const signals = recordSignals();
      const mod = await importForPlatform("linux");

      const result = await mod.shutdownBridgeBrowser({
        sessionName: "copilot-bridge-public-1234abcd",
        profileDir: POSIX_PROFILE,
        disposable: true,
      });

      expect(signals).toEqual([
        [100, "SIGKILL"],
        [200, "SIGTERM"],
        [201, "SIGTERM"],
      ]);
      expect(result).toMatchObject({ stoppedDaemonPids: [100], terminatedPids: [200, 201], remainingPids: [] });
      expect(readdirMock).toHaveBeenCalledWith(join("/run/user/1000", "agent-browser"));
    });

    it("does not take a younger process with a reused id for the daemon on Windows", async () => {
      mockFailedCloseAndListings("powershell.exe", [
        // The browser's real parent is gone; its id now belongs to another session's daemon.
        windowsListing([windowsDaemon(100, 9_000), windowsBrowser(200, 100, 2_000)]),
        "",
      ]);
      const signals = recordSignals();
      const mod = await importForPlatform("win32");

      const result = await mod.shutdownBridgeBrowser({
        sessionName: "copilot-bridge-public-1234abcd",
        profileDir: WINDOWS_PROFILE,
        disposable: true,
      });

      expect(signals).toEqual([[200, "SIGTERM"]]);
      expect(result.stoppedDaemonPids).toBeUndefined();
      expect(result.terminatedPids).toEqual([200]);
      expect(readdirMock).not.toHaveBeenCalled();
    });

    it("leaves the daemon of a lasting browser running and looks only once", async () => {
      const listings = mockFailedCloseAndListings("powershell.exe", [
        windowsListing([windowsDaemon(100, 1_000), windowsBrowser(200, 100, 2_000)]),
      ]);
      const signals = recordSignals();
      const mod = await importForPlatform("win32");

      const result = await mod.shutdownBridgeBrowser({
        sessionName: "copilot-bridge-1234abcd",
        profileDir: WINDOWS_PROFILE,
      });

      expect(signals).toEqual([[200, "SIGTERM"]]);
      expect(listings.listingCalls()).toBe(1);
      expect(result.stoppedDaemonPids).toBeUndefined();
      expect(readdirMock).not.toHaveBeenCalled();
    });
  });
});
