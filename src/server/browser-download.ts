// The `download` step of the browser tools: clicks an element and saves what it downloads.
//
// agent-browser has a `download` command that does the same, and on Windows it never works:
// it hands Chrome the download folder as a verbatim path (`\\?\C:\...`, what Rust's
// `canonicalize` returns there), and Chrome receives the file and then cancels the download
// (vercel-labs/agent-browser#1659). The Bridge therefore does what that command does, with the
// folder's ordinary path: for the length of one step it connects to the browser next to
// agent-browser, tells Chrome where downloads go and to report them, has agent-browser click
// the element, and moves the finished file to the name the step asked for.

import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { ab, type BrowserCommandOptions, type BrowserCommandResult } from "./agent-browser.js";
import { CdpConnection, localDevToolsUrl } from "./browser-devtools.js";
import { stepFilePath, type BrowserStepFiles } from "./browser-step-files.js";

/** How long Chrome gets to answer one DevTools request. */
const REQUEST_TIMEOUT_MS = 5_000;
/** How long after the click the download may take, when the step sets no time limit. */
const DOWNLOAD_WAIT_MS = 30_000;
/** Chrome can report a download as complete a moment before the file has its final name. */
const FILE_RETRY_DELAYS_MS = [100, 200, 400, 800] as const;

export interface BrowserDownloadOptions extends BrowserStepFiles {
  requestTimeoutMs?: number;
  downloadWaitMs?: number;
  fileRetryDelaysMs?: readonly number[];
}

/** Moves the file Chrome saved to the name the step asked for, replacing what is there. */
async function moveDownload(from: string, to: string, retryDelaysMs: readonly number[]): Promise<void> {
  for (const delayMs of [...retryDelaysMs, undefined]) {
    try {
      await rename(from, to);
      return;
    } catch (error) {
      if (delayMs === undefined || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
  }
}

/**
 * The `download` step: `<ref> <file>`. The result reads like an agent-browser command's, so the
 * step fails and reports the way the others do.
 */
export async function saveDownload(
  args: readonly string[],
  timeoutMs: number | undefined,
  commandOptions: BrowserCommandOptions,
  options: BrowserDownloadOptions = {},
): Promise<BrowserCommandResult> {
  const run = options.runCommand ?? ab;
  const fail = (output: string): BrowserCommandResult => ({ ok: false, output });
  const ref = args[0];

  const path = stepFilePath("download", args[1], options.filesDir);
  if (!path.ok) return fail(path.error);
  const folder = dirname(path.value);
  try {
    await mkdir(folder, { recursive: true });
  } catch (error) {
    return fail(`download failed: ${error instanceof Error ? error.message : String(error)}`);
  }

  const endpoint = await run(["get", "cdp-url"], undefined, commandOptions);
  if (!endpoint.ok) return endpoint;
  const url = localDevToolsUrl(endpoint.data?.cdpUrl);
  if (!url) return fail("download could not find the browser. Nothing was clicked.");

  let cdp: CdpConnection | undefined;
  let clicked = false;
  const download: {
    /** Chrome's name for the download the click started; it saves the file under it. */
    guid?: string;
    outcome?: "completed" | "canceled";
    /** A file under Chrome's name may be in the folder. */
    leftover: boolean;
  } = { leftover: false };
  try {
    cdp = await CdpConnection.open(url, options.requestTimeoutMs ?? REQUEST_TIMEOUT_MS);
    const connection = cdp;
    let stopWaiting = (): void => {};
    connection.onEvent = ({ method, params }) => {
      if (method === "Browser.downloadWillBegin" && !download.guid && typeof params?.guid === "string") {
        download.guid = params.guid;
        download.leftover = true;
      } else if (
        method === "Browser.downloadProgress" && download.guid && params?.guid === download.guid && !download.outcome
        && (params.state === "completed" || params.state === "canceled")
      ) {
        download.outcome = params.state;
        stopWaiting();
      }
    };
    connection.onClose = () => stopWaiting();

    // Under Chrome's own name, so that a file of the page's choosing never replaces one that
    // is already in the folder.
    await connection.send("Browser.setDownloadBehavior", {
      behavior: "allowAndName",
      downloadPath: folder,
      eventsEnabled: true,
    });

    // A click that is run again after a browser restart would download with nobody waiting
    // for it, so this one is not recovered.
    const click = await run(["click", ref], timeoutMs, { ...commandOptions, skipRecovery: true });
    if (!click.ok) return click;
    clicked = true;
    if (!download.outcome && !connection.closed) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, options.downloadWaitMs ?? timeoutMs ?? DOWNLOAD_WAIT_MS);
        stopWaiting = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }
    if (download.outcome === "completed" && download.guid) {
      await moveDownload(join(folder, download.guid), path.value, options.fileRetryDelaysMs ?? FILE_RETRY_DELAYS_MS);
      download.leftover = false;
      return { ok: true, output: `Saved the download to ${path.value}.` };
    }
    if (download.outcome === "canceled") return fail("The browser cancelled the download. Nothing was saved.");
    if (connection.closed) {
      return fail("download lost its connection to the browser after the click. Take a snapshot to see the page now.");
    }
    if (!download.guid) {
      return fail(`Clicking ${ref} started no download. The click did happen: take a snapshot to see the page now.`);
    }
    // A download nobody waits for any more would otherwise go on, and leave its file behind.
    await connection.send("Browser.cancelDownload", { guid: download.guid }).catch(() => {});
    return fail("The download did not finish in time. Nothing was saved. Give the step a longer timeoutMs to wait longer.");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return fail(`download failed: ${reason}. ${clicked ? "The click did happen: take a snapshot to see the page now." : "Nothing was clicked."}`);
  } finally {
    cdp?.close();
    // What a download that did not finish, or could not be moved, left in the folder.
    if (download.leftover && download.guid) {
      const names = [download.guid, `${download.guid}.crdownload`];
      await Promise.allSettled(names.map((name) => rm(join(folder, name), { force: true })));
    }
  }
}
