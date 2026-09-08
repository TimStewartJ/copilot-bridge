import { beforeEach, describe, expect, it, vi } from "vitest";
import { testCopilotHome } from "./test-paths.js";

const COPILOT_HOME = testCopilotHome();

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

  it("returns normalized snapshot failures", async () => {
    execFileMock.mockImplementation((_file: string, args: string[], _options: any, cb: (err: any, result?: { stdout: string; stderr: string }) => void) => {
      if (args[0] === "open") cb(null, { stdout: "opened", stderr: "" });
      else if (args[0] === "wait") cb(null, { stdout: "ready", stderr: "" });
      else if (args[0] === "snapshot") cb({ stderr: "snapshot failed" });
      else cb(null, { stdout: "ok", stderr: "" });
      return {} as any;
    });

    const mod = await import("../browser-fetch-tools.js");
    const tools = mod.createBrowserFetchTools(createBrowserToolContext());
    const result = await tools[0].handler({
      url: "https://bridge.internal/example",
      selector: "#content",
    }, {} as any) as any;

    expect(result).toEqual({
      textResultForLlm: "Failed to capture page: snapshot failed",
      resultType: "failure",
      sessionLog: "URL: https://bridge.internal/example\n\nSelector: #content\n\nFailed to capture page: snapshot failed",
    });
  });

  it("requires a reason for authenticated fetches", async () => {
    const mod = await import("../browser-fetch-tools.js");
    const tools = mod.createBrowserFetchTools(createBrowserToolContext());

    const result = await tools[0].handler({
      url: "https://msazure.visualstudio.com/One/",
      context: "authenticated",
    }, {} as any);

    expect(result).toMatchObject({
      resultType: "failure",
      textResultForLlm: "reason is required for authenticated browser access",
    });
    expect(execFileMock).not.toHaveBeenCalled();
  });

  it("keeps ordinary failures in the disposable public browser", async () => {
    const sessions: string[] = [];
    execFileMock.mockImplementation((_file: string, args: string[], options: any, cb: (err: any, result?: { stdout: string; stderr: string }) => void) => {
      const session = options?.env?.AGENT_BROWSER_SESSION;
      if (typeof session === "string") sessions.push(`${args[0]}:${session}`);
      if (args[0] === "open") cb(null, { stdout: "opened", stderr: "" });
      else if (args[0] === "wait") cb(null, { stdout: "ready", stderr: "" });
      else if (args[0] === "snapshot") cb({ stderr: "snapshot failed" });
      else if (args[0] === "close") cb(null, { stdout: "closed", stderr: "" });
      else cb(null, { stdout: "ok", stderr: "" });
      return {} as any;
    });

    const mod = await import("../browser-fetch-tools.js");
    const tools = mod.createBrowserFetchTools(createBrowserToolContext());
    const result = await tools[0].handler({
      url: "https://example.com/failure",
      selector: "#content",
    }, {} as any) as any;

    expect(result).toEqual({
      textResultForLlm: "Failed to capture page: snapshot failed",
      resultType: "failure",
      sessionLog: "URL: https://example.com/failure\n\nSelector: #content\n\nFailed to capture page: snapshot failed",
    });
    expect(sessions.length).toBeGreaterThan(0);
    expect(sessions.every((entry) => entry.includes("copilot-bridge-public-"))).toBe(true);
  });

  it("uses public context for every ordinary host without authenticated fallback", async () => {
    const telemetryStore = { recordSpan: vi.fn() };
    const sessions: string[] = [];
    execFileMock.mockImplementation((_file: string, args: string[], options: any, cb: (err: any, result?: { stdout: string; stderr: string }) => void) => {
      sessions.push(options.env.AGENT_BROWSER_SESSION);
      if (args[0] === "open") cb(null, { stdout: "opened", stderr: "" });
      else if (args[0] === "wait") cb(null, { stdout: "ready", stderr: "" });
      else if (args[0] === "snapshot") cb(null, { stdout: "snapshot", stderr: "" });
      else if (args[0] === "get" && args[1] === "title") cb(null, { stdout: "Example", stderr: "" });
      else if (args[0] === "get" && args[1] === "url") cb(null, { stdout: "https://bridge.internal/example", stderr: "" });
      else cb(null, { stdout: "ok", stderr: "" });
      return {} as any;
    });

    const mod = await import("../browser-fetch-tools.js");
    const tools = mod.createBrowserFetchTools(createBrowserToolContext({}, telemetryStore));
    const result = await tools[0].handler({
      url: "https://bridge.internal/example",
    }, {} as any) as any;

    const toolSpan = telemetryStore.recordSpan.mock.calls
      .map(([span]: any[]) => span)
      .find((span: any) => span.name === "browser.tool.browser_fetch");
    expect(result).toMatchObject({
      url: "https://bridge.internal/example",
      title: "Example",
      snapshot: "snapshot",
      context: "public",
    });
    expect(cpMock).not.toHaveBeenCalled();
    expect(sessions.every((session) => session.includes("copilot-bridge-public-"))).toBe(true);
    expect(telemetryStore.recordSpan).not.toHaveBeenCalledWith(expect.objectContaining({
      name: "browser.clone.fallback_to_primary",
    }));
    expect(toolSpan).toMatchObject({
      name: "browser.tool.browser_fetch",
      metadata: {
        urlHost: "bridge.internal",
        browserContext: "public",
      },
    });
  });

  it("applies the headed setting only to explicit authenticated fetches", async () => {
    const headedValues: Array<string | undefined> = [];
    execFileMock.mockImplementation((_file: string, args: string[], options: any, cb: (err: any, result?: { stdout: string; stderr: string }) => void) => {
      headedValues.push(options.env.AGENT_BROWSER_HEADED);
      if (args[0] === "open") cb(null, { stdout: "opened", stderr: "" });
      else if (args[0] === "wait") cb(null, { stdout: "ready", stderr: "" });
      else if (args[0] === "snapshot") cb(null, { stdout: "snapshot", stderr: "" });
      else if (args[0] === "get" && args[1] === "title") cb(null, { stdout: "Example", stderr: "" });
      else if (args[0] === "get" && args[1] === "url") cb(null, { stdout: "https://bridge.internal/example", stderr: "" });
      else cb(null, { stdout: "ok", stderr: "" });
      return {} as any;
    });

    const mod = await import("../browser-fetch-tools.js");
    const tools = mod.createBrowserFetchTools(createBrowserToolContext({
      browser: { headed: true },
    }));
    const result = await tools[0].handler({
      url: "https://bridge.internal/example",
      context: "authenticated",
      reason: "Read an authenticated page",
    }, {} as any) as any;

    expect(result).toMatchObject({
      url: "https://bridge.internal/example",
      title: "Example",
      snapshot: "snapshot",
      context: "authenticated",
    });
    expect(headedValues.length).toBeGreaterThan(0);
    expect(headedValues.every((value) => value === "true")).toBe(true);
  });
});
