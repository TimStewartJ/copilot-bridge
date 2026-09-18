// Keep-awake: while any session is active, keep Windows from sleeping and reset the user idle
// timer so an unattended run is not interrupted by sleep or an idle lock.
//
// It calls Win32 directly through in-process bindings. The previous design started a fresh
// PowerShell every 60 seconds from the server's main thread, and each start compiled C# through
// Add-Type (which runs csc.exe). Under machine load those process creations froze the event
// loop for tens of seconds at a time. Keeping the machine awake now starts no process at all.

import type { GlobalBus } from "./global-bus.js";
import { loadWindowsKeepAwakeApi, type WindowsKeepAwakeApi } from "./platform.js";

const ES_CONTINUOUS = 0x80000000;
const ES_SYSTEM_REQUIRED = 0x00000001;
const ES_DISPLAY_REQUIRED = 0x00000002;
const JIGGLE_INTERVAL_MS = 60_000;

export class KeepAwake {
  private api: WindowsKeepAwakeApi | null = null;
  private loading: Promise<void> | null = null;
  private wanted = false;
  private jiggleTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly loadApi: () => Promise<WindowsKeepAwakeApi> = loadWindowsKeepAwakeApi,
    private readonly logger: Pick<Console, "log" | "warn"> = console,
  ) {}

  setActive(active: boolean): void {
    if (this.wanted === active) return;
    this.wanted = active;
    this.logger.log(active
      ? "[keep-alive] 🟢 Keep-awake on (sessions active)"
      : "[keep-alive] ⚪ Keep-awake off (all sessions idle)");
    if (this.api) this.apply(this.api);
    else if (active) void this.load();
  }

  private load(): Promise<void> {
    this.loading ??= this.loadApi().then((api) => {
      this.api = api;
      // Apply whatever is wanted now: sessions may have gone idle while the bindings loaded.
      this.apply(api);
    }).catch((error) => {
      this.loading = null;
      this.logger.warn(
        `[keep-alive] Win32 bindings unavailable; the machine may sleep during long runs: ${error instanceof Error ? error.message : String(error)}`,
      );
    });
    return this.loading;
  }

  /** ES_CONTINUOUS state belongs to the calling thread, so every call is made from this one. */
  private apply(api: WindowsKeepAwakeApi): void {
    try {
      if (!this.wanted) {
        if (this.jiggleTimer) clearInterval(this.jiggleTimer);
        this.jiggleTimer = null;
        api.setThreadExecutionState(ES_CONTINUOUS);
        return;
      }
      api.setThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED);
      if (this.jiggleTimer) return;
      this.jiggle(api);
      this.jiggleTimer = setInterval(() => this.jiggle(api), JIGGLE_INTERVAL_MS);
      this.jiggleTimer.unref();
    } catch (error) {
      this.logger.warn(`[keep-alive] Win32 call failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** +1px then -1px: net zero movement that resets the user idle timer. */
  private jiggle(api: WindowsKeepAwakeApi): void {
    try {
      api.moveMouse(1, 0);
      api.moveMouse(-1, 0);
    } catch (error) {
      this.logger.warn(`[keep-alive] Mouse jiggle failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

export function initKeepAlive(globalBus: GlobalBus): void {
  if (process.platform !== "win32") {
    console.log("[keep-alive] Skipped (not Windows)");
    return;
  }

  const keepAwake = new KeepAwake();
  const activeSessions = new Set<string>();
  globalBus.subscribe((event) => {
    if (!("sessionId" in event) || !event.sessionId) return;
    if (event.type === "session:busy" || event.type === "session:stalled") activeSessions.add(event.sessionId);
    else if (event.type === "session:idle") activeSessions.delete(event.sessionId);
    else return;
    keepAwake.setActive(activeSessions.size > 0);
  });

  console.log("[keep-alive] Initialized — keeps the machine awake while sessions are active");
}
