import { join, sep } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testCopilotHome } from "./test-paths.js";

const COPILOT_HOME = testCopilotHome();
const PUBLIC_SLOT_1_PROFILE = join(COPILOT_HOME, "browser-public", "slot-1");

function createBrowserToolContext(settings = {}, telemetryStore?: { recordSpan: ReturnType<typeof vi.fn> }) {
  return {
    copilotHome: COPILOT_HOME,
    settingsStore: { getSettings: () => settings },
    ...(telemetryStore ? { telemetryStore } : {}),
  } as any;
}

const execMock = vi.fn();
const execFileMock = vi.fn();
const cpMock = vi.fn();
const mkdirMock = vi.fn();
const readdirMock = vi.fn();
const rmMock = vi.fn();
const statMock = vi.fn();
const readlinkSyncMock = vi.fn();
const readFileSyncMock = vi.fn();
const unlinkSyncMock = vi.fn();
const rmSyncMock = vi.fn();
const lstatSyncMock = vi.fn();
const killMock = vi.spyOn(process, "kill");

vi.mock("node:child_process", () => ({
  exec: execMock,
  execFile: execFileMock,
}));

vi.mock("node:fs/promises", () => ({
  cp: cpMock,
  mkdir: mkdirMock,
  readdir: readdirMock,
  rm: rmMock,
  stat: statMock,
}));

vi.mock("node:fs", () => ({
  readFileSync: readFileSyncMock,
  readlinkSync: readlinkSyncMock,
  unlinkSync: unlinkSyncMock,
  rmSync: rmSyncMock,
  lstatSync: lstatSyncMock,
}));

/**
 * Directories the code under test created and has not removed again. The mocked filesystem
 * keeps this up to date, so a test can tell whether a directory still exists.
 */
const directories = new Set<string>();

function removeDirectoryTree(target: string): void {
  for (const directory of directories) {
    if (directory === target || directory.startsWith(`${target}${sep}`)) directories.delete(directory);
  }
}

/** One agent-browser command as the Bridge issued it, without the trailing `--json`. */
interface BrowserCall {
  /** The command's name: "open", "eval", "snapshot", "close", "get url", "get title". */
  command: string;
  args: string[];
  session?: string;
  profile?: string;
  headed?: string;
}

/** What agent-browser prints for a command, or the text it fails with. */
type BrowserReply = string | { fails: string };

/**
 * What the page-check script (`pageSignalsScript` in browser-page-check.ts) returns for a page,
 * as the JSON text it produces. Without overrides it is an ordinary page with content.
 */
function pageSignals(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    url: "https://example.com/",
    title: "Example Domain",
    status: 200,
    textLength: 4_200,
    text: "Example Domain. This domain is for use in illustrative examples in documents.",
    inputs: 0,
    links: 18,
    scripts: 4,
    captchaSolved: false,
    markers: [],
    ...overrides,
  });
}

/** agent-browser's `--json` output for an `eval` whose script returned `result`. */
function evalOutput(result: unknown): string {
  return JSON.stringify({ success: true, data: { result }, error: null });
}

const CLOUDFLARE_CHECK = {
  signals: {
    url: "https://shop.example.com/cart",
    title: "Just a moment...",
    status: 403,
    textLength: 96,
    text: "shop.example.com Verifying you are human. This may take a few seconds.",
    links: 1,
    markers: ["cloudflare_challenge"],
  },
  block: { kind: "challenge", by: "Cloudflare", status: 403 },
} as const;

const SITE_REFUSAL = {
  signals: {
    url: "https://tickets.example.com/events",
    title: "Access Denied",
    status: 403,
    textLength: 180,
    text: "Access Denied You don't have permission to access this page. Reference #18.2f1a3b17 "
      + "https://errors.edgesuite.net/18.2f1a3b17",
    links: 1,
    markers: [],
  },
  block: { kind: "denied", by: "This site", status: 403 },
} as const;

const FORM_WITH_CAPTCHA = {
  signals: {
    url: "https://forms.example.com/contact",
    title: "Contact us",
    inputs: 4,
    links: 30,
    markers: ["recaptcha"],
  },
  block: { kind: "captcha", by: "reCAPTCHA", status: 200 },
} as const;

/**
 * Stands in for the agent-browser binary and records what it was asked. `reply` answers the
 * commands a test cares about. Every other command succeeds: the page check reads an ordinary
 * page, and the browser reports the blank page it starts on.
 */
function mockAgentBrowser(
  reply: (call: BrowserCall, earlier: readonly BrowserCall[]) => BrowserReply | undefined = () => undefined,
): BrowserCall[] {
  const calls: BrowserCall[] = [];
  execFileMock.mockImplementation((_file: string, rawArgs: string[], options: any, cb: (err: any, result?: { stdout: string; stderr: string }) => void) => {
    // The Bridge also lists processes through execFile; every agent-browser command ends in --json.
    if (rawArgs.at(-1) !== "--json") {
      cb(null, { stdout: "ok", stderr: "" });
      return {} as any;
    }
    const args = rawArgs.slice(0, -1);
    const call: BrowserCall = {
      command: args[0] === "get" ? `get ${args[1]}` : args[0],
      args,
      session: options?.env?.AGENT_BROWSER_SESSION,
      profile: options?.env?.AGENT_BROWSER_PROFILE,
      headed: options?.env?.AGENT_BROWSER_HEADED,
    };
    const answer = reply(call, calls) ?? defaultReply(call);
    calls.push(call);
    if (typeof answer === "string") cb(null, { stdout: answer, stderr: "" });
    else cb({ stderr: answer.fails });
    return {} as any;
  });
  return calls;
}

function defaultReply(call: BrowserCall): BrowserReply {
  if (call.command === "eval") return evalOutput(pageSignals());
  if (call.command === "get url") return "about:blank";
  if (call.command === "get title") return "";
  if (call.command === "open") return "opened";
  if (call.command === "snapshot") return "snapshot";
  if (call.command === "close") return "closed";
  return "ok";
}

/**
 * Runs a fetch without its real waits: the page check gives a human check five seconds to pass
 * by itself. Only the timers are faked; every round lets the mocked commands and the waits make
 * progress until the fetch has settled.
 */
async function withoutWaits<T>(fetch: () => T | Promise<T>): Promise<T> {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    let settled = false;
    const outcome = Promise.resolve(fetch()).finally(() => {
      settled = true;
    });
    outcome.catch(() => undefined);
    while (!settled) {
      await vi.advanceTimersToNextTimerAsync();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return await outcome;
  } finally {
    vi.useRealTimers();
  }
}

/** The commands from the tool's `open` on, which is where the readiness handshake ends. */
function fromOpen(calls: readonly BrowserCall[]): string[] {
  const commands = calls.map((call) => call.command);
  return commands.slice(commands.indexOf("open"));
}

describe("browser_fetch tool", () => {
  beforeEach(() => {
    vi.resetModules();
    execMock.mockReset();
    execFileMock.mockReset();
    cpMock.mockReset();
    mkdirMock.mockReset();
    readdirMock.mockReset();
    rmMock.mockReset();
    statMock.mockReset();
    readlinkSyncMock.mockReset();
    readFileSyncMock.mockReset();
    unlinkSyncMock.mockReset();
    rmSyncMock.mockReset();
    lstatSyncMock.mockReset();
    killMock.mockReset();
    killMock.mockImplementation(((pid: number, signal?: number | NodeJS.Signals) => {
      if (signal === 0) return true as never;
      return true as never;
    }) as any);
    directories.clear();
    cpMock.mockResolvedValue(undefined);
    mkdirMock.mockImplementation(async (directory: string) => {
      directories.add(directory);
    });
    readdirMock.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
    rmMock.mockImplementation(async (target: string) => removeDirectoryTree(target));
    rmSyncMock.mockImplementation((target: string) => removeDirectoryTree(target));
    lstatSyncMock.mockImplementation((target: string, options?: { throwIfNoEntry?: boolean }) => {
      if (directories.has(target)) return { isDirectory: () => true };
      if (options?.throwIfNoEntry === false) return undefined;
      throw Object.assign(new Error(`ENOENT: no such file or directory, lstat '${target}'`), { code: "ENOENT" });
    });
    statMock.mockResolvedValue({ mtimeMs: Date.now() });
    execMock.mockImplementation((_cmd: string, _options: any, cb: (err: any, result?: { stdout: string; stderr: string }) => void) => {
      cb(null, { stdout: "agent-browser\n", stderr: "" });
      return {} as any;
    });
  });

  async function loadBrowserFetch(settings = {}, telemetryStore?: { recordSpan: ReturnType<typeof vi.fn> }) {
    const mod = await import("../browser-fetch-tools.js");
    const { describePageBlock } = await import("../browser-page-check.js");
    const [tool] = mod.createBrowserFetchTools(createBrowserToolContext(settings, telemetryStore));
    return { tool, describePageBlock };
  }

  it("tells the agent that the public browser is not signed in and that a block is reported", async () => {
    const { tool } = await loadBrowserFetch();

    expect(tool.name).toBe("browser_fetch");
    expect(tool.description).toContain("`blocked`");
    expect(tool.description).toMatch(/public browser[^.]*not signed in/i);
  });

  it("requires a reason for authenticated fetches", async () => {
    const { tool } = await loadBrowserFetch();

    const result = await tool.handler({
      url: "https://msazure.visualstudio.com/One/",
      context: "authenticated",
    }, {} as any);

    expect(result).toMatchObject({
      resultType: "failure",
      textResultForLlm: "reason is required for authenticated browser access",
    });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("returns an install error when agent-browser is unavailable", async () => {
    execMock.mockImplementation((_cmd: string, _options: any, cb: (err: any) => void) => {
      cb(new Error("missing"));
      return {} as any;
    });
    const calls = mockAgentBrowser();
    const { tool } = await loadBrowserFetch();

    const result = await tool.handler({ url: "https://example.com/" }, {} as any) as any;

    expect(result.resultType).toBe("failure");
    expect(result.textResultForLlm).toContain("npm install -g agent-browser");
    expect(calls).toEqual([]);
  });

  it("fetches an authenticated page in the signed-in browser, headed when the setting says so", async () => {
    const calls = mockAgentBrowser((call) => (call.command === "eval"
      ? evalOutput(pageSignals({ url: "https://dev.azure.com/acme/_git/app", title: "app - Repos" }))
      : undefined));
    const { tool } = await loadBrowserFetch({ browser: { headed: true } });

    const result = await tool.handler({
      url: "https://dev.azure.com/acme/_git/app",
      context: "authenticated",
      reason: "Read the repository page",
    }, {} as any) as any;

    expect(result).toEqual({
      url: "https://dev.azure.com/acme/_git/app",
      title: "app - Repos",
      snapshot: "snapshot",
      context: "authenticated",
    });
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.headed === "true")).toBe(true);
    expect(calls.every((call) => !call.session?.includes("copilot-bridge-public-"))).toBe(true);
    expect(calls.every((call) => call.profile === join(COPILOT_HOME, "browser-profile"))).toBe(true);
  });

  it.each([
    ["cannot be opened", "open", "net::ERR_NAME_NOT_RESOLVED", "Failed to open URL: net::ERR_NAME_NOT_RESOLVED"],
    ["cannot be captured", "snapshot", "snapshot failed", "Failed to capture page: snapshot failed"],
  ])("fails for a page that %s, in the public browser, and keeps its profile", async (_name, command, error, message) => {
    const calls = mockAgentBrowser((call) => (call.command === command ? { fails: error } : undefined));
    const { tool } = await loadBrowserFetch();

    const result = await tool.handler({ url: "https://nowhere.invalid/", selector: "#content" }, {} as any) as any;

    expect(result).toMatchObject({ resultType: "failure", textResultForLlm: message });
    // The session log, which the user can open, says what was asked for.
    expect(result.sessionLog).toContain("https://nowhere.invalid/");
    expect(result.sessionLog).toContain("#content");
    expect(calls.every((call) => call.session?.includes("copilot-bridge-public-"))).toBe(true);
    expect(calls.at(-1)).toMatchObject({ command: "close", profile: PUBLIC_SLOT_1_PROFILE });
    expect(directories).toContain(PUBLIC_SLOT_1_PROFILE);
    expect(rmSyncMock).not.toHaveBeenCalled();
  });

  it("says so when the page that could not be opened is the site's refusal", async () => {
    // A refusal without a body fails the navigation; the browser still shows a page for it.
    mockAgentBrowser((call) => {
      if (call.command === "open") return { fails: "Navigation failed: net::ERR_HTTP_RESPONSE_CODE_FAILURE" };
      if (call.command === "eval") return evalOutput(pageSignals(SITE_REFUSAL.signals));
      return undefined;
    });
    const { tool } = await loadBrowserFetch();

    const result = await tool.handler({ url: "https://shop.example.com/" }, {} as any) as any;

    expect(result.resultType).toBe("failure");
    expect(result.blocked).toMatchObject({ kind: "denied" });
    expect(result.textResultForLlm).toContain("Failed to open URL");
    expect(result.textResultForLlm).toContain("refused this request");
  });

  it("closes the public browser after each fetch and uses the same profile for the next", async () => {
    const calls = mockAgentBrowser();
    const { tool } = await loadBrowserFetch();

    await tool.handler({ url: "https://example.com/first" }, {} as any);
    const firstFetchCalls = calls.length;
    await tool.handler({ url: "https://example.com/second" }, {} as any);

    const opens = calls.filter((call) => call.command === "open");
    expect(opens.map((call) => call.args[1])).toEqual(["https://example.com/first", "https://example.com/second"]);
    expect(opens[1].session).toBe(opens[0].session);
    expect(calls.every((call) => call.profile === PUBLIC_SLOT_1_PROFILE)).toBe(true);
    // Each fetch ends by closing its browser, so the second starts a new one on the kept profile.
    expect(calls[firstFetchCalls - 1].command).toBe("close");
    expect(calls.at(-1)?.command).toBe("close");
    expect([...directories].filter((directory) => directory.includes("browser-public"))).toEqual([PUBLIC_SLOT_1_PROFILE]);
    expect(rmSyncMock).not.toHaveBeenCalled();
  });

  describe("page check", () => {
    it("takes the address and title from the page check and asks the browser for neither", async () => {
      const calls = mockAgentBrowser((call) => (call.command === "eval"
        ? evalOutput(pageSignals({ url: "https://example.com/articles/42", title: "Article 42" }))
        : undefined));
      const { tool } = await loadBrowserFetch();

      const result = await tool.handler({ url: "https://example.com/a/42" }, {} as any) as any;

      // The address is the one the page ended up on, which the request only redirected to.
      expect(result).toEqual({
        url: "https://example.com/articles/42",
        title: "Article 42",
        snapshot: "snapshot",
        context: "public",
      });
      const afterOpen = fromOpen(calls);
      expect(afterOpen).not.toContain("get url");
      expect(afterOpen).not.toContain("get title");
    });

    it("asks the browser for the address and title when the page cannot be checked", async () => {
      let opened = false;
      mockAgentBrowser((call) => {
        if (call.command === "open") opened = true;
        if (call.command === "eval") return { fails: "Execution context was destroyed" };
        if (opened && call.command === "get url") return "https://example.com/landing";
        if (opened && call.command === "get title") return "Landing";
        return undefined;
      });
      const { tool } = await loadBrowserFetch();

      const result = await tool.handler({ url: "https://example.com/start" }, {} as any) as any;

      expect(result).toEqual({
        url: "https://example.com/landing",
        title: "Landing",
        snapshot: "snapshot",
        context: "public",
      });
    });

    it("returns the requested address and no title when neither the page check nor the browser can tell", async () => {
      let opened = false;
      mockAgentBrowser((call) => {
        if (call.command === "open") opened = true;
        if (call.command === "eval") return { fails: "Execution context was destroyed" };
        if (opened && call.command.startsWith("get ")) return { fails: "No page" };
        return undefined;
      });
      const { tool } = await loadBrowserFetch();

      const result = await tool.handler({ url: "https://example.com/start" }, {} as any) as any;

      expect(result).toEqual({
        url: "https://example.com/start",
        title: undefined,
        snapshot: "snapshot",
        context: "public",
      });
    });

    it.each([
      ["a human check", { page: CLOUDFLARE_CHECK, field: "blocked", otherField: "captcha", userCanPass: true }],
      // Nothing names who refused, so the site may only want its visitor signed in.
      ["a refusal", { page: SITE_REFUSAL, field: "blocked", otherField: "captcha", userCanPass: true }],
      ["a CAPTCHA inside an ordinary page", { page: FORM_WITH_CAPTCHA, field: "captcha", otherField: "blocked", userCanPass: true }],
    ] as const)("reports %s with what to do in a call that has no browser session", async (_name, { page, field, otherField, userCanPass }) => {
      mockAgentBrowser((call) => (call.command === "eval" ? evalOutput(pageSignals(page.signals)) : undefined));
      const { tool, describePageBlock } = await loadBrowserFetch();

      const result = await withoutWaits(() => tool.handler({ url: page.signals.url }, {} as any)) as any;

      // The page is still returned: a block is told to the agent, it is not a failed fetch.
      expect(result).toEqual({
        [field]: describePageBlock(page.block),
        url: page.signals.url,
        title: page.signals.title,
        snapshot: "snapshot",
        context: "public",
      });
      expect(result).not.toHaveProperty(otherField);
      const notice = result[field];
      expect(notice).toMatchObject({ kind: page.block.kind, by: page.block.by });
      // The browser of this call is gone when the agent reads the result, so there is no session to name.
      expect(notice.guidance).not.toContain("browserSessionId");
      for (const sessionTool of ["browser_session_start", "browser_session_handoff"]) {
        expect(notice.guidance.includes(sessionTool)).toBe(userCanPass);
      }
    });

    it("returns the page behind a human check that passes by itself within a moment", async () => {
      const telemetryStore = { recordSpan: vi.fn() };
      const behindTheCheck = { url: "https://shop.example.com/cart", title: "Your cart – Example Shop" };
      mockAgentBrowser((call, earlier) => {
        if (call.command === "snapshot") {
          return `snapshot after ${earlier.filter((other) => other.command === "eval").length} checks`;
        }
        if (call.command !== "eval") return undefined;
        const firstRead = !earlier.some((other) => other.command === "eval");
        return evalOutput(pageSignals(firstRead ? CLOUDFLARE_CHECK.signals : behindTheCheck));
      });
      const { tool } = await loadBrowserFetch({}, telemetryStore);

      const result = await withoutWaits(() => tool.handler({ url: CLOUDFLARE_CHECK.signals.url }, {} as any)) as any;

      // The snapshot is taken after the second read, so it shows the page and not the check.
      expect(result).toEqual({ ...behindTheCheck, snapshot: "snapshot after 2 checks", context: "public" });
      // Diagnostics counts blocked pages by this span: a check that passed is not one.
      const recorded = telemetryStore.recordSpan.mock.calls.map(([span]: any[]) => span);
      expect(recorded.filter((span: any) => span.name === "browser.page.blocked")).toEqual([]);
    });
  });
});
