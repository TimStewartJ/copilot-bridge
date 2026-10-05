import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { homedir } from "node:os";
import { join } from "node:path";
import type { TelemetryStore } from "../telemetry-store.js";
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

function callbackFailure(failure: { stdout?: string; stderr?: string }) {
  return (
    _file: string,
    _args: string[],
    _options: any,
    cb: (error: unknown) => void,
  ) => {
    cb(failure);
    return {} as any;
  };
}

/** What agent-browser prints for a command that worked. */
function jsonResult(data: unknown): string {
  return JSON.stringify({ success: true, data, error: null });
}

/** Collects the spans a command records. */
function spanRecorder() {
  const recordSpan = vi.fn();
  return {
    telemetryStore: { recordSpan } as unknown as TelemetryStore,
    spans: (): Array<{ name: string; metadata?: Record<string, unknown> }> =>
      recordSpan.mock.calls.map(([span]) => span),
  };
}

// What Chrome prints when the host does not let it create its sandbox, and what agent-browser
// reports with it: that the browser never wrote its DevTools port.
const NO_SANDBOX_OUTPUT = "No usable sandbox! If you are running on Ubuntu 23.10+ or another Linux distro "
  + "that has disabled unprivileged user namespaces with AppArmor, see the Chromium sandbox documentation.";
const NO_SANDBOX_WITH_PORT_OUTPUT = `Chrome exited early without writing DevToolsActivePort\n${NO_SANDBOX_OUTPUT}`;

// The arguments every Bridge browser gets; src/server/__tests__/browser-launch.test.ts has the detail.
const BRIDGE_LAUNCH_ARGS = [
  "--disable-blink-features=AutomationControlled",
  "--enable-unsafe-swiftshader",
  "about:blank",
];

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

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
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

  it("reads the launch configuration the way Settings does: trimmed, and blank means not set", async () => {
    const mod = await import("../agent-browser.js");
    const launch = await import("../browser-launch.js");
    const executablePath = testExecutablePath("chrome");
    const profileDir = join(COPILOT_HOME, "authenticated");

    // One reading of the configuration, shared with the module that starts the browsers.
    expect(mod.getBrowserLaunchConfig).toBe(launch.getBrowserLaunchConfig);
    expect(mod.getBridgeBrowserTarget(COPILOT_HOME, {
      executablePath: `  ${executablePath} `,
      masterProfileDirectory: ` ${profileDir}  `,
    })).toEqual(mod.getBridgeBrowserTarget(COPILOT_HOME, { executablePath, masterProfileDirectory: profileDir }));

    const unconfigured = mod.getBridgeBrowserTarget(COPILOT_HOME);
    expect(mod.getBridgeBrowserTarget(COPILOT_HOME, { executablePath: "  ", masterProfileDirectory: "" }))
      .toEqual(unconfigured);
    expect(unconfigured).toEqual({
      sessionName: expect.stringMatching(/^copilot-bridge-[a-f0-9]{8}$/),
      profileDir: BROWSER_PROFILE,
    });
    // Its daemon stays when the browser is shut down, and nothing limits how long it may idle.
    expect(unconfigured).not.toHaveProperty("stopDaemonOnShutdown");
    expect(unconfigured).not.toHaveProperty("idleTimeoutMs");
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
      data: { title: "Example Domain", url: "https://example.com/" },
    });
    expect(child.kill).toHaveBeenCalledTimes(1);
  });

  describe("command results", () => {
    const failedResult = JSON.stringify({ success: false, data: { url: "about:blank" }, error: "The element is covered" });

    it.each([
      {
        name: "everything a successful command reported as data",
        command: ["get", "url"] as const,
        reply: callbackSuccess(jsonResult({ url: "https://example.com/", tabId: 3, frames: [{ id: "main" }] })),
        expected: { ok: true, output: "https://example.com/", data: { url: "https://example.com/", tabId: 3, frames: [{ id: "main" }] } },
      },
      {
        name: "the text of an element as output",
        command: ["get", "text", "@e1"] as const,
        reply: callbackSuccess(jsonResult({ text: "Hello" })),
        expected: { ok: true, output: "Hello", data: { text: "Hello" } },
      },
      {
        name: "no data for a failed command, even when its result carries some",
        command: ["click", "@e1"] as const,
        reply: callbackFailure({ stdout: failedResult }),
        expected: { ok: false, output: "The element is covered" },
      },
      {
        name: "no data when a successful command reported none",
        command: ["press", "Enter"] as const,
        reply: callbackSuccess(jsonResult(null)),
        expected: { ok: true, output: "" },
      },
      {
        name: "no data for successful output that is not a JSON result",
        command: ["press", "Enter"] as const,
        reply: callbackSuccess("done\n"),
        expected: { ok: true, output: "done" },
      },
      {
        name: "no data for a failure that is not a JSON result",
        command: ["press", "Enter"] as const,
        reply: callbackFailure({ stderr: "the daemon went away\n" }),
        expected: { ok: false, output: "the daemon went away" },
      },
      {
        name: "the string an eval produced as it is",
        command: ["eval", "document.title"] as const,
        reply: callbackSuccess(jsonResult({ origin: "https://example.com", result: "Example \"Domain\"" })),
        expected: { ok: true, output: "Example \"Domain\"", data: { origin: "https://example.com", result: "Example \"Domain\"" } },
      },
      {
        name: "no output for an eval that produced nothing",
        command: ["eval", "void 0"] as const,
        reply: callbackSuccess(jsonResult({ origin: "https://example.com" })),
        expected: { ok: true, output: "", data: { origin: "https://example.com" } },
      },
    ])("returns $name", async ({ command, reply, expected }) => {
      execFileMock.mockImplementation(reply);
      const mod = await import("../agent-browser.js");

      const result = await mod.ab([...command], 5_000, {
        browserTarget: mod.getBridgeBrowserTarget(COPILOT_HOME),
      });

      // toEqual would let a `data: undefined` through.
      expect(result).toStrictEqual(expected);
    });

    it("returns any other value an eval produced as JSON", async () => {
      const values = [{ width: 1280, tags: ["a", "b"] }, [1, 2], 42, false, null];
      for (const value of values) {
        execFileMock.mockImplementationOnce(callbackSuccess(jsonResult({ result: value })));
      }
      const mod = await import("../agent-browser.js");
      const browserTarget = mod.getBridgeBrowserTarget(COPILOT_HOME);

      const results = [];
      for (const _value of values) {
        results.push(await mod.ab(["eval", "window.probe()"], 5_000, { browserTarget }));
      }

      expect(results.map((result) => result.output)).toEqual([
        "{\"width\":1280,\"tags\":[\"a\",\"b\"]}",
        "[1,2]",
        "42",
        "false",
        "null",
      ]);
      expect(results.map((result) => result.data)).toEqual(values.map((value) => ({ result: value })));
    });

  });

  describe("on Windows, where agent-browser may only start through the command shell", () => {
    /** Forces the platform branch; process creation and the file system are mocked already. */
    async function importOnWindows() {
      vi.doMock("node:os", async (importOriginal) => ({
        ...(await importOriginal<typeof import("node:os")>()),
        platform: () => "win32",
      }));
      const mod = await import("../agent-browser.js");
      const browserTarget = mod.getBridgeBrowserTarget(COPILOT_HOME);
      return (argument: string) => mod.ab(["open", argument], 5_000, { browserTarget });
    }

    afterEach(() => {
      vi.doUnmock("node:os");
    });

    it.each([
      ["&", "https://example.com/?a=1&calc.exe"],
      ["|", "https://example.com/|more"],
      ["<", "https://example.com/<in"],
      [">", "https://example.com/>out"],
      ["^", "https://example.com/^"],
      ["a quotation mark", "https://example.com/\"x"],
      ["a line break", "https://example.com/\ncalc.exe"],
    ])("refuses a command with %s in an argument, which the shell would read as its own syntax, and runs nothing", async (_name, argument) => {
      const open = await importOnWindows();

      const result = await open(argument);

      expect(result.ok).toBe(false);
      expect(result.output).toContain("Windows command shell");
      expect(execFileMock).not.toHaveBeenCalled();
    });

    it("runs a command without such an argument through the shell", async () => {
      const open = await importOnWindows();

      await expect(open("https://example.com/next?a=1")).resolves.toMatchObject({ ok: true });

      expect(execFileMock).toHaveBeenCalledOnce();
      expect(execFileMock.mock.calls[0][2]).toMatchObject({ shell: true });
    });

    it("runs a command with such an argument when it found agent-browser's executable, which needs no shell", async () => {
      vi.stubEnv("PATH", join(COPILOT_HOME, "npm"));
      lstatSyncMock.mockImplementation(() => ({}));
      const open = await importOnWindows();

      await expect(open("https://example.com/?a=1&b=2")).resolves.toMatchObject({ ok: true });

      expect(execFileMock).toHaveBeenCalledOnce();
      const [file, args, options] = execFileMock.mock.calls[0];
      expect(file).toContain("agent-browser-win32-x64.exe");
      expect(args).toContain("https://example.com/?a=1&b=2");
      expect(options).toMatchObject({ shell: false });
    });
  });

  describe("a host that refuses the browser its sandbox", () => {
    /** The failure code and signature of the one command that ran. */
    async function classify(output: string) {
      execFileMock.mockImplementation(callbackFailure({ stderr: output }));
      const { telemetryStore, spans } = spanRecorder();
      const mod = await import("../agent-browser.js");
      await mod.ab(["open", "https://example.com"], 5_000, {
        browserTarget: mod.getBridgeBrowserTarget(COPILOT_HOME),
        telemetryStore,
        skipRecovery: true,
      });
      expect(spans().map((span) => span.name)).toEqual(["browser.command.open", "browser.command.open.failed"]);
      const [command, failed] = spans();
      expect(command.metadata).toMatchObject({ success: false });
      expect(failed.metadata?.failureCode).toBe(command.metadata?.failureCode);
      return { failureCode: command.metadata?.failureCode, signature: command.metadata?.signature };
    }

    it.each([
      ["the missing sandbox alone", NO_SANDBOX_OUTPUT, "launch.no_usable_sandbox", undefined],
      ["the missing sandbox when the output also names DevToolsActivePort", NO_SANDBOX_WITH_PORT_OUTPUT, "launch.no_usable_sandbox", "DevToolsActivePort"],
      ["the missing sandbox wherever its line stands in the output", `${NO_SANDBOX_OUTPUT}\nDevToolsActivePort file doesn't exist`, "launch.no_usable_sandbox", "DevToolsActivePort"],
      // Chrome names files it looked for in vain in the same output; that is not a missing agent-browser.
      ["the missing sandbox when the output also says that something was not found", `${NO_SANDBOX_OUTPUT}\nchrome-sandbox: not found`, "launch.no_usable_sandbox", undefined],
      ["a missing agent-browser", "sh: 1: agent-browser: not found", "binary_missing", undefined],
      ["a DevToolsActivePort failure without the sandbox line", "Chrome exited early without writing DevToolsActivePort", "launch.devtools_active_port", "DevToolsActivePort"],
    ])("classifies a failure by %s", async (_name, output, failureCode, signature) => {
      expect(await classify(output)).toEqual({ failureCode, signature });
    });

    it("returns the failure after one run and leaves a stale lock alone", async () => {
      // The stale lock that a DevToolsActivePort failure is cleared and retried for, see above.
      execFileMock.mockImplementation(callbackFailure({ stderr: NO_SANDBOX_WITH_PORT_OUTPUT }));
      readlinkSyncMock.mockReturnValue("host-999999");
      killMock.mockImplementation(((pid: number, signal?: number | NodeJS.Signals) => {
        if (pid === 999999 && signal === 0) {
          throw Object.assign(new Error("gone"), { code: "ESRCH" });
        }
        return true as never;
      }) as any);
      const { telemetryStore, spans } = spanRecorder();
      const mod = await import("../agent-browser.js");

      const result = await mod.ab(["open", "https://example.com"], 5_000, {
        browserTarget: mod.getBridgeBrowserTarget(COPILOT_HOME),
        telemetryStore,
      });

      expect(result).toEqual({ ok: false, output: NO_SANDBOX_WITH_PORT_OUTPUT });
      expect(execFileMock).toHaveBeenCalledTimes(1);
      expect(readlinkSyncMock).not.toHaveBeenCalled();
      expect(unlinkSyncMock).not.toHaveBeenCalled();
      expect(killMock).not.toHaveBeenCalled();
      expect(spans().map((span) => span.name)).toEqual(["browser.command.open", "browser.command.open.failed"]);
    });

    it("returns the failure after one run and leaves the profile's browser processes alone", async () => {
      // Without a lock file, a DevToolsActivePort failure has the profile's processes listed and killed.
      execFileMock.mockImplementation((
        file: string,
        _args: string[],
        _options: any,
        cb: (error: unknown, result?: { stdout: string; stderr: string }) => void,
      ) => {
        if (file === "ps" || file === "powershell.exe") {
          throw new Error(`Unexpected process listing: ${file}`);
        }
        cb({ stderr: NO_SANDBOX_WITH_PORT_OUTPUT });
        return {} as any;
      });
      const mod = await import("../agent-browser.js");

      const result = await mod.ab(["get", "url"], 5_000, {
        browserTarget: mod.getBridgeBrowserTarget(COPILOT_HOME),
      });

      expect(result).toEqual({ ok: false, output: NO_SANDBOX_WITH_PORT_OUTPUT });
      expect(execFileMock).toHaveBeenCalledTimes(1);
      expect(execFileMock.mock.calls[0][1]).toEqual(["get", "url", "--json"]);
      expect(killMock).not.toHaveBeenCalled();
      expect(unlinkSyncMock).not.toHaveBeenCalled();
    });

    it("says what to do about a missing sandbox and nothing about other failures", async () => {
      const mod = await import("../agent-browser.js");

      const advice = mod.browserFailureAdvice(NO_SANDBOX_OUTPUT);
      expect(advice).toContain("sandbox");
      // Both ways out: a Chrome the system allows, or no sandbox, with where to set that.
      expect(advice).toContain("Install Google Chrome from its package");
      expect(advice).toContain("--no-sandbox");
      expect(advice).toContain("AGENT_BROWSER_ARGS");
      expect(advice).toContain(".env");
      expect(mod.browserFailureAdvice(NO_SANDBOX_WITH_PORT_OUTPUT)).toBe(advice);
      expect(mod.browserFailureAdvice(`${NO_SANDBOX_OUTPUT}\nchrome-sandbox: not found`)).toBe(advice);

      for (const output of [
        "",
        "Chrome exited early without writing DevToolsActivePort",
        "Failed to connect: Connection refused",
        "Broken pipe",
        "agent-browser command timed out after 30000ms",
        "The element is covered",
      ]) {
        expect(mod.browserFailureAdvice(output), output).toBeUndefined();
      }
    });
  });

  describe("installed agent-browser version", () => {
    /** How often `agent-browser --version` ran. */
    function versionRuns(): number {
      return execFileMock.mock.calls.filter(([, args]) => args[0] === "--version").length;
    }

    it("reads the version number agent-browser prints", async () => {
      execFileMock.mockImplementation(callbackSuccess("agent-browser 0.38.2\n"));
      const mod = await import("../agent-browser.js");

      await expect(mod.getAgentBrowserVersion()).resolves.toBe("0.38.2");
      expect(execFileMock).toHaveBeenCalledTimes(1);
      expect(execFileMock.mock.calls[0][1]).toEqual(["--version"]);
    });

    it("asks once for callers that arrive together and remembers the answer for a minute", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const startedAt = Date.now();
      execFileMock.mockImplementation(callbackSuccess("agent-browser 0.38.2\n"));
      const mod = await import("../agent-browser.js");

      await expect(Promise.all([mod.getAgentBrowserVersion(), mod.getAgentBrowserVersion()]))
        .resolves.toEqual(["0.38.2", "0.38.2"]);
      expect(versionRuns()).toBe(1);

      // An update installed in the meantime shows once the remembered answer is a minute old.
      execFileMock.mockImplementation(callbackSuccess("agent-browser 0.39.0\n"));
      vi.setSystemTime(startedAt + 59_000);
      await expect(mod.getAgentBrowserVersion()).resolves.toBe("0.38.2");
      expect(versionRuns()).toBe(1);

      vi.setSystemTime(startedAt + 60_000);
      await expect(mod.getAgentBrowserVersion()).resolves.toBe("0.39.0");
      expect(versionRuns()).toBe(2);
    });

    it.each([
      ["fails", callbackFailure({ stderr: "agent-browser 0.38.2 crashed on start" })],
      ["prints none", callbackSuccess("agent-browser (development build)\n")],
    ])("has no version when the command %s", async (_name, reply) => {
      execFileMock.mockImplementation(reply);
      const mod = await import("../agent-browser.js");

      await expect(mod.getAgentBrowserVersion()).resolves.toBeUndefined();
      expect(versionRuns()).toBe(1);
    });

    it("remembers for a minute that it could not read the version, too", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const startedAt = Date.now();
      execFileMock.mockImplementation(callbackFailure({ stderr: "agent-browser: not found" }));
      const mod = await import("../agent-browser.js");

      await expect(mod.getAgentBrowserVersion()).resolves.toBeUndefined();
      // Installed in the meantime: it shows once the remembered answer is a minute old.
      execFileMock.mockImplementation(callbackSuccess("agent-browser 0.38.2\n"));
      vi.setSystemTime(startedAt + 59_000);
      await expect(mod.getAgentBrowserVersion()).resolves.toBeUndefined();
      expect(versionRuns()).toBe(1);

      vi.setSystemTime(startedAt + 60_000);
      await expect(mod.getAgentBrowserVersion()).resolves.toBe("0.38.2");
      expect(versionRuns()).toBe(2);
    });

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

  describe("environment of a command", () => {
    beforeEach(async () => {
      // The machine the tests run on may configure its own browsers.
      for (const name of [
        "AGENT_BROWSER_ARGS",
        "AGENT_BROWSER_CONFIG",
        "AGENT_BROWSER_EXECUTABLE_PATH",
        "AGENT_BROWSER_HEADED",
        "AGENT_BROWSER_IDLE_TIMEOUT_MS",
      ]) {
        vi.stubEnv(name, undefined);
      }
      // The launch configuration is remembered for a few seconds by the module instance the
      // wrapper imports, which is this one until the next vi.resetModules().
      (await import("../browser-launch.js")).resetBrowserLaunchCachesForTests();
    });

    /** Runs one command (the default) or a shutdown and returns the environment of each agent-browser run. */
    async function commandEnvsFor(
      target: (mod: typeof import("../agent-browser.js")) => import("../agent-browser.js").BrowserTarget,
      action: "command" | "shutdown" = "command",
    ) {
      const envs: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
      execFileMock.mockImplementation((
        file: string,
        args: string[],
        options: any,
        cb: (error: unknown, result?: { stdout: string; stderr: string }) => void,
      ) => {
        // A shutdown also lists the processes of the profile; there are none.
        if (file === "ps" || file === "powershell.exe") {
          cb(null, { stdout: "", stderr: "" });
        } else {
          envs.push({ args, env: options.env });
          cb(null, { stdout: "ok", stderr: "" });
        }
        return {} as any;
      });
      const mod = await import("../agent-browser.js");
      if (action === "command") {
        await mod.ab(["get", "url"], 5_000, { browserTarget: target(mod) });
      } else {
        await mod.shutdownBridgeBrowser(target(mod));
      }
      return envs;
    }

    async function commandEnvFor(
      target: (mod: typeof import("../agent-browser.js")) => import("../agent-browser.js").BrowserTarget,
    ) {
      const envs = await commandEnvsFor(target);
      expect(envs).toHaveLength(1);
      return envs[0].env;
    }

    const publicTarget = () => ({
      sessionName: "copilot-bridge-public-1234abcd-1",
      profileDir: join(COPILOT_HOME, "browser-public", "slot-1"),
      idleTimeoutMs: 2_700_000,
      stopDaemonOnShutdown: true,
    });

    it("names the session and profile of a public browser and gives its daemon an idle limit", async () => {
      vi.stubEnv("AGENT_BROWSER_HEADED", "true");

      const env = await commandEnvFor(publicTarget);

      expect(env).toMatchObject({
        AGENT_BROWSER_NAMESPACE: "copilot-bridge",
        AGENT_BROWSER_SESSION: "copilot-bridge-public-1234abcd-1",
        AGENT_BROWSER_PROFILE: join(COPILOT_HOME, "browser-public", "slot-1"),
        AGENT_BROWSER_ARGS: BRIDGE_LAUNCH_ARGS.join("\n"),
        AGENT_BROWSER_IDLE_TIMEOUT_MS: "2700000",
      });
      // Headless unless the target says otherwise, whatever the server's own environment says.
      expect(env.AGENT_BROWSER_HEADED).toBeUndefined();
      expect(env.AGENT_BROWSER_EXECUTABLE_PATH).toBeUndefined();
    });

    it("closes a browser in the environment its commands ran in", async () => {
      vi.stubEnv("AGENT_BROWSER_ARGS", "--no-sandbox");
      const target = () => ({ ...publicTarget(), executablePath: testExecutablePath("chrome"), headed: true });

      const [command] = await commandEnvsFor(target);
      const closes = await commandEnvsFor(target, "shutdown");

      expect(closes.map((close) => close.args)).toEqual([["close", "--json"]]);
      expect(closes[0].env).toEqual(command.env);
      expect(closes[0].env).toMatchObject({
        AGENT_BROWSER_SESSION: "copilot-bridge-public-1234abcd-1",
        AGENT_BROWSER_PROFILE: join(COPILOT_HOME, "browser-public", "slot-1"),
        AGENT_BROWSER_ARGS: ["--no-sandbox", ...BRIDGE_LAUNCH_ARGS].join("\n"),
        AGENT_BROWSER_EXECUTABLE_PATH: testExecutablePath("chrome"),
        AGENT_BROWSER_IDLE_TIMEOUT_MS: "2700000",
        AGENT_BROWSER_HEADED: "true",
      });
    });
  });

  describe("shutdown of a browser that is closed after each use", () => {
    const WINDOWS_PROFILE = "C:\\Users\\test\\.copilot\\browser-public\\slot-1";
    const WINDOWS_OTHER_PROFILE = "C:\\Users\\test\\.copilot\\browser-public\\slot-12";
    const POSIX_PROFILE = "/home/test/.copilot/browser-public/slot-1";
    const POSIX_OTHER_PROFILE = "/home/test/.copilot/browser-public/slot-12";
    const SESSION = "copilot-bridge-public-1234abcd-1";

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
    });

    it("stops the daemon first, then the browser, and catches a browser started meanwhile", async () => {
      vi.stubEnv("AGENT_BROWSER_SOCKET_DIR", undefined);
      vi.stubEnv("XDG_RUNTIME_DIR", undefined);
      readdirMock.mockResolvedValue([
        "browsers",
        `${SESSION}.pid`,
        `${SESSION}.port`,
        // Another public browser of this Bridge, and one of another Bridge on the host.
        "copilot-bridge-public-1234abcd-12.pid",
        "copilot-bridge-public-9876fedc-1.pid",
        "default.pid",
      ]);
      const listings = mockFailedCloseAndListings("powershell.exe", [
        windowsListing([
          windowsDaemon(100, 1_000),
          windowsBrowser(200, 100, 2_000),
          windowsBrowser(201, 200, 2_100, WINDOWS_PROFILE, "--type=renderer "),
          windowsDaemon(300, 1_500),
          windowsBrowser(400, 300, 2_500, WINDOWS_OTHER_PROFILE),
        ]),
        // The first browser is still in the process table, and a new one has appeared.
        windowsListing([
          windowsBrowser(200, 100, 2_000),
          windowsBrowser(500, 100, 3_000),
          windowsDaemon(300, 1_500),
          windowsBrowser(400, 300, 2_500, WINDOWS_OTHER_PROFILE),
        ]),
      ]);
      const signals = recordSignals();
      const mod = await importForPlatform("win32");

      const result = await mod.shutdownBridgeBrowser({
        sessionName: SESSION,
        profileDir: WINDOWS_PROFILE,
        stopDaemonOnShutdown: true,
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
        [join(stateDirectory, `${SESSION}.pid`), { force: true }],
        [join(stateDirectory, `${SESSION}.port`), { force: true }],
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
          `  400   300 chrome          /opt/google/chrome/chrome --headless=new --user-data-dir=${POSIX_OTHER_PROFILE}`,
          "  600   555 agent-browser   agent-browser close --json",
        ].join("\n"),
        "",
      ]);
      const signals = recordSignals();
      const mod = await importForPlatform("linux");

      const result = await mod.shutdownBridgeBrowser({
        sessionName: SESSION,
        profileDir: POSIX_PROFILE,
        stopDaemonOnShutdown: true,
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
        sessionName: SESSION,
        profileDir: WINDOWS_PROFILE,
        stopDaemonOnShutdown: true,
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
