import { beforeEach, describe, expect, it, vi } from "vitest";
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

const invocation = {} as any;

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

  it("rejects unsupported command shapes during normalization", async () => {
    const mod = await import("../browser-exec-tools.js");

    const result = mod.normalizeBrowserExecInput({
      commands: [{ command: "snapshot", args: ["--full"] }],
    });

    expect(result).toEqual({
      ok: false,
      error: "commands[0] snapshot supports [], ['-i'], or ['-i', '-s', selector]",
    });
  });

  it("requires a reason and enforces allowed origins for authenticated access", async () => {
    const mod = await import("../browser-exec-tools.js");

    expect(mod.normalizeBrowserExecInput({
      context: "authenticated",
      commands: [{ command: "open", args: ["https://msazure.visualstudio.com/One/"] }],
    })).toEqual({
      ok: false,
      error: "reason is required for authenticated browser access",
    });
    expect(mod.normalizeBrowserExecInput({
      context: "authenticated",
      reason: "Inspect ADO",
      allowedOrigins: ["https://github.com"],
      commands: [{ command: "open", args: ["https://msazure.visualstudio.com/One/"] }],
    })).toEqual({
      ok: false,
      error: "authenticated browser URL origin is not allowed: https://msazure.visualstudio.com",
    });
  });

  it("uses the disposable public context by default and captures final state", async () => {
    execFileMock.mockImplementation((_file: string, args: string[], options: any, cb: (err: any, result?: { stdout: string; stderr: string }) => void) => {
      const env = options.env;
      if (args[0] === "open") cb(null, { stdout: "opened", stderr: "" });
      else if (args[0] === "wait") cb(null, { stdout: "ready", stderr: "" });
      else if (args[0] === "snapshot") cb(null, { stdout: "snapshot-output", stderr: "" });
      else if (args[0] === "get" && args[1] === "url") cb(null, { stdout: "https://example.com", stderr: "" });
      else if (args[0] === "close") cb(null, { stdout: "closed", stderr: "" });
      else cb(null, { stdout: "ok", stderr: "" });
      expect(env.AGENT_BROWSER_SESSION).toContain("copilot-bridge-public-");
      return {} as any;
    });

    const mod = await import("../browser-exec-tools.js");
    const tools = mod.createBrowserExecTools(createBrowserToolContext());
    const result = await tools[0].handler({
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
    expect(rmMock).toHaveBeenCalledWith(expect.stringContaining("browser-public"), {
      recursive: true,
      force: true,
    });
  });

  it("uses the authenticated context only when explicitly requested", async () => {
    const sessions: string[] = [];
    execFileMock.mockImplementation((_file: string, args: string[], options: any, cb: (err: any, result?: { stdout: string; stderr: string }) => void) => {
      sessions.push(options.env.AGENT_BROWSER_SESSION);
      if (args[0] === "fill") cb(null, { stdout: "filled", stderr: "" });
      else if (args[0] === "get" && args[1] === "title") cb(null, { stdout: "Title", stderr: "" });
      else cb(null, { stdout: "ok", stderr: "" });
      return {} as any;
    });

    const mod = await import("../browser-exec-tools.js");
    const tools = mod.createBrowserExecTools(createBrowserToolContext());
    const result = await tools[0].handler({
      context: "authenticated",
      reason: "Update an authenticated form",
      commands: [{ command: "fill", args: ["@e1", "hello"] }],
      capture: { title: true },
    }, invocation) as any;

    expect(result.context).toBe("authenticated");
    expect(sessions.every((session) => !session.includes("copilot-bridge-public-"))).toBe(true);
    expect(result.finalState.title).toEqual({ ok: true, output: "Title" });
  });

  it("supports authenticated reads against existing browser state", async () => {
    const sessions: string[] = [];
    execFileMock.mockImplementation((_file: string, args: string[], options: any, cb: (err: any, result?: { stdout: string; stderr: string }) => void) => {
      sessions.push(options.env.AGENT_BROWSER_SESSION);
      if (args[0] === "snapshot") cb(null, { stdout: "current-page", stderr: "" });
      else cb(null, { stdout: "ok", stderr: "" });
      return {} as any;
    });

    const mod = await import("../browser-exec-tools.js");
    const tools = mod.createBrowserExecTools(createBrowserToolContext());
    const result = await tools[0].handler({
      context: "authenticated",
      reason: "Inspect the existing authenticated page",
      commands: [{ command: "snapshot", args: ["-i"] }],
    }, invocation) as any;

    expect(result.context).toBe("authenticated");
    expect(result.steps[0]).toMatchObject({ command: "snapshot", ok: true, output: "current-page" });
    expect(sessions.every((session) => !session.includes("copilot-bridge-public-"))).toBe(true);
  });

  it("maps the legacy clone lane to public without authenticated fallback", async () => {
    const sessions: string[] = [];
    execFileMock.mockImplementation((_file: string, args: string[], options: any, cb: (err: any, result?: { stdout: string; stderr: string }) => void) => {
      sessions.push(options.env.AGENT_BROWSER_SESSION);
      cb(null, { stdout: "ok", stderr: "" });
      return {} as any;
    });
    const telemetryStore = { recordSpan: vi.fn() };

    const mod = await import("../browser-exec-tools.js");
    const tools = mod.createBrowserExecTools(createBrowserToolContext(telemetryStore));
    const result = await tools[0].handler({
      lane: "clone",
      commands: [{ command: "open", args: ["https://example.com"] }],
    }, invocation) as any;

    const toolSpan = telemetryStore.recordSpan.mock.calls
      .map(([span]: any[]) => span)
      .find((span: any) => span.name === "browser.tool.browser_exec");
    expect(result).toMatchObject({
      context: "public",
      deprecatedLane: "clone",
    });
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every((session) => session.includes("copilot-bridge-public-"))).toBe(true);
    expect(telemetryStore.recordSpan).not.toHaveBeenCalledWith(expect.objectContaining({
      name: "browser.clone.fallback_to_primary",
    }));
    expect(toolSpan).toMatchObject({
      name: "browser.tool.browser_exec",
      metadata: {
        browserContext: "public",
        legacyLane: "clone",
      },
    });
  });

  it("returns a structured failure with prior step results", async () => {
    execFileMock.mockImplementation((_file: string, args: string[], _options: any, cb: (err: any, result?: { stdout: string; stderr: string }) => void) => {
      if (args[0] === "click") {
        cb({ stderr: "click failed" });
      } else if (args[0] === "open") {
        cb(null, { stdout: "opened", stderr: "" });
      } else if (args[0] === "close") {
        cb(null, { stdout: "closed", stderr: "" });
      } else {
        cb(null, { stdout: "", stderr: "" });
      }
      return {} as any;
    });

    const mod = await import("../browser-exec-tools.js");
    const tools = mod.createBrowserExecTools(createBrowserToolContext());
    const result = await tools[0].handler({
      context: "public",
      commands: [
        { command: "open", args: ["https://example.com"] },
        { command: "click", args: ["@e1"] },
      ],
    }, invocation) as any;

    expect(result).toMatchObject({
      textResultForLlm: "Command 2 failed: click\n\nclick failed",
      resultType: "failure",
      context: "public",
    });
    expect(result).not.toHaveProperty("error");
    expect(result.failedStep).toMatchObject({
      index: 1,
      command: "click",
      ok: false,
      output: "click failed",
    });
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]).toMatchObject({ command: "open", ok: true });
    expect(result.sessionLog).toContain("Failed step: 2 click");
    expect(result.sessionLog).toContain("1. open ok — opened");
    expect(result.sessionLog).toContain("2. click failed — click failed");
  });

  it("returns an install error when agent-browser is unavailable", async () => {
    execMock.mockImplementation((_cmd: string, _options: any, cb: (err: any) => void) => {
      cb(new Error("missing"));
      return {} as any;
    });

    const mod = await import("../browser-exec-tools.js");
    const tools = mod.createBrowserExecTools(createBrowserToolContext());
    const result = await tools[0].handler({
      commands: [{ command: "open", args: ["https://example.com"] }],
    }, invocation);

    expect(result).toEqual({
      textResultForLlm: "agent-browser is not installed. Install it with: npm install -g agent-browser && agent-browser install",
      resultType: "failure",
      sessionLog: "agent-browser is not installed. Install it with: npm install -g agent-browser && agent-browser install",
    });
  });
});
