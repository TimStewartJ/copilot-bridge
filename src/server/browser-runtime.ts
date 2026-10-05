// The Bridge's browser machinery for one app context: the broker that owns the browsers, the
// store of multi-turn browser sessions, and the gateway that shows a session to the user.

import { homedir } from "node:os";
import { join } from "node:path";

import type { AppContext } from "./app-context.js";
import { getBrowserLaunchConfig } from "./browser-launch.js";
import { BrowserBroker } from "./browser-broker.js";
import { BrowserLiveGateway } from "./browser-live.js";
import { BrowserSessionStore } from "./browser-session-store.js";
import { UserBrowserSession } from "./browser-user-session.js";

export interface BrowserRuntime {
  broker: BrowserBroker;
  sessions: BrowserSessionStore;
  live: BrowserLiveGateway;
  /** The signed-in browser as the user opens it from Settings. */
  userSession: UserBrowserSession;
}

const runtimes = new WeakMap<object, BrowserRuntime>();

export function getBrowserRuntime(ctx: AppContext): BrowserRuntime {
  let runtime = runtimes.get(ctx);
  if (!runtime) {
    const telemetryStore = ctx.telemetryStore;
    const broker = new BrowserBroker({
      copilotHome: ctx.copilotHome ?? ctx.runtimePaths?.copilotHome ?? process.env.COPILOT_HOME ?? join(homedir(), ".copilot"),
      telemetryStore,
      getBrowserLaunchConfig: () => getBrowserLaunchConfig(ctx.settingsStore.getSettings()),
    });
    const sessions = new BrowserSessionStore({ browserBroker: broker, telemetryStore });
    const live = new BrowserLiveGateway({ sessions, broker, telemetryStore });
    runtime = { broker, sessions, live, userSession: new UserBrowserSession({ sessions, broker, live }) };
    runtimes.set(ctx, runtime);
  }
  return runtime;
}

/** Ends the live views of a context that has any. Does not create the machinery to do so. */
export function shutdownBrowserLive(ctx: AppContext): void {
  runtimes.get(ctx)?.live.shutdown();
}
