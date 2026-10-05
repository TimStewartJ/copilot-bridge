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
  it("splits a string without newlines by commas", () => {
    expect(launch.parseBrowserArgs("--no-sandbox,--lang=en-US")).toEqual(["--no-sandbox", "--lang=en-US"]);
  });

  it("splits a string with newlines by lines only, so an argument may contain commas", () => {
    expect(launch.parseBrowserArgs("--window-size=1280,720\n--disable-features=Foo,Bar")).toEqual([
      "--window-size=1280,720",
      "--disable-features=Foo,Bar",
    ]);
  });

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

  it.each([
    ["undefined", undefined],
    ["a number", 42],
    ["an object", { args: "--no-sandbox" }],
    ["a blank string", "  \n  "],
  ])("has no arguments for %s", (_label, value) => {
    expect(launch.parseBrowserArgs(value)).toEqual([]);
  });
});

describe("formatBrowserArgs", () => {
  it("joins the arguments with newlines", () => {
    expect(launch.formatBrowserArgs(["--no-sandbox", "--lang=en-US"])).toBe("--no-sandbox\n--lang=en-US");
    expect(launch.formatBrowserArgs([])).toBe("");
  });

  it("round-trips arguments that contain commas through parseBrowserArgs", () => {
    const args = ["--window-size=1280,720", "--disable-features=Foo,Bar", "--no-sandbox"];
    expect(launch.parseBrowserArgs(launch.formatBrowserArgs(args))).toEqual(args);
  });

  it("round-trips what the Bridge composes around a single argument with a comma", () => {
    const composed = launch.composeBrowserLaunchArgs(["--window-size=1280,720"]);
    expect(launch.parseBrowserArgs(launch.formatBrowserArgs(composed))).toEqual(composed);
  });
});

describe("composeBrowserLaunchArgs", () => {
  it("gives a browser with no inherited arguments the Bridge's own", () => {
    expect(launch.composeBrowserLaunchArgs([])).toEqual([
      "--disable-blink-features=AutomationControlled",
      "--enable-unsafe-swiftshader",
      "about:blank",
    ]);
  });

  it("keeps the inherited arguments first and in their order", () => {
    expect(launch.composeBrowserLaunchArgs(["--no-sandbox", "--window-size=1280,720", "--lang=en-US"])).toEqual([
      "--no-sandbox",
      "--window-size=1280,720",
      "--lang=en-US",
      ...DEFAULT_ARGS,
    ]);
  });

  it("adds AutomationControlled to an existing list of disabled Blink features instead of a second switch", () => {
    expect(launch.composeBrowserLaunchArgs(["--disable-blink-features=Foo,Bar", "--no-sandbox"])).toEqual([
      "--disable-blink-features=Foo,Bar,AutomationControlled",
      "--no-sandbox",
      SWIFTSHADER,
      BLANK,
    ]);
  });

  it("extends the last list when the switch is given several times, the one Chrome honours", () => {
    expect(launch.composeBrowserLaunchArgs([
      "--disable-blink-features=Foo",
      "--no-sandbox",
      "--disable-blink-features=Bar",
    ])).toEqual([
      "--disable-blink-features=Foo",
      "--no-sandbox",
      "--disable-blink-features=Bar,AutomationControlled",
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

  it.each<[string, string[]]>([
    ["nothing", []],
    ["plain arguments", ["--no-sandbox", "--window-size=1280,720"]],
    ["a list of disabled Blink features", ["--disable-blink-features=Foo,Bar", "--no-sandbox"]],
    ["several lists of disabled Blink features", ["--disable-blink-features=Foo", "--disable-blink-features=Bar"]],
    ["a blank start page in the middle", ["--no-sandbox", "about:blank", SWIFTSHADER]],
  ])("is idempotent for %s", (_label, inherited) => {
    const once = launch.composeBrowserLaunchArgs(inherited);
    expect(launch.composeBrowserLaunchArgs(once)).toEqual(once);
  });

  it("does not change the list it is given", () => {
    const inherited = ["about:blank", "--disable-blink-features=Foo"];
    launch.composeBrowserLaunchArgs(inherited);
    expect(inherited).toEqual(["about:blank", "--disable-blink-features=Foo"]);
  });
});

describe("resolveBrowserLaunchArgs", () => {
  it("takes the arguments of AGENT_BROWSER_ARGS and reads no configuration file", async () => {
    mockConfigFiles({ [USER_CONFIG]: { args: ["--from-user-config"] }, [PROJECT_CONFIG]: { args: ["--from-project"] } });

    await expect(launch.resolveBrowserLaunchArgs({ AGENT_BROWSER_ARGS: "--no-sandbox,--lang=en-US" })).resolves.toEqual({
      args: ["--no-sandbox", "--lang=en-US", ...DEFAULT_ARGS],
      inheritedFrom: "environment",
    });
    expect(readJsonFile).not.toHaveBeenCalled();
  });

  it.each([
    ["empty", ""],
    ["blank", "  \n "],
  ])("falls back to the configuration files when AGENT_BROWSER_ARGS is %s", async (_label, value) => {
    mockConfigFiles({ [USER_CONFIG]: { args: ["--no-sandbox"] } });

    await expect(launch.resolveBrowserLaunchArgs({ AGENT_BROWSER_ARGS: value })).resolves.toEqual({
      args: ["--no-sandbox", ...DEFAULT_ARGS],
      inheritedFrom: "agent-browser-config",
    });
  });

  it("reads only the file AGENT_BROWSER_CONFIG names", async () => {
    const explicit = testPath("agent-browser", "custom.json");
    mockConfigFiles({
      [explicit]: { args: ["--from-explicit"] },
      [USER_CONFIG]: { args: ["--from-user-config"] },
      [PROJECT_CONFIG]: { args: ["--from-project"] },
    });

    await expect(launch.resolveBrowserLaunchArgs({ AGENT_BROWSER_CONFIG: `  ${explicit}  ` })).resolves.toEqual({
      args: ["--from-explicit", ...DEFAULT_ARGS],
      inheritedFrom: "agent-browser-config",
    });
    expect(readJsonFile.mock.calls).toEqual([[explicit]]);
  });

  it("has no inherited arguments when the file AGENT_BROWSER_CONFIG names is missing", async () => {
    const explicit = testPath("agent-browser", "missing.json");
    mockConfigFiles({ [USER_CONFIG]: { args: ["--from-user-config"] } });

    await expect(launch.resolveBrowserLaunchArgs({ AGENT_BROWSER_CONFIG: explicit })).resolves.toEqual({
      args: DEFAULT_ARGS,
      inheritedFrom: "none",
    });
    expect(readJsonFile.mock.calls).toEqual([[explicit]]);
  });

  it("lets the project's arguments replace the user's", async () => {
    mockConfigFiles({ [USER_CONFIG]: { args: ["--from-user-config"] }, [PROJECT_CONFIG]: { args: ["--from-project"] } });

    await expect(launch.resolveBrowserLaunchArgs({})).resolves.toEqual({
      args: ["--from-project", ...DEFAULT_ARGS],
      inheritedFrom: "agent-browser-config",
    });
  });

  it("keeps the user's arguments when the project's file sets none", async () => {
    mockConfigFiles({ [USER_CONFIG]: { args: ["--from-user-config"] }, [PROJECT_CONFIG]: { headed: true } });

    await expect(launch.resolveBrowserLaunchArgs({})).resolves.toEqual({
      args: ["--from-user-config", ...DEFAULT_ARGS],
      inheritedFrom: "agent-browser-config",
    });
  });

  it.each<[string, unknown, string[]]>([
    ["a comma-separated string", "--no-sandbox, --lang=en-US", ["--no-sandbox", "--lang=en-US"]],
  ])("accepts `args` as %s", async (_label, args, expected) => {
    mockConfigFiles({ [USER_CONFIG]: { args } });

    await expect(launch.resolveBrowserLaunchArgs({})).resolves.toEqual({
      args: [...expected, ...DEFAULT_ARGS],
      inheritedFrom: "agent-browser-config",
    });
  });

  it.each<[string, Record<string, unknown>]>([
    ["no file exists", {}],
    ["the files set no `args`", { [USER_CONFIG]: { headed: true }, [PROJECT_CONFIG]: {} }],
    ["`args` is not a list of arguments", { [USER_CONFIG]: { args: 7 } }],
    ["the files do not hold an object", { [USER_CONFIG]: "--no-sandbox", [PROJECT_CONFIG]: null }],
  ])("has only the Bridge's own arguments when %s", async (_label, files) => {
    mockConfigFiles(files);

    await expect(launch.resolveBrowserLaunchArgs({})).resolves.toEqual({
      args: DEFAULT_ARGS,
      inheritedFrom: "none",
    });
  });

  it("answers again from its cache for the same environment", async () => {
    mockConfigFiles({ [USER_CONFIG]: { args: ["--no-sandbox"] } });

    const first = await launch.resolveBrowserLaunchArgs({ AGENT_BROWSER_ARGS: "" });
    const readsAfterFirst = readJsonFile.mock.calls.length;
    mockConfigFiles({ [USER_CONFIG]: { args: ["--changed"] } });
    const second = await launch.resolveBrowserLaunchArgs({ AGENT_BROWSER_ARGS: "" });

    expect(readsAfterFirst).toBe(2);
    expect(readJsonFile).toHaveBeenCalledTimes(readsAfterFirst);
    expect(second).toEqual(first);
  });

  it("does not answer a different environment from the cache", async () => {
    const explicit = testPath("agent-browser", "custom.json");
    mockConfigFiles({ [USER_CONFIG]: { args: ["--from-user-config"] }, [explicit]: { args: ["--from-explicit"] } });

    const fromFiles = await launch.resolveBrowserLaunchArgs({});
    const fromExplicit = await launch.resolveBrowserLaunchArgs({ AGENT_BROWSER_CONFIG: explicit });
    const fromEnvironment = await launch.resolveBrowserLaunchArgs({ AGENT_BROWSER_ARGS: "--from-environment" });

    expect(fromFiles.args).toEqual(["--from-user-config", ...DEFAULT_ARGS]);
    expect(fromExplicit.args).toEqual(["--from-explicit", ...DEFAULT_ARGS]);
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

      expect(launch.systemBrowserCandidates("linux", { PATH: [first, second].join(path.posix.delimiter) })).toEqual([
        ...packageInstalls,
        path.posix.join(first, "google-chrome-stable"),
        path.posix.join(first, "google-chrome"),
        path.posix.join(first, "microsoft-edge-stable"),
        path.posix.join(second, "google-chrome-stable"),
        path.posix.join(second, "google-chrome"),
        path.posix.join(second, "microsoft-edge-stable"),
      ]);
    });

    it("skips empty PATH entries", () => {
      const only = testPosixPath("opt", "tools", "bin");
      const delimiter = path.posix.delimiter;

      expect(launch.systemBrowserCandidates("linux", { PATH: `${delimiter}${only}${delimiter}${delimiter}` })).toEqual([
        ...packageInstalls,
        path.posix.join(only, "google-chrome-stable"),
        path.posix.join(only, "google-chrome"),
        path.posix.join(only, "microsoft-edge-stable"),
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

  it("uses the path from Settings, trimmed, before anything else", async () => {
    const configured = testPath("browsers", "chrome");
    isExecutableFile.mockResolvedValue(true);

    await expect(launch.resolveBrowserExecutable(
      { executablePath: `  ${configured}  ` },
      { ...detectionEnv, AGENT_BROWSER_EXECUTABLE_PATH: testPath("browsers", "from-env") },
    )).resolves.toStrictEqual({ path: configured, source: "settings" });
    expect(isExecutableFile).not.toHaveBeenCalled();
  });

  it.each([
    ["has no path", {}],
    ["has a blank path", { executablePath: "   " }],
  ])("uses AGENT_BROWSER_EXECUTABLE_PATH when Settings %s", async (_label, launchConfig) => {
    const fromEnvironment = testPath("browsers", "from-env");
    isExecutableFile.mockResolvedValue(true);

    await expect(launch.resolveBrowserExecutable(
      launchConfig,
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

  it("leaves the choice to agent-browser when no system browser is installed", async () => {
    const candidates = hostCandidates();

    const resolved = await launch.resolveBrowserExecutable({}, detectionEnv);

    expect(resolved).toStrictEqual({ source: "auto-detect" });
    expect(resolved).not.toHaveProperty("path");
    expect(isExecutableFile.mock.calls.map(([file]) => file)).toEqual(candidates);
  });

  it("remembers the system browser and looks again once the caches are reset", async () => {
    const candidates = hostCandidates();
    isExecutableFile.mockImplementation(async (file) => file === candidates[0]);

    await launch.resolveBrowserExecutable({}, detectionEnv);
    isExecutableFile.mockResolvedValue(false);
    await expect(launch.resolveBrowserExecutable({}, { ...detectionEnv }))
      .resolves.toStrictEqual({ path: candidates[0], source: "system" });
    expect(isExecutableFile).toHaveBeenCalledTimes(1);

    launch.resetBrowserLaunchCachesForTests();

    await expect(launch.resolveBrowserExecutable({}, detectionEnv)).resolves.toStrictEqual({ source: "auto-detect" });
  });
});

describe("buildBrowserEnv", () => {
  const target = {
    sessionName: "bridge-public-3",
    profileDir: testPath("browser-profiles", "public-3"),
  };

  it("names the namespace, session, profile and launch arguments of the target", async () => {
    const env = await launch.buildBrowserEnv(target, { KEEP_ME: "1", PATH: "" });

    expect(env).toStrictEqual({
      KEEP_ME: "1",
      PATH: "",
      AGENT_BROWSER_NAMESPACE: "copilot-bridge",
      AGENT_BROWSER_SESSION: "bridge-public-3",
      AGENT_BROWSER_PROFILE: target.profileDir,
      AGENT_BROWSER_ARGS: DEFAULT_ARGS.join("\n"),
    });
  });

  it("replaces a namespace, session and profile inherited from the base environment", async () => {
    const env = await launch.buildBrowserEnv(target, {
      AGENT_BROWSER_NAMESPACE: "someone-else",
      AGENT_BROWSER_SESSION: "default",
      AGENT_BROWSER_PROFILE: testPath("another-profile"),
    });

    expect(env).toMatchObject({
      AGENT_BROWSER_NAMESPACE: "copilot-bridge",
      AGENT_BROWSER_SESSION: "bridge-public-3",
      AGENT_BROWSER_PROFILE: target.profileDir,
    });
  });

  it("carries the arguments of AGENT_BROWSER_ARGS over, newline-separated, ahead of the Bridge's own", async () => {
    const env = await launch.buildBrowserEnv(target, { AGENT_BROWSER_ARGS: "--no-sandbox,--lang=en-US" });

    expect(env.AGENT_BROWSER_ARGS).toBe(["--no-sandbox", "--lang=en-US", ...DEFAULT_ARGS].join("\n"));
  });

  it("prefers the target's executable to the base environment's", async () => {
    const configured = testPath("browsers", "chrome");

    const env = await launch.buildBrowserEnv(
      { ...target, executablePath: configured },
      { AGENT_BROWSER_EXECUTABLE_PATH: testPath("browsers", "from-env") },
    );

    expect(env.AGENT_BROWSER_EXECUTABLE_PATH).toBe(configured);
  });

  it("keeps the base environment's executable when the target has none", async () => {
    const fromEnvironment = testPath("browsers", "from-env");

    const env = await launch.buildBrowserEnv(target, { AGENT_BROWSER_EXECUTABLE_PATH: fromEnvironment });

    expect(env.AGENT_BROWSER_EXECUTABLE_PATH).toBe(fromEnvironment);
  });

  it("sets no executable when neither names one and no system browser is installed", async () => {
    const env = await launch.buildBrowserEnv(target, { PATH: "" });

    expect(env).not.toHaveProperty("AGENT_BROWSER_EXECUTABLE_PATH");
  });

  it("sets the system browser when one is installed and nothing else names an executable", async () => {
    const baseEnv = {
      ProgramFiles: testWindowsPath("Program Files"),
      PATH: testPosixPath("opt", "tools", "bin"),
    };
    const [firstCandidate] = launch.systemBrowserCandidates(os.platform(), baseEnv);
    isExecutableFile.mockImplementation(async (file) => file === firstCandidate);

    const env = await launch.buildBrowserEnv(target, baseEnv);

    expect(firstCandidate).toBeTruthy();
    expect(env.AGENT_BROWSER_EXECUTABLE_PATH).toBe(firstCandidate);
  });

  it("sets the idle timeout of the target, over one in the base environment", async () => {
    const env = await launch.buildBrowserEnv(
      { ...target, idleTimeoutMs: 90_000 },
      { AGENT_BROWSER_IDLE_TIMEOUT_MS: "5000" },
    );

    expect(env.AGENT_BROWSER_IDLE_TIMEOUT_MS).toBe("90000");
  });

  it("keeps a real idle timeout from the base environment when the target has none", async () => {
    const env = await launch.buildBrowserEnv(target, { AGENT_BROWSER_IDLE_TIMEOUT_MS: "120000" });

    expect(env.AGENT_BROWSER_IDLE_TIMEOUT_MS).toBe("120000");
  });

  it.each([
    ["empty", ""],
    ["blank", "   "],
  ])("drops an idle timeout that is %s in the base environment", async (_label, value) => {
    const env = await launch.buildBrowserEnv(target, { AGENT_BROWSER_IDLE_TIMEOUT_MS: value });

    expect(env).not.toHaveProperty("AGENT_BROWSER_IDLE_TIMEOUT_MS");
  });

  it("asks for a window when the target is headed", async () => {
    const env = await launch.buildBrowserEnv({ ...target, headed: true }, {});

    expect(env.AGENT_BROWSER_HEADED).toBe("true");
  });

  it.each([
    ["is not headed", { headed: false }],
    ["does not say", {}],
  ])("removes AGENT_BROWSER_HEADED from the base environment when the target %s", async (_label, headed) => {
    const env = await launch.buildBrowserEnv({ ...target, ...headed }, { AGENT_BROWSER_HEADED: "1" });

    expect(env).not.toHaveProperty("AGENT_BROWSER_HEADED");
  });

  it("does not change the base environment", async () => {
    const baseEnv: NodeJS.ProcessEnv = Object.freeze({
      KEEP_ME: "1",
      AGENT_BROWSER_HEADED: "1",
      AGENT_BROWSER_IDLE_TIMEOUT_MS: " ",
      AGENT_BROWSER_ARGS: "--no-sandbox",
      AGENT_BROWSER_SESSION: "default",
    });
    const before = { ...baseEnv };

    const env = await launch.buildBrowserEnv(
      { ...target, executablePath: testPath("browsers", "chrome"), idleTimeoutMs: 1_000 },
      baseEnv,
    );

    expect(env).not.toBe(baseEnv);
    expect(baseEnv).toStrictEqual(before);
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

  it("describes the browser agent-browser downloads when no executable is chosen", async () => {
    await expect(launch.describeBrowserBuild({ source: "auto-detect" }))
      .resolves.toStrictEqual({ kind: "chrome-for-testing" });
    expect(readModifiedAt).not.toHaveBeenCalled();
    expect(readBrowserVersion).not.toHaveBeenCalled();
  });

  it.each<[string, string, string]>([
    ["edge", "msedge.exe", path.win32.join(testWindowsPath("Program Files"), "Microsoft", "Edge", "Application", "msedge.exe")],
    ["chrome", "google-chrome-stable", testPosixPath("opt", "tools", "google-chrome-stable")],
    ["chromium", "chromium-browser", testPosixPath("snap", "bin", "chromium-browser")],
    ["unknown", "a neutral name", neutralBinary()],
  ])("tells only the kind (%s) from the path of %s when the file cannot be read", async (kind, _label, executablePath) => {
    readBrowserVersion.mockResolvedValue("Google Chrome for Testing 1.2.3.4");

    await expect(launch.describeBrowserBuild({ path: executablePath, source: "settings" }))
      .resolves.toStrictEqual({ kind });
    expect(readModifiedAt).toHaveBeenCalledWith(executablePath);
    expect(readBrowserVersion).not.toHaveBeenCalled();
  });

  it.each<[string, string]>([
    ["Google Chrome for Testing 1.2.3.4", "chrome-for-testing"],
    ["Microsoft Edge 1.2.3.4", "edge"],
    ["Chromium 1.2.3.4", "chromium"],
    ["Google Chrome 1.2.3.4", "chrome"],
    ["Vivaldi 1.2.3.4", "unknown"],
  ])("reads \"%s\" as %s and reports the version", async (version, kind) => {
    const executablePath = neutralBinary();
    readModifiedAt.mockResolvedValue(NOW);
    readBrowserVersion.mockResolvedValue(version);

    await expect(launch.describeBrowserBuild({ path: executablePath, source: "system" }))
      .resolves.toStrictEqual({ kind, version, installedDaysAgo: 0 });
    expect(readBrowserVersion).toHaveBeenCalledWith(executablePath);
  });

  it("recognises Chrome for Testing by its version even when it is installed as chrome", async () => {
    readModifiedAt.mockResolvedValue(NOW);
    readBrowserVersion.mockResolvedValue("Google Chrome for Testing 1.2.3.4");

    await expect(launch.describeBrowserBuild({ path: neutralBinary("chrome"), source: "environment" }))
      .resolves.toMatchObject({ kind: "chrome-for-testing", version: "Google Chrome for Testing 1.2.3.4" });
  });

  it.each<[string, string[]]>([
    ["chrome", ["Google", "Chrome", "Application", "chrome.exe"]],
    ["edge", ["Microsoft", "Edge", "Application", "msedge.exe"]],
  ])("tells %s from the path when the version is only a number, as on Windows", async (kind, segments) => {
    readModifiedAt.mockResolvedValue(NOW);
    readBrowserVersion.mockResolvedValue("154.0.8037.97");

    await expect(launch.describeBrowserBuild({
      path: path.win32.join(testWindowsPath("Program Files"), ...segments),
      source: "system",
    })).resolves.toStrictEqual({ kind, version: "154.0.8037.97", installedDaysAgo: 0 });
  });

  it("leaves the version out when the browser does not report one", async () => {
    readModifiedAt.mockResolvedValue(NOW - 2 * DAY);

    await expect(launch.describeBrowserBuild({ path: neutralBinary("msedge"), source: "system" }))
      .resolves.toStrictEqual({ kind: "edge", installedDaysAgo: 2 });
  });

  it.each<[string, number, number]>([
    ["23 hours ago", 23 * HOUR, 0],
    ["exactly one day ago", DAY, 1],
    ["almost four days ago", 3 * DAY + 23 * HOUR, 3],
  ])("counts whole days since the file was replaced %s", async (_label, ageMs, installedDaysAgo) => {
    readModifiedAt.mockResolvedValue(NOW - ageMs);

    await expect(launch.describeBrowserBuild({ path: neutralBinary(), source: "system" }))
      .resolves.toMatchObject({ installedDaysAgo });
  });

  it("never reports a negative age for a file dated in the future", async () => {
    readModifiedAt.mockResolvedValue(NOW + 3 * DAY);

    const build = await launch.describeBrowserBuild({ path: neutralBinary(), source: "system" });

    expect(build.installedDaysAgo).toBe(0);
  });

  it("asks the browser for its version once while the file stays the same", async () => {
    const executable = { path: neutralBinary(), source: "system" as const };
    readModifiedAt.mockResolvedValue(NOW - DAY);
    readBrowserVersion.mockResolvedValue("Google Chrome 1.2.3.4");

    const first = await launch.describeBrowserBuild(executable);
    vi.setSystemTime(NOW + 2 * DAY);
    const second = await launch.describeBrowserBuild(executable);

    expect(readBrowserVersion).toHaveBeenCalledTimes(1);
    expect(first).toStrictEqual({ kind: "chrome", version: "Google Chrome 1.2.3.4", installedDaysAgo: 1 });
    // The age is worked out on every call; only the version is remembered.
    expect(second).toStrictEqual({ kind: "chrome", version: "Google Chrome 1.2.3.4", installedDaysAgo: 3 });
  });

  it("asks again when the file has been replaced", async () => {
    const executable = { path: neutralBinary(), source: "system" as const };
    readModifiedAt.mockResolvedValue(NOW - 30 * DAY);
    readBrowserVersion.mockResolvedValue("Google Chrome 1.2.3.4");
    await launch.describeBrowserBuild(executable);

    readModifiedAt.mockResolvedValue(NOW - HOUR);
    readBrowserVersion.mockResolvedValue("Google Chrome 1.2.3.5");

    await expect(launch.describeBrowserBuild(executable))
      .resolves.toStrictEqual({ kind: "chrome", version: "Google Chrome 1.2.3.5", installedDaysAgo: 0 });
    expect(readBrowserVersion).toHaveBeenCalledTimes(2);
  });

  it("asks each executable for its own version", async () => {
    const chrome = neutralBinary("first");
    const edge = neutralBinary("second");
    readModifiedAt.mockResolvedValue(NOW);
    readBrowserVersion.mockImplementation(async (file) => (file === chrome ? "Google Chrome 1.2.3.4" : "Microsoft Edge 5.6.7.8"));

    await expect(launch.describeBrowserBuild({ path: chrome, source: "system" }))
      .resolves.toMatchObject({ kind: "chrome", version: "Google Chrome 1.2.3.4" });
    await expect(launch.describeBrowserBuild({ path: edge, source: "system" }))
      .resolves.toMatchObject({ kind: "edge", version: "Microsoft Edge 5.6.7.8" });
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

  it.each<[string, unknown]>([
    ["false", false],
    ["the string \"true\"", "true"],
    ["1", 1],
  ])("is not headed when `headed` is %s", (_label, headed) => {
    const browser = { headed } as { headed?: boolean };

    expect(launch.getBrowserLaunchConfig({ browser })).toStrictEqual({});
  });

  it.each<[string, Parameters<typeof launch.getBrowserLaunchConfig>[0]]>([
    ["no settings", undefined],
    ["settings without a browser section", {}],
    ["a null browser section", { browser: null }],
  ])("is empty for %s", (_label, settings) => {
    expect(launch.getBrowserLaunchConfig(settings)).toStrictEqual({});
  });
});
