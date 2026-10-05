import { describe, expect, it } from "vitest";

import { ApiError } from "../api";
import { BrowserLiveConnection, RECONNECT_DELAYS_MS, SOCKET_OPEN_TIMEOUT_MS } from "./live-connection";
import { createFakeLiveNetwork } from "./test-live-fakes";

/** Lets the awaited ticket request and frame draws run. */
async function settle(): Promise<void> {
  for (let turn = 0; turn < 5; turn += 1) await Promise.resolve();
}

async function connect() {
  const network = createFakeLiveNetwork();
  const connection = new BrowserLiveConnection("bs_ab12cd34", network.deps);
  connection.start();
  await settle();
  return { network, connection };
}

describe("BrowserLiveConnection", () => {
  it("asks for a ticket and opens the socket it describes", async () => {
    const { network, connection } = await connect();
    expect(network.ticketRequests).toEqual(["bs_ab12cd34"]);
    expect(network.latestSocket().url).toBe("ws://bridge.test/live?browserSessionId=bs_ab12cd34&token=token-1");
    expect(connection.getSnapshot()).toMatchObject({ phase: "connecting", viewport: null, url: null, hasFrame: false });

    network.latestSocket().open();
    network.latestSocket().receive({ type: "viewport", width: 945, height: 917 });
    network.latestSocket().receive({ type: "url", url: "https://example.com/login" });
    expect(connection.getSnapshot()).toMatchObject({
      phase: "live",
      viewport: { width: 945, height: 917 },
      url: "https://example.com/login",
    });
    connection.stop();
  });

  it("draws frames one at a time and acknowledges each after it is drawn", async () => {
    const { network, connection } = await connect();
    const socket = network.latestSocket();
    const drawn: string[] = [];
    const finish: Array<() => void> = [];
    connection.setFrameSink((data) => new Promise<void>((resolve) => {
      drawn.push(data);
      finish.push(resolve);
    }));
    socket.open();

    socket.receive({ type: "frame", seq: 1, data: "one" });
    await settle();
    expect(drawn).toEqual(["one"]);
    expect(socket.sentOfType("ack")).toEqual([]);

    finish[0]();
    await settle();
    expect(socket.sentOfType("ack")).toEqual([{ type: "ack", seq: 1 }]);
    expect(connection.getSnapshot().hasFrame).toBe(true);
    connection.stop();
  });

  it("skips a frame that a newer one overtakes, and still acknowledges it", async () => {
    const { network, connection } = await connect();
    const socket = network.latestSocket();
    const drawn: string[] = [];
    const finish: Array<() => void> = [];
    connection.setFrameSink((data) => new Promise<void>((resolve) => {
      drawn.push(data);
      finish.push(resolve);
    }));
    socket.open();

    socket.receive({ type: "frame", seq: 1, data: "one" });
    socket.receive({ type: "frame", seq: 2, data: "two" });
    socket.receive({ type: "frame", seq: 3, data: "three" });
    await settle();
    expect(drawn).toEqual(["one"]);
    expect(socket.sentOfType("ack")).toEqual([{ type: "ack", seq: 2 }]);

    finish[0]();
    await settle();
    expect(drawn).toEqual(["one", "three"]);
    finish[1]();
    await settle();
    expect(socket.sentOfType("ack").map((ack) => ack.seq)).toEqual([2, 1, 3]);
    connection.stop();
  });

  it("acknowledges a frame even when it cannot be drawn or nothing draws it", async () => {
    const { network, connection } = await connect();
    const socket = network.latestSocket();
    socket.open();
    socket.receive({ type: "frame", seq: 7, data: "seven" });
    await settle();
    connection.setFrameSink(() => {
      throw new Error("decode failed");
    });
    await settle();
    socket.receive({ type: "frame", seq: 8, data: "eight" });
    await settle();
    expect(socket.sentOfType("ack").map((ack) => ack.seq)).toEqual([7, 8]);
    connection.stop();
  });

  it("gives a sink that arrives late the picture it missed", async () => {
    const { network, connection } = await connect();
    const socket = network.latestSocket();
    socket.open();
    socket.receive({ type: "frame", seq: 1, data: "one" });
    await settle();

    const drawn: string[] = [];
    connection.setFrameSink((data) => {
      drawn.push(data);
    });
    await settle();
    expect(drawn).toEqual(["one"]);
    expect(socket.sentOfType("ack")).toHaveLength(1);
    connection.stop();
  });

  it("sends no pointer input until the page's size is known, and none while disconnected", async () => {
    const { network, connection } = await connect();
    const socket = network.latestSocket();
    const press = { type: "input_mouse", eventType: "mousePressed", x: 5, y: 5, button: "left", clickCount: 1 } as const;
    const key = { type: "input_keyboard", eventType: "char", text: "a" } as const;

    expect(connection.send(key)).toBe(false);
    socket.open();
    expect(connection.send(press)).toBe(false);
    expect(connection.send(key)).toBe(true);

    socket.receive({ type: "viewport", width: 945, height: 917 });
    expect(connection.send(press)).toBe(true);
    expect(socket.sent).toEqual([key, press]);

    socket.drop();
    expect(connection.send(press)).toBe(false);
    connection.stop();
  });

  it("sends what the toolbar asks for as soon as the socket is open", async () => {
    const { network, connection } = await connect();
    const socket = network.latestSocket();
    const commands = [
      { type: "navigate", url: "https://example.com/" },
      { type: "history", direction: "back" },
      { type: "reload" },
      { type: "tab", action: "select", tabId: "t2" },
    ] as const;

    expect(connection.send(commands[0])).toBe(false);
    socket.open();
    // Unlike a click, these need no page size.
    for (const command of commands) expect(connection.send(command)).toBe(true);

    expect(socket.sent).toEqual(commands);
    connection.stop();
  });

  it("keeps the browser's tabs as the server last told them, and ignores what is not a list of tabs", async () => {
    const { network, connection } = await connect();
    const socket = network.latestSocket();
    socket.open();
    expect(connection.getSnapshot().tabs).toEqual([]);
    const tabs = [
      { id: "t1", title: "Sign in", url: "https://accounts.example.com/signin", active: true },
      { id: "t2", title: "", url: "about:blank", active: false },
    ];

    socket.receive({ type: "tabs", tabs });
    expect(connection.getSnapshot().tabs).toEqual(tabs);

    socket.onmessage?.({ data: JSON.stringify({ type: "tabs" }) });
    socket.onmessage?.({ data: JSON.stringify({ type: "tabs", tabs: "t1" }) });
    expect(connection.getSnapshot().tabs).toEqual(tabs);

    // An entry without an id names no tab.
    socket.onmessage?.({ data: JSON.stringify({ type: "tabs", tabs: [null, { title: "No id" }, { id: "t3", title: 5, active: "yes" }] }) });
    expect(connection.getSnapshot().tabs).toEqual([{ id: "t3", title: "", url: "", active: false }]);
    connection.stop();
  });

  it("reconnects with a new ticket after the connection drops, and waits for the new page size", async () => {
    const { network, connection } = await connect();
    network.latestSocket().open();
    network.latestSocket().receive({ type: "viewport", width: 945, height: 917 });

    network.latestSocket().drop();
    expect(connection.getSnapshot().phase).toBe("reconnecting");
    expect(network.ticketRequests).toHaveLength(1);

    network.clock.advance(RECONNECT_DELAYS_MS[0]);
    await settle();
    expect(network.ticketRequests).toHaveLength(2);
    expect(network.sockets).toHaveLength(2);
    expect(network.latestSocket().url).toContain("token=token-2");

    network.latestSocket().open();
    const move = { type: "input_mouse", eventType: "mouseMoved", x: 1, y: 1 } as const;
    expect(connection.send(move)).toBe(false);
    network.latestSocket().receive({ type: "viewport", width: 945, height: 917 });
    expect(connection.getSnapshot().phase).toBe("live");
    expect(connection.send(move)).toBe(true);
    connection.stop();
  });

  it("stops for good when the server says the view is over", async () => {
    const { network, connection } = await connect();
    const socket = network.latestSocket();
    socket.open();
    socket.receive({ type: "viewport", width: 945, height: 917 });
    socket.receive({ type: "closed", reason: "session_ended", message: "The browser session was closed." });
    socket.drop();

    expect(connection.getSnapshot()).toMatchObject({
      phase: "ended",
      message: "The browser session was closed.",
      canRetry: false,
    });
    expect(socket.closedByClient).toBe(true);
    network.clock.advance(60_000);
    await settle();
    expect(network.ticketRequests).toHaveLength(1);
    expect(network.clock.pending()).toBe(0);
  });

  it("offers a retry when the stream ended but the session may still be there", async () => {
    const { network, connection } = await connect();
    network.latestSocket().open();
    network.latestSocket().receive({ type: "closed", reason: "stream_ended", message: "The stream stopped." });
    expect(connection.getSnapshot()).toMatchObject({ phase: "ended", message: "The stream stopped.", canRetry: true });

    connection.retry();
    await settle();
    expect(network.ticketRequests).toHaveLength(2);
    expect(connection.getSnapshot().phase).toBe("connecting");
    connection.stop();
  });

  it("gives up after a bounded number of failed attempts", async () => {
    const { network, connection } = await connect();
    network.latestSocket().drop();
    for (const delay of RECONNECT_DELAYS_MS) {
      expect(connection.getSnapshot().phase).toBe("reconnecting");
      network.clock.advance(delay);
      await settle();
      network.latestSocket().drop();
    }
    expect(connection.getSnapshot()).toMatchObject({ phase: "ended", canRetry: true });
    expect(connection.getSnapshot().message).toContain("connection");
    expect(network.ticketRequests).toHaveLength(RECONNECT_DELAYS_MS.length + 1);
    expect(network.clock.pending()).toBe(0);
  });

  it("starts its retries afresh once a connection has worked", async () => {
    const { network, connection } = await connect();
    for (let round = 0; round < RECONNECT_DELAYS_MS.length + 2; round += 1) {
      network.latestSocket().open();
      network.latestSocket().receive({ type: "viewport", width: 945, height: 917 });
      network.latestSocket().drop();
      expect(connection.getSnapshot().phase).toBe("reconnecting");
      network.clock.advance(RECONNECT_DELAYS_MS[0]);
      await settle();
    }
    expect(connection.getSnapshot().phase).toBe("reconnecting");
    connection.stop();
  });

  it("shows the server's words when it refuses a ticket, without retrying by itself", async () => {
    const network = createFakeLiveNetwork();
    network.setTicketResponder(async () => {
      throw new ApiError("Live view needs a newer agent-browser.", 409);
    });
    const connection = new BrowserLiveConnection("bs_ab12cd34", network.deps);
    connection.start();
    await settle();

    expect(connection.getSnapshot()).toMatchObject({
      phase: "ended",
      message: "Live view needs a newer agent-browser.",
      canRetry: true,
    });
    expect(network.clock.pending()).toBe(0);

    network.setTicketResponder(async (browserSessionId) => ({ browserSessionId, token: "second", expiresAt: "" }));
    connection.retry();
    await settle();
    expect(network.latestSocket().url).toContain("token=second");
    connection.stop();
  });

  it("treats a ticket request that could not reach the server as a dropped connection", async () => {
    const network = createFakeLiveNetwork();
    network.setTicketResponder(async (browserSessionId, attempt) => {
      if (attempt === 1) throw new TypeError("Failed to fetch");
      return { browserSessionId, token: "after-outage", expiresAt: "" };
    });
    const connection = new BrowserLiveConnection("bs_ab12cd34", network.deps);
    connection.start();
    await settle();
    expect(connection.getSnapshot().phase).toBe("reconnecting");

    network.clock.advance(RECONNECT_DELAYS_MS[0]);
    await settle();
    expect(network.latestSocket().url).toContain("token=after-outage");
    connection.stop();
  });

  it("treats a socket that never opens as a failed attempt", async () => {
    const { network, connection } = await connect();
    network.clock.advance(SOCKET_OPEN_TIMEOUT_MS);
    expect(network.sockets[0].closedByClient).toBe(true);
    expect(connection.getSnapshot().phase).toBe("reconnecting");
    connection.stop();
  });

  it("closes the socket and forgets its timers when stopped", async () => {
    const { network, connection } = await connect();
    const socket = network.latestSocket();
    socket.open();
    connection.stop();
    expect(socket.closedByClient).toBe(true);
    expect(network.clock.pending()).toBe(0);

    socket.drop();
    network.clock.advance(60_000);
    await settle();
    expect(network.ticketRequests).toHaveLength(1);
  });

  it("ignores a ticket that arrives after it was stopped", async () => {
    const network = createFakeLiveNetwork();
    const connection = new BrowserLiveConnection("bs_ab12cd34", network.deps);
    connection.start();
    connection.stop();
    await settle();
    expect(network.sockets).toHaveLength(0);
  });

  it("ignores messages it cannot read", async () => {
    const { network, connection } = await connect();
    const socket = network.latestSocket();
    socket.open();
    socket.onmessage?.({ data: "not json" });
    socket.onmessage?.({ data: JSON.stringify({ type: "viewport", width: 0, height: -1 }) });
    socket.onmessage?.({ data: JSON.stringify({ type: "frame", seq: "1" }) });
    socket.onmessage?.({ data: new ArrayBuffer(4) });
    expect(connection.getSnapshot()).toMatchObject({ phase: "connecting", viewport: null, hasFrame: false });
    connection.stop();
  });
});
