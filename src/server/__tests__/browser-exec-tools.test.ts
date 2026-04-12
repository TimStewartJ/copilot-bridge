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
      cb(null, { stdout: "/usr/bin/agent-browser\n", stderr: "" });
      return {} as any;
    });
  });

  it("rejects unsupported command shapes during normalization", async () => {
    const mod = await import("../browser-exec-tools.js");

    const result = mod.normalizeBrowserExecInput({
      commands: [{ command: "snapshot", args: ["--full"] }],
    });

    expect(result).toEqual({
      error: "commands[0] snapshot supports [], ['-i'], or ['-i', '-s', selector]",
    });
  });

  it("uses clone lane for read-only auto flows and captures final state", async () => {
    execFileMock.mockImplementation((_file: string, args: string[], options: any, cb: (err: any, result?: { stdout: string; stderr: string }) => void) => {
      const env = options.env;
      if (args[0] === "open") cb(null, { stdout: "opened", stderr: "" });
      else if (args[0] === "wait") cb(null, { stdout: "ready", stderr: "" });
      else if (args[0] === "snapshot") cb(null, { stdout: "snapshot-output", stderr: "" });
      else if (args[0] === "get" && args[1] === "url") cb(null, { stdout: "https://example.com", stderr: "" });
      else if (args[0] === "close") cb(null, { stdout: "closed", stderr: "" });
      else cb(null, { stdout: "ok", stderr: "" });
      expect(env.AGENT_BROWSER_SESSION).toContain("-clone-");
      return {} as any;
    });

    const mod = await import("../browser-exec-tools.js");
    const tools = mod.createBrowserExecTools({ copilotHome: "/tmp/test-copilot" } as any);
    const result = await tools[0].handler({
      commands: [
        { command: "open", args: ["https://example.com"] },
        { command: "wait", args: ["--load", "networkidle"] },
      ],
      capture: { snapshot: true, url: true },
    }, invocation) as any;

    expect(result.lane).toBe("clone");
    expect(result.steps).toHaveLength(2);
    expect(result.finalState.url).toEqual({ ok: true, output: "https://example.com" });
    expect(result.finalState.snapshot).toEqual({ ok: true, output: "snapshot-output", selector: undefined });
    expect(rmMock).toHaveBeenCalledWith(expect.stringContaining("browser-clones"), {
      recursive: true,
      force: true,
    });
  });

  it("uses primary lane for stateful auto flows", async () => {
    const sessions: string[] = [];
    execFileMock.mockImplementation((_file: string, args: string[], options: any, cb: (err: any, result?: { stdout: string; stderr: string }) => void) => {
      sessions.push(options.env.AGENT_BROWSER_SESSION);
      if (args[0] === "fill") cb(null, { stdout: "filled", stderr: "" });
      else if (args[0] === "get" && args[1] === "title") cb(null, { stdout: "Title", stderr: "" });
      else cb(null, { stdout: "ok", stderr: "" });
      return {} as any;
    });

    const mod = await import("../browser-exec-tools.js");
    const tools = mod.createBrowserExecTools({ copilotHome: "/tmp/test-copilot" } as any);
    const result = await tools[0].handler({
      commands: [{ command: "fill", args: ["@e1", "hello"] }],
      capture: { title: true },
    }, invocation) as any;

    expect(result.lane).toBe("primary");
    expect(sessions.every((session) => !session.includes("-clone-"))).toBe(true);
    expect(result.finalState.title).toEqual({ ok: true, output: "Title" });
  });

  it("keeps read-only auto flows on primary when they depend on existing browser state", async () => {
    const sessions: string[] = [];
    execFileMock.mockImplementation((_file: string, args: string[], options: any, cb: (err: any, result?: { stdout: string; stderr: string }) => void) => {
      sessions.push(options.env.AGENT_BROWSER_SESSION);
      if (args[0] === "snapshot") cb(null, { stdout: "current-page", stderr: "" });
      else cb(null, { stdout: "ok", stderr: "" });
      return {} as any;
    });

    const mod = await import("../browser-exec-tools.js");
    const tools = mod.createBrowserExecTools({ copilotHome: "/tmp/test-copilot" } as any);
    const result = await tools[0].handler({
      commands: [{ command: "snapshot", args: ["-i"] }],
    }, invocation) as any;

    expect(result.lane).toBe("primary");
    expect(result.steps[0]).toMatchObject({ command: "snapshot", ok: true, output: "current-page" });
    expect(sessions.every((session) => !session.includes("-clone-"))).toBe(true);
  });

  it("returns a structured failure with prior step results", async () => {
    execFileMock
      .mockImplementationOnce((_file: string, _args: string[], _options: any, cb: (err: any, result?: { stdout: string; stderr: string }) => void) => {
        cb(null, { stdout: "opened", stderr: "" });
        return {} as any;
      })
      .mockImplementationOnce((_file: string, _args: string[], _options: any, cb: (err: any) => void) => {
        cb({ stderr: "click failed" });
        return {} as any;
      })
      .mockImplementationOnce((_file: string, _args: string[], _options: any, cb: (err: any, result?: { stdout: string; stderr: string }) => void) => {
        cb(null, { stdout: "closed", stderr: "" });
        return {} as any;
      });

    const mod = await import("../browser-exec-tools.js");
    const tools = mod.createBrowserExecTools({ copilotHome: "/tmp/test-copilot" } as any);
    const result = await tools[0].handler({
      lane: "clone",
      commands: [
        { command: "open", args: ["https://example.com"] },
        { command: "click", args: ["@e1"] },
      ],
    }, invocation) as any;

    expect(result.error).toBe("Command 2 failed: click");
    expect(result.failedStep).toMatchObject({
      index: 1,
      command: "click",
      ok: false,
      output: "click failed",
    });
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]).toMatchObject({ command: "open", ok: true });
  });

  it("returns an install error when agent-browser is unavailable", async () => {
    execMock.mockImplementation((_cmd: string, _options: any, cb: (err: any) => void) => {
      cb(new Error("missing"));
      return {} as any;
    });

    const mod = await import("../browser-exec-tools.js");
    const tools = mod.createBrowserExecTools({ copilotHome: "/tmp/test-copilot" } as any);
    const result = await tools[0].handler({
      commands: [{ command: "open", args: ["https://example.com"] }],
    }, invocation);

    expect(result).toEqual({
      error: "agent-browser is not installed. Install it with: npm install -g agent-browser && agent-browser install",
    });
  });
});
