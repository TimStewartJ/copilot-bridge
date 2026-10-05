import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppContext } from "../app-context.js";
import { makeTestDir, setupTestDb } from "./helpers.js";
import { createSettingsStore } from "../settings-store.js";
import { createTelemetryStore } from "../telemetry-store.js";
import { normalizePath, pathBasename, testExecutablePath, testPath, testWindowsPath } from "./test-paths.js";

const { execMock, execFileMock } = vi.hoisted(() => ({
  execMock: vi.fn(),
  execFileMock: vi.fn(),
}));
const killMock = vi.spyOn(process, "kill");

vi.mock("node:child_process", () => ({
  exec: execMock,
  execFile: execFileMock,
}));

// src/test-support/vitest-setup.ts replaces the host lookups of browser-launch for every test
// file. This file replaces them again with mocks a test can steer.
const isExecutableFile = vi.fn<(file: string) => Promise<boolean>>();
const readJsonFile = vi.fn<(file: string) => Promise<unknown>>();
const readModifiedAt = vi.fn<(file: string) => Promise<number | undefined>>();
const readBrowserVersion = vi.fn<(file: string) => Promise<string | undefined>>();

const BLINK_DEFAULT = "--disable-blink-features=AutomationControlled";
const SWIFTSHADER = "--enable-unsafe-swiftshader";
const BLANK = "about:blank";
const DAY_MS = 86_400_000;

type ExecFileCallback = (err: unknown, result?: { stdout: string; stderr: string }) => void;
interface SeenCommand {
  file: string;
  args: string[];
  env?: NodeJS.ProcessEnv;
}
type CommandAnswer = { stdout?: string; stderr?: string } | { fail: { stdout?: string; stderr?: string } };

/** What `agent-browser --version` prints. Undefined makes the command fail. */
let agentBrowserVersionOutput: string | undefined;

/**
 * Answers every command the browser layer runs: a mocked process that is never answered leaves
 * its caller waiting for good. `respond` decides the commands a test cares about; the rest get
 * the version, or empty output, which reads as "closed", "no processes" and "nothing to say".
 */
function answerCommands(respond: (command: SeenCommand) => CommandAnswer | undefined = () => undefined): SeenCommand[] {
  const seen: SeenCommand[] = [];
  execFileMock.mockImplementation((file: string, args: string[], options: any, cb: ExecFileCallback) => {
    const command = { file, args, env: options?.env };
    seen.push(command);
    // Matched by its arguments: on Windows the executable is a resolved path or goes through a shell.
    const answer = respond(command) ?? (args[0] === "--version"
      ? agentBrowserVersionOutput === undefined
        ? { fail: { stderr: "agent-browser: not found" } }
        : { stdout: `${agentBrowserVersionOutput}\n` }
      : {});
    if ("fail" in answer) {
      cb(Object.assign(new Error("Command failed"), { stdout: answer.fail.stdout ?? "", stderr: answer.fail.stderr ?? "" }));
    } else {
      cb(null, { stdout: answer.stdout ?? "", stderr: answer.stderr ?? "" });
    }
    return {} as any;
  });
  return seen;
}

function createContext(options: { copilotHome?: string } = {}) {
  const db = setupTestDb();
  const settingsStore = createSettingsStore(db);
  const telemetryStore = createTelemetryStore(db);
  const copilotHome = options.copilotHome ?? path.join(makeTestDir("browser-diagnostics"), ".copilot");
  const ctx = { settingsStore, telemetryStore, copilotHome } as AppContext;
  return { ctx, settingsStore, telemetryStore, copilotHome };
}

/** A path with no browser name in it, whatever the host's temp or home directory is called. */
function neutralBinary(name: string): string {
  return path.join(path.sep, "srv", "acme", name);
}

/**
 * Runs work that waits on production retry delays without spending them: the delays run on fake
 * timers, and each round also yields to the real event loop for the file I/O in between. Ends
 * with the work, or with the test (`signal`) when the work never ends.
 */
async function settleThroughDelays<T>(signal: AbortSignal, start: () => Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    let settled = false;
    const work = start().finally(() => {
      settled = true;
    });
    work.catch(() => undefined);
    while (!settled && !signal.aborted) {
      await vi.advanceTimersByTimeAsync(2_000);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    signal.throwIfAborted();
    return await work;
  } finally {
    vi.useRealTimers();
  }
}

describe("browser diagnostics", () => {
  beforeEach(async () => {
    execMock.mockReset();
    execFileMock.mockReset();
    killMock.mockReset();
    killMock.mockImplementation((() => true) as any);
    // `which agent-browser` / `where.exe agent-browser`.
    execMock.mockImplementation((_command: string, _options: any, cb: (err: any, result?: { stdout: string; stderr: string }) => void) => {
      cb(null, { stdout: "agent-browser\n", stderr: "" });
      return {} as any;
    });
    agentBrowserVersionOutput = "agent-browser 0.38.2";
    answerCommands();

    // The machine running the tests may configure its own browser.
    vi.stubEnv("AGENT_BROWSER_EXECUTABLE_PATH", undefined);
    vi.stubEnv("AGENT_BROWSER_ARGS", undefined);
    vi.stubEnv("AGENT_BROWSER_CONFIG", undefined);

    isExecutableFile.mockReset().mockResolvedValue(false);
    readJsonFile.mockReset().mockResolvedValue(undefined);
    readModifiedAt.mockReset().mockResolvedValue(undefined);
    readBrowserVersion.mockReset().mockResolvedValue(undefined);
    vi.doMock("../browser-launch-host.js", () => ({
      isExecutableFile,
      readJsonFile,
      readModifiedAt,
      readBrowserVersion,
    }));
    // Every test imports the modules fresh, so none sees another's cached version or launch setup.
    vi.resetModules();
    (await import("../browser-launch.js")).resetBrowserLaunchCachesForTests();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("summarizes configured paths and recent browser_web_search challenge telemetry", async () => {
    const { ctx, settingsStore, telemetryStore, copilotHome } = createContext({ copilotHome: testPath(".copilot") });
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
    const result = await mod.getBrowserDiagnostics(ctx);

    expect(result.summary).toMatchObject({
      tone: "error",
      label: "Browser binary missing",
    });
    expect(result.config.executablePath).toBe(executablePath);
    expect(result.config.executablePathSource).toBe("settings");
    expect(result.config.masterProfileDirectory).toBe(profileDir);
    expect(result.config.headed).toBe(true);
    expect(result).toMatchObject({
      schemaVersion: 3,
      windowHours: 24,
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
    expect(result.contexts.public.profileRoot).toBe(path.join(copilotHome, "browser-public"));
    expect(result.contexts.public.profileRoot).not.toBe(profileDir);
    expect(result.contexts.public).not.toHaveProperty("disposableProfileRoot");
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "search.google_captcha", count: 1 }),
      expect.objectContaining({ code: "search.bing_captcha", count: 1 }),
      expect.objectContaining({ code: "search.ddg_challenge", count: 1 }),
    ]));
  });

  it("surfaces an inherited agent-browser executable environment override", async () => {
    vi.stubEnv("AGENT_BROWSER_EXECUTABLE_PATH", process.execPath);
    const { ctx } = createContext({ copilotHome: testPath(".copilot") });

    const mod = await import("../browser-diagnostics.js");
    const result = await mod.getBrowserDiagnostics(ctx);

    expect(result.config).toMatchObject({
      executablePath: process.execPath,
      executablePathSource: "environment",
      executablePathConfigured: true,
      executablePathExists: true,
      headed: false,
    });
  });

  describe("browser executable and build", () => {
    it("prefers the Settings path over the environment and describes that browser", async () => {
      const executablePath = neutralBinary("browser");
      vi.stubEnv("AGENT_BROWSER_EXECUTABLE_PATH", neutralBinary("from-environment"));
      isExecutableFile.mockResolvedValue(true);
      readModifiedAt.mockImplementation(async () => Date.now() - 40.5 * DAY_MS);
      readBrowserVersion.mockResolvedValue("Microsoft Edge 141.0.3537.71");
      const { ctx, settingsStore } = createContext();
      settingsStore.updateSettings({ browser: { executablePath } });

      const { getBrowserDiagnostics } = await import("../browser-diagnostics.js");
      const result = await getBrowserDiagnostics(ctx);

      expect(result.config).toMatchObject({
        executablePath,
        executablePathSource: "settings",
        executablePathConfigured: true,
        executablePathExists: false,
      });
      expect(result.config.browser).toEqual({
        kind: "edge",
        version: "Microsoft Edge 141.0.3537.71",
        installedDaysAgo: 40,
      });
      expect(readModifiedAt).toHaveBeenCalledWith(executablePath);
      expect(readBrowserVersion).toHaveBeenCalledWith(executablePath);
      expect(result.summary.label).toBe("Browser binary missing");
    });

    it("uses the system's own browser when none is configured, without calling it configured", async () => {
      // Windows looks under these folders; the other platforms have fixed candidates.
      vi.stubEnv("ProgramFiles", testWindowsPath("Program Files"));
      const launch = await import("../browser-launch.js");
      const [systemBrowser] = launch.systemBrowserCandidates(os.platform(), process.env);
      expect(systemBrowser).toBeTruthy();
      isExecutableFile.mockImplementation(async (file) => file === systemBrowser);
      readModifiedAt.mockImplementation(async () => Date.now() - 3.5 * DAY_MS);
      readBrowserVersion.mockResolvedValue("Google Chrome 154.0.8037.97");
      const { ctx } = createContext();

      const { getBrowserDiagnostics } = await import("../browser-diagnostics.js");
      const result = await getBrowserDiagnostics(ctx);

      expect(result.config).toMatchObject({
        executablePath: systemBrowser,
        executablePathSource: "system",
        executablePathConfigured: false,
      });
      // Only a configured path is checked on disk and reported as missing.
      expect(result.config.executablePathExists).toBeUndefined();
      expect(result.summary.label).not.toBe("Browser binary missing");
      expect(result.config.browser).toEqual({
        kind: "chrome",
        version: "Google Chrome 154.0.8037.97",
        installedDaysAgo: 3,
      });
    });

    it("leaves the choice to agent-browser when there is no browser to find", async () => {
      const { ctx } = createContext();

      const { getBrowserDiagnostics } = await import("../browser-diagnostics.js");
      const result = await getBrowserDiagnostics(ctx);

      expect(result.config).toMatchObject({
        executablePathSource: "auto-detect",
        executablePathConfigured: false,
      });
      expect(result.config.executablePath).toBeUndefined();
      expect(result.config.executablePathExists).toBeUndefined();
      // agent-browser then runs the Chrome for Testing it downloaded.
      expect(result.config.browser).toEqual({ kind: "chrome-for-testing" });
      expect(readModifiedAt).not.toHaveBeenCalled();
      expect(readBrowserVersion).not.toHaveBeenCalled();
    });
  });

  describe("launch arguments", () => {
    it("shows the arguments inherited from AGENT_BROWSER_ARGS", async () => {
      vi.stubEnv("AGENT_BROWSER_ARGS", "--no-sandbox,--lang=en-US");
      // The environment replaces agent-browser's configuration file, as it does in agent-browser.
      readJsonFile.mockResolvedValue({ args: ["--from-config"] });
      const { ctx } = createContext();

      const { getBrowserDiagnostics } = await import("../browser-diagnostics.js");
      const result = await getBrowserDiagnostics(ctx);

      expect(result.config.launch).toEqual({
        args: ["--no-sandbox", "--lang=en-US", BLINK_DEFAULT, SWIFTSHADER, BLANK],
        inheritedFrom: "environment",
      });
    });

  });

  describe("agent-browser version", () => {
    it.each([
      { name: "the version agent-browser prints", output: "agent-browser 0.38.2", version: "0.38.2" },
      { name: "no version when the version command fails", output: undefined, version: undefined },
      { name: "no version when the output holds none", output: "agent-browser (development build)", version: undefined },
    ])("reports $name", async ({ output, version }) => {
      agentBrowserVersionOutput = output;
      const { ctx } = createContext();

      const { getBrowserDiagnostics } = await import("../browser-diagnostics.js");
      const result = await getBrowserDiagnostics(ctx);

      expect(result.config.agentBrowserVersion).toBe(version);
      // Knowing the version is not what makes agent-browser count as installed.
      expect(result.agentBrowserInstalled).toBe(true);
    });
  });

  describe("live view", () => {
    /** Answers the readiness handshake of a probe; everything else, the stream included, says nothing. */
    function answerReadiness(): SeenCommand[] {
      return answerCommands(({ args }) => {
        if (args[0] === "get" && args[1] === "url") return { stdout: "about:blank" };
        if (args[0] === "get" && args[1] === "title") return { stdout: "New tab" };
        return undefined;
      });
    }

    it("reports nothing until a live view was checked, and then what the check found", async () => {
      const { ctx } = createContext();
      const { getBrowserDiagnostics } = await import("../browser-diagnostics.js");
      const { getBrowserRuntime } = await import("../browser-runtime.js");

      expect((await getBrowserDiagnostics(ctx)).config).not.toHaveProperty("liveView");

      const check = { ok: true, checkedAt: "2026-03-10T12:00:00.000Z" };
      vi.spyOn(getBrowserRuntime(ctx).live, "getLastCheck").mockReturnValue(check);

      expect((await getBrowserDiagnostics(ctx)).config.liveView).toEqual(check);
    });

    it("checks the live view in the browser of the public probe, and reports a failure without failing the probe", async () => {
      const seen = answerReadiness();
      const { ctx, copilotHome } = createContext();
      const mod = await import("../browser-diagnostics.js");

      const probe = await mod.probeBrowserContext(ctx, "public");

      // The browser itself works; that it cannot be shown is a finding of its own.
      expect(probe).toMatchObject({ ok: true, context: "public", state: "ready" });
      const streamCommands = seen.filter((command) => command.args[0] === "stream");
      expect(streamCommands.length).toBeGreaterThan(0);
      expect(streamCommands.every((command) =>
        command.env?.AGENT_BROWSER_PROFILE === path.join(copilotHome, "browser-public", "slot-1"))).toBe(true);
      const { liveView } = (await mod.getBrowserDiagnostics(ctx)).config;
      expect(liveView).toMatchObject({ ok: false, message: expect.any(String) });
      expect(liveView?.message).not.toBe("");
      expect(Number.isNaN(Date.parse(liveView?.checkedAt ?? ""))).toBe(false);
    });

    it("does not check the live view in the authenticated probe", async () => {
      const seen = answerReadiness();
      const { ctx } = createContext();
      const mod = await import("../browser-diagnostics.js");

      const probe = await mod.probeBrowserContext(ctx, "authenticated");

      expect(probe).toMatchObject({ ok: true, context: "authenticated", state: "ready" });
      expect(seen.filter((command) => command.args[0] === "stream")).toEqual([]);
      expect((await mod.getBrowserDiagnostics(ctx)).config).not.toHaveProperty("liveView");
    });
  });

  describe("public profiles", () => {
    function seedPublicProfiles(copilotHome: string): string {
      const profileRoot = path.join(copilotHome, "browser-public");
      for (const slot of ["slot-1", "slot-2", "slot-3"]) {
        mkdirSync(path.join(profileRoot, slot), { recursive: true });
        writeFileSync(path.join(profileRoot, slot, "Cookies"), slot);
      }
      // Neither is a public profile: a throwaway profile of an earlier version, and a stray file.
      mkdirSync(path.join(profileRoot, "profile-0b1c2d3e"), { recursive: true });
      writeFileSync(path.join(profileRoot, "slot-9"), "");
      return profileRoot;
    }

    it("counts the profiles on disk and the ones a browser is using", async () => {
      const { ctx, copilotHome } = createContext();
      const profileRoot = seedPublicProfiles(copilotHome);
      const { getBrowserDiagnostics } = await import("../browser-diagnostics.js");
      const { getBrowserRuntime } = await import("../browser-runtime.js");
      const broker = getBrowserRuntime(ctx).broker;

      expect((await getBrowserDiagnostics(ctx)).contexts.public).toMatchObject({
        context: "public",
        profileRoot,
        profiles: 3,
        profilesInUse: 0,
        concurrencyLimit: 5,
      });

      const lease = await broker.createSessionTarget("public");
      expect(lease.browserTarget.profileDir).toBe(path.join(profileRoot, "slot-1"));
      expect((await getBrowserDiagnostics(ctx)).contexts.public).toMatchObject({ profiles: 3, profilesInUse: 1 });

      await broker.disposeSessionTarget(lease, { toolName: "test", browserOpId: "op-1" });
      // The profile stays for the next browser.
      expect((await getBrowserDiagnostics(ctx)).contexts.public).toMatchObject({ profiles: 3, profilesInUse: 0 });
    });

    it("still answers, with no profiles counted, when their folder cannot be read", async () => {
      const { ctx, copilotHome } = createContext();
      // A file where the folder belongs.
      mkdirSync(copilotHome, { recursive: true });
      writeFileSync(path.join(copilotHome, "browser-public"), "");

      const { getBrowserDiagnostics } = await import("../browser-diagnostics.js");
      const result = await getBrowserDiagnostics(ctx);

      expect(result.contexts.public).toMatchObject({
        context: "public",
        profileRoot: path.join(copilotHome, "browser-public"),
        profiles: 0,
        profilesInUse: 0,
      });
      expect(result.config.agentBrowserVersion).toBe("0.38.2");
    });

    it("resets the public profiles nothing is using and leaves the authenticated profile alone", async () => {
      const seen = answerCommands();
      const { ctx, copilotHome } = createContext();
      const profileRoot = seedPublicProfiles(copilotHome);
      const authenticatedCookies = path.join(copilotHome, "browser-profile", "Cookies");
      mkdirSync(path.dirname(authenticatedCookies), { recursive: true });
      writeFileSync(authenticatedCookies, "signed in");
      const mod = await import("../browser-diagnostics.js");
      const { getBrowserRuntime } = await import("../browser-runtime.js");
      const broker = getBrowserRuntime(ctx).broker;
      expect(broker.getAuthenticatedTarget().profileDir).toBe(path.dirname(authenticatedCookies));
      const lease = await broker.createSessionTarget("public");

      await expect(mod.resetPublicBrowserProfiles(ctx)).resolves.toEqual({ ok: true, cleared: 2, inUse: 1 });

      expect(existsSync(path.join(profileRoot, "slot-1", "Cookies"))).toBe(true);
      expect(existsSync(path.join(profileRoot, "slot-2"))).toBe(false);
      expect(existsSync(path.join(profileRoot, "slot-3"))).toBe(false);
      expect(existsSync(authenticatedCookies)).toBe(true);
      // Only public browsers were closed on the way.
      const profiles = seen.flatMap((command) => command.env?.AGENT_BROWSER_PROFILE ?? []);
      expect(profiles.length).toBeGreaterThan(0);
      expect(profiles.every((profile) => path.dirname(profile) === profileRoot)).toBe(true);
      expect((await mod.getBrowserDiagnostics(ctx)).contexts.public).toMatchObject({ profiles: 1, profilesInUse: 1 });

      await broker.disposeSessionTarget(lease, { toolName: "test", browserOpId: "op-1" });
      await expect(mod.resetPublicBrowserProfiles(ctx)).resolves.toEqual({ ok: true, cleared: 1, inUse: 0 });
      expect(existsSync(path.join(profileRoot, "slot-1"))).toBe(false);
      await expect(mod.resetPublicBrowserProfiles(ctx)).resolves.toEqual({ ok: true, cleared: 0, inUse: 0 });
      expect(existsSync(authenticatedCookies)).toBe(true);
    });
  });

  describe("issues", () => {
    it("lists none when nothing went wrong", async () => {
      const { ctx } = createContext();

      const { getBrowserDiagnostics } = await import("../browser-diagnostics.js");
      const result = await getBrowserDiagnostics(ctx);

      expect(result.issues).toEqual([]);
      expect(result.summary).toMatchObject({ tone: "warning", label: "Functional check required" });
    });

    it("counts each kind of failure from its own telemetry and ignores what is not a failure", async () => {
      const { ctx, telemetryStore } = createContext();
      const record = (name: string, metadata: Record<string, unknown>, times = 1) => {
        for (let index = 0; index < times; index++) {
          telemetryStore.recordSpan({ name, duration: 0, source: "server", metadata });
        }
      };
      record("browser.tool.browser_web_search.google.failed", { failureCode: "search.google_captcha" }, 2);
      record("browser.tool.browser_web_search.google.failed", { failureCode: "search.no_results" });
      record("browser.tool.browser_web_search.bing.failed", { failureCode: "search.bing_captcha" });
      record("browser.tool.browser_web_search.duckduckgo.failed", { failureCode: "search.ddg_challenge" }, 3);
      record("browser.recovery.detected", { signature: "DevToolsActivePort" }, 2);
      record("browser.broker.readiness", { success: false, browserContext: "public" });
      record("browser.broker.readiness", { success: true, browserContext: "public" }, 4);
      // What a client reports under the same name is not the server's own observation.
      telemetryStore.recordSpan({ name: "browser.recovery.detected", duration: 0, source: "client" });

      const { getBrowserDiagnostics } = await import("../browser-diagnostics.js");
      const result = await getBrowserDiagnostics(ctx);

      expect(result.issues.map(({ code, label, count }) => ({ code, label, count }))).toEqual([
        { code: "search.google_captcha", label: "Google CAPTCHA during browser_web_search", count: 2 },
        { code: "search.bing_captcha", label: "Bing CAPTCHA during browser_web_search", count: 1 },
        { code: "search.ddg_challenge", label: "DuckDuckGo challenge during browser_web_search", count: 3 },
        { code: "browser.recovery.detected", label: "Browser recovery path invoked", count: 2 },
        { code: "browser.broker.readiness.failed", label: "Browser context readiness failed", count: 1 },
      ]);
      for (const issue of result.issues) {
        expect(Number.isNaN(Date.parse(issue.latestAt ?? ""))).toBe(false);
      }
      expect(result.summary).toMatchObject({ tone: "warning", label: "Search challenges detected" });
      // All three engines' challenges together, and the window they were counted in.
      expect(result.summary.detail).toMatch(/\b6\b.*\b24 hours\b/);
    });

    it("says so when recovery was the only trouble", async () => {
      const { ctx, telemetryStore } = createContext();
      telemetryStore.recordSpan({ name: "browser.recovery.detected", duration: 0, source: "server" });

      const { getBrowserDiagnostics } = await import("../browser-diagnostics.js");
      const result = await getBrowserDiagnostics(ctx);

      expect(result.summary).toMatchObject({ tone: "warning", label: "Browser recovery used" });
    });

    it("groups blocked pages by the product that blocked them, or by site when none was recognised", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const now = new Date("2026-03-10T12:00:00.000Z").getTime();
      const { ctx, telemetryStore } = createContext();
      const hoursAgo = (hours: number) => new Date(now - hours * 3_600_000);
      const recordBlock = (hours: number, metadata: Record<string, unknown>, source: "server" | "client" = "server") => {
        vi.setSystemTime(hoursAgo(hours));
        telemetryStore.recordSpan({ name: "browser.page.blocked", duration: 0, source, metadata });
      };
      // Outside the 24 hours the page looks back.
      recordBlock(30, { kind: "challenge", by: "DataDome", urlHost: "old.example.test" });
      recordBlock(25, { kind: "challenge", by: "Cloudflare", urlHost: "shop.example.test" });
      recordBlock(10, { kind: "denied", by: "This site", status: 403, urlHost: "api.example.test" });
      recordBlock(9, { kind: "denied", by: "This site", status: 403, urlHost: "api.example.test" });
      recordBlock(8, { kind: "challenge", by: "Cloudflare", status: 403, urlHost: "shop.example.test" });
      recordBlock(7, { kind: "challenge", by: "HUMAN Security", urlHost: "tickets.example.test" });
      recordBlock(6, { kind: "denied", by: "Cloudflare", status: 403, urlHost: "news.example.test" });
      recordBlock(5, { kind: "challenge", by: "This site", urlHost: "forum.example.test" });
      recordBlock(4, { kind: "challenge", by: "Cloudflare", urlHost: "shop.example.test" });
      recordBlock(3, { kind: "denied", by: "This site" });
      // A CAPTCHA inside a page that otherwise works did not turn the browser away.
      recordBlock(3, { kind: "captcha", by: "reCAPTCHA", urlHost: "forms.example.test" });
      recordBlock(2, { kind: "captcha", by: "Cloudflare", urlHost: "forms.example.test" });
      // Nothing says who blocked it, or it is not the server's own observation.
      recordBlock(1, { kind: "challenge" });
      recordBlock(1, { kind: "challenge", by: "Akamai" }, "client");
      vi.setSystemTime(now);

      const { getBrowserDiagnostics } = await import("../browser-diagnostics.js");
      const result = await getBrowserDiagnostics(ctx);

      // Most frequent first: a product across every site it protects, a site by its host.
      expect(result.issues.slice(0, 2)).toEqual([
        {
          code: "page.blocked.cloudflare",
          label: "Blocked by Cloudflare",
          count: 3,
          latestAt: hoursAgo(4).toISOString(),
        },
        {
          code: "page.blocked.api.example.test",
          label: "Blocked by api.example.test",
          count: 2,
          latestAt: hoursAgo(9).toISOString(),
        },
      ]);
      expect(result.issues.slice(2).map(({ label, count }) => ({ label, count }))
        .sort((a, b) => a.label.localeCompare(b.label))).toEqual([
        { label: "Blocked by an unknown site", count: 1 },
        { label: "Blocked by forum.example.test", count: 1 },
        { label: "Blocked by HUMAN Security", count: 1 },
      ]);
      // Blocked pages are listed; they do not change the verdict on the browser itself.
      expect(result.summary.label).toBe("Functional check required");
    });

    it("lists blocked pages after the browser's own issues", async () => {
      const { ctx, telemetryStore } = createContext();
      telemetryStore.recordSpan({
        name: "browser.page.blocked",
        duration: 0,
        source: "server",
        metadata: { kind: "challenge", by: "AWS WAF" },
      });
      telemetryStore.recordSpan({ name: "browser.recovery.detected", duration: 0, source: "server" });

      const { getBrowserDiagnostics } = await import("../browser-diagnostics.js");
      const result = await getBrowserDiagnostics(ctx);

      expect(result.issues.map((issue) => issue.code)).toEqual(["browser.recovery.detected", "page.blocked.aws_waf"]);
    });

    it("tells what to do when the host refuses Chrome its sandbox", async ({ signal }) => {
      const refusal = "Chrome exited early (exit code: 133) without writing DevToolsActivePort: "
        + "FATAL:zygote_host_impl_linux.cc No usable sandbox! If you are running on Ubuntu 23.10+ ...";
      answerCommands(({ args }) => (args[0] === "get"
        ? { fail: { stdout: JSON.stringify({ success: false, data: null, error: refusal }) } }
        : undefined));
      const { ctx, telemetryStore } = createContext();
      const mod = await import("../browser-diagnostics.js");

      const probe = await settleThroughDelays(signal, () => mod.probeBrowserContext(ctx, "public"));

      expect(probe).toMatchObject({ ok: false, context: "public", state: "unavailable" });
      expect(probe.message).toContain("Chrome cannot use its sandbox on this host");
      expect(probe.message).toContain("--no-sandbox");
      expect(probe.message).toContain("AGENT_BROWSER_ARGS");
      expect(probe.message).not.toContain("DevToolsActivePort");
      // The profile is not at fault, so nothing is killed or cleared to recover it.
      expect(telemetryStore.querySpans({ name: "browser.recovery.detected" })).toEqual([]);
      expect(killMock).not.toHaveBeenCalled();

      const result = await mod.getBrowserDiagnostics(ctx);
      expect(result.summary).toMatchObject({ tone: "error", label: "Browser unavailable" });
      expect(result.runtime.transport.state).toBe("unavailable");
      expect(result.contexts.public).toMatchObject({
        state: "unavailable",
        profilesInUse: 0,
        functionalProbe: { state: "failed", checkedAt: probe.checkedAt, message: probe.message },
      });
      expect(result.issues.map(({ code, label, count }) => ({ code, label, count }))).toEqual([
        { code: "browser.broker.readiness.failed", label: "Browser context readiness failed", count: 1 },
      ]);
    });

    it("replaces a public profile on which the browser no longer starts, and passes the probe", async ({ signal }) => {
      const { ctx, copilotHome } = createContext();
      const profileRoot = path.join(copilotHome, "browser-public");
      mkdirSync(path.join(profileRoot, "slot-1"), { recursive: true });
      writeFileSync(path.join(profileRoot, "slot-1", "Preferences"), "{ broken");
      const seen = answerCommands(({ args, env }) => (args[0] === "get" && pathBasename(env?.AGENT_BROWSER_PROFILE ?? "") === "slot-1"
        ? { fail: { stdout: JSON.stringify({ success: false, data: null, error: "The browser closed before it answered" }) } }
        : undefined));
      const mod = await import("../browser-diagnostics.js");

      const probe = await settleThroughDelays(signal, () => mod.probeBrowserContext(ctx, "public"));

      expect(probe).toMatchObject({ ok: true, context: "public", state: "ready" });
      expect(probe).not.toHaveProperty("message");
      const startedOn = seen.filter((command) => command.args[0] === "get")
        .map((command) => pathBasename(command.env?.AGENT_BROWSER_PROFILE ?? ""));
      expect([...new Set(startedOn)]).toEqual(["slot-1", "slot-2"]);
      // The profile that was in the way is gone; the one the browser started on stays.
      expect(existsSync(path.join(profileRoot, "slot-1"))).toBe(false);
      expect(existsSync(path.join(profileRoot, "slot-2"))).toBe(true);

      const result = await mod.getBrowserDiagnostics(ctx);
      expect(result.contexts.public).toMatchObject({
        state: "ready",
        profiles: 1,
        profilesInUse: 0,
        functionalProbe: { state: "passed", checkedAt: probe.checkedAt },
      });
      // What went wrong on the way is still listed.
      expect(result.issues.map(({ code, count }) => ({ code, count }))).toEqual([
        { code: "browser.broker.readiness.failed", count: 1 },
      ]);
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
    // The probe creates the public profile it runs in.
    const copilotHome = path.join(makeTestDir("browser-diagnostics-probe"), ".copilot");

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
    // A public browser runs in a numbered profile that is kept for the next one.
    expect(new Set(seenProfiles.map(pathBasename))).toEqual(new Set(["slot-1"]));
    expect(existsSync(path.join(copilotHome, "browser-public", "slot-1"))).toBe(true);
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
          cb(null, { stdout: `4242 1 chrome chrome --user-data-dir=${normalizePath(profileDir)}`, stderr: "" });
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
    }
  });
});
