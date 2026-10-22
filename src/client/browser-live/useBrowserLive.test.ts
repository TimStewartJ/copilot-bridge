import { createElement } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { createReactDomHarness, waitUntilAct, type ReactDomHarness } from "../test-react-harness";
import type { BrowserLiveConnection, BrowserLiveSnapshot } from "./live-connection";
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
