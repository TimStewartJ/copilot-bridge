// The `upload` step of the browser tools: gives files to the file chooser a page element opens.
//
// A browser draws its file chooser outside the page, where neither agent-browser nor a live
// view reaches it; on a headed browser it is a window on the server's screen that stays open.
// Chrome hands the chooser to a DevTools client that asks for it. For the length of one step
// the Bridge therefore connects to the browser next to agent-browser, asks for the choosers of
// the tab on show and of the frames inside it, has agent-browser click the element, and answers
// the chooser that opens with the files. Clicking, rather than setting the files on a node, is
// what makes a styled button, a label and a hidden input work, and it lets Chrome say whether
// the page takes one file or several.

import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { WebSocket } from "ws";
import { ab, type BrowserCommandOptions, type BrowserCommandResult } from "./agent-browser.js";
import { stepFilePath, type BrowserStepFiles } from "./browser-step-files.js";
import { err, ok, type Result } from "./tool-results.js";

/** How long Chrome gets to answer one DevTools request. */
const REQUEST_TIMEOUT_MS = 5_000;
/** How long after the click a chooser may still open: pages open it from their own handlers. */
const CHOOSER_WAIT_MS = 3_000;

export interface BrowserUploadOptions extends BrowserStepFiles {
  requestTimeoutMs?: number;
  chooserWaitMs?: number;
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, any>;
  result?: Record<string, any>;
  error?: { message?: string };
  sessionId?: string;
}

interface FileChooser {
  sessionId: string;
  backendNodeId: number;
  multiple: boolean;
}

/** A connection to the browser's DevTools endpoint, for requests and the events of its sessions. */
class CdpConnection {
  private nextId = 0;
  private readonly pending = new Map<number, (message: CdpMessage | Error) => void>();
  closed = false;
  onEvent: (message: CdpMessage) => void = () => {};
  onClose: () => void = () => {};

  private constructor(private readonly socket: WebSocket, private readonly timeoutMs: number) {
    socket.on("message", (data) => {
      let message: CdpMessage;
      try {
        message = JSON.parse(data.toString()) as CdpMessage;
      } catch {
        return;
      }
      if (message.id === undefined) this.onEvent(message);
      else this.pending.get(message.id)?.(message);
    });
    socket.on("close", () => {
      this.closed = true;
      for (const settle of [...this.pending.values()]) settle(new Error("the browser's DevTools connection closed"));
      this.onClose();
    });
    // A close always follows; without a listener the error would be thrown.
    socket.on("error", () => {});
  }

  static open(url: string, timeoutMs: number): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { perMessageDeflate: false, handshakeTimeout: timeoutMs });
      const connection = new CdpConnection(socket, timeoutMs);
      socket.once("open", () => resolve(connection));
      socket.once("close", () => reject(new Error("the browser's DevTools address did not answer")));
    });
  }

  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<Record<string, any>> {
    return new Promise((resolve, reject) => {
      if (this.closed) return reject(new Error("the browser's DevTools connection closed"));
      const id = ++this.nextId;
      const timer = setTimeout(
        () => this.pending.get(id)?.(new Error(`the browser did not answer ${method}`)),
        this.timeoutMs,
      );
      this.pending.set(id, (message) => {
        clearTimeout(timer);
        this.pending.delete(id);
        if (message instanceof Error) reject(message);
        else if (message.error) reject(new Error(`${method}: ${message.error.message ?? "failed"}`));
        else resolve(message.result ?? {});
      });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  close(): void {
    this.socket.close();
  }
}

/**
 * The files of an `upload` step as paths the browser can read. agent-browser's own `upload`
 * gives the page an empty file for a path that does not exist, so every file is checked here.
 */
async function resolveUploadFiles(files: readonly string[], filesDir: string | undefined): Promise<Result<string[]>> {
  const paths: string[] = [];
  for (const file of files) {
    const path = stepFilePath("upload", file, filesDir);
    if (!path.ok) return path;
    if (!await stat(path.value).then((entry) => entry.isFile(), () => false)) {
      return err(`upload found no file at ${path.value}. Nothing was clicked.`);
    }
    paths.push(path.value);
  }
  return ok(paths);
}

/** The DevTools target of the tab agent-browser acts on, from its `tab list`. */
function activeTargetId(data: Record<string, unknown> | undefined): string | undefined {
  const tabs = Array.isArray(data?.tabs) ? data.tabs as Array<{ active?: unknown; targetId?: unknown }> : [];
  const active = tabs.filter((tab) => tab.active === true);
  return active.length === 1 && typeof active[0].targetId === "string" ? active[0].targetId : undefined;
}

/** The browser's DevTools address when it is on this machine, which is the only place the Bridge connects to. */
function localDevToolsUrl(value: unknown): string | undefined {
  try {
    const url = new URL(String(value));
    return url.protocol === "ws:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ? url.href : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Clicks the element `ref` and gives `files` to the file chooser that opens. The result reads
 * like an agent-browser command's, so the step fails and reports the way the others do.
 */
export async function uploadFiles(
  ref: string,
  files: readonly string[],
  timeoutMs: number | undefined,
  commandOptions: BrowserCommandOptions,
  options: BrowserUploadOptions = {},
): Promise<BrowserCommandResult> {
  const run = options.runCommand ?? ab;
  const fail = (output: string): BrowserCommandResult => ({ ok: false, output });

  const paths = await resolveUploadFiles(files, options.filesDir);
  if (!paths.ok) return fail(paths.error);

  const tabs = await run(["tab", "list"], undefined, commandOptions);
  if (!tabs.ok) return tabs;
  const targetId = activeTargetId(tabs.data);
  const endpoint = await run(["get", "cdp-url"], undefined, commandOptions);
  if (!endpoint.ok) return endpoint;
  const url = localDevToolsUrl(endpoint.data?.cdpUrl);
  if (!targetId || !url) return fail("upload could not find the browser's open tab. Nothing was clicked.");

  let cdp: CdpConnection | undefined;
  const sessions: string[] = [];
  let clicked = false;
  try {
    cdp = await CdpConnection.open(url, options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
    const connection = cdp;
    let chooser: FileChooser | undefined;
    let stopWaiting = (): void => {};
    const frameSetups: Promise<void>[] = [];
    /** Asks for the choosers of a page or frame, and to be told of the frames inside it. */
    const intercept = async (sessionId: string): Promise<void> => {
      sessions.push(sessionId);
      await connection.send("Page.enable", {}, sessionId);
      await connection.send("Page.setInterceptFileChooserDialog", { enabled: true }, sessionId);
      // A frame of another site is a target of its own, and its chooser is reported only there.
      await connection.send("Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: false,
        flatten: true,
        filter: [{ type: "iframe" }],
      }, sessionId);
    };
    connection.onEvent = ({ method, params, sessionId }) => {
      if (method === "Target.attachedToTarget" && params?.targetInfo?.type === "iframe" && typeof params.sessionId === "string") {
        // A frame that cannot be watched leaves the rest of the page working.
        frameSetups.push(intercept(params.sessionId).catch(() => {}));
      } else if (method === "Page.fileChooserOpened" && sessionId && !chooser && typeof params?.backendNodeId === "number") {
        chooser = { sessionId, backendNodeId: params.backendNodeId, multiple: params.mode === "selectMultiple" };
        stopWaiting();
      }
    };
    connection.onClose = () => stopWaiting();

    const page = await connection.send("Target.attachToTarget", { targetId, flatten: true });
    await intercept(String(page.sessionId));
    // Frames are announced while their parent is set up, and a frame can hold frames.
    for (let index = 0; index < frameSetups.length; index++) await frameSetups[index];

    // A click that is run again after a browser restart would open the chooser with nobody
    // asking for it, so this one is not recovered.
    const click = await run(["click", ref], timeoutMs, { ...commandOptions, skipRecovery: true });
    if (!click.ok) return click;
    clicked = true;
    if (!chooser && !connection.closed) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, options.chooserWaitMs ?? CHOOSER_WAIT_MS);
        stopWaiting = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
    const opened = chooser as FileChooser | undefined;
    if (!opened) {
      return fail(connection.closed
        ? "upload lost its connection to the browser after the click. Take a snapshot to see the page now."
        : `Clicking ${ref} opened no file chooser. The click did happen: take a snapshot to see the page now.`);
    }
    if (!opened.multiple && paths.value.length > 1) {
      return fail(`The page takes one file here and upload was given ${paths.value.length}. No file was chosen.`);
    }
    await connection.send("DOM.setFileInputFiles", { files: paths.value, backendNodeId: opened.backendNodeId }, opened.sessionId);
    return { ok: true, output: `Chose ${paths.value.map((path) => basename(path)).join(", ")} in the file chooser ${ref} opened.` };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return fail(`upload failed: ${reason}. ${clicked ? "The click did happen: take a snapshot to see the page now." : "Nothing was clicked."}`);
  } finally {
    if (cdp && !cdp.closed) {
      const connection = cdp;
      // Closing the connection ends its sessions and with them the interception; asking first
      // costs one bounded round and leaves nothing to a Chrome that is slow to notice the close.
      await Promise.allSettled(sessions.map((sessionId) =>
        connection.send("Page.setInterceptFileChooserDialog", { enabled: false }, sessionId)));
      connection.close();
    }
  }
}
