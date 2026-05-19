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

interface RestartBusyFetchDeps {
  fetch: (url: string, init?: RequestInit) => Promise<Response>;
  quiesceUrl: string;
  busyUrl: string;
  log: (msg: string) => void;
}

function getSuspendedSessionIds(data: unknown): string[] {
  if (!data || typeof data !== "object") return [];
  const value = (data as { suspendedSessionIds?: unknown }).suspendedSessionIds;
  return Array.isArray(value)
    ? value.filter((id): id is string => typeof id === "string")
    : [];
}

export async function fetchRestartBusyState(deps: RestartBusyFetchDeps): Promise<BusyState> {
  const quiesceRes = await deps.fetch(deps.quiesceUrl, { method: "POST" });
  if (quiesceRes.ok) {
    const quiesceData = await quiesceRes.json() as unknown;
    const suspendedSessionIds = getSuspendedSessionIds(quiesceData);
    if (suspendedSessionIds.length > 0) {
      deps.log(`Suspended ${suspendedSessionIds.length} session(s) for restart: ${suspendedSessionIds.map((id) => id.slice(0, 8)).join(", ")}`);
    }
  } else if (quiesceRes.status !== 404 && quiesceRes.status !== 405 && quiesceRes.status < 500) {
    throw new Error(`Busy check failed: ${quiesceRes.status}`);
  }

  const busyRes = await deps.fetch(deps.busyUrl);
  if (!busyRes.ok) throw new Error(`Busy check failed: ${busyRes.status}`);
  return await busyRes.json() as BusyState;
}

interface WaitForIdleDeps {
  fetchBusy: () => Promise<BusyState>;
  sleep: (ms: number) => Promise<void>;
  log: (msg: string) => void;
  isServerAlive: () => boolean;
  busyCheckInterval: number;
  busyWaitTimeout: number;
  staleThreshold: number;
  /** Called on each loop iteration when sessions are still busy, with the current active count. */
  onWaiting?: (count: number) => void | Promise<void>;
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

      if (deps.onWaiting) await Promise.resolve(deps.onWaiting(data.count));

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
