import { API_BASE, ApiError } from "./api";

export interface BridgeRuntimeStatus {
  fetchedAt: string;
  serverInstanceId: string;
  pid: number;
  uptimeSeconds: number;
  isStaging: boolean;
  sourceManagementAvailable: boolean;
  sessions: {
    active: number;
    stalled: number;
    waitingForUserInput: number;
  };
  agents: {
    running: number;
    idle: number;
    failed: number;
    total: number;
    liveSessions: number;
    staleSessions: number;
    unknownSessions: number;
  };
  capacity: {
    contexts: {
      used: number;
      retained: number;
      limit: number;
    };
    weightedUnits: {
      used: number;
      retained: number;
      limit: number;
    };
    localMcpSlots: {
      used: number;
      retained: number;
    };
    cache: {
      readyParents: number;
      protectedParents: number;
      limit: number;
    };
    cleanup: {
      pending: number;
      failed: number;
      limit: number;
    };
    waitingRequests: number;
    localMcpWeight: number;
    waitTimeoutSeconds: number;
  };
}

export interface RestartBridgeResponse {
  ok: true;
  waitingSessions: number;
}

async function parseApiError(res: Response): Promise<ApiError> {
  const body = await res.json().catch(() => ({ error: res.statusText }));
  const message = body && typeof body === "object" && "error" in body && typeof body.error === "string"
    ? body.error
    : res.statusText;
  const details = body && typeof body === "object" && "details" in body ? body.details : undefined;
  return new ApiError(message || res.statusText, res.status, details);
}

async function bridgeManagementFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, init);
  if (!res.ok) throw await parseApiError(res);
  return res.json() as Promise<T>;
}

export async function fetchBridgeRuntimeStatus(
  options: { signal?: AbortSignal } = {},
): Promise<BridgeRuntimeStatus> {
  return bridgeManagementFetch<BridgeRuntimeStatus>(
    "/api/server/runtime-status",
    { signal: options.signal },
  );
}

export async function restartBridge(): Promise<RestartBridgeResponse> {
  return bridgeManagementFetch<RestartBridgeResponse>(
    "/api/server/restart",
    { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
  );
}
