import { beforeEach, describe, expect, it, vi } from "vitest";
import { testCopilotHome } from "./test-paths.js";

const COPILOT_HOME = testCopilotHome();

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

  it("returns normalized DuckDuckGo snapshot failures after all fallbacks", async () => {
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
    const tools = mod.createWebSearchTools(createBrowserToolContext());
    expect(tools[0].name).toBe("browser_web_search");
    const result = await tools[0].handler({ query: "copilot bridge" }, {} as any) as any;

    expect(result).toEqual({
      textResultForLlm: "All browser web search providers failed to return usable results. Do not retry browser_web_search with the same or alternate queries; use a different research tool/source or ask the user for guidance.",
      resultType: "failure",
      sessionLog: "Query: copilot bridge\n\nFailed to capture Google results: snapshot failed\n\nFailed to capture Bing results: snapshot failed\n\nFailed to capture DuckDuckGo results: snapshot failed\n\nAll browser web search providers failed to return usable results. Do not retry browser_web_search with the same or alternate queries; use a different research tool/source or ask the user for guidance.",
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
    const tools = mod.createWebSearchTools(createBrowserToolContext());
    const result = await tools[0].handler({ query: "copilot bridge" }, {} as any) as any;

    expect(result).toEqual({
      textResultForLlm: "All browser web search providers failed to return usable results. Do not retry browser_web_search with the same or alternate queries; use a different research tool/source or ask the user for guidance.",
      resultType: "failure",
      sessionLog: "Query: copilot bridge\n\nFailed to capture Google results: snapshot failed\n\nFailed to capture Bing results: snapshot failed\n\nFailed to capture DuckDuckGo results: snapshot failed\n\nAll browser web search providers failed to return usable results. Do not retry browser_web_search with the same or alternate queries; use a different research tool/source or ask the user for guidance.",
    });
    expect(commandSessions.some((entry) => /:(?!.*-clone-).*copilot-bridge-/.test(entry))).toBe(false);
    expect(commandSessions.some((entry) => entry.includes("-clone-"))).toBe(true);
  });

  it("falls back to Bing after Google sorry redirects", async () => {
    let currentUrl = "";
    execFileMock.mockImplementation((_file: string, args: string[], _options: any, cb: (err: any, result?: { stdout: string; stderr: string }) => void) => {
      if (args[0] === "open") {
        currentUrl = args[1] ?? "";
        cb(null, { stdout: "opened", stderr: "" });
      }
      else if (args[0] === "wait") cb(null, { stdout: "ready", stderr: "" });
      else if (args[0] === "get" && args[1] === "url") {
        cb(null, {
          stdout: currentUrl.includes("bing.com")
            ? "https://www.bing.com/search?q=copilot%20bridge"
            : "https://www.google.com/sorry/index?continue=https://www.google.com/search",
          stderr: "",
        });
      } else if (args[0] === "snapshot" && args.includes("#b_results")) {
        cb(null, {
          stdout: [
            "heading Bing Result",
            "- link Bing Result",
            "heading Another Result",
            "- link Another Result",
            "- link Third Result",
          ].join("\n"),
          stderr: "",
        });
      } else if (args[0] === "close") {
        cb(null, { stdout: "closed", stderr: "" });
      } else {
        cb(null, { stdout: "ok", stderr: "" });
      }
      return {} as any;
    });

    const mod = await import("../web-search-tools.js");
    const tools = mod.createWebSearchTools(createBrowserToolContext());
    const result = await tools[0].handler({ query: "copilot bridge" }, {} as any) as any;

    expect(result).toMatchObject({
      source: "bing",
      query: "copilot bridge",
      url: "https://www.bing.com/search?q=copilot%20bridge",
    });
    expect(result.snapshot).toContain("heading Bing Result");
  });

  it("reports prior provider context when DuckDuckGo is also challenged", async () => {
    execFileMock.mockImplementation((_file: string, args: string[], _options: any, cb: (err: any, result?: { stdout: string; stderr: string }) => void) => {
      if (args[0] === "open") cb(null, { stdout: "opened", stderr: "" });
      else if (args[0] === "wait") cb(null, { stdout: "ready", stderr: "" });
      else if (args[0] === "get" && args[1] === "url") {
        cb(null, { stdout: "https://www.google.com/sorry/index?continue=https://www.google.com/search", stderr: "" });
      } else if (args[0] === "snapshot") {
        cb(null, {
          stdout: [
            "- link DuckDuckGo",
            "iframe",
            "checkbox image challenge 1",
            "checkbox image challenge 2",
            "button Submit",
            "Images not loading?",
          ].join("\n"),
          stderr: "",
        });
      } else if (args[0] === "close") {
        cb(null, { stdout: "closed", stderr: "" });
      } else {
        cb(null, { stdout: "ok", stderr: "" });
      }
      return {} as any;
    });

    const mod = await import("../web-search-tools.js");
    const tools = mod.createWebSearchTools(createBrowserToolContext());
    const result = await tools[0].handler({ query: "copilot bridge" }, {} as any) as any;

    expect(result).toEqual({
      textResultForLlm: "All browser web search providers failed to return usable results. Do not retry browser_web_search with the same or alternate queries; use a different research tool/source or ask the user for guidance.",
      resultType: "failure",
      sessionLog: "Query: copilot bridge\n\nGoogle requires captcha verification before search results can be returned. Google will be skipped for 15m.\n\nBing did not return recognizable search results.\n\nDuckDuckGo requires challenge verification before search results can be returned. DuckDuckGo will be skipped for 15m.\n\nAll browser web search providers failed to return usable results. Do not retry browser_web_search with the same or alternate queries; use a different research tool/source or ask the user for guidance.",
    });
  });

  it("treats DuckDuckGo checkbox pages as challenge failures", async () => {
    execFileMock.mockImplementation((_file: string, args: string[], _options: any, cb: (err: any, result?: { stdout: string; stderr: string }) => void) => {
      if (args[0] === "open") cb(null, { stdout: "opened", stderr: "" });
      else if (args[0] === "wait") cb(null, { stdout: "ready", stderr: "" });
      else if (args[0] === "get" && args[1] === "url") {
        cb(null, { stdout: "https://www.google.com/search?q=copilot%20bridge", stderr: "" });
      } else if (args[0] === "snapshot" && args.includes("#rso")) {
        cb(null, { stdout: "heading Search Results\n- link result one", stderr: "" });
      } else if (args[0] === "snapshot") {
        cb(null, {
          stdout: [
            "- link DuckDuckGo",
            "iframe",
            "checkbox image challenge 1",
            "checkbox image challenge 2",
            "checkbox image challenge 3",
            "button Submit",
            "Images not loading?",
          ].join("\n"),
          stderr: "",
        });
      } else if (args[0] === "close") {
        cb(null, { stdout: "closed", stderr: "" });
      } else {
        cb(null, { stdout: "ok", stderr: "" });
      }
      return {} as any;
    });

    const mod = await import("../web-search-tools.js");
    const tools = mod.createWebSearchTools(createBrowserToolContext());
    const result = await tools[0].handler({ query: "copilot bridge" }, {} as any) as any;

    expect(result).toEqual({
      textResultForLlm: "All browser web search providers failed to return usable results. Do not retry browser_web_search with the same or alternate queries; use a different research tool/source or ask the user for guidance.",
      resultType: "failure",
      sessionLog: "Query: copilot bridge\n\nGoogle did not return recognizable search results.\n\nBing did not return recognizable search results.\n\nDuckDuckGo requires challenge verification before search results can be returned. DuckDuckGo will be skipped for 15m.\n\nAll browser web search providers failed to return usable results. Do not retry browser_web_search with the same or alternate queries; use a different research tool/source or ask the user for guidance.",
    });
  });

  it("skips only the provider cooling down after captcha", async () => {
    let currentUrl = "";
    const openUrls: string[] = [];
    execFileMock.mockImplementation((_file: string, args: string[], _options: any, cb: (err: any, result?: { stdout: string; stderr: string }) => void) => {
      if (args[0] === "open") {
        currentUrl = args[1] ?? "";
        openUrls.push(currentUrl);
        cb(null, { stdout: "opened", stderr: "" });
      } else if (args[0] === "wait") {
        cb(null, { stdout: "ready", stderr: "" });
      } else if (args[0] === "get" && args[1] === "url") {
        cb(null, {
          stdout: currentUrl.includes("bing.com")
            ? "https://www.bing.com/turing/captcha?foo=bar"
            : currentUrl,
          stderr: "",
        });
      } else if (args[0] === "snapshot" && args.includes("#rso")) {
        cb(null, { stdout: "heading Google Result\n- link Google Result", stderr: "" });
      } else if (args[0] === "snapshot") {
        cb(null, {
          stdout: [
            "heading DuckDuckGo Result",
            "- link DuckDuckGo Result",
            "heading Another Result",
            "- link Another Result",
            "- link Third Result",
          ].join("\n"),
          stderr: "",
        });
      } else if (args[0] === "close") {
        cb(null, { stdout: "closed", stderr: "" });
      } else {
        cb(null, { stdout: "ok", stderr: "" });
      }
      return {} as any;
    });

    const mod = await import("../web-search-tools.js");
    const tools = mod.createWebSearchTools(createBrowserToolContext());
    const firstResult = await tools[0].handler({ query: "copilot bridge" }, {} as any) as any;
    openUrls.length = 0;
    const secondResult = await tools[0].handler({ query: "copilot bridge" }, {} as any) as any;

    expect(firstResult).toMatchObject({
      source: "duckduckgo",
      url: "https://duck.com/?q=copilot%20bridge&ia=web",
    });
    expect(secondResult).toMatchObject({
      source: "duckduckgo",
      url: "https://duck.com/?q=copilot%20bridge&ia=web",
    });
    expect(openUrls.some((url) => url.includes("google.com/search"))).toBe(true);
    expect(openUrls.some((url) => url.includes("bing.com/search"))).toBe(false);
    expect(openUrls.some((url) => url.includes("duck.com"))).toBe(true);
  });

  it("returns a cooldown failure without opening a provider when all are cooling down", async () => {
    let currentUrl = "";
    const openUrls: string[] = [];
    execFileMock.mockImplementation((_file: string, args: string[], _options: any, cb: (err: any, result?: { stdout: string; stderr: string }) => void) => {
      if (args[0] === "open") {
        currentUrl = args[1] ?? "";
        openUrls.push(currentUrl);
        cb(null, { stdout: "opened", stderr: "" });
      } else if (args[0] === "wait") {
        cb(null, { stdout: "ready", stderr: "" });
      } else if (args[0] === "get" && args[1] === "url") {
        cb(null, {
          stdout: currentUrl.includes("bing.com")
            ? "https://www.bing.com/turing/captcha?foo=bar"
            : "https://www.google.com/sorry/index?continue=https://www.google.com/search",
          stderr: "",
        });
      } else if (args[0] === "snapshot") {
        cb(null, {
          stdout: [
            "- link DuckDuckGo",
            "iframe",
            "checkbox image challenge 1",
            "checkbox image challenge 2",
            "button Submit",
            "Images not loading?",
          ].join("\n"),
          stderr: "",
        });
      } else if (args[0] === "close") {
        cb(null, { stdout: "closed", stderr: "" });
      } else {
        cb(null, { stdout: "ok", stderr: "" });
      }
      return {} as any;
    });

    const mod = await import("../web-search-tools.js");
    const tools = mod.createWebSearchTools(createBrowserToolContext());
    const firstResult = await tools[0].handler({ query: "copilot bridge" }, {} as any) as any;
    expect(firstResult).toMatchObject({
      textResultForLlm: "All browser web search providers are blocked by challenge verification or cooling down. Do not retry browser_web_search until the cooldown expires; use a different research tool/source or ask the user to resolve the browser challenges.",
      resultType: "failure",
    });
    openUrls.length = 0;
    const result = await tools[0].handler({ query: "copilot bridge" }, {} as any) as any;

    expect(openUrls).toHaveLength(0);
    expect(result).toMatchObject({
      textResultForLlm: "All browser web search providers are blocked by challenge verification or cooling down. Do not retry browser_web_search until the cooldown expires; use a different research tool/source or ask the user to resolve the browser challenges.",
      resultType: "failure",
    });
    expect(result.sessionLog).toContain("Google is cooling down after a recent captcha/challenge.");
    expect(result.sessionLog).toContain("Bing is cooling down after a recent captcha/challenge.");
    expect(result.sessionLog).toContain("DuckDuckGo is cooling down after a recent captcha/challenge.");
  });

  it("still succeeds with normal Google results", async () => {
    execFileMock.mockImplementation((_file: string, args: string[], _options: any, cb: (err: any, result?: { stdout: string; stderr: string }) => void) => {
      if (args[0] === "open") cb(null, { stdout: "opened", stderr: "" });
      else if (args[0] === "wait") cb(null, { stdout: "ready", stderr: "" });
      else if (args[0] === "get" && args[1] === "url") {
        cb(null, { stdout: "https://www.google.com/search?q=copilot%20bridge", stderr: "" });
      } else if (args[0] === "snapshot" && args.includes("#rso")) {
        cb(null, {
          stdout: [
            "heading Copilot Bridge",
            "- link Copilot Bridge",
            "heading GitHub Copilot",
            "- link GitHub Copilot",
            "- link Documentation",
          ].join("\n"),
          stderr: "",
        });
      } else if (args[0] === "close") {
        cb(null, { stdout: "closed", stderr: "" });
      } else {
        cb(null, { stdout: "ok", stderr: "" });
      }
      return {} as any;
    });

    const mod = await import("../web-search-tools.js");
    const tools = mod.createWebSearchTools(createBrowserToolContext());
    const result = await tools[0].handler({ query: "copilot bridge" }, {} as any) as any;

    expect(result).toMatchObject({
      source: "google",
      query: "copilot bridge",
      url: "https://www.google.com/search?q=copilot%20bridge",
    });
    expect(result.snapshot).toContain("heading Copilot Bridge");
  });
});
