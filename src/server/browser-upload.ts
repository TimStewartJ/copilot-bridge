// Gives files to the file choosers a browser's pages open.
//
// A browser draws its file chooser outside the page, where neither agent-browser nor a live
// view reaches it; on a headed browser it is a window on the server's screen that stays open.
// Chrome hands the chooser to a DevTools client that asks for it, which is what a
// FileChooserWatch does, next to agent-browser:
// - The `upload` step watches the tab on show for the length of the step, has agent-browser
//   click the element, and answers the chooser that opens. Clicking, rather than setting the
//   files on a node, is what makes a styled button, a label and a hidden input work, and it
//   lets Chrome say whether the page takes one file or several.
// - A live view watches every tab for as long as it is open, and answers a chooser with the
//   files the person viewing picks on their own device (browser-live.ts).

import { stat } from "node:fs/promises";
import { basename } from "node:path";
import { ab, type BrowserCommandOptions, type BrowserCommandResult } from "./agent-browser.js";
import { CdpConnection, localDevToolsUrl } from "./browser-devtools.js";
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

/** A file chooser a page opened, and that Chrome handed over instead of showing it. */
export interface FileChooser {
  sessionId: string;
  backendNodeId: number;
  multiple: boolean;
}

export interface FileChooserWatchOptions {
  /** The one tab to watch. Without it every tab is watched, also those opened later. */
  targetId?: string;
  requestTimeoutMs?: number;
  onChooser: (chooser: FileChooser) => void;
  onClose?: () => void;
}

/** Has Chrome hand over the file choosers of a browser's pages for as long as it is open. */
export class FileChooserWatch {
  /** The pages and frames asked for their choosers, by DevTools session. */
  private readonly watched = new Map<string, Promise<void>>();

  private constructor(private readonly cdp: CdpConnection) {}

  static async open(url: string, options: FileChooserWatchOptions): Promise<FileChooserWatch> {
    const cdp = await CdpConnection.open(url, options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
    const watch = new FileChooserWatch(cdp);
    cdp.onClose = () => options.onClose?.();
    cdp.onEvent = ({ method, params, sessionId }) => {
      if (method === "Target.attachedToTarget" && typeof params?.sessionId === "string") {
        // A page or frame that cannot be watched leaves the rest working.
        watch.intercept(params.sessionId).catch(() => {});
      } else if (method === "Target.detachedFromTarget" && typeof params?.sessionId === "string") {
        watch.watched.delete(params.sessionId);
      } else if (method === "Page.fileChooserOpened" && sessionId && typeof params?.backendNodeId === "number") {
        options.onChooser({ sessionId, backendNodeId: params.backendNodeId, multiple: params.mode === "selectMultiple" });
      }
    };
    try {
      if (options.targetId) {
        const page = await cdp.send("Target.attachToTarget", { targetId: options.targetId, flatten: true });
        await watch.intercept(String(page.sessionId));
      } else {
        // Chrome attaches this connection to every tab there is and to each one opened later.
        await cdp.send("Target.setAutoAttach", {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true,
          filter: [{ type: "page" }],
        });
      }
      // Frames are announced while their parent is set up, and a frame can hold frames.
      for (let settled = 0; settled < watch.watched.size;) {
        const setups = [...watch.watched.values()];
        await Promise.allSettled(setups.slice(settled));
        settled = setups.length;
      }
    } catch (error) {
      await watch.close();
      throw error;
    }
    return watch;
  }

  get closed(): boolean {
    return this.cdp.closed;
  }

  /** Asks for the choosers of a page or frame, and to be told of the frames inside it. */
  private intercept(sessionId: string): Promise<void> {
    let setup = this.watched.get(sessionId);
    if (!setup) {
      setup = (async () => {
        await this.cdp.send("Page.enable", {}, sessionId);
        await this.cdp.send("Page.setInterceptFileChooserDialog", { enabled: true }, sessionId);
        // A frame of another site is a target of its own, and its chooser is reported only there.
        await this.cdp.send("Target.setAutoAttach", {
          autoAttach: true,
          waitForDebuggerOnStart: false,
          flatten: true,
          filter: [{ type: "iframe" }],
        }, sessionId);
      })();
      this.watched.set(sessionId, setup);
    }
    return setup;
  }

  /** The kinds of file the chooser's input accepts, as its `accept` attribute says. */
  async accept(chooser: FileChooser): Promise<string | undefined> {
    try {
      const { node } = await this.cdp.send("DOM.describeNode", { backendNodeId: chooser.backendNodeId }, chooser.sessionId);
      // Names and values in turn.
      const attributes: unknown[] = Array.isArray(node?.attributes) ? node.attributes : [];
      const value = attributes.find((_, index) => index % 2 === 1 && attributes[index - 1] === "accept");
      return typeof value === "string" && value.trim() ? value : undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Answers a chooser. The browser reads a file when the page does, which can be much later.
   * Rejects when the page that asked has reloaded or gone elsewhere since: Chrome reports
   * success for its input then and nothing happens, but it no longer finds the input's node.
   */
  async setFiles(chooser: FileChooser, paths: readonly string[]): Promise<void> {
    await this.cdp.send("DOM.resolveNode", { backendNodeId: chooser.backendNodeId }, chooser.sessionId);
    await this.cdp.send("DOM.setFileInputFiles", { files: paths, backendNodeId: chooser.backendNodeId }, chooser.sessionId);
  }

  async close(): Promise<void> {
    if (this.cdp.closed) return;
    // Closing the connection ends its sessions and with them the interception; asking first
    // costs one bounded round and leaves nothing to a Chrome that is slow to notice the close.
    await Promise.allSettled([...this.watched.keys()].map((sessionId) =>
      this.cdp.send("Page.setInterceptFileChooserDialog", { enabled: false }, sessionId)));
    this.cdp.close();
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

  let watch: FileChooserWatch | undefined;
  let clicked = false;
  try {
    let chooser: FileChooser | undefined;
    let stopWaiting = (): void => {};
    watch = await FileChooserWatch.open(url, {
      targetId,
      requestTimeoutMs: options.requestTimeoutMs,
      onChooser: (opened) => {
        chooser ??= opened;
        stopWaiting();
      },
      onClose: () => stopWaiting(),
    });

    // A click that is run again after a browser restart would open the chooser with nobody
    // asking for it, so this one is not recovered.
    const click = await run(["click", ref], timeoutMs, { ...commandOptions, skipRecovery: true });
    if (!click.ok) return click;
    clicked = true;
    if (!chooser && !watch.closed) {
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
      return fail(watch.closed
        ? "upload lost its connection to the browser after the click. Take a snapshot to see the page now."
        : `Clicking ${ref} opened no file chooser. The click did happen: take a snapshot to see the page now.`);
    }
    if (!opened.multiple && paths.value.length > 1) {
      return fail(`The page takes one file here and upload was given ${paths.value.length}. No file was chosen.`);
    }
    await watch.setFiles(opened, paths.value);
    return { ok: true, output: `Chose ${paths.value.map((path) => basename(path)).join(", ")} in the file chooser ${ref} opened.` };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return fail(`upload failed: ${reason}. ${clicked ? "The click did happen: take a snapshot to see the page now." : "Nothing was clicked."}`);
  } finally {
    await watch?.close();
  }
}
