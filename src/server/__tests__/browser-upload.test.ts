import { mkdtemp, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

import type { BrowserCommand, BrowserCommandResult } from "../agent-browser.js";
import { runBrowserAutomationCommands } from "../browser-automation.js";
import { normalizeBrowserAutomationCommands } from "../browser-steps.js";
import { chatStepFiles } from "../browser-step-files.js";
import { uploadFiles } from "../browser-upload.js";

interface CdpRequest {
  id: number;
  method: string;
  params: Record<string, any>;
  sessionId?: string;
}

/** Stands in for Chrome's DevTools endpoint: one page with one frame of another site in it. */
class FakeChrome {
  readonly server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  readonly requests: CdpRequest[] = [];
  private socket: WebSocket | undefined;
  /** Requests answered only when the test says so. */
  held: string[] = [];

  constructor() {
    this.server.on("connection", (socket) => {
      this.socket = socket;
      socket.on("message", (data) => {
        const request = JSON.parse(data.toString()) as CdpRequest;
        this.requests.push(request);
        if (this.held.includes(request.method)) return;
        if (request.method === "Target.setAutoAttach" && request.sessionId === "page") {
          this.event("Target.attachedToTarget", { sessionId: "frame", targetInfo: { type: "iframe" } }, "page");
        }
        const result = request.method === "Target.attachToTarget" ? { sessionId: "page" } : {};
        socket.send(JSON.stringify({ id: request.id, result }));
      });
    });
  }

  get url(): string {
    return `ws://127.0.0.1:${(this.server.address() as AddressInfo).port}/devtools/browser/fake`;
  }

  event(method: string, params: Record<string, unknown>, sessionId: string): void {
    this.socket?.send(JSON.stringify({ method, params, sessionId }));
  }

  /** The requests of one kind, as `session:detail`. */
  sent(method: string, detail: (params: Record<string, any>) => unknown = () => ""): string[] {
    return this.requests.filter((request) => request.method === method)
      .map((request) => `${request.sessionId}:${String(detail(request.params))}`);
  }

  reset(): void {
    this.requests.length = 0;
    this.held = [];
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
let photo: string;
let second: string;

beforeAll(async () => {
  folder = await mkdtemp(join(tmpdir(), "bridge-upload-"));
  photo = join(folder, "photo.jpg");
  second = join(folder, "second.jpg");
  await writeFile(photo, "one");
  await writeFile(second, "two");
});

afterEach(() => chrome.reset());

afterAll(async () => {
  chrome.server.close();
  await rm(folder, { recursive: true, force: true });
});

/** agent-browser as the upload sees it. `click` is what the click on the element does. */
function commands(click: () => BrowserCommandResult = () => ({ ok: true, output: "" }), overrides: Record<string, BrowserCommandResult> = {}) {
  return vi.fn(async (command: BrowserCommand): Promise<BrowserCommandResult> => {
    const name = command.slice(0, 2).join(" ");
    if (overrides[name]) return overrides[name];
    if (name === "tab list") {
      return { ok: true, output: "", data: { tabs: [{ active: false, targetId: "other" }, { active: true, targetId: "shown" }] } };
    }
    if (name === "get cdp-url") return { ok: true, output: "", data: { cdpUrl: chrome.url } };
    return click();
  });
}

const chooserIn = (sessionId: string, mode = "selectSingle") => () => {
  chrome.event("Page.fileChooserOpened", { mode, backendNodeId: 14 }, sessionId);
  return { ok: true, output: "" };
};

describe("uploadFiles", () => {
  it("clicks the element and gives the files to the chooser of the tab on show", async () => {
    const runCommand = commands(chooserIn("page", "selectMultiple"));

    const result = await uploadFiles("@e3", [photo, "second.jpg"], 9_000, {}, { runCommand, filesDir: folder });

    expect(result).toEqual({ ok: true, output: "Chose photo.jpg, second.jpg in the file chooser @e3 opened." });
    expect(chrome.sent("Target.attachToTarget", (params) => params.targetId)).toEqual(["undefined:shown"]);
    expect(chrome.sent("DOM.setFileInputFiles", (params) => `${params.backendNodeId} ${params.files.join(",")}`))
      .toEqual([`page:14 ${photo},${second}`]);
    // The click is the step's own command: it carries the step's time limit and is never run twice.
    expect(runCommand).toHaveBeenLastCalledWith(["click", "@e3"], 9_000, { skipRecovery: true });
    // Both the page and its frame were asked for their choosers before the click, and told to stop after.
    expect(chrome.sent("Page.setInterceptFileChooserDialog", (params) => params.enabled))
      .toEqual(["page:true", "frame:true", "page:false", "frame:false"]);
    await chrome.disconnected();
  });

  it("answers a chooser that a frame of another site opened", async () => {
    const result = await uploadFiles("@e9", [photo], undefined, {}, { runCommand: commands(chooserIn("frame")) });

    expect(result.ok).toBe(true);
    expect(chrome.sent("DOM.setFileInputFiles", (params) => params.backendNodeId)).toEqual(["frame:14"]);
  });

  it("waits for a chooser the page opens after the click returned", async () => {
    const runCommand = commands(() => {
      setTimeout(() => chrome.event("Page.fileChooserOpened", { mode: "selectSingle", backendNodeId: 14 }, "page"), 20);
      return { ok: true, output: "" };
    });

    const result = await uploadFiles("@e3", [photo], undefined, {}, { runCommand });

    expect(result.ok).toBe(true);
  });

  it("reports a click that opened no chooser", async () => {
    const result = await uploadFiles("@e2", [photo], undefined, {}, { runCommand: commands(), chooserWaitMs: 10 });

    expect(result).toEqual({
      ok: false,
      output: "Clicking @e2 opened no file chooser. The click did happen: take a snapshot to see the page now.",
    });
    expect(chrome.sent("DOM.setFileInputFiles")).toEqual([]);
    await chrome.disconnected();
  });

  it("chooses nothing when the page takes one file and several were given", async () => {
    const result = await uploadFiles("@e3", [photo, second], undefined, {}, { runCommand: commands(chooserIn("page")) });

    expect(result).toEqual({ ok: false, output: "The page takes one file here and upload was given 2. No file was chosen." });
    expect(chrome.sent("DOM.setFileInputFiles")).toEqual([]);
  });

  it("returns the failure of the click and stops asking for choosers", async () => {
    const runCommand = commands(() => ({ ok: false, output: "Unknown ref: e99" }));

    const result = await uploadFiles("@e99", [photo], undefined, {}, { runCommand });

    expect(result).toEqual({ ok: false, output: "Unknown ref: e99" });
    expect(chrome.sent("Page.setInterceptFileChooserDialog", (params) => params.enabled).slice(-2))
      .toEqual(["page:false", "frame:false"]);
    await chrome.disconnected();
  });

  it.each([
    ["a file that does not exist", () => [join(folder, "missing.jpg")], "upload found no file at"],
    ["a folder", () => [folder], "upload found no file at"],
    ["a name alone that is not in the chat's files", () => ["missing.jpg"], "upload found no file at"],
    ["a relative path", () => [join("sub", "photo.jpg")], "upload takes absolute file paths, or the name alone"],
  ])("touches nothing for %s", async (_label, files, message) => {
    const runCommand = commands();

    const result = await uploadFiles("@e3", files(), undefined, {}, { runCommand, filesDir: folder });

    expect(result.ok).toBe(false);
    expect(result.output).toContain(message);
    expect(runCommand).not.toHaveBeenCalled();
  });

  it("takes only absolute paths when it does not know the calling chat", async () => {
    const result = await uploadFiles("@e3", ["photo.jpg"], undefined, {}, { runCommand: commands() });

    expect(result).toEqual({ ok: false, output: "upload takes absolute file paths: photo.jpg" });
  });

  it.each([
    ["no tab is the one on show", { "tab list": { ok: true, output: "", data: { tabs: [{ active: false, targetId: "a" }] } } }],
    ["the browser is not on this machine", { "get cdp-url": { ok: true, output: "", data: { cdpUrl: "ws://203.0.113.7:9222/devtools/browser/x" } } }],
  ])("clicks nothing when %s", async (_label, overrides) => {
    const runCommand = commands(undefined, overrides);

    const result = await uploadFiles("@e3", [photo], undefined, {}, { runCommand });

    expect(result).toEqual({ ok: false, output: "upload could not find the browser's open tab. Nothing was clicked." });
    expect(runCommand.mock.calls.map(([command]) => command[0])).not.toContain("click");
    expect(chrome.requests).toEqual([]);
  });

  it("says that the click happened when the browser fails to take the files", async () => {
    chrome.held = ["DOM.setFileInputFiles"];

    const result = await uploadFiles("@e3", [photo], undefined, {}, { runCommand: commands(chooserIn("page")), requestTimeoutMs: 250 });

    expect(result).toEqual({
      ok: false,
      output: "upload failed: the browser did not answer DOM.setFileInputFiles. The click did happen: take a snapshot to see the page now.",
    });
  });

  it("fails without clicking when the browser does not answer", async () => {
    chrome.held = ["Page.setInterceptFileChooserDialog"];
    const runCommand = commands();

    const result = await uploadFiles("@e3", [photo], undefined, {}, { runCommand, requestTimeoutMs: 250 });

    expect(result).toEqual({
      ok: false,
      output: "upload failed: the browser did not answer Page.setInterceptFileChooserDialog. Nothing was clicked.",
    });
    expect(runCommand.mock.calls.map(([command]) => command[0])).not.toContain("click");
    await chrome.disconnected();
  });
});

describe("the upload step", () => {
  it("needs a ref and at least one file", () => {
    expect(normalizeBrowserAutomationCommands([{ command: "upload", args: ["e5", photo] }]))
      .toEqual({ ok: true, value: [{ command: "upload", args: ["@e5", photo], timeoutMs: undefined }] });
    expect(normalizeBrowserAutomationCommands([{ command: "upload", args: ["@e5"] }]))
      .toEqual({ ok: false, error: "commands[0] upload requires an element ref (e.g. @e42) and at least one file" });
    expect(normalizeBrowserAutomationCommands([{ command: "upload", args: ["#photo", photo] }]).ok).toBe(false);
  });

  it("runs through the upload and stops the step list when it fails", async () => {
    const missing = join(folder, "missing.jpg");

    const result = await runBrowserAutomationCommands(
      [{ command: "upload", args: ["@e5", missing] }, { command: "click", args: ["@e6"] }],
      {},
    );

    expect(result).toMatchObject({
      ok: false,
      error: { error: "Command 1 failed: upload", steps: [{ command: "upload", ok: false, output: `upload found no file at ${missing}. Nothing was clicked.` }] },
    });
  });

  it("looks up a bare file name in the files of the calling chat", () => {
    const chat = "38b77239-bdb2-4a12-b68c-268f2d0f69cb";

    expect(chatStepFiles({ copilotHome: folder }, chat)).toEqual({ filesDir: join(folder, "session-state", chat, "files") });
    expect(chatStepFiles({ copilotHome: folder }, undefined)).toEqual({});
    expect(chatStepFiles({ copilotHome: folder }, join("..", "elsewhere"))).toEqual({});
  });
});
