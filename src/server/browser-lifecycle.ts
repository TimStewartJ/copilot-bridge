// BrowserLifecycle dependency: encapsulates bridge browser process cleanup so
// SessionManager (and any future consumer) can be exercised in tests without
// spawning the agent-browser CLI or scanning OS processes.
//
// Production wiring lives in createSessionManager and constructs a real
// BridgeBrowserLifecycle. Tests that do not care about browser cleanup get the
// safe no-op default automatically when no lifecycle is injected.

import { hasBrowserRuntimeActivity, type BrowserShutdownResult, type BrowserTarget } from "./agent-browser.js";
import type { BrowserBroker } from "./browser-broker.js";

export type BrowserShutdownSkipReason = "no_browser_activity" | "disabled";

export type BrowserShutdownOutcome =
  | { skipped: true; reason: BrowserShutdownSkipReason; target?: BrowserTarget }
  | (BrowserShutdownResult & { skipped: false; target: BrowserTarget });

export interface BrowserLifecycle {
  shutdown(): Promise<BrowserShutdownOutcome>;
}

class BridgeBrowserLifecycle implements BrowserLifecycle {
  constructor(private readonly browserBroker: BrowserBroker) {}

  async shutdown(): Promise<BrowserShutdownOutcome> {
    const target = this.browserBroker.getAuthenticatedTarget();
    if (!hasBrowserRuntimeActivity(target.profileDir)) {
      return { skipped: true, reason: "no_browser_activity", target };
    }
    const result = await this.browserBroker.shutdownAuthenticated();
    return { ...result, skipped: false, target };
  }
}

/** Closes the authenticated browser of the given broker, which the rest of the Bridge shares. */
export function createBridgeBrowserLifecycle(browserBroker: BrowserBroker): BrowserLifecycle {
  return new BridgeBrowserLifecycle(browserBroker);
}

export const noopBrowserLifecycle: BrowserLifecycle = {
  async shutdown(): Promise<BrowserShutdownOutcome> {
    return { skipped: true, reason: "disabled" };
  },
};
