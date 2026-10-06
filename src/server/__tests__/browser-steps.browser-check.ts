// Runs the steps that depend on how the installed agent-browser and a real browser behave:
// upload (the Bridge answers Chrome's file chooser next to agent-browser), screenshot, drag and
// download. Unit tests cover them against fakes; this is what tells whether an agent-browser or
// Chrome update broke one. Run with `npm run check:browser`.

import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

// The shared setup replaces the host lookups, and with them the browser and its launch arguments.
vi.unmock("../browser-launch-host.js");

const { runBrowserAutomationCommands } = await import("../browser-automation.js");
const { BrowserBroker } = await import("../browser-broker.js");
const { BrowserSessionStore, sessionLease } = await import("../browser-session-store.js");
const { normalizeBrowserAutomationCommands } = await import("../browser-steps.js");

/** A styled button over a hidden file input, a download link, and two lists that reorder by dragging. */
const PAGE = `<!doctype html><title>Steps</title>
<button onclick="document.getElementById('file').click()">Add photos</button>
<input type="file" id="file" style="display:none">
<button id="send">Send</button>
<a href="/report" download="report.txt">Get report</a>
<div id="list" style="display:flex;gap:8px;margin:12px"></div>
<pre id="log"></pre>
<script>
const log = document.getElementById('log'), list = document.getElementById('list');
document.getElementById('send').onclick = async () => {
  const body = new FormData();
  for (const file of document.getElementById('file').files) body.append('file', file);
  log.textContent = await (await fetch('/upload', { method: 'POST', body })).text();
};
let held;
for (const name of ['one', 'two', 'three']) {
  const item = document.createElement('button');
  item.textContent = name;
  item.style.cssText = 'width:90px;height:90px;background:#2980b9;touch-action:none';
  item.onpointerdown = () => { held = item; };
  list.appendChild(item);
}
document.onpointerup = (event) => {
  const over = document.elementFromPoint(event.clientX, event.clientY);
  if (held && over && over.parentNode === list && over !== held) list.insertBefore(held, over);
  held = undefined;
};
</script>`;

it("uploads through a styled button, screenshots, drags and downloads in a real browser", async () => {
  const copilotHome = await mkdtemp(join(tmpdir(), "bridge-browser-check-"));
  const filesDir = join(copilotHome, "chat-files");
  const pages = createServer((req, res) => {
    if (req.method === "POST") {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const body = Buffer.concat(chunks).toString("latin1");
        res.end(`received ${/filename="([^"]+)"/.exec(body)?.[1] ?? "nothing"} ${body.includes("photo-bytes") ? "intact" : "empty"}`);
      });
    } else if (req.url === "/report") {
      res.end("the report");
    } else {
      res.setHeader("content-type", "text/html");
      res.end(PAGE);
    }
  });
  const broker = new BrowserBroker({ copilotHome });
  const sessions = new BrowserSessionStore({ browserBroker: broker });
  try {
    pages.listen(0, "127.0.0.1");
    await once(pages, "listening");
    const site = `http://127.0.0.1:${(pages.address() as AddressInfo).port}/`;
    const photo = join(copilotHome, "photo.jpg");
    await writeFile(photo, "photo-bytes");
    const session = await sessions.createSession("browser-check", "public");

    /** Runs steps the way the tools do and returns their outputs and the screenshots. */
    const run = async (...steps: Array<[string, ...string[]]>) => {
      const commands = normalizeBrowserAutomationCommands(steps.map(([command, ...args]) => ({ command, args })));
      if (!commands.ok) throw new Error(commands.error);
      const used = await sessions.useSession(session.id, "browser-check", (record) => broker.withTarget(
        sessionLease(record),
        { toolName: "browser_steps_check", browserOpId: "browser-check" },
        () => runBrowserAutomationCommands(commands.value, { browserTarget: record.browserTarget }, { filesDir }),
      ));
      if (!used.ok) throw new Error(used.error);
      if (!used.value.ok) throw new Error(`${used.value.error.error}: ${used.value.error.failedStep.output}`);
      return { outputs: used.value.value.steps.map((step) => step.output), images: used.value.value.images };
    };
    const order = ["eval", "[...document.getElementById('list').children].map((item) => item.textContent).join(' ')"] as const;

    const opened = await run(["open", site], ["snapshot", "-i"], [...order]);
    const ref = (name: string): string => `@${new RegExp(`"${name}" \\[ref=(e\\d+)\\]`).exec(opened.outputs[1])?.[1]}`;
    expect(opened.outputs[2]).toBe("one two three");

    // A hidden input behind a button: only answering the chooser the click opens gets a file in.
    const uploaded = await run(["upload", ref("Add photos"), photo], ["click", ref("Send")], ["wait", "--text", "received"], ["eval", "document.getElementById('log').textContent"]);
    expect(uploaded.outputs[0]).toBe(`Chose photo.jpg in the file chooser ${ref("Add photos")} opened.`);
    expect(uploaded.outputs[3]).toBe("received photo.jpg intact");

    const dragged = await run(["drag", ref("three"), ref("one")], [...order]);
    expect(dragged.outputs[1]).toBe("three one two");

    const shot = await run(["screenshot"], ["screenshot", ref("two"), "square.png"]);
    expect(shot.outputs[0]).toMatch(/^Screenshot attached \(\d+x\d+\)\.$/);
    expect(shot.images.map((image) => image.mimeType)).toEqual(["image/jpeg", "image/png"]);
    // JPEG and PNG files start with these bytes.
    expect(shot.images[0].data.startsWith("/9j/")).toBe(true);
    expect((await readFile(join(filesDir, "square.png"))).subarray(1, 4).toString()).toBe("PNG");

    const downloaded = await run(["download", ref("Get report"), "report.txt"]);
    expect(downloaded.outputs[0]).toBe(`Saved the download to ${join(filesDir, "report.txt")}.`);
    await expect(readFile(join(filesDir, "report.txt"), "utf-8")).resolves.toBe("the report");
  } finally {
    await sessions.closeAll();
    pages.closeAllConnections();
    pages.close();
    await rm(copilotHome, { recursive: true, force: true });
  }
});
