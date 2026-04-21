import { beforeEach, describe, expect, it, vi } from "vitest";
import { testCopilotHome } from "./test-paths.js";

const COPILOT_HOME = testCopilotHome();

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

describe("web_search tool", () => {
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

  it("returns normalized DuckDuckGo snapshot failures after fallback", async () => {
    execFileMock.mockImplementation((_file: string, args: string[], _options: any, cb: (err: any, result?: { stdout: string; stderr: string }) => void) => {
      if (args[0] === "open") cb(null, { stdout: "opened", stderr: "" });
      else if (args[0] === "wait") cb(null, { stdout: "ready", stderr: "" });
      else if (args[0] === "snapshot" && args[2] === "#rso") {
        cb(null, { stdout: "heading Search Results\n- link result one", stderr: "" });
      } else if (args[0] === "snapshot") {
        cb({ stderr: "snapshot failed" });
      } else if (args[0] === "close") {
        cb(null, { stdout: "closed", stderr: "" });
      } else {
        cb(null, { stdout: "ok", stderr: "" });
      }
      return {} as any;
    });

    const mod = await import("../web-search-tools.js");
    const tools = mod.createWebSearchTools({ copilotHome: COPILOT_HOME } as any);
    const result = await tools[0].handler({ query: "copilot bridge" }, {} as any) as any;

    expect(result).toEqual({
      textResultForLlm: "Failed to capture results: snapshot failed",
      resultType: "failure",
      sessionLog: "Search engine: duckduckgo\n\nQuery: copilot bridge\n\nFailed to capture results: snapshot failed",
    });
  });

  it("keeps ordinary search failures on the clone lane", async () => {
    const commandSessions: string[] = [];
    execFileMock.mockImplementation((_file: string, args: string[], options: any, cb: (err: any, result?: { stdout: string; stderr: string }) => void) => {
      const session = options?.env?.AGENT_BROWSER_SESSION;
      if (typeof session === "string") commandSessions.push(`${args[0]}:${session}`);
      if (args[0] === "open") cb(null, { stdout: "opened", stderr: "" });
      else if (args[0] === "wait") cb(null, { stdout: "ready", stderr: "" });
      else if (args[0] === "snapshot" && args[2] === "#rso") {
        cb(null, { stdout: "heading Search Results\n- link result one", stderr: "" });
      } else if (args[0] === "snapshot") {
        cb({ stderr: "snapshot failed" });
      } else if (args[0] === "close") {
        cb(null, { stdout: "closed", stderr: "" });
      } else {
        cb(null, { stdout: "ok", stderr: "" });
      }
      return {} as any;
    });

    const mod = await import("../web-search-tools.js");
    const tools = mod.createWebSearchTools({ copilotHome: COPILOT_HOME } as any);
    const result = await tools[0].handler({ query: "copilot bridge" }, {} as any) as any;

    expect(result).toEqual({
      textResultForLlm: "Failed to capture results: snapshot failed",
      resultType: "failure",
      sessionLog: "Search engine: duckduckgo\n\nQuery: copilot bridge\n\nFailed to capture results: snapshot failed",
    });
    expect(commandSessions.some((entry) => /:(?!.*-clone-).*copilot-bridge-/.test(entry))).toBe(false);
    expect(commandSessions.some((entry) => entry.includes("-clone-"))).toBe(true);
  });
});
