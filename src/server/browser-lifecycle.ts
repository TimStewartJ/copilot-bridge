// Browser cleanup behind an interface so tests skip agent-browser; no-op when none is injected.

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
