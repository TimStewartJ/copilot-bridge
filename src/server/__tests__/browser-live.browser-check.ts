// Runs the Bridge's own live-view check against the installed agent-browser and a real browser.
// Everything the live view relies on agent-browser's stream for is in that check, so this is
// what tells whether an agent-browser update broke it. The second test opens a live view the
// way a Bridge client does, for what only shows with the stream of a real agent-browser behind
// the relay. Run with `npm run check:browser`.

import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, it, vi } from "vitest";
import { WebSocket } from "ws";

import { BROWSER_LIVE_WS_PATH, type BrowserLiveCheck, type BrowserLiveServerMessage } from "../../shared/browser-live.js";

// The shared setup replaces the host lookups, and with them the browser and its launch arguments.
vi.unmock("../browser-launch-host.js");

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

    // agent-browser announces its tabs after every command it runs. A view that reads the page
    // for each announcement never stops; the first period lets the reads of its opening finish.
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
