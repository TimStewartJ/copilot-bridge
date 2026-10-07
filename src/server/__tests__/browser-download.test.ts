import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

import type { BrowserCommand, BrowserCommandResult } from "../agent-browser.js";
import { saveDownload } from "../browser-download.js";
import { makeTestDir } from "./helpers.js";

interface CdpRequest {
  id: number;
  method: string;
  params: Record<string, any>;
}

/** Stands in for Chrome's DevTools endpoint: answers every request and sends the events a test asks for. */
class FakeChrome {
  readonly server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  readonly requests: CdpRequest[] = [];
  private socket: WebSocket | undefined;

  constructor() {
    this.server.on("connection", (socket) => {
      this.socket = socket;
      socket.on("message", (data) => {
        const request = JSON.parse(data.toString()) as CdpRequest;
        this.requests.push(request);
        socket.send(JSON.stringify({ id: request.id, result: {} }));
      });
    });
  }

  get url(): string {
    return `ws://127.0.0.1:${(this.server.address() as AddressInfo).port}/devtools/browser/fake`;
  }

  event(method: string, params: Record<string, unknown>): void {
    this.socket?.send(JSON.stringify({ method, params }));
  }

  /** The parameters of the requests of one kind. */
  sent(method: string): Array<Record<string, any>> {
    return this.requests.filter((request) => request.method === method).map((request) => request.params);
  }

  reset(): void {
    this.requests.length = 0;
    this.socket?.terminate();
    this.socket = undefined;
  }

  /** Resolves once the Bridge has closed its connection. */
  async disconnected(): Promise<void> {
    await vi.waitFor(() => expect(this.server.clients.size).toBe(0));
  }
}

const chrome = new FakeChrome();
let folder: string;

beforeEach(() => {
  folder = makeTestDir("browser-download");
});

afterEach(() => chrome.reset());

afterAll(() => {
  chrome.server.close();
});

/** agent-browser as the download sees it. `click` is what the click on the element does. */
function commands(click: () => BrowserCommandResult | Promise<BrowserCommandResult>, overrides: Record<string, BrowserCommandResult> = {}) {
  return vi.fn(async (command: BrowserCommand): Promise<BrowserCommandResult> => {
    const name = command.slice(0, 2).join(" ");
    if (overrides[name]) return overrides[name];
    if (name === "get cdp-url") return { ok: true, output: "", data: { cdpUrl: chrome.url } };
    return click();
  });
}

/** A click that starts download `guid`, which Chrome saves under that name with `content`. */
const downloading = (guid: string, content: string | undefined, ...states: string[]) => async (): Promise<BrowserCommandResult> => {
  chrome.event("Browser.downloadWillBegin", { guid, suggestedFilename: "from-the-page.bin" });
  if (content !== undefined) await writeFile(join(folder, guid), content);
  for (const state of states) chrome.event("Browser.downloadProgress", { guid, state });
  return { ok: true, output: "" };
};

describe("saveDownload", () => {
  it("clicks the element and saves what Chrome downloaded under the name the step asked for", async () => {
    const runCommand = commands(downloading("guid-1", "the report", "inProgress", "completed"));
    const saved = join(folder, "report.pdf");

    const result = await saveDownload(["@e5", saved], 9_000, {}, { runCommand });

    expect(result).toEqual({ ok: true, output: `Saved the download to ${saved}.` });
    await expect(readFile(saved, "utf-8")).resolves.toBe("the report");
    // The folder's ordinary path: Chrome cancels a download into a folder named any other way.
    expect(chrome.sent("Browser.setDownloadBehavior"))
      .toEqual([{ behavior: "allowAndName", downloadPath: folder, eventsEnabled: true }]);
    // The click is the step's own command: it carries the step's time limit and is never run twice.
    expect(runCommand).toHaveBeenLastCalledWith(["click", "@e5"], 9_000, { skipRecovery: true });
    expect(runCommand.mock.calls.map(([command]) => command[0])).toEqual(["get", "click"]);
    await expect(readdir(folder)).resolves.toEqual(["report.pdf"]);
    await chrome.disconnected();
  });

  it("saves a file named alone in the chat's files, in a folder that did not exist", async () => {
    const filesDir = join(folder, "new-chat");
    const click = async (): Promise<BrowserCommandResult> => {
      chrome.event("Browser.downloadWillBegin", { guid: "guid-2" });
      await writeFile(join(filesDir, "guid-2"), "bytes");
      chrome.event("Browser.downloadProgress", { guid: "guid-2", state: "completed" });
      return { ok: true, output: "" };
    };

    const result = await saveDownload(["@e5", "report.pdf"], undefined, {}, { runCommand: commands(click), filesDir });

    expect(result).toEqual({ ok: true, output: `Saved the download to ${join(filesDir, "report.pdf")}.` });
    expect(chrome.sent("Browser.setDownloadBehavior")[0].downloadPath).toBe(filesDir);
    await expect(readFile(join(filesDir, "report.pdf"), "utf-8")).resolves.toBe("bytes");
  });

  it("replaces a file that already has the name", async () => {
    const saved = join(folder, "report.pdf");
    await writeFile(saved, "last week's");

    const result = await saveDownload(["@e5", saved], undefined, {}, { runCommand: commands(downloading("guid-3", "this week's", "completed")) });

    expect(result.ok).toBe(true);
    await expect(readFile(saved, "utf-8")).resolves.toBe("this week's");
  });

  it("says so when the browser cancels the download, and leaves nothing behind", async () => {
    const saved = join(folder, "report.pdf");

    const result = await saveDownload(["@e5", saved], undefined, {}, { runCommand: commands(downloading("guid-4", "half", "inProgress", "canceled")) });

    expect(result).toEqual({ ok: false, output: "The browser cancelled the download. Nothing was saved." });
    await expect(readdir(folder)).resolves.toEqual([]);
    await chrome.disconnected();
  });

  it("says that the click started no download when none begins", async () => {
    const runCommand = commands(() => ({ ok: true, output: "" }));

    const result = await saveDownload(["@e5", join(folder, "report.pdf")], undefined, {}, { runCommand, downloadWaitMs: 20 });

    expect(result).toEqual({
      ok: false,
      output: "Clicking @e5 started no download. The click did happen: take a snapshot to see the page now.",
    });
    expect(chrome.sent("Browser.cancelDownload")).toEqual([]);
  });

  it("cancels a download that does not finish in time, and is not ended by another download's progress", async () => {
    const click = async (): Promise<BrowserCommandResult> => {
      await downloading("guid-5", "so far", "inProgress")();
      chrome.event("Browser.downloadProgress", { guid: "another-tab", state: "completed" });
      return { ok: true, output: "" };
    };

    const result = await saveDownload(["@e5", join(folder, "report.pdf")], undefined, {}, { runCommand: commands(click), downloadWaitMs: 20 });

    expect(result).toEqual({
      ok: false,
      output: "The download did not finish in time. Nothing was saved. Give the step a longer timeoutMs to wait longer.",
    });
    expect(chrome.sent("Browser.cancelDownload")).toEqual([{ guid: "guid-5" }]);
    await expect(readdir(folder)).resolves.toEqual([]);
  });

  it("fails, saying the click happened, when the finished file is not where Chrome said", async () => {
    const saved = join(folder, "report.pdf");

    const result = await saveDownload(["@e5", saved], undefined, {}, {
      runCommand: commands(downloading("guid-6", undefined, "completed")),
      fileRetryDelaysMs: [0, 0],
    });

    expect(result.ok).toBe(false);
    expect(result.output).toMatch(/^download failed: .*ENOENT.*\. The click did happen: take a snapshot to see the page now\.$/s);
    await expect(stat(saved)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns the failure of the click, and waits for no download", async () => {
    const runCommand = commands(() => ({ ok: false, output: "Unknown ref: e5" }));

    await expect(saveDownload(["@e5", join(folder, "report.pdf")], undefined, {}, { runCommand }))
      .resolves.toEqual({ ok: false, output: "Unknown ref: e5" });
    await chrome.disconnected();
  });

  it.each([
    ["the browser is not on this machine", { ok: true, output: "", data: { cdpUrl: "ws://203.0.113.7:9222/devtools/browser/x" } }, "download could not find the browser. Nothing was clicked."],
    ["agent-browser cannot say where the browser is", { ok: false, output: "Browser not launched" }, "Browser not launched"],
  ])("clicks nothing when %s", async (_name, answer, output) => {
    const runCommand = commands(() => ({ ok: true, output: "" }), { "get cdp-url": answer });

    await expect(saveDownload(["@e5", join(folder, "report.pdf")], undefined, {}, { runCommand }))
      .resolves.toEqual({ ok: false, output });
    expect(runCommand).toHaveBeenCalledTimes(1);
  });

  it("downloads nothing to a file it cannot place", async () => {
    const runCommand = vi.fn();

    await expect(saveDownload(["@e5", "report.pdf"], undefined, {}, { runCommand }))
      .resolves.toEqual({ ok: false, output: "download takes absolute file paths: report.pdf" });
    await expect(saveDownload(["@e5", join("..", "report.pdf")], undefined, {}, { runCommand, filesDir: folder }))
      .resolves.toMatchObject({ ok: false });
    expect(runCommand).not.toHaveBeenCalled();
  });
});
