import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { testPath, testPosixPath, testWindowsPath } from "./test-paths.js";

// src/test-support/vitest-setup.ts replaces the host lookups for every test file. This file
// replaces them again with mocks it can steer, and imports browser-launch fresh for each test.
const isExecutableFile = vi.fn<(file: string) => Promise<boolean>>();
const readJsonFile = vi.fn<(file: string) => Promise<unknown>>();
const readModifiedAt = vi.fn<(file: string) => Promise<number | undefined>>();
const readBrowserVersion = vi.fn<(file: string) => Promise<string | undefined>>();

let launch: typeof import("../browser-launch.js");

const BLINK_DEFAULT = "--disable-blink-features=AutomationControlled";
const SWIFTSHADER = "--enable-unsafe-swiftshader";
const BLANK = "about:blank";
const DEFAULT_ARGS = [BLINK_DEFAULT, SWIFTSHADER, BLANK];

const USER_CONFIG = path.join(os.homedir(), ".agent-browser", "config.json");
const PROJECT_CONFIG = path.resolve("agent-browser.json");

/** Answers `readJsonFile` from a table of file contents; any other file is missing. */
function mockConfigFiles(files: Record<string, unknown>): void {
  readJsonFile.mockImplementation(async (file) => files[file]);
}

/** A path with no browser name in it, whatever the host's temp or home directory is called. */
function neutralBinary(name = "app"): string {
  return path.join(path.sep, "srv", "acme", name);
}

beforeEach(async () => {
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
  vi.resetModules();
  launch = await import("../browser-launch.js");
  launch.resetBrowserLaunchCachesForTests();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("parseBrowserArgs", () => {

  it("accepts Windows line endings", () => {
    expect(launch.parseBrowserArgs("--window-size=1280,720\r\n--no-sandbox\r\n")).toEqual([
      "--window-size=1280,720",
      "--no-sandbox",
    ]);
  });

  it("takes the strings of an array as they are and drops everything else", () => {
    expect(launch.parseBrowserArgs(["--window-size=1280,720", 7, null, undefined, { arg: "--x" }, "--no-sandbox"]))
      .toEqual(["--window-size=1280,720", "--no-sandbox"]);
  });

  it("trims each argument and drops blank ones", () => {
    expect(launch.parseBrowserArgs("  --no-sandbox , ,, --lang=en-US  ,")).toEqual(["--no-sandbox", "--lang=en-US"]);
    expect(launch.parseBrowserArgs("\n  --no-sandbox  \n\n \n--lang=en-US\n")).toEqual(["--no-sandbox", "--lang=en-US"]);
    expect(launch.parseBrowserArgs(["  --no-sandbox  ", "", "   "])).toEqual(["--no-sandbox"]);
  });
});

describe("formatBrowserArgs", () => {

  it("round-trips what the Bridge composes around a single argument with a comma", () => {
    const composed = launch.composeBrowserLaunchArgs(["--window-size=1280,720"]);
    expect(launch.parseBrowserArgs(launch.formatBrowserArgs(composed))).toEqual(composed);
  });
});

describe("composeBrowserLaunchArgs", () => {

  it("adds AutomationControlled to an existing list of disabled Blink features instead of a second switch", () => {
    expect(launch.composeBrowserLaunchArgs(["--disable-blink-features=Foo,Bar", "--no-sandbox"])).toEqual([
      "--disable-blink-features=Foo,Bar,AutomationControlled",
      "--no-sandbox",
      SWIFTSHADER,
      BLANK,
    ]);
  });

  it("extends the last list even when only an earlier one names AutomationControlled", () => {
    expect(launch.composeBrowserLaunchArgs([
      "--disable-blink-features=AutomationControlled",
      "--disable-blink-features=Foo",
    ])).toEqual([
      "--disable-blink-features=AutomationControlled",
      "--disable-blink-features=Foo,AutomationControlled",
      SWIFTSHADER,
      BLANK,
    ]);
  });

  it("does not repeat AutomationControlled when the list already has it", () => {
    expect(launch.composeBrowserLaunchArgs(["--disable-blink-features=AutomationControlled,Foo"])).toEqual([
      "--disable-blink-features=AutomationControlled,Foo",
      SWIFTSHADER,
      BLANK,
    ]);
    expect(launch.composeBrowserLaunchArgs([BLINK_DEFAULT])).toEqual(DEFAULT_ARGS);
  });

  it("does not repeat the software WebGL switch when it is inherited", () => {
    expect(launch.composeBrowserLaunchArgs([SWIFTSHADER, "--no-sandbox"])).toEqual([
      SWIFTSHADER,
      "--no-sandbox",
      BLINK_DEFAULT,
      BLANK,
    ]);
  });

  it("puts the blank start page last, once, wherever the inherited arguments had it", () => {
    const composed = launch.composeBrowserLaunchArgs(["--no-sandbox", "about:blank", "--lang=en-US", "about:blank"]);
    expect(composed).toEqual(["--no-sandbox", "--lang=en-US", ...DEFAULT_ARGS]);
    expect(composed.filter((arg) => arg === "about:blank")).toHaveLength(1);
    expect(composed.at(-1)).toBe("about:blank");
  });

  it("is idempotent for several lists of disabled Blink features", () => {
    const once = launch.composeBrowserLaunchArgs(["--disable-blink-features=Foo", "--disable-blink-features=Bar"]);
    expect(launch.composeBrowserLaunchArgs(once)).toEqual(once);
  });
});

describe("resolveBrowserLaunchArgs", () => {

  it("has no inherited arguments when the file AGENT_BROWSER_CONFIG names is missing", async () => {
    const explicit = testPath("agent-browser", "missing.json");
    mockConfigFiles({ [USER_CONFIG]: { args: ["--from-user-config"] } });

    await expect(launch.resolveBrowserLaunchArgs({ AGENT_BROWSER_CONFIG: explicit })).resolves.toEqual({
      args: DEFAULT_ARGS,
      inheritedFrom: "none",
    });
    expect(readJsonFile.mock.calls).toEqual([[explicit]]);
  });

  it("inherits the user config arguments when both the environment and project leave them unset", async () => {
    mockConfigFiles({ [USER_CONFIG]: { args: "--no-sandbox, --lang=en-US" }, [PROJECT_CONFIG]: { headed: true } });

    await expect(launch.resolveBrowserLaunchArgs({ AGENT_BROWSER_ARGS: "  \n " })).resolves.toEqual({
      args: ["--no-sandbox", "--lang=en-US", ...DEFAULT_ARGS],
      inheritedFrom: "agent-browser-config",
    });
  });

  it.each<[string, Record<string, unknown>]>([
    ["`args` is not a list of arguments", { [USER_CONFIG]: { args: 7 } }],
    ["the files do not hold an object", { [USER_CONFIG]: "--no-sandbox", [PROJECT_CONFIG]: null }],
  ])("has only the Bridge's own arguments when %s", async (_label, files) => {
    mockConfigFiles(files);

    await expect(launch.resolveBrowserLaunchArgs({})).resolves.toEqual({
      args: DEFAULT_ARGS,
      inheritedFrom: "none",
    });
  });

  it("does not answer a different environment from the cache", async () => {
    const explicit = testPath("agent-browser", "custom.json");
    mockConfigFiles({
      [USER_CONFIG]: { args: ["--from-user-config"] },
      [PROJECT_CONFIG]: { args: ["--from-project"] },
      [explicit]: { args: ["--from-explicit"] },
    });

    const fromFiles = await launch.resolveBrowserLaunchArgs({});
    expect(fromFiles).toEqual({ args: ["--from-project", ...DEFAULT_ARGS], inheritedFrom: "agent-browser-config" });
    readJsonFile.mockClear();
    const fromExplicit = await launch.resolveBrowserLaunchArgs({ AGENT_BROWSER_CONFIG: `  ${explicit}  ` });
    expect(readJsonFile.mock.calls).toEqual([[explicit]]);
    const fromEnvironment = await launch.resolveBrowserLaunchArgs({ AGENT_BROWSER_ARGS: "--from-environment" });

    expect(fromExplicit).toEqual({ args: ["--from-explicit", ...DEFAULT_ARGS], inheritedFrom: "agent-browser-config" });
    expect(fromEnvironment).toEqual({ args: ["--from-environment", ...DEFAULT_ARGS], inheritedFrom: "environment" });
  });

  it("reads the files again after the cached answer has gone stale", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-10T12:00:00Z"));
    mockConfigFiles({ [USER_CONFIG]: { args: ["--no-sandbox"] } });
    await launch.resolveBrowserLaunchArgs({});
    mockConfigFiles({ [USER_CONFIG]: { args: ["--changed"] } });

    vi.setSystemTime(new Date("2026-03-10T13:00:00Z"));

    await expect(launch.resolveBrowserLaunchArgs({})).resolves.toMatchObject({ args: ["--changed", ...DEFAULT_ARGS] });
  });
});

describe("systemBrowserCandidates", () => {
  const chromeExe = ["Google", "Chrome", "Application", "chrome.exe"];
  const edgeExe = ["Microsoft", "Edge", "Application", "msedge.exe"];

  it("lists Chrome under every Windows install root before Edge", () => {
    const programFiles = testWindowsPath("Program Files");
    const programFilesX86 = testWindowsPath("Program Files (x86)");
    const localAppData = testWindowsPath("Users", "tester", "AppData", "Local");

    expect(launch.systemBrowserCandidates("win32", {
      ProgramFiles: programFiles,
      "ProgramFiles(x86)": programFilesX86,
      LOCALAPPDATA: localAppData,
    })).toEqual([
      path.win32.join(programFiles, ...chromeExe),
      path.win32.join(programFilesX86, ...chromeExe),
      path.win32.join(localAppData, ...chromeExe),
      path.win32.join(programFiles, ...edgeExe),
      path.win32.join(programFilesX86, ...edgeExe),
      path.win32.join(localAppData, ...edgeExe),
    ]);
  });

  it("skips Windows install roots that are missing or blank", () => {
    const programFiles = testWindowsPath("Program Files");

    expect(launch.systemBrowserCandidates("win32", { ProgramFiles: programFiles, "ProgramFiles(x86)": "   " })).toEqual([
      path.win32.join(programFiles, ...chromeExe),
      path.win32.join(programFiles, ...edgeExe),
    ]);
    expect(launch.systemBrowserCandidates("win32", {})).toEqual([]);
  });

  it("lists the system's Chrome, the user's Chrome and the system's Edge on macOS", () => {
    const home = testPosixPath("Users", "tester");
    const chromeApp = ["Google Chrome.app", "Contents", "MacOS", "Google Chrome"];
    const edgeApp = ["Microsoft Edge.app", "Contents", "MacOS", "Microsoft Edge"];

    expect(launch.systemBrowserCandidates("darwin", { PATH: testPosixPath("opt", "tools", "bin") }, home)).toEqual([
      path.posix.join(path.posix.sep, "Applications", ...chromeApp),
      path.posix.join(home, "Applications", ...chromeApp),
      path.posix.join(path.posix.sep, "Applications", ...edgeApp),
    ]);
  });

  describe("on Linux", () => {
    const packageInstalls = [
      testPosixPath("opt", "google", "chrome", "chrome"),
      testPosixPath("usr", "bin", "google-chrome-stable"),
      testPosixPath("usr", "bin", "google-chrome"),
      testPosixPath("opt", "microsoft", "msedge", "msedge"),
      testPosixPath("usr", "bin", "microsoft-edge-stable"),
    ];

    it("lists the package installs first, then every PATH directory", () => {
      const first = testPosixPath("home", "tester", ".local", "bin");
      const second = testPosixPath("opt", "tools", "bin");

      expect(launch.systemBrowserCandidates("linux", { PATH: ["", first, "", second, ""].join(path.posix.delimiter) })).toEqual([
        ...packageInstalls,
        path.posix.join(first, "google-chrome-stable"),
        path.posix.join(first, "google-chrome"),
        path.posix.join(first, "microsoft-edge-stable"),
        path.posix.join(second, "google-chrome-stable"),
        path.posix.join(second, "google-chrome"),
        path.posix.join(second, "microsoft-edge-stable"),
      ]);
    });

    it("lists only the package installs without a PATH", () => {
      expect(launch.systemBrowserCandidates("linux", {})).toEqual(packageInstalls);
      expect(launch.systemBrowserCandidates("linux", { PATH: "" })).toEqual(packageInstalls);
    });
  });
});

describe("resolveBrowserExecutable", () => {
  // Gives every platform candidates of its own, so the host this runs on decides nothing.
  const detectionEnv: NodeJS.ProcessEnv = {
    ProgramFiles: testWindowsPath("Program Files"),
    "ProgramFiles(x86)": testWindowsPath("Program Files (x86)"),
    LOCALAPPDATA: testWindowsPath("Users", "tester", "AppData", "Local"),
    PATH: [testPosixPath("home", "tester", ".local", "bin"), testPosixPath("opt", "tools", "bin")]
      .join(path.posix.delimiter),
  };

  function hostCandidates(): string[] {
    const candidates = launch.systemBrowserCandidates(os.platform(), detectionEnv);
    expect(candidates.length).toBeGreaterThanOrEqual(3);
    return candidates;
  }

  it("uses AGENT_BROWSER_EXECUTABLE_PATH when Settings has a blank path", async () => {
    const fromEnvironment = testPath("browsers", "from-env");
    isExecutableFile.mockResolvedValue(true);

    await expect(launch.resolveBrowserExecutable(
      { executablePath: "   " },
      { ...detectionEnv, AGENT_BROWSER_EXECUTABLE_PATH: ` ${fromEnvironment} ` },
    )).resolves.toStrictEqual({ path: fromEnvironment, source: "environment" });
    expect(isExecutableFile).not.toHaveBeenCalled();
  });

  it("uses the first installed system browser, in candidate order", async () => {
    const candidates = hostCandidates();
    const installed = new Set([candidates[1], candidates[2]]);
    isExecutableFile.mockImplementation(async (file) => installed.has(file));

    await expect(launch.resolveBrowserExecutable({}, detectionEnv))
      .resolves.toStrictEqual({ path: candidates[1], source: "system" });
    // Candidates after the first installed one play no part.
    expect(isExecutableFile.mock.calls).toEqual([[candidates[0]], [candidates[1]]]);
  });
});

describe("buildBrowserEnv", () => {
  const target = {
    sessionName: "bridge-public-3",
    profileDir: testPath("browser-profiles", "public-3"),
  };

  it("builds an isolated headless launch environment using the target's settings", async () => {
    const executablePath = testPath("browsers", "chrome");
    const baseEnv = Object.freeze({
      KEEP_ME: "1",
      AGENT_BROWSER_HEADED: "1",
      AGENT_BROWSER_NAMESPACE: "someone-else",
      AGENT_BROWSER_SESSION: "default",
      AGENT_BROWSER_PROFILE: testPath("another-profile"),
      AGENT_BROWSER_EXECUTABLE_PATH: testPath("browsers", "from-env"),
      AGENT_BROWSER_IDLE_TIMEOUT_MS: "5000",
      AGENT_BROWSER_ARGS: "--no-sandbox,--lang=en-US",
    });
    const before = { ...baseEnv };
    const env = await launch.buildBrowserEnv({ ...target, headed: false, executablePath, idleTimeoutMs: 90_000 }, baseEnv);

    expect(env).toMatchObject({
      KEEP_ME: "1",
      AGENT_BROWSER_NAMESPACE: "copilot-bridge",
      AGENT_BROWSER_SESSION: "bridge-public-3",
      AGENT_BROWSER_PROFILE: target.profileDir,
      AGENT_BROWSER_EXECUTABLE_PATH: executablePath,
      AGENT_BROWSER_IDLE_TIMEOUT_MS: "90000",
      AGENT_BROWSER_ARGS: ["--no-sandbox", "--lang=en-US", ...DEFAULT_ARGS].join("\n"),
    });
    expect(env).not.toHaveProperty("AGENT_BROWSER_HEADED");
    expect(env).not.toBe(baseEnv);
    expect(baseEnv).toStrictEqual(before);
  });

  it("inherits the executable and idle timeout when neither is set on the target", async () => {
    const fromEnvironment = testPath("browsers", "from-env");

    const env = await launch.buildBrowserEnv(target, {
      AGENT_BROWSER_EXECUTABLE_PATH: fromEnvironment,
      AGENT_BROWSER_IDLE_TIMEOUT_MS: "120000",
      AGENT_BROWSER_HEADED: "1",
    });

    expect(env.AGENT_BROWSER_IDLE_TIMEOUT_MS).toBe("120000");
    expect(env).not.toHaveProperty("AGENT_BROWSER_HEADED");
    expect(env.AGENT_BROWSER_EXECUTABLE_PATH).toBe(fromEnvironment);
  });

  it("sets the system browser when one is installed and nothing else names an executable", async () => {
    const baseEnv = {
      AGENT_BROWSER_IDLE_TIMEOUT_MS: "   ",
      ProgramFiles: testWindowsPath("Program Files"),
      PATH: testPosixPath("opt", "tools", "bin"),
    };
    const [firstCandidate] = launch.systemBrowserCandidates(os.platform(), baseEnv);
    isExecutableFile.mockImplementation(async (file) => file === firstCandidate);

    const env = await launch.buildBrowserEnv(target, baseEnv);

    expect(env).not.toHaveProperty("AGENT_BROWSER_IDLE_TIMEOUT_MS");
    expect(firstCandidate).toBeTruthy();
    expect(env.AGENT_BROWSER_EXECUTABLE_PATH).toBe(firstCandidate);
  });

});

describe("describeBrowserBuild", () => {
  const NOW = new Date("2026-03-10T12:00:00Z").getTime();
  const HOUR = 3_600_000;
  const DAY = 24 * HOUR;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  it("tells only the kind (chromium) from the path of chromium-browser when the file cannot be read", async () => {
    const executablePath = testPosixPath("snap", "bin", "chromium-browser");
    readBrowserVersion.mockResolvedValue("Google Chrome for Testing 1.2.3.4");

    await expect(launch.describeBrowserBuild({ path: executablePath, source: "settings" }))
      .resolves.toStrictEqual({ kind: "chromium" });
    expect(readModifiedAt).toHaveBeenCalledWith(executablePath);
    expect(readBrowserVersion).not.toHaveBeenCalled();
  });

  it("recognises Chrome for Testing by its version even when it is installed as chrome", async () => {
    readModifiedAt.mockResolvedValue(NOW);
    readBrowserVersion.mockResolvedValue("Google Chrome for Testing 1.2.3.4");

    await expect(launch.describeBrowserBuild({ path: neutralBinary("chrome"), source: "environment" }))
      .resolves.toMatchObject({ kind: "chrome-for-testing", version: "Google Chrome for Testing 1.2.3.4" });
  });

  it("tells chrome from the path when the version is only a number, as on Windows", async () => {
    readModifiedAt.mockResolvedValue(NOW);
    readBrowserVersion.mockResolvedValue("154.0.8037.97");

    await expect(launch.describeBrowserBuild({
      path: path.win32.join(testWindowsPath("Program Files"), "Google", "Chrome", "Application", "chrome.exe"),
      source: "system",
    })).resolves.toStrictEqual({ kind: "chrome", version: "154.0.8037.97", installedDaysAgo: 0 });
  });

  it("leaves the version out when the browser does not report one", async () => {
    readModifiedAt.mockResolvedValue(NOW - 2 * DAY);

    await expect(launch.describeBrowserBuild({ path: neutralBinary("msedge"), source: "system" }))
      .resolves.toStrictEqual({ kind: "edge", installedDaysAgo: 2 });
  });

  it("never reports a negative age for a file dated in the future", async () => {
    readModifiedAt.mockResolvedValue(NOW + 3 * DAY);

    const build = await launch.describeBrowserBuild({ path: neutralBinary(), source: "system" });

    expect(build).toMatchObject({ kind: "unknown", installedDaysAgo: 0 });
  });

  it("reuses the version until the executable is replaced but calculates its age on every read", async () => {
    const executable = { path: neutralBinary(), source: "system" as const };
    readModifiedAt.mockResolvedValue(NOW - DAY);
    readBrowserVersion.mockResolvedValue("Chromium 1.2.3.4");

    const first = await launch.describeBrowserBuild(executable);
    vi.setSystemTime(NOW + 2 * DAY);
    const second = await launch.describeBrowserBuild(executable);

    expect(readBrowserVersion).toHaveBeenCalledTimes(1);
    expect(first).toStrictEqual({ kind: "chromium", version: "Chromium 1.2.3.4", installedDaysAgo: 1 });
    // The age is worked out on every call; only the version is remembered.
    expect(second).toStrictEqual({ kind: "chromium", version: "Chromium 1.2.3.4", installedDaysAgo: 3 });

    readModifiedAt.mockResolvedValue(Date.now() - HOUR);
    readBrowserVersion.mockResolvedValue("Chromium 1.2.3.5");
    await expect(launch.describeBrowserBuild(executable))
      .resolves.toStrictEqual({ kind: "chromium", version: "Chromium 1.2.3.5", installedDaysAgo: 0 });
    expect(readBrowserVersion).toHaveBeenCalledTimes(2);
  });

  it("asks each executable for its own version", async () => {
    const other = neutralBinary("first");
    const edge = path.win32.join(testWindowsPath("Program Files"), "Microsoft", "Edge", "Application", "msedge.exe");
    readModifiedAt.mockResolvedValue(NOW);
    readBrowserVersion.mockImplementation(async (file) => (file === other ? "Vivaldi 1.2.3.4" : "5.6.7.8"));

    const first = await launch.describeBrowserBuild({ path: other, source: "system" });
    const second = await launch.describeBrowserBuild({ path: edge, source: "system" });
    expect([first.version, second.version]).toEqual(["Vivaldi 1.2.3.4", "5.6.7.8"]);
    // Neither standard installation should trigger the automation-build warning.
    expect([first.kind, second.kind]).not.toContain("chromium");
    expect([first.kind, second.kind]).not.toContain("chrome-for-testing");
  });

});

describe("getBrowserLaunchConfig", () => {
  it("trims the configured paths", () => {
    const executablePath = testPath("browsers", "chrome");
    const masterProfileDirectory = testPath("profiles", "master");

    expect(launch.getBrowserLaunchConfig({
      browser: {
        executablePath: `  ${executablePath}\n`,
        masterProfileDirectory: `\t${masterProfileDirectory}  `,
        headed: true,
      },
    })).toStrictEqual({ executablePath, masterProfileDirectory, headed: true });
  });

  it("drops blank paths", () => {
    expect(launch.getBrowserLaunchConfig({ browser: { executablePath: "", masterProfileDirectory: "   " } }))
      .toStrictEqual({});
  });

  it("drops paths that are not strings", () => {
    const browser = { executablePath: 7, masterProfileDirectory: ["profiles"] } as unknown as { executablePath: string };

    expect(launch.getBrowserLaunchConfig({ browser })).toStrictEqual({});
  });

  it("is not headed when `headed` is the string \"true\"", () => {
    const browser = { headed: "true" } as unknown as { headed?: boolean };

    expect(launch.getBrowserLaunchConfig({ browser })).toStrictEqual({});
  });

  it.each<[string, Parameters<typeof launch.getBrowserLaunchConfig>[0]]>([
    ["no settings", undefined],
    ["a null browser section", { browser: null }],
  ])("is empty for %s", (_label, settings) => {
    expect(launch.getBrowserLaunchConfig(settings)).toStrictEqual({});
  });
});
