import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { testCopilotHome } from "./test-paths.js";

const COPILOT_HOME = testCopilotHome();

function createBrowserToolContext(telemetryStore?: { recordSpan: ReturnType<typeof vi.fn> }) {
  return {
    copilotHome: COPILOT_HOME,
    settingsStore: { getSettings: () => ({}) },
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
}));

type Engine = "google" | "bing" | "duckduckgo";

/** One agent-browser command as the Bridge issued it, without the trailing `--json`. */
interface BrowserCall {
  /** The command's name: "open", "eval", "snapshot", "close", "get url", "get title". */
  command: string;
  args: string[];
  session?: string;
  /** The search engine whose page was open when the command ran. */
  engine?: Engine;
}

/** What agent-browser prints for a command, or the text it fails with. */
type BrowserReply = string | { fails: string };

/** What a search engine answers a query with, as far as the browser can tell. */
interface EnginePage {
  /** What the page check reads, as changes to an ordinary results page at the address that was opened. */
  signals?: Record<string, unknown>;
  /** The answer to the page check when it does not get to read the page; wins over `signals`. */
  pageCheck?: BrowserReply;
  /** The snapshot of the results area. Recognisable results unless a test says otherwise. */
  snapshot?: BrowserReply;
}

/** What the agent is told when no provider returned results, and when all of them are blocked. */
const ALL_PROVIDERS_FAILED = "All browser web search providers failed to return usable results. Do not retry browser_web_search";
const ALL_PROVIDERS_BLOCKED = "All browser web search providers are blocked by challenge verification or cooling down. Do not retry browser_web_search";

const GOOGLE_SORRY_URL = "https://www.google.com/sorry/index?continue=https://www.google.com/search";
const BING_CAPTCHA_URL = "https://www.bing.com/turing/captcha?foo=bar";

function resultsSnapshot(engine: string): string {
  return [
    `heading ${engine} Result`,
    `- link ${engine} Result`,
    "heading Another Result",
    "- link Another Result",
    "- link Third Result",
  ].join("\n");
}

/** A results area with too little in it to be search results. */
const NO_RESULTS_SNAPSHOT = "heading No results\n- link Search help";

/**
 * What the page-check script (`pageSignalsScript` in browser-page-check.ts) returns for a page,
 * as the JSON text it produces. Without overrides it is a page of search results.
 */
function pageSignals(url: string, overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    url,
    title: "copilot bridge - Search",
    status: 200,
    textLength: 5_200,
    text: "All Images Videos News Maps About 1,230,000 results Copilot Bridge Run agent sessions from your browser.",
    inputs: 1,
    links: 46,
    scripts: 12,
    captchaSolved: false,
    markers: [],
    ...overrides,
  });
}

/** agent-browser's `--json` output for an `eval` whose script returned `result`. */
function evalOutput(result: unknown): string {
  return JSON.stringify({ success: true, data: { result }, error: null });
}

function engineOf(url: string): Engine | undefined {
  const host = new URL(url).hostname;
  if (host.endsWith("google.com")) return "google";
  if (host.endsWith("bing.com")) return "bing";
  if (host.endsWith("duck.com")) return "duckduckgo";
  return undefined;
}

/**
 * Stands in for the agent-browser binary in front of the three search engines and records what
 * it was asked. An engine that `pages` says nothing about shows an ordinary page of results.
 * `pages` is read at each command, so a test can change an engine's answer between searches.
 */
function mockSearchEngines(pages: Partial<Record<Engine, EnginePage>> = {}): BrowserCall[] {
  const calls: BrowserCall[] = [];
  let engine: Engine | undefined;
  let openedUrl = "about:blank";
  execFileMock.mockImplementation((_file: string, rawArgs: string[], options: any, cb: (err: any, result?: { stdout: string; stderr: string }) => void) => {
    // The Bridge also lists processes through execFile; every agent-browser command ends in --json.
    if (rawArgs.at(-1) !== "--json") {
      cb(null, { stdout: "ok", stderr: "" });
      return {} as any;
    }
    const args = rawArgs.slice(0, -1);
    const command = args[0] === "get" ? `get ${args[1]}` : args[0];
    if (command === "open") {
      openedUrl = args[1];
      engine = engineOf(openedUrl);
    }
    if (command === "close") engine = undefined;
    calls.push({ command, args, session: options?.env?.AGENT_BROWSER_SESSION, engine });

    const page = (engine && pages[engine]) || {};
    let answer: BrowserReply = "ok";
    if (command === "open") answer = "opened";
    else if (command === "close") answer = "closed";
    else if (command === "eval") answer = page.pageCheck ?? evalOutput(pageSignals(openedUrl, page.signals));
    else if (command === "snapshot") answer = page.snapshot ?? resultsSnapshot(engine ?? "");

    if (typeof answer === "string") cb(null, { stdout: answer, stderr: "" });
    else cb({ stderr: answer.fails });
    return {} as any;
  });
  return calls;
}

/**
 * Runs a search without its real waits: the page check gives a human check five seconds to pass
 * by itself. Only the timers are faked; every round lets the mocked commands and the waits make
 * progress until the search has settled. A test that has faked the clock itself keeps its clock,
 * which then moves by exactly the waits that passed.
 */
async function withoutWaits<T>(search: () => T | Promise<T>): Promise<T> {
  const ownClock = vi.isFakeTimers();
  if (!ownClock) vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  try {
    let settled = false;
    const outcome = Promise.resolve(search()).finally(() => {
      settled = true;
    });
    outcome.catch(() => undefined);
    while (!settled) {
      await vi.advanceTimersToNextTimerAsync();
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return await outcome;
  } finally {
    if (!ownClock) vi.useRealTimers();
  }
}

/** The engines whose results page was opened, in order. */
function openedEngines(calls: readonly BrowserCall[]): Array<Engine | undefined> {
  return calls.filter((call) => call.command === "open").map((call) => call.engine);
}

function spans(telemetryStore: { recordSpan: ReturnType<typeof vi.fn> }, name: string): any[] {
  return telemetryStore.recordSpan.mock.calls
    .map(([span]: any[]) => span)
    .filter((span: any) => span.name === name);
}

describe("browser_web_search tool", () => {
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
    killMock.mockReset();
    killMock.mockImplementation(((pid: number, signal?: number | NodeJS.Signals) => {
      if (signal === 0) return true as never;
      return true as never;
    }) as any);
    cpMock.mockResolvedValue(undefined);
    mkdirMock.mockResolvedValue(undefined);
    readdirMock.mockRejectedValue(Object.assign(new Error("missing"), { code: "ENOENT" }));
    rmMock.mockResolvedValue(undefined);
    statMock.mockResolvedValue({ mtimeMs: Date.now() });
    execMock.mockImplementation((_cmd: string, _options: any, cb: (err: any, result?: { stdout: string; stderr: string }) => void) => {
      cb(null, { stdout: "agent-browser\n", stderr: "" });
      return {} as any;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  async function loadWebSearch(telemetryStore?: { recordSpan: ReturnType<typeof vi.fn> }) {
    const mod = await import("../web-search-tools.js");
    const [tool] = mod.createWebSearchTools(createBrowserToolContext(telemetryStore));
    return (query = "copilot bridge"): Promise<any> => withoutWaits(() => tool.handler({ query }, {} as any));
  }

  /** The failure codes a provider's failures were recorded with. Diagnostics counts challenges by them. */
  function failureCodes(telemetryStore: { recordSpan: ReturnType<typeof vi.fn> }, engine: Engine): string[] {
    return spans(telemetryStore, `browser.tool.browser_web_search.${engine}.failed`)
      .map((span) => span.metadata.failureCode);
  }

  it("tells the agent that it searches with the public browser, which is not signed in", async () => {
    const mod = await import("../web-search-tools.js");
    const [tool] = mod.createWebSearchTools(createBrowserToolContext());

    expect(tool.name).toBe("browser_web_search");
    expect(tool.description).toMatch(/public browser[^.]*not signed in/i);
  });

  it("returns Google's results, from the public browser", async () => {
    const calls = mockSearchEngines();
    const search = await loadWebSearch();

    const result = await search();

    expect(result).toEqual({
      ok: true,
      source: "google",
      query: "copilot bridge",
      url: "https://www.google.com/search?q=copilot%20bridge",
      snapshot: resultsSnapshot("google"),
    });
    expect(openedEngines(calls)).toEqual(["google"]);
    expect(calls.every((call) => call.session?.includes("copilot-bridge-public-"))).toBe(true);
  });

  it.each([
    ["has no recognisable results", { snapshot: NO_RESULTS_SNAPSHOT }, "search.google_no_results"],
    ["cannot be captured", { snapshot: { fails: "snapshot failed" } }, "extraction.snapshot_failed"],
    // A check that neither the page check nor the address gives away reads as a page without results.
    ["is a check the page check could not read", {
      pageCheck: { fails: "Execution context was destroyed" },
      snapshot: "heading About this page\n- link Why did this happen?\nOur systems have detected unusual traffic",
    }, "search.google_no_results"],
  ] as const)("falls through to the next provider, without a cooldown, when a results page %s", async (_name, page, failureCode) => {
    const telemetryStore = { recordSpan: vi.fn() };
    const calls = mockSearchEngines({ google: page });
    const search = await loadWebSearch(telemetryStore);

    const result = await search();

    expect(result).toMatchObject({ source: "bing", url: "https://www.bing.com/search?q=copilot%20bridge" });
    expect(result.snapshot).toContain("heading bing Result");
    expect(openedEngines(calls)).toEqual(["google", "bing"]);
    expect(failureCodes(telemetryStore, "google")).toEqual([failureCode]);

    // Nothing cools down: the next search asks Google again.
    calls.length = 0;
    await search();
    expect(openedEngines(calls)).toEqual(["google", "bing"]);
  });

  it("tells the agent not to retry when no provider returned results", async () => {
    const calls = mockSearchEngines({
      google: { snapshot: NO_RESULTS_SNAPSHOT },
      bing: { snapshot: { fails: "snapshot failed" } },
      duckduckgo: { snapshot: NO_RESULTS_SNAPSHOT },
    });
    const search = await loadWebSearch();

    const result = await search();

    expect(result.resultType).toBe("failure");
    expect(result.textResultForLlm).toContain(ALL_PROVIDERS_FAILED);
    expect(openedEngines(calls)).toEqual(["google", "bing", "duckduckgo"]);
    // The session log, which the user can open, says what each provider did.
    expect(result.sessionLog).toContain("Google did not return recognizable search results.");
    expect(result.sessionLog).toContain("Failed to capture Bing results: snapshot failed");
    expect(result.sessionLog).toContain("DuckDuckGo did not return recognizable search results.");
  });

  describe("a provider that asks for a human", () => {
    it.each([
      ["a human check the page check finds", 2, {
        title: "Verification",
        textLength: 140,
        text: "Please verify you are a human to continue. Complete the security check below.",
        links: 2,
      }],
      ["a protection vendor's check", 2, {
        title: "Just a moment...",
        status: 403,
        textLength: 96,
        text: "www.google.com Verifying you are human. This may take a few seconds.",
        links: 1,
        markers: ["cloudflare_challenge"],
      }],
      ["a refusal with nothing to pass", 1, {
        title: "Error 429 (Too Many Requests)",
        status: 429,
        textLength: 110,
        text: "429. That's an error. We're sorry, but you have sent too many requests to us recently.",
        links: 1,
        scripts: 0,
      }],
      // The provider's own challenge address, on a page that otherwise reads like any other.
      ["a redirect to Google's sorry page", 1, { url: GOOGLE_SORRY_URL }],
    ] as const)("treats %s as that provider's challenge: next provider now, cooldown afterwards", async (_name, pageReads, signals) => {
      const telemetryStore = { recordSpan: vi.fn() };
      const calls = mockSearchEngines({ google: { signals } });
      const search = await loadWebSearch(telemetryStore);

      const firstResult = await search();

      expect(firstResult).toMatchObject({ source: "bing", url: "https://www.bing.com/search?q=copilot%20bridge" });
      expect(openedEngines(calls)).toEqual(["google", "bing"]);
      // The blocked page is not captured: there are no results on it to read. A check is read a
      // second time after a moment, in case it passes by itself; a refusal is not.
      expect(calls.filter((call) => call.engine === "google").map((call) => call.command))
        .toEqual(["open", ...Array.from({ length: pageReads }, () => "eval")]);
      expect(failureCodes(telemetryStore, "google")).toEqual(["search.google_captcha"]);

      calls.length = 0;
      const secondResult = await search();

      expect(secondResult).toMatchObject({ source: "bing" });
      expect(openedEngines(calls)).toEqual(["bing"]);
    });

    it("skips only the provider that is cooling down", async () => {
      const calls = mockSearchEngines({
        google: { snapshot: NO_RESULTS_SNAPSHOT },
        bing: { signals: { url: BING_CAPTCHA_URL } },
      });
      const search = await loadWebSearch();

      await expect(search()).resolves.toMatchObject({ source: "duckduckgo", url: "https://duck.com/?q=copilot%20bridge&ia=web" });
      expect(openedEngines(calls)).toEqual(["google", "bing", "duckduckgo"]);
      calls.length = 0;

      await expect(search()).resolves.toMatchObject({ source: "duckduckgo" });
      expect(openedEngines(calls)).toEqual(["google", "duckduckgo"]);
    });

    it("returns a provider's results when its human check passes by itself within a moment", async () => {
      const telemetryStore = { recordSpan: vi.fn() };
      let pageReads = 0;
      const calls = mockSearchEngines({
        google: {
          // The check on the first read, the results page it gave way to on the second.
          get signals() {
            pageReads += 1;
            return pageReads === 1
              ? {
                title: "Just a moment...",
                status: 403,
                textLength: 96,
                text: "www.google.com Verifying you are human. This may take a few seconds.",
                links: 1,
                markers: ["cloudflare_challenge"],
              }
              : {};
          },
        },
      });
      const search = await loadWebSearch(telemetryStore);

      const result = await search();

      expect(result).toMatchObject({ source: "google", url: "https://www.google.com/search?q=copilot%20bridge" });
      expect(failureCodes(telemetryStore, "google")).toEqual([]);
      expect(spans(telemetryStore, "browser.page.blocked")).toEqual([]);

      // No cooldown either: the next search asks Google again.
      calls.length = 0;
      await search();
      expect(openedEngines(calls)).toEqual(["google"]);
    });

    it("tries a challenged provider again once its cooldown is over", async () => {
      vi.useFakeTimers({ toFake: ["Date", "setTimeout", "clearTimeout"] });
      vi.setSystemTime(new Date("2026-03-10T08:59:55.000Z"));
      const pages: Partial<Record<Engine, EnginePage>> = {
        google: {
          signals: {
            title: "Verification",
            textLength: 140,
            text: "Please verify you are a human to continue. Complete the security check below.",
            links: 2,
          },
        },
      };
      const calls = mockSearchEngines(pages);
      const search = await loadWebSearch();

      await search();
      expect(openedEngines(calls)).toEqual(["google", "bing"]);
      // The cooldown counts from when the check was still there after its five seconds.
      expect(new Date().toISOString()).toBe("2026-03-10T09:00:00.000Z");

      // Google would answer again, but it is not asked while it cools down.
      delete pages.google;
      calls.length = 0;
      vi.setSystemTime(new Date("2026-03-10T09:14:59.000Z"));
      await expect(search()).resolves.toMatchObject({ source: "bing" });
      expect(openedEngines(calls)).toEqual(["bing"]);

      calls.length = 0;
      vi.setSystemTime(new Date("2026-03-10T09:15:00.000Z"));
      await expect(search()).resolves.toMatchObject({ source: "google" });
      expect(openedEngines(calls)).toEqual(["google"]);
    });

    it("says that every provider is blocked when each is challenged, and opens none while they cool down", async () => {
      const telemetryStore = { recordSpan: vi.fn() };
      const calls = mockSearchEngines({
        google: { signals: { url: GOOGLE_SORRY_URL } },
        bing: {
          signals: {
            title: "Bing",
            textLength: 150,
            text: "One last step. Please solve the challenge below to continue. Verify you are a human.",
            links: 3,
          },
        },
        duckduckgo: {
          signals: {
            title: "DuckDuckGo",
            status: 403,
            textLength: 60,
            text: "Unfortunately, bots use DuckDuckGo too.",
            links: 0,
          },
        },
      });
      const search = await loadWebSearch(telemetryStore);

      const result = await search();

      expect(result.resultType).toBe("failure");
      expect(result.textResultForLlm).toContain(ALL_PROVIDERS_BLOCKED);
      expect(openedEngines(calls)).toEqual(["google", "bing", "duckduckgo"]);
      expect(calls.map((call) => call.command)).not.toContain("snapshot");
      // The codes diagnostics counts each provider's challenges by.
      expect(failureCodes(telemetryStore, "google")).toEqual(["search.google_captcha"]);
      expect(failureCodes(telemetryStore, "bing")).toEqual(["search.bing_captcha"]);
      expect(failureCodes(telemetryStore, "duckduckgo")).toEqual(["search.ddg_challenge"]);

      calls.length = 0;
      const nextResult = await search("something else");

      expect(nextResult.resultType).toBe("failure");
      expect(nextResult.textResultForLlm).toContain(ALL_PROVIDERS_BLOCKED);
      expect(openedEngines(calls)).toEqual([]);
      for (const label of ["Google", "Bing", "DuckDuckGo"]) {
        expect(nextResult.sessionLog).toContain(`${label} is cooling down`);
      }
    });

    it("tells the agent that no provider returned results when only some were challenged", async () => {
      mockSearchEngines({
        google: { signals: { url: GOOGLE_SORRY_URL } },
        bing: { snapshot: NO_RESULTS_SNAPSHOT },
        duckduckgo: { signals: { status: 403, textLength: 60, text: "Unfortunately, bots use DuckDuckGo too.", links: 0 } },
      });
      const search = await loadWebSearch();

      const result = await search();

      expect(result.resultType).toBe("failure");
      expect(result.textResultForLlm).toContain(ALL_PROVIDERS_FAILED);
    });

    it.each([
      ["finds a CAPTCHA widget inside the page", { signals: { markers: ["recaptcha"] } }],
      ["cannot read the page", { pageCheck: { fails: "Execution context was destroyed" } }],
    ] as const)("returns recognisable results when the page check %s", async (_name, page) => {
      const calls = mockSearchEngines({ google: page });
      const search = await loadWebSearch();

      await expect(search()).resolves.toMatchObject({ source: "google", snapshot: resultsSnapshot("google") });
      expect(openedEngines(calls)).toEqual(["google"]);
    });
  });
});
