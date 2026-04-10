export interface BusySessionActivity {
  id: string;
  staleMs: number;
  elapsedMs: number;
}

export interface BusyState {
  busy: boolean;
  count: number;
  sessions?: BusySessionActivity[];
}

interface WaitForIdleDeps {
  fetchBusy: () => Promise<BusyState>;
  sleep: (ms: number) => Promise<void>;
  log: (msg: string) => void;
  isServerAlive: () => boolean;
  busyCheckInterval: number;
  busyWaitTimeout: number;
  staleThreshold: number;
}

export async function waitForIdleSessions(deps: WaitForIdleDeps): Promise<boolean> {
  const start = Date.now();
  let firstCheck = true;

  while (Date.now() - start < deps.busyWaitTimeout) {
    if (!firstCheck) {
      await deps.sleep(deps.busyCheckInterval);
    }
    firstCheck = false;

    try {
      const data = await deps.fetchBusy();
      if (!data.busy) {
        if (Date.now() > start) deps.log("All sessions idle — proceeding with restart");
        return true;
      }

      const sessions = data.sessions ?? [];
      if (sessions.length === 0) {
        deps.log("Busy check reported active work without session details — retrying...");
        continue;
      }

      if (sessions.every((s) => s.staleMs >= deps.staleThreshold)) {
        deps.log(`All ${sessions.length} session(s) are stuck (no events for ${deps.staleThreshold / 1000}s+) — proceeding with restart`);
        return true;
      }

      if (sessions.length === data.count) {
        const elapsed = Math.floor((Date.now() - start) / 1000);
        const stuckCount = sessions.filter((s) => s.staleMs >= deps.staleThreshold).length;
        const detail = stuckCount > 0
          ? ` (${stuckCount} stuck, ${sessions.length - stuckCount} active)`
          : "";
        const prefix = elapsed === 0
          ? `Waiting for ${data.count} active session(s) to finish: ${sessions.map((s) => s.id.slice(0, 8)).join(", ")}`
          : `Still waiting for ${data.count} session(s)${detail}... (${elapsed}s)`;
        deps.log(prefix);
      }
    } catch {
      if (!deps.isServerAlive()) {
        deps.log("Server not reachable for busy check — proceeding with restart");
        return true;
      }
      deps.log("Busy check failed while server is still running — retrying...");
    }
  }

  deps.log(`⚠️ Timed out after ${deps.busyWaitTimeout / 1000}s waiting for sessions — proceeding with restart`);
  return true;
}
