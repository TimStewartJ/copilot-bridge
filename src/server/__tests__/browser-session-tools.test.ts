import { beforeEach, describe, expect, it, vi } from "vitest";

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
      cb(null, { stdout: "/usr/bin/agent-browser\n", stderr: "" });
      return {} as any;
    });
  });

  it("persists continuity on the shared primary browser session", async () => {
    const seenSessions: string[] = [];
    execFileMock.mockImplementation((_file: string, args: string[], options: any, cb: (err: any, result?: { stdout: string; stderr: string }) => void) => {
      seenSessions.push(options.env.AGENT_BROWSER_SESSION);
      if (args[0] === "open") cb(null, { stdout: "opened", stderr: "" });
      else if (args[0] === "wait") cb(null, { stdout: "ready", stderr: "" });
      else if (args[0] === "get" && args[1] === "title") cb(null, { stdout: "Example Domain", stderr: "" });
      else if (args[0] === "get" && args[1] === "url") cb(null, { stdout: "https://example.com/", stderr: "" });
      else cb(null, { stdout: "ok", stderr: "" });
      return {} as any;
    });

    const mod = await import("../browser-session-tools.js");
    const tools = Object.fromEntries(mod.createBrowserSessionTools({ copilotHome: "/tmp/test-copilot" } as any).map((tool: any) => [tool.name, tool]));
    const invocation = { sessionId: "copilot-a" } as any;

    const started = await tools.browser_session_start.handler({ mode: "persistent" }, invocation) as any;
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

    expect(first.mode).toBe("persistent");
    expect(second.mode).toBe("persistent");
    expect(second.state.title).toEqual({ ok: true, output: "Example Domain" });
    expect(second.state.url).toEqual({ ok: true, output: "https://example.com/" });
    expect(seenSessions.every((value) => !value.includes("-clone-"))).toBe(true);
    expect(new Set(seenSessions).size).toBe(1);
  });

  it("keeps isolated sessions alive across exec calls until closed", async () => {
    const seenSessions: string[] = [];
    execFileMock.mockImplementation((_file: string, args: string[], options: any, cb: (err: any, result?: { stdout: string; stderr: string }) => void) => {
      seenSessions.push(options.env.AGENT_BROWSER_SESSION);
      if (args[0] === "open") cb(null, { stdout: "opened", stderr: "" });
      else if (args[0] === "get" && args[1] === "title") cb(null, { stdout: "Example Domain", stderr: "" });
      else if (args[0] === "close") cb(null, { stdout: "closed", stderr: "" });
      else cb(null, { stdout: "ok", stderr: "" });
      return {} as any;
    });

    const mod = await import("../browser-session-tools.js");
    const tools = Object.fromEntries(mod.createBrowserSessionTools({ copilotHome: "/tmp/test-copilot" } as any).map((tool: any) => [tool.name, tool]));
    const invocation = { sessionId: "copilot-a" } as any;

    const started = await tools.browser_session_start.handler({ mode: "isolated" }, invocation) as any;
    const first = await tools.browser_session_exec.handler({
      browserSessionId: started.browserSessionId,
      commands: [{ command: "open", args: ["https://example.com"] }],
    }, invocation) as any;
    const second = await tools.browser_session_get_state.handler({
      browserSessionId: started.browserSessionId,
      title: true,
      url: false,
    }, invocation) as any;
    const closed = await tools.browser_session_close.handler({
      browserSessionId: started.browserSessionId,
    }, invocation) as any;

    expect(first.mode).toBe("isolated");
    expect(second.mode).toBe("isolated");
    expect(second.state.title).toEqual({ ok: true, output: "Example Domain" });
    const cloneSessions = seenSessions.filter((value) => value.includes("-clone-"));
    expect(cloneSessions.length).toBeGreaterThan(0);
    expect(new Set(cloneSessions).size).toBe(1);
    expect(closed).toEqual({ success: true, browserSessionId: started.browserSessionId });
    expect(rmMock).toHaveBeenCalledWith(expect.stringContaining("browser-clones"), {
      recursive: true,
      force: true,
    });
  });

  it("rejects access from a different Copilot session", async () => {
    execFileMock.mockImplementation((_file: string, _args: string[], _options: any, cb: (err: any, result?: { stdout: string; stderr: string }) => void) => {
      cb(null, { stdout: "ok", stderr: "" });
      return {} as any;
    });

    const mod = await import("../browser-session-tools.js");
    const tools = Object.fromEntries(mod.createBrowserSessionTools({ copilotHome: "/tmp/test-copilot" } as any).map((tool: any) => [tool.name, tool]));
    const ownerInvocation = { sessionId: "copilot-a" } as any;
    const otherInvocation = { sessionId: "copilot-b" } as any;

    const started = await tools.browser_session_start.handler({ mode: "persistent" }, ownerInvocation) as any;
    const result = await tools.browser_session_exec.handler({
      browserSessionId: started.browserSessionId,
      commands: [{ command: "get", args: ["title"] }],
    }, otherInvocation);

    expect(result).toEqual({ error: "Browser session belongs to a different Copilot session" });
  });
});
