import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTOMATIC_ANSWERS } from "../../shared/automatic-answer.js";
import { BROWSER_HANDOFF_ANSWERS } from "../../shared/browser-live.js";
import type { AgentElicitationResponse } from "../agent-backend/types.js";
import type { PageSignals } from "../browser-page-check.js";
import { testCopilotHome } from "./test-paths.js";

const COPILOT_HOME = testCopilotHome();
const STREAM_PORT = 9223;
const REASON = "Pass the human check on www.example.com so I can read the pricing page.";
const OWNER = { sessionId: "copilot-a" } as any;
const OTHER_CHAT = { sessionId: "copilot-b" } as any;

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

/** The page behind the check: what the browser shows once the user has passed it. */
const PRICING_PAGE: PageSignals = {
  url: "https://www.example.com/pricing",
  title: "Pricing – Example",
  status: 200,
  textLength: 6_200,
  text: "Example Home Products Pricing Blog Sign in Pricing Starter 9 per month Team 29 per month",
  inputs: 1,
  links: 47,
  scripts: 8,
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

type AgentBrowserReply =
  /** The command succeeded and printed this JSON result. */
  | { data: Record<string, unknown> }
  /** The command failed with this on stderr. */
  | { fail: string };

interface FakeAgentBrowser {
  /** What the browser shows. Tests change it to stand for what the user did there. */
  page: PageSignals;
  calls: Array<{ command: string[]; session: string }>;
}

/**
 * Stands in for the agent-browser CLI behind `execFile`: a browser that starts, can be streamed
 * and shows `page`, unless `respond` answers a command differently.
 */
function fakeAgentBrowser(
  respond: (command: string[]) => AgentBrowserReply | undefined = () => undefined,
): FakeAgentBrowser {
  const browser: FakeAgentBrowser = {
    page: CHALLENGE_PAGE,
    calls: [],
  };
  const answer = (command: string[]): AgentBrowserReply => {
    const [name, argument] = command;
    if (name === "get" && argument === "url") return { data: { url: browser.page.url } };
    if (name === "get" && argument === "title") return { data: { title: browser.page.title } };
    if (name === "snapshot") return { data: { snapshot: `- heading "${browser.page.title}" [ref=e1]` } };
    if (name === "eval") return { data: { result: JSON.stringify(browser.page) } };
    if (name === "stream" && argument === "status") return { data: { enabled: true, port: STREAM_PORT } };
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
    if ("fail" in reply) cb({ stderr: reply.fail });
    else cb(null, { stdout: JSON.stringify({ success: true, data: reply.data }), stderr: "" });
    return {} as any;
  });
  return browser;
}

interface AskedForm {
  sessionId: string;
  request: { message: string; requestedSchema: any };
  respond(response: AgentElicitationResponse): void;
  fail(error: Error): void;
}

/** A session manager whose questions wait until the test answers them. */
function createAskingSessionManager() {
  const asked: AskedForm[] = [];
  const waiting: Array<(form: AskedForm) => void> = [];
  const everyForm: AskedForm[] = [];
  const watching: Array<(form: AskedForm) => void> = [];
  return {
    canRequestElicitation: vi.fn((_sessionId: string) => true),
    requestElicitation: vi.fn((sessionId: string, request: AskedForm["request"]) =>
      new Promise<AgentElicitationResponse>((respond, fail) => {
        const form: AskedForm = { sessionId, request, respond, fail };
        everyForm.push(form);
        for (const watch of watching) watch(form);
        const waiter = waiting.shift();
        if (waiter) waiter(form);
        else asked.push(form);
      })),
    /** The next form a tool asks, whether it has asked already or not. */
    nextForm: () => new Promise<AskedForm>((resolve) => {
      const form = asked.shift();
      if (form) resolve(form);
      else waiting.push(resolve);
    }),
    /** The form that asks the user to do `reason`, whether it was asked already or not. */
    formAbout: (reason: string) => new Promise<AskedForm>((resolve) => {
      const isAbout = (form: AskedForm) => form.request.message.includes(reason);
      const form = everyForm.find(isAbout);
      if (form) resolve(form);
      else watching.push((later) => {
        if (isAbout(later)) resolve(later);
      });
    }),
  };
}

const contexts: any[] = [];

async function loadHandoffTools() {
  const sessionManager = createAskingSessionManager();
  const ctx = {
    copilotHome: COPILOT_HOME,
    settingsStore: { getSettings: () => ({}) },
    sessionManager,
  } as any;
  contexts.push(ctx);
  const mod = await import("../browser-session-tools.js");
  const { getBrowserRuntime } = await import("../browser-runtime.js");
  const tools = Object.fromEntries(mod.createBrowserSessionToolDefinitions(ctx).map((tool: any) => [tool.name, tool]));
  return { tools, runtime: getBrowserRuntime(ctx), sessionManager };
}

async function startSession(
  tools: Record<string, any>,
  context: "public" | "authenticated" = "public",
  invocation = OWNER,
): Promise<string> {
  const started = await tools.browser_session_start.handler(
    context === "authenticated" ? { context, purpose: "Read the signed-in dashboard" } : { context },
    invocation,
  ) as any;
  expect(started.browserSessionId).toEqual(expect.any(String));
  return started.browserSessionId;
}

/** The form a handoff call asks. A call that ends without asking fails here instead of leaving the test waiting. */
function askedForm(
  sessionManager: ReturnType<typeof createAskingSessionManager>,
  result: Promise<any>,
): Promise<AskedForm> {
  return Promise.race([
    sessionManager.nextForm(),
    result.then((value) => {
      throw new Error(`The handoff ended without asking the user: ${JSON.stringify(value)}`);
    }),
  ]);
}

/** Starts a session, calls the handoff and returns once the user has been asked. */
async function openHandoff(options: {
  context?: "public" | "authenticated";
  reason?: string;
  respond?: (command: string[]) => AgentBrowserReply | undefined;
} = {}) {
  const browser = fakeAgentBrowser(options.respond);
  const loaded = await loadHandoffTools();
  const browserSessionId = await startSession(loaded.tools, options.context);
  const result: Promise<any> = loaded.tools.browser_session_handoff.handler({
    browserSessionId,
    reason: options.reason ?? REASON,
  }, OWNER);
  const form = await askedForm(loaded.sessionManager, result);
  const fieldName = Object.keys(form.request.requestedSchema.properties)[0];
  return { ...loaded, browser, browserSessionId, result, form, fieldName };
}

const ACCEPT_DONE = (fieldName: string): AgentElicitationResponse =>
  ({ action: "accept", content: { [fieldName]: BROWSER_HANDOFF_ANSWERS.done } });

/** The ways a question to the user ends: with an answer, or with the runtime's error. */
const WAYS_THE_QUESTION_ENDS: Array<[string, (fieldName: string) => AgentElicitationResponse | Error]> = [
  ["done", (fieldName) => ACCEPT_DONE(fieldName)],
  ["Bridge's reply in the user's place", (fieldName) => ({ action: "accept", content: { [fieldName]: AUTOMATIC_ANSWERS.unanswered } })],
  ["cancel", () => ({ action: "cancel" })],
  ["a question that could not be asked", () => new Error("The runtime dropped the question")],
];

/** What the broker says to anything else that wants a browser the user was asked to act in. */
const userHasBrowser = (reason: string = REASON): string =>
  `The user has this browser right now (${reason}). Try again after they hand it back.`;

/** One of the owning agent's own calls on a browser session: it reads the page's address. */
function readAddress(tools: Record<string, any>, browserSessionId: string, invocation = OWNER): Promise<any> {
  return tools.browser_session_exec.handler({
    browserSessionId,
    commands: [{ command: "get", args: ["url"] }],
  }, invocation);
}

async function expectBrowserUsable(tools: Record<string, any>, browserSessionId: string, invocation = OWNER): Promise<void> {
  const exec = await readAddress(tools, browserSessionId, invocation);
  expect(exec).not.toHaveProperty("resultType");
  expect(exec.steps).toMatchObject([{ command: "get", ok: true }]);
}

async function expectBrowserWithUser(
  tools: Record<string, any>,
  browserSessionId: string,
  reason: string = REASON,
  invocation = OWNER,
): Promise<void> {
  const exec = await readAddress(tools, browserSessionId, invocation);
  expect(exec).toMatchObject({ resultType: "failure" });
  expect(exec.textResultForLlm).toContain(userHasBrowser(reason));
  expect(exec).not.toHaveProperty("steps");
}

describe("browser_session_handoff", () => {
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

  afterEach(async () => {
    vi.useRealTimers();
    const { getBrowserRuntime, shutdownBrowserLive } = await import("../browser-runtime.js");
    for (const ctx of contexts.splice(0)) {
      await getBrowserRuntime(ctx).sessions.closeAll();
      shutdownBrowserLive(ctx);
    }
  });

  describe("the request to the user", () => {
    it("is a form with one required choice between done and not done, asked of the calling chat", async () => {
      const { form, fieldName, result, sessionManager } = await openHandoff();

      expect(sessionManager.requestElicitation).toHaveBeenCalledTimes(1);
      expect(form.sessionId).toBe("copilot-a");
      expect(form.request.message).toContain(REASON);
      expect(form.request.requestedSchema).toEqual({
        type: "object",
        properties: { [fieldName]: expect.objectContaining({ type: "string", enum: ["done", "not_done"] }) },
        required: [fieldName],
      });

      form.respond({ action: "cancel" });
      await result;
    });

    it("shows a reason of the greatest length, without the whitespace around it", async () => {
      const reason = "x".repeat(500);
      const { form, fieldName, result, runtime, browserSessionId } = await openHandoff({ reason: `  ${reason}\n` });

      expect(form.request.message.endsWith(`: ${reason}`)).toBe(true);
      expect(runtime.sessions.matchHandoff("copilot-a", [fieldName])).toEqual({ browserSessionId, reason });

      form.respond({ action: "cancel" });
      await result;
    });

    it.each([
      ["an empty reason", "   \n"],
      ["a reason longer than a few sentences", "x".repeat(501)],
    ])("is not made for %s, and the browser is not touched", async (_name, reason) => {
      const browser = fakeAgentBrowser();
      const { tools, sessionManager } = await loadHandoffTools();
      const browserSessionId = await startSession(tools);
      const usedBeforeHandoff = browser.calls.length;

      const result = await tools.browser_session_handoff.handler({ browserSessionId, reason }, OWNER) as any;

      expect(result.resultType).toBe("failure");
      expect(result.textResultForLlm).toContain("reason");
      expect(sessionManager.requestElicitation).not.toHaveBeenCalled();
      expect(browser.calls).toHaveLength(usedBeforeHandoff);
    });

    // The runtime reports the form back to Bridge, which shows it only if it is a valid form and
    // recognises the handoff by the form's field names.
    it("is a form Bridge accepts, with answers Bridge accepts", async () => {
      const { normalizePendingElicitationRequest, validateElicitationResponse } = await import(
        "../pending-interaction-validation.js"
      );
      const { form, fieldName, result, runtime, browserSessionId } = await openHandoff();

      const view = normalizePendingElicitationRequest({ requestId: "request-1", ...form.request });

      expect(view.message).toBe(form.request.message);
      expect(runtime.sessions.matchHandoff("copilot-a", Object.keys(view.requestedSchema?.properties ?? {}))).toEqual({
        browserSessionId,
        reason: REASON,
      });
      for (const answer of [BROWSER_HANDOFF_ANSWERS.done, BROWSER_HANDOFF_ANSWERS.notDone]) {
        expect(validateElicitationResponse(view, { action: "accept", content: { [fieldName]: answer } })).toEqual({
          action: "accept",
          content: { [fieldName]: answer },
        });
      }
      expect(() => validateElicitationResponse(view, { action: "accept", content: {} })).toThrow();

      form.respond({ action: "cancel" });
      await result;
    });
  });

  describe("the answer", () => {
    it("done: returns the page as the user left it", async () => {
      const { form, fieldName, result, browser, browserSessionId } = await openHandoff();

      browser.page = PRICING_PAGE;
      form.respond(ACCEPT_DONE(fieldName));

      await expect(result).resolves.toEqual({
        browserSessionId,
        handoff: "completed",
        state: {
          url: { ok: true, output: "https://www.example.com/pricing" },
          title: { ok: true, output: "Pricing – Example" },
          snapshot: { ok: true, output: '- heading "Pricing – Example" [ref=e1]' },
        },
      });
    });

    it("done, with the check still on the page: says so", async () => {
      const { form, fieldName, result, browserSessionId } = await openHandoff();

      form.respond(ACCEPT_DONE(fieldName));
      const handedBack = await result;

      expect(handedBack).toMatchObject({
        browserSessionId,
        handoff: "completed",
        state: { title: { ok: true, output: "Just a moment..." } },
        blocked: { kind: "challenge", by: "Cloudflare" },
      });
      expect(handedBack.blocked.guidance).toContain("browser_session_handoff");
      expect(handedBack.blocked.guidance).toContain(browserSessionId);
    });

    it("not done: says the user could not do it, with the page as it is", async () => {
      const { form, fieldName, result, browserSessionId } = await openHandoff();

      form.respond({ action: "accept", content: { [fieldName]: BROWSER_HANDOFF_ANSWERS.notDone } });

      await expect(result).resolves.toMatchObject({
        browserSessionId,
        handoff: "not_completed",
        guidance: expect.stringContaining("could not"),
        state: {
          url: { ok: true, output: "https://www.example.com/pricing" },
          title: { ok: true, output: "Just a moment..." },
          snapshot: { ok: true },
        },
        blocked: { kind: "challenge", by: "Cloudflare" },
      });
    });

    // The Bridge closes every browser when it shuts down, whoever is in it.
    it("done, after the Bridge closed the browser: says that the session has ended, without starting a browser", async () => {
      const { form, fieldName, result, browser, runtime, browserSessionId } = await openHandoff();
      await runtime.sessions.closeAll();
      expect(runtime.sessions.getSession(browserSessionId)).toBeUndefined();
      const usedBeforeAnswer = browser.calls.length;

      form.respond(ACCEPT_DONE(fieldName));

      await expect(result).resolves.toEqual({
        browserSessionId,
        handoff: "completed",
        guidance: expect.stringContaining("has ended"),
      });
      expect(browser.calls).toHaveLength(usedBeforeAnswer);
    });

    it.each([
      ["nobody answered in time", AUTOMATIC_ANSWERS.unanswered],
      ["the chat runs in Autopilot", AUTOMATIC_ANSWERS.autopilot],
    ])("Bridge's reply in the user's place (%s): reports that nobody was there, with the reply", async (_name, reply) => {
      const { form, fieldName, result, browser, browserSessionId } = await openHandoff();
      const usedBeforeAnswer = browser.calls.length;

      form.respond({ action: "accept", content: { [fieldName]: reply } });

      await expect(result).resolves.toEqual({
        browserSessionId,
        handoff: "unattended",
        guidance: expect.stringContaining("Nobody acted in the browser"),
        reply,
      });
      // Nobody touched the page, so it is not read again.
      expect(browser.calls).toHaveLength(usedBeforeAnswer);
    });

    it.each<[string, (fieldName: string) => AgentElicitationResponse]>([
      ["no content", () => ({ action: "accept" })],
      ["an empty answer", (fieldName) => ({ action: "accept", content: { [fieldName]: "" } })],
      ["an answer that is not text", (fieldName) => ({ action: "accept", content: { [fieldName]: ["done"] } })],
    ])("an accepted form with %s: reports that nobody was there", async (_name, response) => {
      const { form, fieldName, result, browserSessionId } = await openHandoff();

      form.respond(response(fieldName));

      await expect(result).resolves.toEqual({
        browserSessionId,
        handoff: "unattended",
        guidance: expect.any(String),
      });
    });

    it.each([
      ["decline", "declined"],
      ["cancel", "cancelled"],
    ] as const)("%s: reports it and leaves the session open", async (action, handoff) => {
      const { form, result, browser, browserSessionId, runtime } = await openHandoff();
      const usedBeforeAnswer = browser.calls.length;

      form.respond({ action });

      await expect(result).resolves.toEqual({
        browserSessionId,
        handoff,
        guidance: expect.stringContaining("still open"),
      });
      expect(browser.calls).toHaveLength(usedBeforeAnswer);
      expect(runtime.sessions.getSession(browserSessionId)).toMatchObject({ activeCount: 0 });
    });

    it("fails with the runtime's error when the question cannot be asked", async () => {
      const { form, result, browserSessionId, tools } = await openHandoff();

      form.fail(new Error("This chat cannot ask its user a question right now."));
      const failure = await result;

      expect(failure.resultType).toBe("failure");
      expect(failure.textResultForLlm).toContain("This chat cannot ask its user a question right now.");
      expect(failure).not.toHaveProperty("handoff");
      // The session is not left in use.
      await expect(tools.browser_session_close.handler({ browserSessionId }, OWNER)).resolves.toEqual({
        success: true,
        browserSessionId,
      });
    });
  });

  describe("while the user is asked", () => {
    it.each(["public", "authenticated"] as const)(
      "the %s browser is the user's: the agent's own calls on it are refused until it is handed back",
      async (context) => {
        const { form, fieldName, result, tools, runtime, browser, browserSessionId } = await openHandoff({ context });
        const usedBeforeCalls = browser.calls.length;

        const exec = await tools.browser_session_exec.handler({
          browserSessionId,
          commands: [{ command: "open", args: ["https://www.example.com/"] }],
          capture: { title: true },
        }, OWNER) as any;
        const state = await tools.browser_session_get_state.handler({ browserSessionId, snapshot: true }, OWNER) as any;
        const close = await tools.browser_session_close.handler({ browserSessionId }, OWNER) as any;

        for (const refused of [exec, state]) {
          expect(refused.resultType).toBe("failure");
          expect(refused.textResultForLlm).toContain(userHasBrowser(REASON));
          expect(refused).not.toHaveProperty("steps");
          expect(refused).not.toHaveProperty("state");
        }
        expect(close).toMatchObject({ resultType: "failure", textResultForLlm: "Browser session is busy" });
        // Nothing reached the page the user is looking at.
        expect(browser.calls).toHaveLength(usedBeforeCalls);
        // The wait for the user is not an operation of the broker, and nothing queues behind it.
        expect(runtime.broker.getSnapshot()[context]).toMatchObject({ activeOperations: 0, queuedOperations: 0 });

        browser.page = PRICING_PAGE;
        form.respond(ACCEPT_DONE(fieldName));
        await expect(result).resolves.toMatchObject({
          handoff: "completed",
          state: { title: { ok: true, output: "Pricing – Example" } },
        });

        const after = await tools.browser_session_exec.handler({
          browserSessionId,
          commands: [{ command: "get", args: ["title"] }],
        }, OWNER) as any;
        expect(after.steps).toMatchObject([{ command: "get", ok: true, output: "Pricing – Example" }]);
      },
    );

    it.each(WAYS_THE_QUESTION_ENDS)(
      "the form is marked as a handoff, and both the mark and the hold end after %s",
      async (_name, outcome) => {
        const { form, fieldName, result, tools, runtime, browserSessionId } = await openHandoff();

        expect(runtime.sessions.matchHandoff("copilot-a", [fieldName])).toEqual({ browserSessionId, reason: REASON });
        expect(runtime.sessions.matchHandoff("copilot-b", [fieldName])).toBeUndefined();
        await expectBrowserWithUser(tools, browserSessionId);

        const answer = outcome(fieldName);
        if (answer instanceof Error) form.fail(answer);
        else form.respond(answer);
        await result;

        expect(runtime.sessions.matchHandoff("copilot-a", [fieldName])).toBeUndefined();
        expect(runtime.sessions.getSession(browserSessionId)).toMatchObject({ activeCount: 0 });
        await expectBrowserUsable(tools, browserSessionId);
      },
    );

    it.each(["public", "authenticated"] as const)(
      "lets the live view work in the %s browser the user has",
      async (context) => {
        const { form, result, runtime, browserSessionId } = await openHandoff({ context });

        // What the client asks for when the user opens the view.
        await expect(runtime.live.createTicket(browserSessionId)).resolves.toMatchObject({
          browserSessionId,
          token: expect.any(String),
        });

        form.respond({ action: "cancel" });
        await result;
      },
    );

    it("tells a refused call the beginning of a long reason, in a sentence that is not cut off", async () => {
      const reason = `Sign in to the store with the shared account. ${"Then accept the new terms. ".repeat(16)}`.trim();
      expect(reason.length).toBeGreaterThan(400);
      const { form, result, tools, browserSessionId } = await openHandoff({ reason });

      const refused = await readAddress(tools, browserSessionId);

      expect(refused).toMatchObject({ resultType: "failure" });
      expect(refused.textResultForLlm).toContain(userHasBrowser(reason.slice(0, 120)));
      expect(refused.textResultForLlm).not.toContain(reason.slice(0, 121));
      // The user is asked with the whole reason.
      expect(form.request.message).toContain(reason);

      form.respond({ action: "cancel" });
      await result;
    });

    it("leaves every other browser usable while the user has a public one", async () => {
      const { form, result, tools, runtime, browserSessionId } = await openHandoff();
      const otherPublic = await startSession(tools);
      const signedIn = await startSession(tools, "authenticated");
      const otherChat = await startSession(tools, "public", OTHER_CHAT);

      await expectBrowserUsable(tools, otherPublic);
      await expectBrowserUsable(tools, signedIn);
      await expectBrowserUsable(tools, otherChat, OTHER_CHAT);
      // A one-shot tool's browser, which is opened for the call.
      await expect(runtime.broker.withEphemeralContext(
        "public",
        { toolName: "browser_exec", browserOpId: "test-operation" },
        async () => "ran",
      )).resolves.toBe("ran");
      await expectBrowserWithUser(tools, browserSessionId);

      form.respond({ action: "cancel" });
      await result;
    });

    // Every authenticated session, and every one-shot authenticated call, works in the one signed-in browser.
    it("refuses everything that uses the signed-in browser while the user has it, and leaves public browsers usable", async () => {
      const { form, result, tools, runtime, browser, browserSessionId } = await openHandoff({ context: "authenticated" });
      const sameChat = await startSession(tools, "authenticated");
      const otherChat = await startSession(tools, "authenticated", OTHER_CHAT);
      const publicSession = await startSession(tools);
      const usedBeforeCalls = browser.calls.length;

      await expectBrowserWithUser(tools, browserSessionId);
      await expectBrowserWithUser(tools, sameChat);
      await expectBrowserWithUser(tools, otherChat, REASON, OTHER_CHAT);
      await expect(runtime.broker.withEphemeralContext(
        "authenticated",
        { toolName: "browser_exec", browserOpId: "test-operation" },
        async () => "ran",
      )).rejects.toThrow(userHasBrowser(REASON));
      expect(browser.calls).toHaveLength(usedBeforeCalls);

      await expectBrowserUsable(tools, publicSession);

      form.respond({ action: "cancel" });
      await result;
      await expectBrowserUsable(tools, sameChat);
      await expectBrowserUsable(tools, otherChat, OTHER_CHAT);
    });

    it("keeps each browser with the user, under a form of its own, until its own handoff is answered", async () => {
      const first = await openHandoff();
      const { tools, sessionManager, runtime } = first;
      const otherSessionId = await startSession(tools);
      const otherReason = "Approve the sign-in prompt on your phone.";
      const second: Promise<any> = tools.browser_session_handoff.handler({
        browserSessionId: otherSessionId,
        reason: otherReason,
      }, OWNER);
      const secondForm = await askedForm(sessionManager, second);
      const secondFieldName = Object.keys(secondForm.request.requestedSchema.properties)[0];

      expect(secondFieldName).not.toBe(first.fieldName);
      expect(runtime.sessions.matchHandoff("copilot-a", [secondFieldName])).toEqual({
        browserSessionId: otherSessionId,
        reason: otherReason,
      });
      await expectBrowserWithUser(tools, first.browserSessionId, REASON);
      await expectBrowserWithUser(tools, otherSessionId, otherReason);

      secondForm.respond({ action: "cancel" });
      await second;
      await expectBrowserUsable(tools, otherSessionId);
      expect(runtime.sessions.matchHandoff("copilot-a", [secondFieldName])).toBeUndefined();
      expect(runtime.sessions.matchHandoff("copilot-a", [first.fieldName])).toBeDefined();
      await expectBrowserWithUser(tools, first.browserSessionId, REASON);

      first.form.respond({ action: "cancel" });
      await first.result;
      await expectBrowserUsable(tools, first.browserSessionId);
    });

    it("refuses a second handoff on a browser the user already has, and the first stays as it is", async () => {
      const { form, fieldName, result, tools, sessionManager, runtime, browser, browserSessionId } = await openHandoff();
      const usedBeforeSecond = browser.calls.length;
      const otherReason = "Approve the sign-in prompt on your phone.";

      const second = await tools.browser_session_handoff.handler({ browserSessionId, reason: otherReason }, OWNER) as any;

      expect(second.resultType).toBe("failure");
      expect(second.textResultForLlm).toContain(userHasBrowser(REASON));
      expect(second).not.toHaveProperty("handoff");
      expect(sessionManager.requestElicitation).toHaveBeenCalledTimes(1);
      expect(browser.calls).toHaveLength(usedBeforeSecond);
      // The user still has the browser, for the first reason.
      expect(runtime.sessions.matchHandoff("copilot-a", [fieldName])).toEqual({ browserSessionId, reason: REASON });
      await expectBrowserWithUser(tools, browserSessionId, REASON);

      form.respond({ action: "decline" });
      await expect(result).resolves.toMatchObject({ handoff: "declined" });

      // Once it is handed back, the user can be asked again.
      const again: Promise<any> = tools.browser_session_handoff.handler({ browserSessionId, reason: otherReason }, OWNER);
      const againForm = await askedForm(sessionManager, again);
      expect(againForm.request.message).toContain(otherReason);
      againForm.respond({ action: "cancel" });
      await expect(again).resolves.toMatchObject({ handoff: "cancelled" });
    });

    // A model can issue several tool calls at once. They reach the broker before the handoff has
    // asked the user, and wait there for the browser while the handoff makes sure it can be shown.
    it("lets no call made at the same time reach the browser once the user has been asked", async () => {
      fakeAgentBrowser();
      const { tools, sessionManager } = await loadHandoffTools();
      const browserSessionId = await startSession(tools);

      const handoff: Promise<any> = tools.browser_session_handoff.handler({ browserSessionId, reason: REASON }, OWNER);
      const exec: Promise<any> = tools.browser_session_exec.handler({
        browserSessionId,
        commands: [{ command: "open", args: ["https://www.example.com/blog"] }],
      }, OWNER);
      const form = await askedForm(sessionManager, handoff);
      try {
        // The call is refused, or it was through with the browser before the user was asked.
        await exec;
        const askedAt = sessionManager.requestElicitation.mock.invocationCallOrder[0];
        const ranAfterAsking = execFileMock.mock.calls
          .filter(([, , options], index) => typeof options?.env?.AGENT_BROWSER_SESSION === "string"
            && execFileMock.mock.invocationCallOrder[index] > askedAt)
          .map(([, args]) => (args as string[]).filter((arg) => arg !== "--json").slice(0, 2).join(" "));
        expect(ranAfterAsking).toEqual([]);
      } finally {
        form.respond({ action: "cancel" });
        await Promise.all([handoff, exec]);
      }
    });

    // A browser has one user at a time: of two handoffs called at once, one asks and the other is refused.
    it("asks the user once when two handoffs are called at the same time, and refuses the other", async () => {
      fakeAgentBrowser();
      const { tools, sessionManager } = await loadHandoffTools();
      const browserSessionId = await startSession(tools);
      const reasons = [REASON, "Approve the sign-in prompt on your phone."];

      const calls: Array<Promise<any>> = reasons.map((reason) =>
        tools.browser_session_handoff.handler({ browserSessionId, reason }, OWNER));
      // Each call either asks the user, or ends because the user has the browser already.
      const reached = await Promise.all(reasons.map((reason, index) => Promise.race([
        sessionManager.formAbout(reason).then((form) => ({ asked: true as const, form, reason, call: calls[index] })),
        calls[index].then((result) => ({ asked: false as const, result })),
      ])));
      const asked = reached.flatMap((entry) => (entry.asked ? [entry] : []));
      const refused = reached.flatMap((entry) => (entry.asked ? [] : [entry.result]));
      try {
        expect(asked).toHaveLength(1);
        expect(sessionManager.requestElicitation).toHaveBeenCalledTimes(1);
        expect(refused).toHaveLength(1);
        expect(refused[0]).toMatchObject({ resultType: "failure" });
        expect(refused[0].textResultForLlm).toContain(userHasBrowser(asked[0].reason));

        // The refusal took nothing from the handoff that asked: the browser is still the user's.
        await expectBrowserWithUser(tools, browserSessionId, asked[0].reason);

        asked[0].form.respond({ action: "cancel" });
        await expect(asked[0].call).resolves.toMatchObject({ handoff: "cancelled" });
        await expectBrowserUsable(tools, browserSessionId);
      } finally {
        for (const entry of asked) entry.form.respond({ action: "cancel" });
        await Promise.all(calls);
      }
    });

    it("keeps the browser session from expiring or being closed, and counts the answer as a use", async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      const askedAt = Date.parse("2026-03-10T12:00:00Z");
      vi.setSystemTime(askedAt);
      const { BROWSER_SESSION_IDLE_TIMEOUT_MS } = await import("../browser-broker.js");
      const { form, fieldName, result, tools, runtime, browserSessionId } = await openHandoff();

      // The user takes longer than a session may otherwise go unused.
      const answeredAt = askedAt + BROWSER_SESSION_IDLE_TIMEOUT_MS + 15 * 60_000;
      vi.setSystemTime(answeredAt);
      await expect(runtime.sessions.sweepIdleSessions()).resolves.toBe(0);
      expect(runtime.sessions.getSession(browserSessionId)).toBeDefined();
      await expect(tools.browser_session_close.handler({ browserSessionId }, OWNER)).resolves.toMatchObject({
        resultType: "failure",
        textResultForLlm: "Browser session is busy",
      });

      form.respond(ACCEPT_DONE(fieldName));
      await expect(result).resolves.toMatchObject({ handoff: "completed" });

      await expect(runtime.sessions.sweepIdleSessions()).resolves.toBe(0);
      vi.setSystemTime(answeredAt + BROWSER_SESSION_IDLE_TIMEOUT_MS);
      await expect(runtime.sessions.sweepIdleSessions()).resolves.toBe(1);
      expect(runtime.sessions.getSession(browserSessionId)).toBeUndefined();
    });
  });

  describe("a browser session the chat cannot hand over", () => {
    it.each<[string, (tools: Record<string, any>) => Promise<string>, string]>([
      ["a session of another chat", (tools) => startSession(tools, "public", OTHER_CHAT), "belongs to a different Copilot session"],
      ["a handle that does not exist", async () => "bs_missing", "Browser session not found: bs_missing"],
      ["a session that was closed", async (tools) => {
        const browserSessionId = await startSession(tools);
        await tools.browser_session_close.handler({ browserSessionId }, OWNER);
        return browserSessionId;
      }, "Browser session not found"],
    ])("refuses %s without asking anyone or touching a browser", async (_name, sessionId, message) => {
      const browser = fakeAgentBrowser();
      const { tools, sessionManager } = await loadHandoffTools();
      const browserSessionId = await sessionId(tools);
      const usedBeforeHandoff = browser.calls.length;

      const result = await tools.browser_session_handoff.handler({ browserSessionId, reason: REASON }, OWNER) as any;

      expect(result.resultType).toBe("failure");
      expect(result.textResultForLlm).toContain(message);
      expect(sessionManager.requestElicitation).not.toHaveBeenCalled();
      // In particular no browser is started on a profile a closed session gave up.
      expect(browser.calls).toHaveLength(usedBeforeHandoff);
    });
  });

  describe("a chat that has nobody to ask", () => {
    it("reports that nobody was there, without asking or touching the browser", async () => {
      const browser = fakeAgentBrowser();
      const { tools, runtime, sessionManager } = await loadHandoffTools();
      const browserSessionId = await startSession(tools);
      const usedBeforeHandoff = browser.calls.length;
      sessionManager.canRequestElicitation.mockReturnValue(false);

      const result = await tools.browser_session_handoff.handler({ browserSessionId, reason: REASON }, OWNER) as any;

      expect(result).toEqual({
        browserSessionId,
        handoff: "unattended",
        guidance: expect.stringContaining("Nobody acted in the browser"),
      });
      expect(sessionManager.canRequestElicitation).toHaveBeenCalledWith("copilot-a");
      expect(sessionManager.requestElicitation).not.toHaveBeenCalled();
      expect(browser.calls).toHaveLength(usedBeforeHandoff);
      expect(runtime.sessions.getSession(browserSessionId)).toMatchObject({ activeCount: 0 });
      // The browser was given to nobody.
      await expectBrowserUsable(tools, browserSessionId);
    });

    it("still refuses a browser session that is not the chat's to hand over", async () => {
      fakeAgentBrowser();
      const { tools, sessionManager } = await loadHandoffTools();
      const ofOtherChat = await startSession(tools, "public", OTHER_CHAT);
      sessionManager.canRequestElicitation.mockReturnValue(false);

      const notOwned = await tools.browser_session_handoff.handler({ browserSessionId: ofOtherChat, reason: REASON }, OWNER);

      expect(notOwned).toMatchObject({
        textResultForLlm: "Browser session belongs to a different Copilot session",
        resultType: "failure",
      });
    });
  });

  describe("a browser that cannot be shown", () => {
    it("fails with the reason when this agent-browser has no streaming, and asks nobody", async () => {
      fakeAgentBrowser((command) => (command[0] === "stream" ? { fail: "Unknown command: stream" } : undefined));
      const { tools, runtime, sessionManager } = await loadHandoffTools();
      const browserSessionId = await startSession(tools);

      const result = await tools.browser_session_handoff.handler({ browserSessionId, reason: REASON }, OWNER) as any;

      expect(result.resultType).toBe("failure");
      expect(result.textResultForLlm).toContain("cannot show a live browser");
      expect(result.textResultForLlm).toContain("agent-browser");
      // The live view's own message, and nothing else of the error.
      expect(result.textResultForLlm).not.toContain("Browser handoff failed");
      expect(sessionManager.requestElicitation).not.toHaveBeenCalled();
      expect(runtime.sessions.getSession(browserSessionId)).toMatchObject({ activeCount: 0 });
      expect(runtime.broker.getSnapshot().public).toMatchObject({ activeOperations: 0, queuedOperations: 0 });
      // A browser nobody was asked to look at is not kept from the agent.
      await expectBrowserUsable(tools, browserSessionId);
    });

    it("reports any other failure to reach the browser as a failed handoff", async () => {
      fakeAgentBrowser();
      const { tools, runtime, sessionManager } = await loadHandoffTools();
      const browserSessionId = await startSession(tools);
      vi.spyOn(runtime.live, "resolveStreamPort").mockRejectedValue(new Error("socket hang up"));

      const result = await tools.browser_session_handoff.handler({ browserSessionId, reason: REASON }, OWNER) as any;

      expect(result.resultType).toBe("failure");
      expect(result.textResultForLlm).toContain("Browser handoff failed");
      expect(result.textResultForLlm).toContain("socket hang up");
      expect(sessionManager.requestElicitation).not.toHaveBeenCalled();
      expect(runtime.sessions.getSession(browserSessionId)).toMatchObject({ activeCount: 0 });
      await expectBrowserUsable(tools, browserSessionId);
    });
  });
});
