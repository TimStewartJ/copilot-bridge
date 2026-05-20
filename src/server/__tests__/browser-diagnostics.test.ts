import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppContext } from "../app-context.js";
import { setupTestDb } from "./helpers.js";
import { createSettingsStore } from "../settings-store.js";
import { createTelemetryStore } from "../telemetry-store.js";
import { testExecutablePath, testPath } from "./test-paths.js";

const { execMock, execFileMock } = vi.hoisted(() => ({
  execMock: vi.fn(),
  execFileMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({
  exec: execMock,
  execFile: execFileMock,
}));

describe("browser diagnostics", () => {
  beforeEach(() => {
    vi.resetModules();
    execMock.mockReset();
    execFileMock.mockReset();
    execMock.mockImplementation((_command: string, _options: any, cb: (err: any, result?: { stdout: string; stderr: string }) => void) => {
      cb(null, { stdout: "agent-browser\n", stderr: "" });
      return {} as any;
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("summarizes configured paths and recent web_search challenge telemetry", async () => {
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
      name: "browser.tool.web_search.google.failed",
      duration: 0,
      source: "server",
      metadata: { failureCode: "search.google_captcha" },
    });
    telemetryStore.recordSpan({
      name: "browser.tool.web_search.duckduckgo.failed",
      duration: 0,
      source: "server",
      metadata: { failureCode: "search.ddg_challenge" },
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
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "search.google_captcha", count: 1 }),
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
      masterProfileDirectory: profileDir,
      executablePath,
    });
    expect(result.message).toContain("Headed browser close requested");
    expect(closeCalls).toHaveLength(1);
    expect(closeCalls[0].args).toEqual(["close"]);
    expect(closeCalls[0].env).toMatchObject({
      AGENT_BROWSER_PROFILE: profileDir,
      AGENT_BROWSER_EXECUTABLE_PATH: executablePath,
      AGENT_BROWSER_HEADED: "true",
    });
    expect(closeCalls[0].env?.AGENT_BROWSER_SESSION).toContain("copilot-bridge-");
  });
});
