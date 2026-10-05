import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { createReactDomHarness, waitUntilAct, type ReactDomHarness } from "../test-react-harness";
import type { BrowserLiveConnection, BrowserLiveSnapshot } from "./live-connection";
import { RECONNECT_DELAYS_MS } from "./live-connection";
import { createFakeLiveNetwork, type FakeLiveNetwork } from "./test-live-fakes";
import { useBrowserLive } from "./useBrowserLive";

let seen: { connection: BrowserLiveConnection; state: BrowserLiveSnapshot } | null = null;

function Probe({ browserSessionId, network }: { browserSessionId: string; network: FakeLiveNetwork }) {
  seen = useBrowserLive(browserSessionId, network.deps);
  return createElement("div", null, `${seen.state.phase}|${seen.state.url ?? ""}|${seen.state.message ?? ""}`);
}

describe("useBrowserLive", () => {
  let harness: ReactDomHarness | null = null;

  afterEach(async () => {
    await harness?.cleanup();
    harness = null;
    seen = null;
  });

  async function mount(browserSessionId = "bs_ab12cd34") {
    const network = createFakeLiveNetwork();
    harness = await createReactDomHarness();
    await harness.render(createElement(Probe, { browserSessionId, network }));
    await waitUntilAct(harness.act, () => network.sockets.length === 1, { label: "first socket" });
    return { network, harness };
  }

  it("connects on mount and shows what the server reports", async () => {
    const { network, harness } = await mount();
    expect(network.ticketRequests).toEqual(["bs_ab12cd34"]);
    expect(harness.dom.container.textContent).toBe("connecting||");

    await harness.act(async () => {
      network.latestSocket().open();
      network.latestSocket().receive({ type: "viewport", width: 945, height: 917 });
      network.latestSocket().receive({ type: "url", url: "https://example.com/" });
    });
    expect(harness.dom.container.textContent).toBe("live|https://example.com/|");
    expect(seen?.state.viewport).toEqual({ width: 945, height: 917 });
  });

  it("acknowledges every frame", async () => {
    const { network, harness } = await mount();
    const socket = network.latestSocket();
    await harness.act(async () => {
      socket.open();
      socket.receive({ type: "frame", seq: 41, data: "AAAA" });
    });
    await waitUntilAct(harness.act, () => socket.sentOfType("ack").length === 1, { label: "first ack" });
    await harness.act(async () => {
      socket.receive({ type: "frame", seq: 42, data: "BBBB" });
    });
    await waitUntilAct(harness.act, () => socket.sentOfType("ack").length === 2, { label: "second ack" });
    expect(socket.sentOfType("ack").map((ack) => ack.seq)).toEqual([41, 42]);
    expect(seen?.state.hasFrame).toBe(true);
  });

  it("sends no pointer input before the page's size arrives", async () => {
    const { network, harness } = await mount();
    const socket = network.latestSocket();
    const press = { type: "input_mouse", eventType: "mousePressed", x: 10, y: 10, button: "left", clickCount: 1 } as const;
    await harness.act(async () => {
      socket.open();
    });
    expect(seen?.connection.send(press)).toBe(false);
    expect(socket.sent).toEqual([]);

    await harness.act(async () => {
      socket.receive({ type: "viewport", width: 945, height: 917 });
    });
    expect(seen?.connection.send(press)).toBe(true);
    expect(socket.sent).toEqual([press]);
  });

  it("asks for a new ticket to reconnect after an unexpected close", async () => {
    const { network, harness } = await mount();
    await harness.act(async () => {
      network.latestSocket().open();
      network.latestSocket().receive({ type: "viewport", width: 945, height: 917 });
      network.latestSocket().drop();
    });
    expect(harness.dom.container.textContent).toBe("reconnecting||");
    expect(network.ticketRequests).toHaveLength(1);

    await harness.act(async () => {
      network.clock.advance(RECONNECT_DELAYS_MS[0]);
    });
    await waitUntilAct(harness.act, () => network.sockets.length === 2, { label: "second socket" });
    expect(network.ticketRequests).toHaveLength(2);
    expect(network.latestSocket().url).toContain("token=token-2");

    await harness.act(async () => {
      network.latestSocket().open();
      network.latestSocket().receive({ type: "viewport", width: 945, height: 917 });
    });
    expect(harness.dom.container.textContent).toBe("live||");
  });

  it("stops reconnecting when the server closes the view", async () => {
    const { network, harness } = await mount();
    await harness.act(async () => {
      network.latestSocket().open();
      network.latestSocket().receive({ type: "closed", reason: "session_ended", message: "The browser session was closed." });
      network.latestSocket().drop();
    });
    expect(harness.dom.container.textContent).toBe("ended||The browser session was closed.");

    await harness.act(async () => {
      network.clock.advance(120_000);
    });
    expect(network.ticketRequests).toHaveLength(1);
    expect(network.sockets).toHaveLength(1);
    expect(network.clock.pending()).toBe(0);
  });

  it("closes the connection on unmount", async () => {
    const { network, harness } = await mount();
    const socket = network.latestSocket();
    await harness.act(async () => {
      socket.open();
    });
    await harness.cleanup();
    expect(socket.closedByClient).toBe(true);
    expect(network.clock.pending()).toBe(0);
  });

  it("opens a new connection when the browser session changes", async () => {
    const { network, harness } = await mount("bs_first");
    const first = network.latestSocket();
    await harness.render(createElement(Probe, { browserSessionId: "bs_second", network }));
    await waitUntilAct(harness.act, () => network.sockets.length === 2, { label: "socket for the new session" });
    expect(first.closedByClient).toBe(true);
    expect(network.ticketRequests).toEqual(["bs_first", "bs_second"]);
    expect(network.latestSocket().url).toContain("browserSessionId=bs_second");
  });
});
