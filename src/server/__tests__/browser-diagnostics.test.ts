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
const FAILED_READINESS = /(?=.*(?:readiness|probe|check))(?=.*(?:fail|unavailable|unable))/i;

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
    const executablePath = neutralBinary("browser");
    vi.stubEnv("AGENT_BROWSER_EXECUTABLE_PATH", neutralBinary("from-environment"));
    readModifiedAt.mockImplementation(async () => Date.now() - 40.5 * DAY_MS);
    readBrowserVersion.mockImplementation(async (file) => file === executablePath ? "Microsoft Edge 141.0.3537.71" : undefined);
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

    expect(result.summary.tone).toBe("error");
    expect(result.summary.label).toMatch(/missing|not found|unavailable/i);
    expect(result.summary.detail).toMatch(/(?:path|executable).*(?:does not exist|not found|missing)/i);
    expect(result.config).toMatchObject({
      executablePath,
      executablePathSource: "settings",
      executablePathConfigured: true,
      executablePathExists: false,
    });
    expect(result.config.browser).toEqual({ kind: "edge", version: expect.stringContaining("141.0.3537.71"), installedDaysAgo: 40 });
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
    vi.stubEnv("AGENT_BROWSER_ARGS", "--no-sandbox,--lang=en-US");
    readJsonFile.mockResolvedValue({ args: ["--from-config"] });
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
    expect(result.config.launch).toEqual({
      args: ["--no-sandbox", "--lang=en-US", BLINK_DEFAULT, SWIFTSHADER, BLANK],
      inheritedFrom: "environment",
    });
  });

  describe("browser executable and build", () => {
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
      expect(result.summary.tone).toBe("warning");
      expect(result.config.browser).toEqual({
        kind: "chrome",
        version: "Google Chrome 154.0.8037.97",
        installedDaysAgo: 3,
      });
    });

    it("leaves the choice to agent-browser when there is no browser to find", async () => {
      agentBrowserVersionOutput = undefined;
      const { ctx } = createContext();

      const { getBrowserDiagnostics } = await import("../browser-diagnostics.js");
      const result = await getBrowserDiagnostics(ctx);

      expect(result.issues).toEqual([]);
      expect(result.summary.tone).toBe("warning");
      expect(result.summary.label).toMatch(/(?:check|probe).*(?:needed|required|pending)|unverified/i);
      expect(result.summary.detail).toMatch(/no successful.*(?:probe|check)/i);
      expect(result.agentBrowserInstalled).toBe(true);
      expect(result.config.agentBrowserVersion).toBeUndefined();
      expect(result.config).not.toHaveProperty("liveView");
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

  describe("live view", () => {
    /** A usable browser whose CLI predates the live stream. */
    function answerReadiness(): SeenCommand[] {
      return answerCommands(({ args }) => {
        if (args[0] === "get" && args[1] === "url") return { stdout: "about:blank" };
        if (args[0] === "get" && args[1] === "title") return { stdout: "New tab" };
        if (args[0] === "stream") return { fail: { stderr: "error: unrecognized subcommand 'stream'" } };
        return undefined;
      });
    }

    it("checks the live view in the browser of the public probe, and reports a failure without failing the probe", async ({ onTestFinished }) => {
      const connect = vi.fn();
      vi.doMock("ws", async (importOriginal) => ({ ...await importOriginal<typeof import("ws")>(), WebSocket: connect }));
      onTestFinished(() => { vi.doUnmock("ws"); });
      const seen = answerReadiness();
      const { ctx, copilotHome } = createContext();
      const mod = await import("../browser-diagnostics.js");

      const probe = await mod.probeBrowserContext(ctx, "public");

      // The browser itself works; that it cannot be shown is a finding of its own.
      expect(probe).toMatchObject({ ok: true, context: "public", state: "ready" });
      const profile = path.join(copilotHome, "browser-public", "slot-1");
      const targetProfiles = seen.flatMap((command) => command.env?.AGENT_BROWSER_PROFILE ?? []);
      expect(seen.filter(({ args }) => args[0] === "stream").map(({ args, env }) => [...args.slice(0, 2), env?.AGENT_BROWSER_PROFILE]))
        .toEqual([["stream", "status", profile]]);
      expect(seen.some(({ args }) => args[0] === "eval")).toBe(false);
      expect(connect).not.toHaveBeenCalled();
      expect(new Set(targetProfiles)).toEqual(new Set([profile]));
      expect(existsSync(profile)).toBe(true);
      const { liveView } = (await mod.getBrowserDiagnostics(ctx)).config;
      expect(liveView).toMatchObject({ ok: false, message: expect.stringMatching(/npm (?:install|i|update) -g agent-browser@latest/) });
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

  it("gives only a preview's signed-in browser a limit after which it closes by itself", async () => {
    const { getBrowserRuntime } = await import("../browser-runtime.js");
    const preview = { ...createContext().ctx, isStaging: true } as AppContext;

    expect(getBrowserRuntime(createContext().ctx).broker.getAuthenticatedTarget().idleTimeoutMs).toBeUndefined();
    expect(getBrowserRuntime(preview).broker.getAuthenticatedTarget().idleTimeoutMs).toBeGreaterThan(0);
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
      expect((await mod.getBrowserDiagnostics(ctx)).contexts.public).toMatchObject({
        context: "public",
        profileRoot,
        profiles: 3,
        profilesInUse: 0,
        concurrencyLimit: 5,
      });
      const lease = await broker.createSessionTarget("public");

      expect(lease.browserTarget.profileDir).toBe(path.join(profileRoot, "slot-1"));
      expect((await mod.getBrowserDiagnostics(ctx)).contexts.public).toMatchObject({ profiles: 3, profilesInUse: 1 });
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
      expect((await mod.getBrowserDiagnostics(ctx)).contexts.public).toMatchObject({ profiles: 1, profilesInUse: 0 });
      await expect(mod.resetPublicBrowserProfiles(ctx)).resolves.toEqual({ ok: true, cleared: 1, inUse: 0 });
      expect(existsSync(path.join(profileRoot, "slot-1"))).toBe(false);
      await expect(mod.resetPublicBrowserProfiles(ctx)).resolves.toEqual({ ok: true, cleared: 0, inUse: 0 });
      expect(existsSync(authenticatedCookies)).toBe(true);
    });
  });

  describe("issues", () => {
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

      expect(result.issues).toEqual([
        expect.objectContaining({ code: "search.google_captcha", label: expect.stringMatching(/Google/i), count: 2 }),
        expect.objectContaining({ code: "search.bing_captcha", label: expect.stringMatching(/Bing/i), count: 1 }),
        expect.objectContaining({ code: "search.ddg_challenge", label: expect.stringMatching(/DuckDuckGo/i), count: 3 }),
        expect.objectContaining({ code: "browser.recovery.detected", label: expect.stringMatching(/recover/i), count: 2 }),
        expect.objectContaining({ code: "browser.broker.readiness.failed", label: expect.stringMatching(FAILED_READINESS), count: 1 }),
      ]);
      for (const issue of result.issues.slice(0, 3)) expect(issue.label).toMatch(/captcha|challenge|human check/i);
      for (const issue of result.issues) {
        expect(Number.isNaN(Date.parse(issue.latestAt ?? ""))).toBe(false);
      }
      expect(result.summary.tone).toBe("warning");
      expect(result.summary.label).toMatch(/challenge|human check|captcha/i);
      expect(result.summary.detail).toMatch(/(?:engine|search).*?(?:challenge|human check|captcha)/i);
      // All three engines' challenges together, and the window they were counted in.
      expect(result.summary.detail).toMatch(/\b6\b.*\b24 hours\b/);
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
          label: expect.stringMatching(/Cloudflare/i),
          count: 3,
          latestAt: hoursAgo(4).toISOString(),
        },
        {
          code: "page.blocked.api.example.test",
          label: expect.stringContaining("api.example.test"),
          count: 2,
          latestAt: hoursAgo(9).toISOString(),
        },
      ]);
      expect(result.issues).toHaveLength(5);
      expect(result.issues.slice(2)).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: "page.blocked.an_unknown_site", label: expect.stringMatching(/unknown|unidentified/i), count: 1 }),
        expect.objectContaining({ code: "page.blocked.forum.example.test", label: expect.stringContaining("forum.example.test"), count: 1 }),
        expect.objectContaining({ code: "page.blocked.human_security", label: expect.stringMatching(/HUMAN Security/i), count: 1 }),
      ]));
      for (const issue of result.issues) expect(issue.label).toMatch(/block|deni(?:ed|al)|refus/i);
      // Blocked pages are listed; they do not change the verdict on the browser itself.
      expect(result.summary.tone).toBe("warning");
      expect(result.summary.detail).toMatch(/no successful.*(?:probe|check)/i);
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
      expect(probe.message).toMatch(/(?:cannot|unable|refus|no usable).*sandbox/i);
      expect(probe.message).toContain("--no-sandbox");
      expect(probe.message).toContain("AGENT_BROWSER_ARGS");
      expect(probe.message).not.toContain("DevToolsActivePort");
      // The profile is not at fault, so nothing is killed or cleared to recover it.
      expect(telemetryStore.querySpans({ name: "browser.recovery.detected" })).toEqual([]);
      expect(killMock).not.toHaveBeenCalled();

      const result = await mod.getBrowserDiagnostics(ctx);
      expect(result.summary.tone).toBe("error");
      expect(result.summary.label).toMatch(/unavailable|not ready|failed|offline/i);
      expect(result.summary.detail).toMatch(/(?:readiness|probe|check).*fail/i);
      expect(result.runtime.transport.state).toBe("unavailable");
      expect(result.contexts.public).toMatchObject({
        state: "unavailable",
        profilesInUse: 0,
        functionalProbe: { state: "failed", checkedAt: probe.checkedAt, message: probe.message },
      });
      expect(result.issues).toEqual([
        expect.objectContaining({ code: "browser.broker.readiness.failed", label: expect.stringMatching(FAILED_READINESS), count: 1 }),
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
    expect(result.message).toMatch(/close requested|clos(?:ed|ing)|shut down/i);
    expect(result.message).not.toMatch(/fail|unable|cannot|could not|not closed/i);
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

  it("verifies authenticated Azure DevOps state through the broker", async () => {
    const db = setupTestDb();
    const settingsStore = createSettingsStore(db);
    const telemetryStore = createTelemetryStore(db);
    settingsStore.updateSettings({
      providers: {
        ado: {
          org: "exampleorg",
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
            ? "https://exampleorg.visualstudio.com/One/_workitems/assignedtome/"
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
      finalOrigin: "https://exampleorg.visualstudio.com",
      expectedOrigin: "https://exampleorg.visualstudio.com",
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
