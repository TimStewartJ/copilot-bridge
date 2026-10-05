import { join, sep } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { testCopilotHome } from "./test-paths.js";

const COPILOT_HOME = testCopilotHome();
const PUBLIC_SLOT_1_PROFILE = join(COPILOT_HOME, "browser-public", "slot-1");

function createBrowserToolContext() {
  return {
    copilotHome: COPILOT_HOME,
    settingsStore: { getSettings: () => ({}) },
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

const invocation = {} as any;

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
  /** The command's name: "open", "click", "eval", "snapshot", "close", "get url", "get title". */
  command: string;
  args: string[];
  session?: string;
  profile?: string;
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
 * commands a test cares about. Every other command succeeds, and the page check reads an
 * ordinary page.
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
    };
    const answer = reply(call, calls) ?? (call.command === "eval" ? evalOutput(pageSignals()) : "ok");
    calls.push(call);
    if (typeof answer === "string") cb(null, { stdout: answer, stderr: "" });
    else cb({ stderr: answer.fails });
    return {} as any;
  });
  return calls;
}

describe("browser_exec tool", () => {
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

  async function loadBrowserExec() {
    const mod = await import("../browser-exec-tools.js");
    const { describePageBlock } = await import("../browser-page-check.js");
    const [tool] = mod.createBrowserExecTools(createBrowserToolContext());
    return { tool, describePageBlock };
  }

  it("tells the agent that the public context is not signed in and that a block is reported", async () => {
    const { tool } = await loadBrowserExec();

    expect(tool.name).toBe("browser_exec");
    expect(tool.description).toContain("`blocked`");
    expect(tool.description).toMatch(/public context[^.]*not signed in/i);
  });

  it.each([
    ["an unsupported command shape", { commands: [{ command: "snapshot", args: ["--full"] }] }, "commands[0] snapshot supports"],
    ["an unknown context", { context: "private", commands: [{ command: "snapshot" }] }, "context"],
    ["authenticated access without a reason", {
      context: "authenticated",
      commands: [{ command: "open", args: ["https://msazure.visualstudio.com/One/"] }],
    }, "reason is required for authenticated browser access"],
    ["an allowed origin that is not a web origin", {
      allowedOrigins: ["file:///etc/passwd"],
      commands: [{ command: "snapshot" }],
    }, "allowedOrigins must contain valid HTTP(S) origins"],
    ["an authenticated open outside the allowed origins", {
      context: "authenticated",
      reason: "Inspect ADO",
      allowedOrigins: ["https://github.com"],
      commands: [{ command: "open", args: ["https://msazure.visualstudio.com/One/"] }],
    }, "authenticated browser URL origin is not allowed: https://msazure.visualstudio.com"],
  ])("rejects %s before starting a browser", async (_name, args, message) => {
    const calls = mockAgentBrowser();
    const { tool } = await loadBrowserExec();

    const result = await tool.handler(args, invocation) as any;

    expect(result.resultType).toBe("failure");
    expect(result.textResultForLlm).toContain(message);
    expect(calls).toEqual([]);
  });

  it("uses the public context by default, captures final state and keeps the profile for the next call", async () => {
    const calls = mockAgentBrowser((call) => {
      if (call.command === "snapshot") return "snapshot-output";
      if (call.command === "get url") return "https://example.com";
      return undefined;
    });
    const { tool } = await loadBrowserExec();

    const result = await tool.handler({
      commands: [
        { command: "open", args: ["https://example.com"] },
        { command: "wait", args: ["--load", "networkidle"] },
      ],
      capture: { snapshot: true, url: true },
    }, invocation) as any;

    expect(result.context).toBe("public");
    expect(result.steps).toHaveLength(2);
    expect(result.finalState.url).toEqual({ ok: true, output: "https://example.com" });
    expect(result.finalState.snapshot).toEqual({ ok: true, output: "snapshot-output", selector: undefined });
    // An ordinary page: nothing is said about a block.
    expect(Object.keys(result).sort()).toEqual(["context", "finalState", "steps"]);

    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.session?.includes("copilot-bridge-public-"))).toBe(true);
    expect(calls.every((call) => call.profile === PUBLIC_SLOT_1_PROFILE)).toBe(true);
    // The browser is closed when the call returns; its profile stays.
    expect(calls.at(-1)?.command).toBe("close");
    expect(directories).toContain(PUBLIC_SLOT_1_PROFILE);
    expect(rmMock).not.toHaveBeenCalledWith(PUBLIC_SLOT_1_PROFILE, expect.anything());
    expect(rmSyncMock).not.toHaveBeenCalled();
  });

  it("uses the signed-in browser only when explicitly requested, and checks the page there too", async () => {
    const calls = mockAgentBrowser((call) => {
      if (call.command === "get title") return "Just a moment...";
      if (call.command === "eval") return evalOutput(pageSignals(CLOUDFLARE_CHECK.signals));
      return undefined;
    });
    const { tool, describePageBlock } = await loadBrowserExec();

    const result = await tool.handler({
      context: "authenticated",
      reason: "Update an authenticated form",
      commands: [{ command: "fill", args: ["@e1", "hello"] }],
      capture: { title: true },
    }, invocation) as any;

    expect(result.context).toBe("authenticated");
    expect(result.finalState.title).toEqual({ ok: true, output: "Just a moment..." });
    expect(result.blocked).toEqual(describePageBlock(CLOUDFLARE_CHECK.block));
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((call) => call.profile === join(COPILOT_HOME, "browser-profile"))).toBe(true);
    expect(calls.every((call) => !call.session?.includes("copilot-bridge-public-"))).toBe(true);
  });

  it("fails an authenticated call that ended outside the allowed origins", async () => {
    mockAgentBrowser((call) => (call.command === "get url" ? "https://login.example.net/redirected" : undefined));
    const { tool } = await loadBrowserExec();

    const result = await tool.handler({
      context: "authenticated",
      reason: "Read the dashboard",
      allowedOrigins: ["https://example.com"],
      commands: [{ command: "open", args: ["https://example.com/dashboard"] }],
    }, invocation) as any;

    expect(result.resultType).toBe("failure");
    expect(result.textResultForLlm).toContain("left the allowed origins: https://login.example.net");
    expect(result).not.toHaveProperty("steps");
  });

  it("returns an install error when agent-browser is unavailable", async () => {
    execMock.mockImplementation((_cmd: string, _options: any, cb: (err: any) => void) => {
      cb(new Error("missing"));
      return {} as any;
    });
    const calls = mockAgentBrowser();
    const { tool } = await loadBrowserExec();

    const result = await tool.handler({
      commands: [{ command: "open", args: ["https://example.com"] }],
    }, invocation) as any;

    expect(result.resultType).toBe("failure");
    expect(result.textResultForLlm).toContain("npm install -g agent-browser");
    expect(calls).toEqual([]);
  });

  describe("page check", () => {
    const blockingPages = [
      ["a human check", { page: CLOUDFLARE_CHECK, field: "blocked", otherField: "captcha", userCanPass: true }],
      // Nothing names who refused, so the site may only want its visitor signed in.
      ["a refusal", { page: SITE_REFUSAL, field: "blocked", otherField: "captcha", userCanPass: true }],
      ["a CAPTCHA inside an ordinary page", { page: FORM_WITH_CAPTCHA, field: "captcha", otherField: "blocked", userCanPass: true }],
    ] as const;

    it.each(blockingPages)("reports %s after commands that all succeeded", async (_name, { page, field, otherField, userCanPass }) => {
      mockAgentBrowser((call) => {
        if (call.command === "eval") return evalOutput(pageSignals(page.signals));
        if (call.command === "open") return "opened";
        if (call.command === "snapshot") return "snapshot-output";
        return undefined;
      });
      const { tool, describePageBlock } = await loadBrowserExec();

      const result = await tool.handler({
        commands: [{ command: "open", args: [page.signals.url] }],
        capture: { snapshot: true },
      }, invocation) as any;

      // The call did what it was asked; the block is told alongside its results.
      expect(result).toEqual({
        [field]: describePageBlock(page.block),
        context: "public",
        steps: [{ index: 0, command: "open", args: [page.signals.url], timeoutMs: undefined, ok: true, output: "opened" }],
        finalState: { snapshot: { ok: true, output: "snapshot-output", selector: undefined } },
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

    it("leaves a successful call as it is when the page cannot be checked", async () => {
      mockAgentBrowser((call) => {
        if (call.command === "eval") return { fails: "Execution context was destroyed" };
        if (call.command === "open") return "opened";
        return undefined;
      });
      const { tool } = await loadBrowserExec();

      const result = await tool.handler({
        commands: [{ command: "open", args: ["https://example.com"] }],
      }, invocation) as any;

      expect(result).toEqual({
        context: "public",
        steps: [{ index: 0, command: "open", args: ["https://example.com"], timeoutMs: undefined, ok: true, output: "opened" }],
        finalState: {},
      });
    });

    describe("after a failed step", () => {
      const failedClick = {
        context: "public",
        commands: [
          { command: "open", args: ["https://shop.example.com/cart"] },
          { command: "click", args: ["@e7"] },
          { command: "snapshot", args: ["-i"] },
        ],
        capture: { snapshot: true },
      };

      function replyWithFailedClick(pageCheckReply: BrowserReply) {
        return (call: BrowserCall): BrowserReply | undefined => {
          if (call.command === "click") return { fails: "Element @e7 not found" };
          if (call.command === "open") return "opened";
          if (call.command === "eval") return pageCheckReply;
          return undefined;
        };
      }

      // The model is given only `textResultForLlm` of a failure result (see normalizeToolResult in
      // agent-tools-mcp/server.ts and convertBridgeToolResultToSdk in bridge-native-tools.ts), so a
      // block that were only in the `blocked` field would never reach it.
      it.each(blockingPages)("reports the failed step, and says in the text the agent reads that the page is %s", async (_name, { page, field, otherField }) => {
        const calls = mockAgentBrowser(replyWithFailedClick(evalOutput(pageSignals(page.signals))));
        const { tool, describePageBlock } = await loadBrowserExec();

        const result = await tool.handler(failedClick, invocation) as any;

        const notice = describePageBlock(page.block);
        expect(result).toMatchObject({
          resultType: "failure",
          context: "public",
          [field]: notice,
          failedStep: { index: 1, command: "click", ok: false, output: "Element @e7 not found" },
        });
        expect(result).not.toHaveProperty(otherField);
        // What failed, what agent-browser said about it, then what to do about the page.
        expect(result.textResultForLlm).toBe(`Command 2 failed: click\n\nElement @e7 not found\n\n${notice.guidance}`);
        // No later step and no capture runs after the failure.
        expect(result.steps.map((step: any) => `${step.command}:${step.ok}`)).toEqual(["open:true", "click:false"]);
        expect(calls.map((call) => call.command)).not.toContain("snapshot");
      });

      it.each([
        ["reads an ordinary page", evalOutput(pageSignals())],
        ["fails", { fails: "Execution context was destroyed" }],
      ] as const)("reports only the failed step when the page check %s", async (_name, pageCheckReply) => {
        mockAgentBrowser(replyWithFailedClick(pageCheckReply));
        const { tool } = await loadBrowserExec();

        const result = await tool.handler(failedClick, invocation) as any;

        expect(result).toMatchObject({
          textResultForLlm: "Command 2 failed: click\n\nElement @e7 not found",
          resultType: "failure",
          context: "public",
          failedStep: { index: 1, command: "click", ok: false, output: "Element @e7 not found" },
        });
        expect(result).not.toHaveProperty("blocked");
        expect(result).not.toHaveProperty("captcha");
        // The session log, which the user can open, is the record of the steps.
        expect(result.sessionLog).toContain("1. open ok");
        expect(result.sessionLog).toContain("2. click failed");
      });
    });
  });
});
