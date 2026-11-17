// Live-view check against a real agent-browser and browser. Run with `npm run check:browser`.

import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { BROWSER_LIVE_WS_PATH, type BrowserLiveCheck, type BrowserLiveServerMessage } from "../../shared/browser-live.js";

// Use real browser lookups and agent-browser path; the mocked bare name fails on Windows.
vi.unmock("../browser-launch-host.js");
vi.unmock("../agent-browser-command.js");

const { ab } = await import("../agent-browser.js");
const { BrowserBroker } = await import("../browser-broker.js");
const { BrowserLiveGateway } = await import("../browser-live.js");
const { BrowserSessionStore, sessionLease } = await import("../browser-session-store.js");

/** How long a view is watched for commands it has no reason to run. */
const QUIET_PERIOD_MS = 3_000;

it("shows a page of a public browser and passes a click and typed text to it", async () => {
  const copilotHome = await mkdtemp(join(tmpdir(), "bridge-browser-check-"));
  const broker = new BrowserBroker({ copilotHome });
  const sessions = new BrowserSessionStore({ browserBroker: broker });
  const live = new BrowserLiveGateway({ sessions, broker });
  try {
    let check: BrowserLiveCheck | undefined;
    const health = await broker.probe("public", async (lease) => {
      check = await live.checkStream(lease.browserTarget);
    });

    expect(health.lastError).toBeUndefined();
    expect(health.status).toBe("ready");
    expect(check).toMatchObject({ ok: true });
    // The browser was closed and its profile given back.
    await expect(broker.getPublicProfileStats()).resolves.toEqual({ profiles: 1, inUse: 0 });
  } finally {
    live.shutdown();
    await sessions.closeAll();
    await rm(copilotHome, { recursive: true, force: true });
  }
});

it("runs no commands for a view that only shows a page, and reports the page a click in it leads to", async () => {
  const copilotHome = await mkdtemp(join(tmpdir(), "bridge-browser-check-"));
  const pages = createServer((req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(req.url === "/next"
      ? "<body>next</body>"
      : '<body style="margin:0"><a href="/next" style="display:block;width:100vw;height:100vh">next</a></body>');
  });
  /** The agent-browser commands the views ran, by name. */
  const commands: string[] = [];
  const broker = new BrowserBroker({ copilotHome });
  const sessions = new BrowserSessionStore({ browserBroker: broker });
  const live = new BrowserLiveGateway({
    sessions,
    broker,
    runCommand: (command, timeout, options) => {
      commands.push(command[0]);
      return ab(command, timeout, options);
    },
  });
  const bridge = createServer();
  bridge.on("upgrade", (req, socket, head) => {
    if (!live.handleUpgrade(req, socket, head)) socket.destroy();
  });
  let view: WebSocket | undefined;
  try {
    for (const server of [pages, bridge]) {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
    }
    const site = `http://127.0.0.1:${(pages.address() as AddressInfo).port}`;
    const session = await sessions.createSession("browser-check", "public");
    const opened = await sessions.useSession(session.id, "browser-check", (record) => broker.withTarget(
      sessionLease(record),
      { toolName: "browser_live_check", browserOpId: "browser-check" },
      () => ab(["open", `${site}/`], 30_000, { browserTarget: record.browserTarget }),
    ));
    expect(opened).toMatchObject({ ok: true, value: { ok: true } });

    const ticket = await live.createTicket(session.id);
    const query = new URLSearchParams({ browserSessionId: session.id, token: ticket.token });
    const socket = new WebSocket(
      `ws://127.0.0.1:${(bridge.address() as AddressInfo).port}${BROWSER_LIVE_WS_PATH}?${query.toString()}`,
    );
    view = socket;
    let frames = 0;
    const addresses: string[] = [];
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as BrowserLiveServerMessage;
      if (message.type === "frame") {
        frames += 1;
        socket.send(JSON.stringify({ type: "ack", seq: message.seq }));
      } else if (message.type === "url") {
        addresses.push(message.url);
      }
    });
    await vi.waitFor(() => {
      expect(frames).toBeGreaterThan(0);
      expect(addresses).toEqual([`${site}/`]);
    });

    // agent-browser announces tabs after every command; a view reading on each would never stop.
    await delay(QUIET_PERIOD_MS);
    const afterOpening = commands.length;
    await delay(QUIET_PERIOD_MS);
    expect(commands.slice(afterOpening)).toEqual([]);

    const click = { type: "input_mouse", x: 40, y: 40, button: "left", clickCount: 1 };
    socket.send(JSON.stringify({ type: "input_mouse", eventType: "mouseMoved", x: 40, y: 40 }));
    socket.send(JSON.stringify({ ...click, eventType: "mousePressed" }));
    socket.send(JSON.stringify({ ...click, eventType: "mouseReleased" }));
    await vi.waitFor(() => expect(addresses.at(-1)).toBe(`${site}/next`));
  } finally {
    view?.terminate();
    live.shutdown();
    await sessions.closeAll();
    for (const server of [pages, bridge]) {
      server.closeAllConnections();
      server.close();
    }
    await rm(copilotHome, { recursive: true, force: true });
  }
});

it("asks the viewer for the file when a tap in a view opens the page's file chooser, and gives the page the file", async () => {
  const copilotHome = await mkdtemp(join(tmpdir(), "bridge-browser-check-"));
  // A button over a hidden file input, the way sites style their "Add photos".
  const pages = createServer((_req, res) => {
    res.setHeader("content-type", "text/html");
    res.end(`<body style="margin:0">
      <button style="display:block;width:100vw;height:100vh" onclick="document.getElementById('file').click()">Add photo</button>
      <input type="file" id="file" accept="image/*" style="display:none" onchange="document.title = this.files[0].name + ' ' + this.files[0].size">
    </body>`);
  });
  const commands: string[] = [];
  const broker = new BrowserBroker({ copilotHome });
  const sessions = new BrowserSessionStore({ browserBroker: broker });
  const live = new BrowserLiveGateway({
    sessions,
    broker,
    filesDir: join(copilotHome, "live-files"),
    runCommand: async (command, timeout, options) => {
      const result = await ab(command, timeout, options);
      commands.push(command.join(" "));
      return result;
    },
  });
  const bridge = createServer();
  bridge.on("upgrade", (req, socket, head) => {
    if (!live.handleUpgrade(req, socket, head)) socket.destroy();
  });
  let view: WebSocket | undefined;
  try {
    for (const server of [pages, bridge]) {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
    }
    const session = await sessions.createSession("browser-check", "public");
    const onBrowser = (command: [string, ...string[]]) => sessions.useSession(session.id, "browser-check", (record) => broker.withTarget(
      sessionLease(record),
      { toolName: "browser_live_check", browserOpId: "browser-check" },
      () => ab(command, 30_000, { browserTarget: record.browserTarget }),
    ));
    expect(await onBrowser(["open", `http://127.0.0.1:${(pages.address() as AddressInfo).port}/`])).toMatchObject({ ok: true, value: { ok: true } });

    const ticket = await live.createTicket(session.id);
    const query = new URLSearchParams({ browserSessionId: session.id, token: ticket.token });
    const socket = new WebSocket(
      `ws://127.0.0.1:${(bridge.address() as AddressInfo).port}${BROWSER_LIVE_WS_PATH}?${query.toString()}`,
    );
    view = socket;
    let frames = 0;
    const asked: Array<Extract<BrowserLiveServerMessage, { type: "file_chooser" }>> = [];
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as BrowserLiveServerMessage;
      if (message.type === "frame") {
        frames += 1;
        socket.send(JSON.stringify({ type: "ack", seq: message.seq }));
      } else if (message.type === "file_chooser") {
        asked.push(message);
      }
    });
    await vi.waitFor(() => {
      expect(frames).toBeGreaterThan(0);
      expect(commands).toContain("get cdp-url");
    });
    // The view asks Chrome for the choosers once it knows where Chrome is; that takes a moment.
    await delay(1_000);

    const click = { type: "input_mouse", x: 40, y: 40, button: "left", clickCount: 1 };
    socket.send(JSON.stringify({ type: "input_mouse", eventType: "mouseMoved", x: 40, y: 40 }));
    socket.send(JSON.stringify({ ...click, eventType: "mousePressed" }));
    socket.send(JSON.stringify({ ...click, eventType: "mouseReleased" }));
    await vi.waitFor(() => expect(asked).toEqual([{ type: "file_chooser", id: expect.any(String), multiple: false, accept: "image/*" }]));

    const claim = await live.claimFileChooser(asked[0].id);
    const photo = join(claim!.folder, "photo.jpg");
    await writeFile(photo, "photo");
    await expect(live.chooseFiles(asked[0].id, [photo])).resolves.toMatchObject({ ok: true });
    await vi.waitFor(async () => expect(await onBrowser(["get", "title"])).toMatchObject({ value: { output: "photo.jpg 5" } }));

    // A page reloaded since it asked takes no file and the viewer is told; Chrome says success.
    socket.send(JSON.stringify({ ...click, eventType: "mousePressed" }));
    socket.send(JSON.stringify({ ...click, eventType: "mouseReleased" }));
    await vi.waitFor(() => expect(asked).toHaveLength(2));
    expect(await onBrowser(["reload"])).toMatchObject({ value: { ok: true } });
    await live.claimFileChooser(asked[1].id);
    await expect(live.chooseFiles(asked[1].id, [photo])).resolves.toEqual({
      ok: false,
      error: "The page is no longer asking for a file. Use its button again.",
    });
  } finally {
    view?.terminate();
    live.shutdown();
    await sessions.closeAll();
    for (const server of [pages, bridge]) {
      server.closeAllConnections();
      server.close();
    }
    await rm(copilotHome, { recursive: true, force: true });
  }
});

/** A popup sign-in like Microsoft's; each page is one full-page button, `pressed` logs presses. */
function createSignInSite() {
  const whole = "display:block;width:100vw;height:100vh";
  const pressed: string[] = [];
  const server = createServer((req, res) => {
    if (req.url?.startsWith("/pressed/")) {
      pressed.push(req.url.slice("/pressed/".length));
      res.end();
      return;
    }
    res.setHeader("content-type", "text/html");
    if (req.url === "/accounts") {
      res.end(`<body style="margin:0"><button style="${whole}" onclick="fetch('/pressed/popup').then(() => { location = '/signed-in' })">Pick an account</button></body>`);
    } else if (req.url === "/signed-in") {
      res.end("<script>opener.postMessage('signed in', '*'); close()</script>");
    } else {
      res.end(`<body style="margin:0">
        <button style="${whole}" onclick="fetch('/pressed/page'); open('/accounts', 'sign-in', 'width=500,height=600')">Sign in</button>
        <script>addEventListener('message', (event) => { document.title = event.data })</script>
      </body>`);
    }
  });
  return { server, pressed };
}

// The view's stream must follow agent-browser into a popup and back (0.33 stayed on the page).
it.each([
  ["a press in the view", false],
  ["the agent, before the view was opened for a handoff", true],
])("shows a sign-in popup opened by %s, passes a press to it, and goes back to the page when it closes", async (_name, openedByAgent) => {
  const copilotHome = await mkdtemp(join(tmpdir(), "bridge-browser-check-"));
  const { server: pages, pressed } = createSignInSite();
  const broker = new BrowserBroker({ copilotHome });
  const sessions = new BrowserSessionStore({ browserBroker: broker });
  const live = new BrowserLiveGateway({ sessions, broker });
  const bridge = createServer();
  bridge.on("upgrade", (req, socket, head) => {
    if (!live.handleUpgrade(req, socket, head)) socket.destroy();
  });
  let view: WebSocket | undefined;
  let handBack: (() => void) | undefined;
  try {
    for (const server of [pages, bridge]) {
      server.listen(0, "127.0.0.1");
      await once(server, "listening");
    }
    const site = `http://127.0.0.1:${(pages.address() as AddressInfo).port}`;
    const session = await sessions.createSession("browser-check", "public");
    const onBrowser = (command: [string, ...string[]]) => sessions.useSession(session.id, "browser-check", (record) => broker.withTarget(
      sessionLease(record),
      { toolName: "browser_live_check", browserOpId: "browser-check" },
      () => ab(command, 30_000, { browserTarget: record.browserTarget }),
    ));
    expect(await onBrowser(["open", `${site}/`])).toMatchObject({ ok: true, value: { ok: true } });
    if (openedByAgent) {
      expect(await onBrowser(["click", "button"])).toMatchObject({ value: { ok: true } });
      await vi.waitFor(async () => expect(await onBrowser(["get", "url"])).toMatchObject({ value: { output: `${site}/accounts` } }));
      // The browser is the user's from here on, as in a handoff.
      handBack = broker.holdTarget(sessionLease(sessions.getSession(session.id)!), "Sign in");
    }

    const ticket = await live.createTicket(session.id);
    const query = new URLSearchParams({ browserSessionId: session.id, token: ticket.token });
    const socket = new WebSocket(
      `ws://127.0.0.1:${(bridge.address() as AddressInfo).port}${BROWSER_LIVE_WS_PATH}?${query.toString()}`,
    );
    view = socket;
    let frames = 0;
    const addresses: string[] = [];
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString()) as BrowserLiveServerMessage;
      if (message.type === "frame") {
        frames += 1;
        socket.send(JSON.stringify({ type: "ack", seq: message.seq }));
      } else if (message.type === "url") {
        addresses.push(message.url);
      }
    });
    await vi.waitFor(() => expect(frames).toBeGreaterThan(0));

    const press = (): void => {
      const click = { type: "input_mouse", x: 40, y: 40, button: "left", clickCount: 1 };
      socket.send(JSON.stringify({ type: "input_mouse", eventType: "mouseMoved", x: 40, y: 40 }));
      socket.send(JSON.stringify({ ...click, eventType: "mousePressed" }));
      socket.send(JSON.stringify({ ...click, eventType: "mouseReleased" }));
    };
    if (!openedByAgent) press();
    await vi.waitFor(() => {
      expect(pressed).toEqual(["page"]);
      expect(addresses.at(-1)).toBe(`${site}/accounts`);
    });
    // The view is told of the popup a moment before the stream is on it.
    await delay(1_000);

    press();
    await vi.waitFor(() => {
      expect(pressed).toEqual(["page", "popup"]);
      expect(addresses.at(-1)).toBe(`${site}/`);
    });
    handBack?.();
    handBack = undefined;
    await vi.waitFor(async () => expect(await onBrowser(["get", "title"])).toMatchObject({ value: { output: "signed in" } }));

    // The stream is back on the page: a press reaches it again.
    press();
    await vi.waitFor(() => expect(pressed).toEqual(["page", "popup", "page"]));
  } finally {
    handBack?.();
    view?.terminate();
    live.shutdown();
    await sessions.closeAll();
    for (const server of [pages, bridge]) {
      server.closeAllConnections();
      server.close();
    }
    await rm(copilotHome, { recursive: true, force: true });
  }
});
