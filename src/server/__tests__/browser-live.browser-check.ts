// Runs the Bridge's own live-view check against the installed agent-browser and a real browser.
// Everything the live view relies on agent-browser's stream for is in that check, so this is
// what tells whether an agent-browser update broke it. Run with `npm run check:browser`.

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";

import type { BrowserLiveCheck } from "../../shared/browser-live.js";

// The shared setup replaces the host lookups, and with them the browser and its launch arguments.
vi.unmock("../browser-launch-host.js");

const { BrowserBroker } = await import("../browser-broker.js");
const { BrowserLiveGateway } = await import("../browser-live.js");
const { BrowserSessionStore } = await import("../browser-session-store.js");

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
