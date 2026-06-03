// BrowserLifecycle dependency: encapsulates bridge browser process cleanup so
// SessionManager (and any future consumer) can be exercised in tests without
// spawning the agent-browser CLI or scanning OS processes.
//
// Production wiring lives in createSessionManager and constructs a real
// BridgeBrowserLifecycle. Tests that do not care about browser cleanup get the
// safe no-op default automatically when no lifecycle is injected.

import {
  getBridgeBrowserTarget,
  getBrowserLaunchConfig,
  hasBrowserRuntimeActivity,
  shutdownBridgeBrowser,
  type BrowserLaunchConfig,
  type BrowserShutdownResult,
  type BrowserTarget,
} from "./agent-browser.js";
import type { TelemetryStore } from "./telemetry-store.js";

export type BrowserShutdownSkipReason = "no_browser_activity" | "disabled";

export type BrowserShutdownOutcome =
  | { skipped: true; reason: BrowserShutdownSkipReason; target?: BrowserTarget }
  | (BrowserShutdownResult & { skipped: false; target: BrowserTarget });

export interface BrowserLifecycle {
  shutdown(): Promise<BrowserShutdownOutcome>;
}

export interface BridgeBrowserLifecycleSettingsSource {
  getSettings(): { browser?: BrowserLaunchConfig | null } | undefined;
}

export interface BridgeBrowserLifecycleOptions {
  copilotHome?: string;
  settingsStore?: BridgeBrowserLifecycleSettingsSource;
  telemetryStore?: TelemetryStore;
}

class BridgeBrowserLifecycle implements BrowserLifecycle {
  constructor(private readonly opts: BridgeBrowserLifecycleOptions) {}

  async shutdown(): Promise<BrowserShutdownOutcome> {
    const target = this.resolveTarget();
    if (!hasBrowserRuntimeActivity(target.profileDir)) {
      return { skipped: true, reason: "no_browser_activity", target };
    }
    const result = await shutdownBridgeBrowser(target, this.opts.telemetryStore);
    return { ...result, skipped: false, target };
  }

  private resolveTarget(): BrowserTarget {
    const launchConfig = getBrowserLaunchConfig(this.opts.settingsStore?.getSettings());
    return getBridgeBrowserTarget(this.opts.copilotHome, launchConfig);
  }
}

export function createBridgeBrowserLifecycle(opts: BridgeBrowserLifecycleOptions): BrowserLifecycle {
  return new BridgeBrowserLifecycle(opts);
}

export const noopBrowserLifecycle: BrowserLifecycle = {
  async shutdown(): Promise<BrowserShutdownOutcome> {
    return { skipped: true, reason: "disabled" };
  },
};
