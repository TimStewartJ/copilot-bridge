import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppContext } from "../app-context.js";
import { setupTestDb } from "./helpers.js";
import { createSettingsStore } from "../settings-store.js";
import { createTelemetryStore } from "../telemetry-store.js";
import { normalizePath, testExecutablePath, testPath } from "./test-paths.js";

const { execMock, execFileMock } = vi.hoisted(() => ({
  execMock: vi.fn(),
  execFileMock: vi.fn(),
}));
const killMock = vi.spyOn(process, "kill");

vi.mock("node:child_process", () => ({
  exec: execMock,
  execFile: execFileMock,
}));

describe("browser diagnostics", () => {
  beforeEach(() => {
    vi.resetModules();
    execMock.mockReset();
    execFileMock.mockReset();
    killMock.mockReset();
    killMock.mockImplementation((() => true) as any);
    execMock.mockImplementation((_command: string, _options: any, cb: (err: any, result?: { stdout: string; stderr: string }) => void) => {
      cb(null, { stdout: "agent-browser\n", stderr: "" });
      return {} as any;
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("summarizes configured paths and recent browser_web_search challenge telemetry", async () => {
    const db = setupTestDb();
    const settingsStore = createSettingsStore(db);
    const telemetryStore = createTelemetryStore(db);
    const executablePath = testExecutablePath("chrome");
    const profileDir = testPath("browser-master-profile");
    settingsStore.updateSettings({
      browser: {
        executablePath,
        masterProfileDirectory: profileDir,
        headed: true,
      },
    });
    telemetryStore.recordSpan({
      name: "browser.tool.browser_web_search.google.failed",
      duration: 0,
      source: "server",
      metadata: { failureCode: "search.google_captcha" },
    });
    telemetryStore.recordSpan({
      name: "browser.tool.browser_web_search.duckduckgo.failed",
      duration: 0,
      source: "server",
      metadata: { failureCode: "search.ddg_challenge" },
    });
    telemetryStore.recordSpan({
      name: "browser.tool.browser_web_search.bing.failed",
      duration: 0,
      source: "server",
      metadata: { failureCode: "search.bing_captcha" },
    });

    const mod = await import("../browser-diagnostics.js");
    const result = await mod.getBrowserDiagnostics({
      settingsStore,
      telemetryStore,
      copilotHome: testPath(".copilot"),
    } as AppContext);

    expect(result.summary).toMatchObject({
      tone: "error",
      label: "Browser binary missing",
    });
    expect(result.config.executablePath).toBe(executablePath);
    expect(result.config.executablePathSource).toBe("settings");
    expect(result.config.masterProfileDirectory).toBe(profileDir);
    expect(result.config.headed).toBe(true);
    expect(result).toMatchObject({
      schemaVersion: 2,
      runtime: {
        transport: {
          kind: "cli",
          namespace: "copilot-bridge",
        },
      },
      contexts: {
        public: {
          context: "public",
          functionalProbe: { state: "not_run" },
        },
        authenticated: {
          context: "authenticated",
          profilePath: profileDir,
          headed: true,
          functionalProbe: { state: "not_run" },
        },
      },
    });
    expect(result.contexts.public.disposableProfileRoot).not.toBe(profileDir);
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "search.google_captcha", count: 1 }),
      expect.objectContaining({ code: "search.bing_captcha", count: 1 }),
      expect.objectContaining({ code: "search.ddg_challenge", count: 1 }),
    ]));
  });

  it("surfaces an inherited agent-browser executable environment override", async () => {
    vi.stubEnv("AGENT_BROWSER_EXECUTABLE_PATH", process.execPath);
    const db = setupTestDb();
    const settingsStore = createSettingsStore(db);
    const telemetryStore = createTelemetryStore(db);

    const mod = await import("../browser-diagnostics.js");
    const result = await mod.getBrowserDiagnostics({
      settingsStore,
      telemetryStore,
      copilotHome: testPath(".copilot"),
    } as AppContext);

    expect(result.config).toMatchObject({
      executablePath: process.execPath,
      executablePathSource: "environment",
      executablePathConfigured: true,
      executablePathExists: true,
      headed: false,
    });
  });

  it("closes the configured headed diagnostics browser target", async () => {
    const closeCalls: Array<{ args: string[]; env?: NodeJS.ProcessEnv }> = [];
    execFileMock.mockImplementation((_file: string, args: string[], options: any, cb: (err: any, result?: { stdout: string; stderr: string }) => void) => {
      if (args[0] === "close") {
        closeCalls.push({ args, env: options?.env });
      }
      cb(null, { stdout: "", stderr: "" });
      return {} as any;
    });
    const db = setupTestDb();
    const settingsStore = createSettingsStore(db);
    const telemetryStore = createTelemetryStore(db);
    const executablePath = testExecutablePath("chrome");
    const profileDir = testPath("browser-master-profile");
    settingsStore.updateSettings({
      browser: {
        executablePath,
        masterProfileDirectory: profileDir,
      },
    });

    const mod = await import("../browser-diagnostics.js");
    const result = await mod.closeHeadedDiagnosticsBrowser({
      settingsStore,
      telemetryStore,
      copilotHome: testPath(".copilot"),
    } as AppContext);

    expect(result).toMatchObject({
      ok: true,
      context: "authenticated",
      masterProfileDirectory: profileDir,
      executablePath,
    });
    expect(result.message).toContain("Headed browser close requested");
    expect(closeCalls).toHaveLength(1);
    expect(closeCalls[0].args).toEqual(["close", "--json"]);
    expect(closeCalls[0].env).toMatchObject({
      AGENT_BROWSER_NAMESPACE: "copilot-bridge",
      AGENT_BROWSER_PROFILE: profileDir,
      AGENT_BROWSER_EXECUTABLE_PATH: executablePath,
      AGENT_BROWSER_HEADED: "true",
    });
    expect(closeCalls[0].env?.AGENT_BROWSER_SESSION).toContain("copilot-bridge-");
  });

  it("probes public readiness without using the authenticated profile", async () => {
    const seenProfiles: string[] = [];
    execFileMock.mockImplementation((
      _file: string,
      args: string[],
      options: any,
      cb: (err: any, result?: { stdout: string; stderr: string }) => void,
    ) => {
      if (options?.env?.AGENT_BROWSER_PROFILE) {
        seenProfiles.push(options.env.AGENT_BROWSER_PROFILE);
      }
      if (args[0] === "get" && args[1] === "url") {
        cb(null, { stdout: "about:blank", stderr: "" });
      } else if (args[0] === "get" && args[1] === "title") {
        cb(null, { stdout: "New tab", stderr: "" });
      } else {
        cb(null, { stdout: "", stderr: "" });
      }
      return {} as any;
    });
    const db = setupTestDb();
    const settingsStore = createSettingsStore(db);
    const telemetryStore = createTelemetryStore(db);
    const copilotHome = testPath(".copilot-public-probe");

    const mod = await import("../browser-diagnostics.js");
    const result = await mod.probeBrowserContext({
      settingsStore,
      telemetryStore,
      copilotHome,
    } as AppContext, "public");

    expect(result).toMatchObject({
      ok: true,
      context: "public",
      state: "ready",
    });
    expect(seenProfiles.length).toBeGreaterThan(0);
    expect(seenProfiles.every((profile) => profile.includes("browser-public"))).toBe(true);
  });

  it("verifies authenticated Azure DevOps state through the broker", async () => {
    const db = setupTestDb();
    const settingsStore = createSettingsStore(db);
    const telemetryStore = createTelemetryStore(db);
    settingsStore.updateSettings({
      providers: {
        ado: {
          org: "msazure",
          project: "One",
        },
      },
    });
    let titleReads = 0;
    execFileMock.mockImplementation((
      _file: string,
      args: string[],
      _options: any,
      cb: (err: any, result?: { stdout: string; stderr: string }) => void,
    ) => {
      if (args[0] === "get" && args[1] === "url") {
        cb(null, {
          stdout: args.includes("--json")
            ? "https://msazure.visualstudio.com/One/_workitems/assignedtome/"
            : "about:blank",
          stderr: "",
        });
      } else if (args[0] === "get" && args[1] === "title") {
        titleReads += 1;
        cb(null, {
          stdout: titleReads < 3 ? "" : "Work items - Boards",
          stderr: "",
        });
      } else {
        cb(null, { stdout: "opened", stderr: "" });
      }
      return {} as any;
    });

    const mod = await import("../browser-diagnostics.js");
    const result = await mod.checkAdoBrowserAuthentication({
      settingsStore,
      telemetryStore,
      copilotHome: testPath(".copilot-ado-auth"),
    } as AppContext);

    expect(result).toMatchObject({
      service: "ado",
      state: "verified",
      finalOrigin: "https://msazure.visualstudio.com",
      expectedOrigin: "https://msazure.visualstudio.com",
    });
    expect(titleReads).toBeGreaterThanOrEqual(3);
  });

  it("fails headed diagnostics close when agent-browser close fails or profile-bound PIDs remain", async () => {
    const profileDir = testPath("browser-master-profile");

    // Case 1: agent-browser close fails
    {
      const db = setupTestDb();
      const settingsStore = createSettingsStore(db);
      const telemetryStore = createTelemetryStore(db);
      settingsStore.updateSettings({ browser: { masterProfileDirectory: profileDir } });
      execFileMock.mockImplementation((file: string, args: string[], _options: any, cb: (err: any, result?: { stdout: string; stderr: string }) => void) => {
        if (args[0] === "close") {
          cb({ stderr: `timed out closing ${profileDir}` });
          return {} as any;
        }
        if (file === "ps" || file === "powershell.exe") {
          cb(null, { stdout: "", stderr: "" });
          return {} as any;
        }
        throw new Error(`Unexpected execFile command: ${file}`);
      });

      const mod = await import("../browser-diagnostics.js");
      await expect(mod.closeHeadedDiagnosticsBrowser({
        settingsStore,
        telemetryStore,
        copilotHome: testPath(".copilot"),
      } as AppContext)).rejects.toMatchObject({
        name: "BrowserHeadedCloseError",
        message: expect.stringContaining("agent-browser close failed (launch.timeout)"),
        details: expect.objectContaining({
          failureCode: "launch.timeout",
          closeFailureCode: "launch.timeout",
          remainingPids: [],
        }),
      });
      const closeSpans = telemetryStore.querySpans({ name: "browser.tool.browser_diagnostics_close_headed", limit: 1 });
      expect(closeSpans[0]?.metadata, "close fails telemetry").toMatchObject({
        success: false,
        failureCode: "launch.timeout",
        closeFailureCode: "launch.timeout",
        remainingPids: [],
      });
    }

    // Case 2: close succeeds but profile-bound PIDs remain
    {
      const db = setupTestDb();
      const settingsStore = createSettingsStore(db);
      const telemetryStore = createTelemetryStore(db);
      settingsStore.updateSettings({ browser: { masterProfileDirectory: profileDir } });
      execFileMock.mockImplementation((file: string, args: string[], _options: any, cb: (err: any, result?: { stdout: string; stderr: string }) => void) => {
        if (args[0] === "close") {
          cb(null, { stdout: "", stderr: "" });
          return {} as any;
        }
        if (file === "powershell.exe") {
          cb(null, {
            stdout: JSON.stringify({
              ProcessId: 4242,
              Name: "chrome.exe",
              CommandLine: `"chrome.exe" --user-data-dir="${profileDir}"`,
            }),
            stderr: "",
          });
          return {} as any;
        }
        if (file === "ps") {
          cb(null, { stdout: `4242 chrome chrome --user-data-dir=${normalizePath(profileDir)}`, stderr: "" });
          return {} as any;
        }
        throw new Error(`Unexpected execFile command: ${file}`);
      });
      killMock.mockImplementation(((pid: number, signal?: number | NodeJS.Signals) => {
        if (pid !== 4242) throw Object.assign(new Error("unexpected pid"), { code: "ESRCH" });
        if (signal === "SIGKILL") throw Object.assign(new Error("permission denied"), { code: "EPERM" });
        return true as never;
      }) as any);

      const mod = await import("../browser-diagnostics.js");
      await expect(mod.closeHeadedDiagnosticsBrowser({
        settingsStore,
        telemetryStore,
        copilotHome: testPath(".copilot"),
      } as AppContext)).rejects.toMatchObject({
        name: "BrowserHeadedCloseError",
        message: expect.stringContaining("remaining profile-bound browser process PIDs: 4242"),
        details: expect.objectContaining({
          failureCode: "profile_processes_remaining",
          remainingPids: [4242],
        }),
      });
      const closeSpans = telemetryStore.querySpans({ name: "browser.tool.browser_diagnostics_close_headed", limit: 1 });
      expect(closeSpans[0]?.metadata, "pids remain telemetry").toMatchObject({
        success: false,
        failureCode: "profile_processes_remaining",
        remainingPids: [4242],
      });
    }
  });
});
