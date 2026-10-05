// How the Bridge starts its browsers: which executable, with which arguments, in which
// agent-browser session. The Bridge sets all of it through the environment of every
// agent-browser command, so this is the one place that decides it.

import { homedir, platform } from "node:os";
import path from "node:path";

import type {
  BrowserBuildDiagnostics,
  BrowserBuildKind,
  BrowserExecutableSource,
  BrowserLaunchDiagnostics,
} from "../shared/browser-diagnostics.js";
import { isExecutableFile, readBrowserVersion, readJsonFile, readModifiedAt } from "./browser-launch-host.js";

export interface BrowserTarget {
  sessionName: string;
  profileDir: string;
  executablePath?: string;
  headed?: boolean;
  /**
   * How long the session's agent-browser daemon may go without a command before it closes its
   * browser and exits by itself. It counts from the last command it received, so it has to be
   * longer than any single command.
   */
  idleTimeoutMs?: number;
  /**
   * Shutting the target down also stops its agent-browser daemon. Set for browsers the Bridge
   * closes after each use, whose daemon would otherwise idle until its own timeout.
   */
  stopDaemonOnShutdown?: boolean;
}

export interface BrowserLaunchConfig {
  executablePath?: string;
  masterProfileDirectory?: string;
  headed?: boolean;
}

export interface ResolvedBrowserExecutable {
  /** Absent when the choice is left to agent-browser, which uses the Chrome it downloaded. */
  path?: string;
  source: BrowserExecutableSource;
}

export interface ResolvedBrowserLaunchArgs {
  args: string[];
  inheritedFrom: BrowserLaunchDiagnostics["inheritedFrom"];
}

type PlatformName = ReturnType<typeof platform>;

/**
 * Chrome no longer falls back to software WebGL by itself, so a host without a GPU has no WebGL
 * at all, which no real desktop looks like. The flag only allows the fallback; a working GPU is
 * still used.
 */
const BRIDGE_BROWSER_ARGS = ["--enable-unsafe-swiftshader"] as const;
/** While this Blink feature is on, `navigator.webdriver` is true and most bot checks stop there. */
const AUTOMATION_CONTROLLED = "AutomationControlled";
const DISABLE_BLINK_FEATURES = "--disable-blink-features=";
/**
 * A browser started without a URL opens its new-tab page. In Edge that is a news feed, which
 * loads on every launch and keeps a processor busy for as long as the tab exists.
 */
const BLANK_START_PAGE = "about:blank";

const SYSTEM_BROWSER_CACHE_MS = 60_000;
const INHERITED_ARGS_CACHE_MS = 5_000;

function normalizeConfiguredPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

export function getBrowserLaunchConfig(settings?: {
  browser?: BrowserLaunchConfig | null;
}): BrowserLaunchConfig {
  const executablePath = normalizeConfiguredPath(settings?.browser?.executablePath);
  const masterProfileDirectory = normalizeConfiguredPath(settings?.browser?.masterProfileDirectory);
  const headed = settings?.browser?.headed === true;
  return {
    ...(executablePath ? { executablePath } : {}),
    ...(masterProfileDirectory ? { masterProfileDirectory } : {}),
    ...(headed ? { headed } : {}),
  };
}

/**
 * Where the regular, self-updating browsers are installed, best first. A browser that is on
 * the release channel and keeps itself current is what sites expect to see; the Chrome for
 * Testing build agent-browser downloads identifies itself as such and never updates.
 */
export function systemBrowserCandidates(
  platformName: PlatformName,
  env: NodeJS.ProcessEnv,
  home = homedir(),
): string[] {
  if (platformName === "win32") {
    const roots = [env.ProgramFiles, env["ProgramFiles(x86)"], env.LOCALAPPDATA]
      .filter((root): root is string => !!root?.trim());
    return [
      ...roots.map((root) => path.win32.join(root, "Google", "Chrome", "Application", "chrome.exe")),
      ...roots.map((root) => path.win32.join(root, "Microsoft", "Edge", "Application", "msedge.exe")),
    ];
  }
  if (platformName === "darwin") {
    const chrome = path.posix.join("Google Chrome.app", "Contents", "MacOS", "Google Chrome");
    const edge = path.posix.join("Microsoft Edge.app", "Contents", "MacOS", "Microsoft Edge");
    return [
      path.posix.join("/Applications", chrome),
      path.posix.join(home, "Applications", chrome),
      path.posix.join("/Applications", edge),
    ];
  }
  // Package installs first, so one made later takes over from a copy in the user's own folders.
  const onPath = (env.PATH ?? "").split(path.posix.delimiter).filter(Boolean).flatMap((directory) =>
    ["google-chrome-stable", "google-chrome", "microsoft-edge-stable"]
      .map((name) => path.posix.join(directory, name)));
  return [
    "/opt/google/chrome/chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/opt/microsoft/msedge/msedge",
    "/usr/bin/microsoft-edge-stable",
    ...onPath,
  ];
}

let systemBrowser: { key: string; expiresAt: number; path: Promise<string | undefined> } | undefined;

function findSystemBrowser(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  const candidates = systemBrowserCandidates(platform(), env);
  const key = candidates.join("\n");
  const now = Date.now();
  if (systemBrowser?.key === key && systemBrowser.expiresAt > now) return systemBrowser.path;
  const found = (async () => {
    for (const candidate of candidates) {
      if (await isExecutableFile(candidate)) return candidate;
    }
    return undefined;
  })();
  systemBrowser = { key, expiresAt: now + SYSTEM_BROWSER_CACHE_MS, path: found };
  return found;
}

/** The executable a Bridge browser runs: the configured one, else the system's own browser. */
export async function resolveBrowserExecutable(
  launchConfig: BrowserLaunchConfig = {},
  env: NodeJS.ProcessEnv = process.env,
): Promise<ResolvedBrowserExecutable> {
  const settingsPath = normalizeConfiguredPath(launchConfig.executablePath);
  if (settingsPath) return { path: settingsPath, source: "settings" };
  const environmentPath = normalizeConfiguredPath(env.AGENT_BROWSER_EXECUTABLE_PATH);
  if (environmentPath) return { path: environmentPath, source: "environment" };
  const systemPath = await findSystemBrowser(env);
  return systemPath ? { path: systemPath, source: "system" } : { source: "auto-detect" };
}

/** Splits arguments the way agent-browser does: by newlines when there are any, else by commas. */
export function parseBrowserArgs(value: unknown): string[] {
  const parts = Array.isArray(value)
    ? value.filter((part): part is string => typeof part === "string")
    : typeof value === "string"
      ? value.split(value.includes("\n") ? /\r?\n/ : ",")
      : [];
  return parts.map((part) => part.trim()).filter(Boolean);
}

/** Newline-separated, so an argument may itself contain commas. */
export function formatBrowserArgs(args: readonly string[]): string {
  return args.join("\n");
}

/** The arguments the deployment asked for, completed with the ones every Bridge browser gets. */
export function composeBrowserLaunchArgs(inherited: readonly string[]): string[] {
  const args = inherited.filter((arg) => arg !== BLANK_START_PAGE);
  // Chrome honours only the last occurrence of a switch, so the feature joins an existing list.
  const blinkIndex = args.reduce((last, arg, index) => (arg.startsWith(DISABLE_BLINK_FEATURES) ? index : last), -1);
  if (blinkIndex === -1) {
    args.push(`${DISABLE_BLINK_FEATURES}${AUTOMATION_CONTROLLED}`);
  } else {
    const features = args[blinkIndex].slice(DISABLE_BLINK_FEATURES.length).split(",").filter(Boolean);
    if (!features.includes(AUTOMATION_CONTROLLED)) {
      args[blinkIndex] = `${DISABLE_BLINK_FEATURES}${[...features, AUTOMATION_CONTROLLED].join(",")}`;
    }
  }
  for (const arg of BRIDGE_BROWSER_ARGS) {
    if (!args.includes(arg)) args.push(arg);
  }
  args.push(BLANK_START_PAGE);
  return args;
}

/**
 * The `args` of agent-browser's own configuration files. The Bridge always sets
 * AGENT_BROWSER_ARGS, which replaces them, so it has to carry them over itself: a deployment
 * that needs `--no-sandbox` usually says so there.
 */
async function readAgentBrowserConfigArgs(env: NodeJS.ProcessEnv): Promise<string[] | undefined> {
  const explicit = normalizeConfiguredPath(env.AGENT_BROWSER_CONFIG);
  // The project file overrides the user's, as it does in agent-browser.
  const files = explicit
    ? [explicit]
    : [path.join(homedir(), ".agent-browser", "config.json"), path.resolve("agent-browser.json")];
  let args: string[] | undefined;
  for (const file of files) {
    // A missing or unreadable file configures nothing, as for agent-browser.
    const parsed = await readJsonFile(file) as { args?: unknown } | null | undefined;
    if (parsed && typeof parsed === "object" && parsed.args !== undefined) args = parseBrowserArgs(parsed.args);
  }
  return args;
}

let inheritedArgs: { key: string; expiresAt: number; value: Promise<ResolvedBrowserLaunchArgs> } | undefined;

export function resolveBrowserLaunchArgs(env: NodeJS.ProcessEnv = process.env): Promise<ResolvedBrowserLaunchArgs> {
  const fromEnvironment = env.AGENT_BROWSER_ARGS?.trim();
  const key = `${fromEnvironment ?? ""}\u0000${env.AGENT_BROWSER_CONFIG ?? ""}`;
  const now = Date.now();
  if (inheritedArgs?.key === key && inheritedArgs.expiresAt > now) return inheritedArgs.value;
  const value = (async (): Promise<ResolvedBrowserLaunchArgs> => {
    if (fromEnvironment) {
      return { args: composeBrowserLaunchArgs(parseBrowserArgs(fromEnvironment)), inheritedFrom: "environment" };
    }
    const fromConfig = await readAgentBrowserConfigArgs(env);
    return fromConfig?.length
      ? { args: composeBrowserLaunchArgs(fromConfig), inheritedFrom: "agent-browser-config" }
      : { args: composeBrowserLaunchArgs([]), inheritedFrom: "none" };
  })();
  inheritedArgs = { key, expiresAt: now + INHERITED_ARGS_CACHE_MS, value };
  return value;
}

/** The environment of an agent-browser command that acts on the given target. */
export async function buildBrowserEnv(
  target: BrowserTarget,
  baseEnv: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
  const [executable, launchArgs] = await Promise.all([
    resolveBrowserExecutable({ executablePath: target.executablePath }, baseEnv),
    resolveBrowserLaunchArgs(baseEnv),
  ]);
  const env: NodeJS.ProcessEnv = {
    ...baseEnv,
    AGENT_BROWSER_NAMESPACE: "copilot-bridge",
    AGENT_BROWSER_SESSION: target.sessionName,
    AGENT_BROWSER_PROFILE: target.profileDir,
    AGENT_BROWSER_ARGS: formatBrowserArgs(launchArgs.args),
    ...(executable.path ? { AGENT_BROWSER_EXECUTABLE_PATH: executable.path } : {}),
    ...(target.idleTimeoutMs !== undefined ? { AGENT_BROWSER_IDLE_TIMEOUT_MS: String(target.idleTimeoutMs) } : {}),
  };
  if (target.headed) {
    env.AGENT_BROWSER_HEADED = "true";
  } else {
    delete env.AGENT_BROWSER_HEADED;
  }
  // A blank value, as in a copied .env.example, means no setting rather than a setting of nothing.
  if (!env.AGENT_BROWSER_IDLE_TIMEOUT_MS?.trim()) delete env.AGENT_BROWSER_IDLE_TIMEOUT_MS;
  return env;
}

function browserBuildKind(description: string): BrowserBuildKind {
  if (/for testing/i.test(description)) return "chrome-for-testing";
  if (/edge/i.test(description)) return "edge";
  if (/chromium/i.test(description)) return "chromium";
  if (/chrome/i.test(description)) return "chrome";
  return "unknown";
}

const browserBuilds = new Map<string, Promise<BrowserBuildDiagnostics>>();

/** What the browser is and how fresh, for the diagnostics page. */
export async function describeBrowserBuild(executable: ResolvedBrowserExecutable): Promise<BrowserBuildDiagnostics> {
  if (!executable.path) return { kind: "chrome-for-testing" };
  const executablePath = executable.path;
  const modifiedAtMs = await readModifiedAt(executablePath);
  if (modifiedAtMs === undefined) return { kind: browserBuildKind(executablePath) };
  const key = `${executablePath}\u0000${modifiedAtMs}`;
  let build = browserBuilds.get(key);
  if (!build) {
    build = (async (): Promise<BrowserBuildDiagnostics> => {
      const version = await readBrowserVersion(executablePath);
      return {
        kind: browserBuildKind(`${version ?? ""} ${executablePath}`),
        ...(version ? { version } : {}),
      };
    })();
    browserBuilds.clear();
    browserBuilds.set(key, build);
  }
  return {
    ...(await build),
    installedDaysAgo: Math.max(0, Math.floor((Date.now() - modifiedAtMs) / 86_400_000)),
  };
}

export function resetBrowserLaunchCachesForTests(): void {
  systemBrowser = undefined;
  inheritedArgs = undefined;
  browserBuilds.clear();
}
