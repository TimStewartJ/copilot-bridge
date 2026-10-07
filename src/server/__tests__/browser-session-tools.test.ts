import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PageSignals } from "../browser-page-check.js";
import { testCopilotHome, testPath } from "./test-paths.js";

const COPILOT_HOME = testCopilotHome();

const execMock = vi.fn();
const execFileMock = vi.fn();
const cpMock = vi.fn();
const mkdirMock = vi.fn();
const readdirMock = vi.fn();
const rmMock = vi.fn();
const statMock = vi.fn();
const lstatSyncMock = vi.fn();
const readlinkSyncMock = vi.fn();
const readFileSyncMock = vi.fn();
const rmSyncMock = vi.fn();
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
  lstatSync: lstatSyncMock,
  readFileSync: readFileSyncMock,
  readlinkSync: readlinkSyncMock,
  rmSync: rmSyncMock,
  unlinkSync: unlinkSyncMock,
}));

/** What the page check reads from an ordinary page: plenty of text, links and a field. */
const ARTICLE_PAGE: PageSignals = {
  url: "https://example.com/",
  title: "Example Domain",
  status: 200,
  textLength: 9_400,
  text: "Example Domain This domain is for use in documentation examples without needing permission.",
  inputs: 1,
  links: 84,
  scripts: 6,
  captchaSolved: false,
  markers: [],
};

/** A page that is nothing but a check a person can pass. */
const CHALLENGE_PAGE: PageSignals = {
  url: "https://www.example.com/pricing",
  title: "Just a moment...",
  status: 403,
  textLength: 118,
  text: "www.example.com Verifying you are human. This may take a few seconds. Performance & security by Cloudflare",
  inputs: 0,
  links: 1,
  scripts: 2,
  captchaSolved: false,
  markers: ["cloudflare_challenge", "turnstile"],
};

/** A refusal with nothing to pass. */
const DENIED_PAGE: PageSignals = {
  url: "https://www.example.com/pricing",
  title: "Attention Required! | Cloudflare",
  status: 403,
  textLength: 96,
  text: "Sorry, you have been blocked You are unable to access example.com Cloudflare Ray ID: 8f2a6c1d9e3b4a57",
  inputs: 0,
  links: 2,
  scripts: 0,
  captchaSolved: false,
  markers: ["cloudflare_block"],
};

/** An ordinary sign-up form with a CAPTCHA in front of its submit button. */
const CAPTCHA_PAGE: PageSignals = {
  url: "https://www.example.com/signup",
  title: "Create your account – Example",
  status: 200,
  textLength: 2_400,
  text: "Example Home Pricing Sign in Create your account Email Password I'm not a robot Create account",
  inputs: 3,
  links: 31,
  scripts: 9,
  captchaSolved: false,
  markers: ["recaptcha"],
};

type AgentBrowserReply =
  /** The command succeeded and printed this JSON result. */
  | { data: Record<string, unknown> }
  /** The command failed with this on stderr. */
  | { fail: string };

interface FakeAgentBrowser {
  /** What the page check reads. Tests change it to move the browser to another page. */
  page: PageSignals;
  calls: Array<{ command: string[]; session: string }>;
}

/**
 * Stands in for the agent-browser CLI behind `execFile`. Every command succeeds on an ordinary
 * page unless `respond` answers it differently.
 */
function fakeAgentBrowser(
  respond: (command: string[]) => AgentBrowserReply | undefined = () => undefined,
): FakeAgentBrowser {
  const browser: FakeAgentBrowser = {
    page: ARTICLE_PAGE,
    calls: [],
  };
  const answer = (command: string[]): AgentBrowserReply => {
    const [name, argument] = command;
    if (name === "get" && argument === "url") return { data: { url: browser.page.url } };
    if (name === "get" && argument === "title") return { data: { title: browser.page.title } };
    if (name === "open") return { data: { url: browser.page.url, title: browser.page.title } };
    if (name === "snapshot") return { data: { snapshot: `- heading "${browser.page.title}" [ref=e1]` } };
    if (name === "eval") return { data: { result: JSON.stringify(browser.page) } };
    return { data: {} };
  };
  execFileMock.mockImplementation((
    _file: string,
    args: string[],
    options: any,
    cb: (err: any, result?: { stdout: string; stderr: string }) => void,
  ) => {
    const session = options?.env?.AGENT_BROWSER_SESSION;
    if (typeof session !== "string") {
      // The process listing that a browser shutdown reads: no browser is running.
      cb(null, { stdout: "", stderr: "" });
      return {} as any;
    }
    const command = args.filter((arg) => arg !== "--json");
    browser.calls.push({ command, session });
    const reply = respond(command) ?? answer(command);
    if ("fail" in reply) {
      cb({ stderr: reply.fail });
    } else {
      cb(null, { stdout: JSON.stringify({ success: true, data: reply.data }), stderr: "" });
    }
    return {} as any;
  });
  return browser;
}

const contexts: any[] = [];
const invocation = { sessionId: "copilot-a" } as any;

function createBrowserToolContext() {
  const ctx = {
    copilotHome: COPILOT_HOME,
    settingsStore: { getSettings: () => ({}) },
  } as any;
  contexts.push(ctx);
  return ctx;
}

async function loadBrowserSessionTools(ctx = createBrowserToolContext()) {
  const mod = await import("../browser-session-tools.js");
  const { getBrowserRuntime } = await import("../browser-runtime.js");
  const definitions = mod.createBrowserSessionToolDefinitions(ctx);
  const tools = Object.fromEntries(definitions.map((tool: any) => [tool.name, tool]));
  return { definitions, tools, runtime: getBrowserRuntime(ctx) };
}

describe("browser session tools", () => {
  beforeEach(() => {
    vi.resetModules();
    execMock.mockReset();
    execFileMock.mockReset();
    cpMock.mockReset();
    mkdirMock.mockReset();
    readdirMock.mockReset();
    rmMock.mockReset();
    statMock.mockReset();
    lstatSyncMock.mockReset();
    readlinkSyncMock.mockReset();
    readFileSyncMock.mockReset();
    rmSyncMock.mockReset();
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
    // Only a public profile exists on disk, so that removing one would be noticed.
    lstatSyncMock.mockImplementation((path: unknown) => {
      if (String(path).includes("browser-public")) return {};
      throw Object.assign(new Error("missing"), { code: "ENOENT" });
    });
    execMock.mockImplementation((_cmd: string, _options: any, cb: (err: any, result?: { stdout: string; stderr: string }) => void) => {
      cb(null, { stdout: "agent-browser\n", stderr: "" });
      return {} as any;
    });
  });

  afterEach(async () => {
    const { getBrowserRuntime, shutdownBrowserLive } = await import("../browser-runtime.js");
    for (const ctx of contexts.splice(0)) {
      await getBrowserRuntime(ctx).sessions.closeAll();
      shutdownBrowserLive(ctx);
    }
  });

  it("offers the session tools, with the handoff among them", async () => {
    const { definitions, tools } = await loadBrowserSessionTools();

    expect(definitions.map((tool: any) => tool.name)).toEqual([
      "browser_session_start",
      "browser_session_exec",
      "browser_session_get_state",
      "browser_session_handoff",
      "browser_session_close",
    ]);
    expect(tools.browser_session_start.description).toContain("browser_session_handoff");
    expect(tools.browser_session_start.inputSchema.required).toEqual(["context"]);
    expect(tools.browser_session_handoff.inputSchema.required).toEqual(["browserSessionId", "reason"]);
  });

  it.each([
    ["no context", {}, "context"],
    ["an unknown context", { context: "private" }, "context"],
    ["an authenticated session without a purpose", { context: "authenticated", purpose: "  " }, "purpose is required"],
  ])("refuses to start with %s", async (_name, args, message) => {
    const browser = fakeAgentBrowser();
    const { tools } = await loadBrowserSessionTools();

    const result = await tools.browser_session_start.handler(args, invocation) as any;

    expect(result.resultType).toBe("failure");
    expect(result.textResultForLlm).toContain(message);
    expect(browser.calls).toEqual([]);
  });

  it("persists continuity on the shared authenticated browser session", async () => {
    const browser = fakeAgentBrowser();
    const { tools, runtime } = await loadBrowserSessionTools();

    const started = await tools.browser_session_start.handler({
      context: "authenticated",
      purpose: "Continue an authenticated workflow",
    }, invocation) as any;
    const first = await tools.browser_session_exec.handler({
      browserSessionId: started.browserSessionId,
      commands: [
        { command: "open", args: ["https://example.com"] },
        { command: "wait", args: ["--load", "networkidle"] },
      ],
      capture: { title: true, url: true },
    }, invocation) as any;
    const second = await tools.browser_session_get_state.handler({
      browserSessionId: started.browserSessionId,
    }, invocation) as any;

    expect(started).toMatchObject({ context: "authenticated", sharedAuthenticated: true });
    expect(first.context).toBe("authenticated");
    expect(first.steps.map((step: any) => [step.command, step.ok])).toEqual([["open", true], ["wait", true]]);
    expect(first.finalState.title).toEqual({ ok: true, output: "Example Domain" });
    expect(second.state.title).toEqual({ ok: true, output: "Example Domain" });
    expect(second.state.url).toEqual({ ok: true, output: "https://example.com/" });
    const seenSessions = browser.calls.map((call) => call.session);
    expect(seenSessions.every((value) => !value.includes("copilot-bridge-public-"))).toBe(true);
    expect(new Set(seenSessions).size).toBe(1);
    expect(runtime.sessions.getSession(started.browserSessionId)?.publicSlot).toBeUndefined();
  });

  it("keeps public sessions alive across exec calls until closed, and their profile after that", async () => {
    const browser = fakeAgentBrowser();
    const { tools, runtime } = await loadBrowserSessionTools();
    const profileDir = testPath("browser-public", "slot-1");

    const started = await tools.browser_session_start.handler({ context: "public" }, invocation) as any;
    const record = runtime.sessions.getSession(started.browserSessionId);
    const first = await tools.browser_session_exec.handler({
      browserSessionId: started.browserSessionId,
      commands: [{ command: "open", args: ["https://example.com"] }],
    }, invocation) as any;
    const second = await tools.browser_session_get_state.handler({
      browserSessionId: started.browserSessionId,
      title: true,
      url: false,
    }, invocation) as any;
    const usedBeforeClose = browser.calls.length;
    const closed = await tools.browser_session_close.handler({
      browserSessionId: started.browserSessionId,
    }, invocation) as any;

    expect(started).toMatchObject({ context: "public", sharedAuthenticated: false });
    expect(record).toMatchObject({ context: "public", publicSlot: 1 });
    expect(record?.browserTarget.profileDir).toBe(profileDir);
    expect(first.context).toBe("public");
    expect(second.state.title).toEqual({ ok: true, output: "Example Domain" });
    expect(second.state).not.toHaveProperty("url");
    // Every command, the page check included, ran in the session's own browser.
    expect(new Set(browser.calls.map((call) => call.session))).toEqual(new Set([record?.browserTarget.sessionName]));
    expect(closed).toEqual({ success: true, browserSessionId: started.browserSessionId });
    expect(browser.calls.slice(usedBeforeClose).map((call) => call.command)).toEqual([["close"]]);
    expect(runtime.sessions.getSession(started.browserSessionId)).toBeUndefined();

    // The browser is gone; what it stored stays for the next browser on this profile.
    expect(rmSyncMock).not.toHaveBeenCalled();
    // What is removed with a session are the files a viewer picked for its pages.
    expect(rmMock).not.toHaveBeenCalledWith(expect.stringContaining("browser-public"), expect.anything());
    const next = await tools.browser_session_start.handler({ context: "public" }, invocation) as any;
    expect(runtime.sessions.getSession(next.browserSessionId)).toMatchObject({
      publicSlot: 1,
      browserTarget: record?.browserTarget,
    });
  });

  it("rejects access from a different Copilot session", async () => {
    const browser = fakeAgentBrowser();
    const { tools } = await loadBrowserSessionTools();

    const started = await tools.browser_session_start.handler({ context: "public" }, invocation) as any;
    browser.calls.length = 0;
    const result = await tools.browser_session_exec.handler({
      browserSessionId: started.browserSessionId,
      commands: [{ command: "get", args: ["title"] }],
    }, { sessionId: "copilot-b" } as any);

    expect(result).toMatchObject({
      resultType: "failure",
      textResultForLlm: "Browser session belongs to a different Copilot session",
    });
    expect(browser.calls).toEqual([]);
  });

  describe("page check", () => {
    async function startPublicSession(browser: FakeAgentBrowser) {
      const loaded = await loadBrowserSessionTools();
      const started = await loaded.tools.browser_session_start.handler({ context: "public" }, invocation) as any;
      browser.calls.length = 0;
      return { ...loaded, browserSessionId: started.browserSessionId as string };
    }

    /** What each kind of page is reported as, and whether the user can be handed it. */
    const blockingPages = [
      { name: "a human check", page: CHALLENGE_PAGE, field: "blocked", other: "captcha", kind: "challenge", by: "Cloudflare", handoff: true },
      { name: "a refusal", page: DENIED_PAGE, field: "blocked", other: "captcha", kind: "denied", by: "Cloudflare", handoff: false },
      { name: "a CAPTCHA inside a usable page", page: CAPTCHA_PAGE, field: "captcha", other: "blocked", kind: "captcha", by: "reCAPTCHA", handoff: true },
    ] as const;

    it("attaches nothing for a page a person would simply read", async () => {
      const browser = fakeAgentBrowser();
      const { tools, browserSessionId } = await startPublicSession(browser);

      const exec = await tools.browser_session_exec.handler({
        browserSessionId,
        commands: [{ command: "open", args: ["https://example.com"] }],
      }, invocation) as any;
      const state = await tools.browser_session_get_state.handler({ browserSessionId }, invocation) as any;

      for (const result of [exec, state]) {
        expect(result).not.toHaveProperty("blocked");
        expect(result).not.toHaveProperty("captcha");
        expect(result).not.toHaveProperty("resultType");
      }
    });

    it.each(blockingPages)("reports $name beside the work, with what to do about it", async ({ page, field, other, kind, by, handoff }) => {
      const browser = fakeAgentBrowser();
      const { tools, browserSessionId } = await startPublicSession(browser);
      browser.page = page;

      const exec = await tools.browser_session_exec.handler({
        browserSessionId,
        commands: [{ command: "open", args: [page.url] }],
        capture: { title: true },
      }, invocation) as any;
      const state = await tools.browser_session_get_state.handler({ browserSessionId }, invocation) as any;

      for (const result of [exec, state]) {
        expect(result).not.toHaveProperty("resultType");
        expect(result).not.toHaveProperty(other);
        expect(result[field]).toEqual({ kind, by, guidance: expect.any(String) });
        // Only something a person can pass is worth handing over, and then in this session.
        expect(result[field].guidance.includes("browser_session_handoff")).toBe(handoff);
        expect(result[field].guidance.includes(browserSessionId)).toBe(handoff);
      }
      // The work itself is reported as usual.
      expect(exec.steps).toHaveLength(1);
      expect(exec.finalState.title).toEqual({ ok: true, output: page.title });
      expect(state.state.url).toEqual({ ok: true, output: page.url });
    });

    it("reports the page as it is at the end of each call", async () => {
      const browser = fakeAgentBrowser();
      const { tools, browserSessionId } = await startPublicSession(browser);

      browser.page = CHALLENGE_PAGE;
      const blocked = await tools.browser_session_get_state.handler({ browserSessionId }, invocation) as any;
      browser.page = ARTICLE_PAGE;
      const passed = await tools.browser_session_get_state.handler({ browserSessionId }, invocation) as any;

      expect(blocked.blocked).toMatchObject({ kind: "challenge" });
      expect(passed).not.toHaveProperty("blocked");
    });

    // A failed tool result reaches the model as `textResultForLlm` alone (normalizeToolResult,
    // convertBridgeToolResultToSdk): the other fields and the session log are not shown to it.
    it.each(blockingPages)("tells the agent in the failure text about $name after a failed step", async ({ page, field, other, kind, by }) => {
      const browser = fakeAgentBrowser((command) => (command[0] === "click" ? { fail: "Element @e1 not found" } : undefined));
      const { tools, browserSessionId } = await startPublicSession(browser);
      browser.page = page;

      const result = await tools.browser_session_exec.handler({
        browserSessionId,
        commands: [
          { command: "open", args: [page.url] },
          { command: "click", args: ["@e1"] },
          { command: "get", args: ["text", "@e2"] },
        ],
        capture: { title: true },
      }, invocation) as any;

      // The steps stop at the failure.
      expect(result).toMatchObject({
        resultType: "failure",
        browserSessionId,
        context: "public",
        failedStep: { index: 1, command: "click", ok: false, output: "Element @e1 not found" },
      });
      expect(result.steps).toHaveLength(2);
      expect(result).not.toHaveProperty("finalState");
      expect(result).not.toHaveProperty(other);
      expect(result[field]).toMatchObject({ kind, by });
      // What failed, what agent-browser said about it, then what to do about the page.
      expect(result.textResultForLlm).toBe(
        `Command 2 failed: click\n\nElement @e1 not found\n\n${result[field].guidance}`,
      );
    });

    it("attaches nothing to a step that failed on an ordinary page", async () => {
      const browser = fakeAgentBrowser((command) => (command[0] === "click" ? { fail: "click failed" } : undefined));
      const { tools, browserSessionId } = await startPublicSession(browser);

      const result = await tools.browser_session_exec.handler({
        browserSessionId,
        commands: [{ command: "click", args: ["@e1"] }],
      }, invocation) as any;

      expect(result).toMatchObject({
        textResultForLlm: "Command 1 failed: click\n\nclick failed",
        resultType: "failure",
      });
      expect(result).not.toHaveProperty("blocked");
      expect(result).not.toHaveProperty("captcha");
      // The session log, which the user can open, says which browser and which step.
      expect(result.sessionLog).toContain(browserSessionId);
      expect(result.sessionLog).toContain("click failed");
    });

    it("does its work as usual when the page cannot be checked", async () => {
      const browser = fakeAgentBrowser((command) => {
        if (command[0] === "eval") return { fail: "Execution context was destroyed" };
        if (command[0] === "click") return { fail: "click failed" };
        return undefined;
      });
      const { tools, browserSessionId } = await startPublicSession(browser);
      // A check that could be read would report this page.
      browser.page = CHALLENGE_PAGE;

      const exec = await tools.browser_session_exec.handler({
        browserSessionId,
        commands: [{ command: "open", args: ["https://www.example.com/pricing"] }],
        capture: { url: true },
      }, invocation) as any;
      const state = await tools.browser_session_get_state.handler({ browserSessionId }, invocation) as any;
      const failed = await tools.browser_session_exec.handler({
        browserSessionId,
        commands: [{ command: "click", args: ["@e1"] }],
      }, invocation) as any;

      expect(exec).not.toHaveProperty("resultType");
      expect(exec.finalState.url).toEqual({ ok: true, output: "https://www.example.com/pricing" });
      expect(state).not.toHaveProperty("resultType");
      expect(state.state.title).toEqual({ ok: true, output: "Just a moment..." });
      expect(failed).toMatchObject({
        textResultForLlm: "Command 1 failed: click\n\nclick failed",
        resultType: "failure",
      });
      for (const result of [exec, state, failed]) {
        expect(result).not.toHaveProperty("blocked");
        expect(result).not.toHaveProperty("captcha");
      }
    });
  });
});
