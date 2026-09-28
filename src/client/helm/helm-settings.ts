import { useEffect, useSyncExternalStore } from "react";
import { API_BASE } from "../api";
import { type HelmSettingsResponse, type UnifiedHelmSettings } from "../../shared/helm-settings";

type Snapshot = { data: HelmSettingsResponse | null; error: string | null };
let snapshot: Snapshot = { data: null, error: null };
const listeners = new Set<() => void>();
let pending: Promise<HelmSettingsResponse> | undefined;
let writes: Promise<unknown> = Promise.resolve();

function publish(next: Snapshot): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

async function request(patch?: Partial<UnifiedHelmSettings>): Promise<HelmSettingsResponse> {
  const response = await fetch(`${API_BASE}/api/helm/settings`, {
    cache: "no-store",
    ...(patch ? { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) } : {}),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body?.error || `Helm settings: HTTP ${response.status}`);
  if (body?.schemaVersion !== 1 || !body.settings) throw new Error("This Bridge does not support unified Helm settings");
  return body as HelmSettingsResponse;
}

export function refreshHelmSettings(): Promise<HelmSettingsResponse> {
  if (pending) return pending;
  pending = writes.then(() => request()).then((data) => {
    publish({ data, error: null });
    return data;
  }).catch((error: unknown) => {
    publish({ ...snapshot, error: error instanceof Error ? error.message : String(error) });
    throw error;
  }).finally(() => { pending = undefined; });
  writes = pending.catch(() => undefined);
  return pending;
}

/** Serialize flat patches; never send cached or legacy browser values back to the server. */
export function patchHelmSettings(patch: Partial<UnifiedHelmSettings>): Promise<HelmSettingsResponse> {
  const result = writes.then(async () => {
    const data = await request(patch);
    publish({ data, error: null });
    return data;
  }).catch((error: unknown) => {
    publish({ ...snapshot, error: error instanceof Error ? error.message : String(error) });
    throw error;
  });
  writes = result.catch(() => undefined);
  return result;
}

export function useHelmPreferences(): Snapshot {
  const state = useSyncExternalStore(
    (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    () => snapshot,
    () => snapshot,
  );
  useEffect(() => {
    const refresh = () => { void refreshHelmSettings().catch(() => undefined); };
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);
  return state;
}
