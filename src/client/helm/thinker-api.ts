import { useQuery, useQueryClient } from "@tanstack/react-query";
import { API_BASE } from "../api";
import type {
  HelmBriefResponse,
  HelmHandledView,
  HelmMemoryEntry,
  HelmRunView,
  HelmThinkerSettings,
} from "../../shared/helm-thinker";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}/api/helm${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => undefined) as { error?: string } | undefined;
    throw new Error(body?.error ?? res.statusText ?? `HTTP ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export const helmBriefKey = ["helm", "brief"] as const;
export const helmMemoryKey = ["helm", "memory"] as const;
export const helmRunsKey = ["helm", "runs"] as const;
export const helmBriefStatusKey = ["helm", "brief-status"] as const;

export interface HelmBriefStatus { runId: string | null; seen: boolean }

export const fetchHelmBrief = (signal?: AbortSignal) => request<HelmBriefResponse>("/brief", { signal });
export const fetchHelmBriefStatus = (signal?: AbortSignal) => request<HelmBriefStatus>("/brief/status", { signal });
export const markHelmBriefSeen = (runId: string) => request<HelmBriefStatus>(`/brief/${encodeURIComponent(runId)}/seen`, { method: "POST", body: "{}" });
export const thinkNow = () => request<HelmRunView>("/think", { method: "POST", body: "{}" });
export const actOnItem = (runId: string, itemId: string, input: { actionId?: string; text?: string }) =>
  request<{ ok: true; outcome: string; sessionId?: string }>(`/brief/${encodeURIComponent(runId)}/items/${encodeURIComponent(itemId)}/act`, { method: "POST", body: JSON.stringify(input) });
export const itemFeedback = (runId: string, itemId: string, kind: "not_for_helm" | "dismiss" | "done" | "reopen", note?: string) =>
  request<{ ok: true }>(`/brief/${encodeURIComponent(runId)}/items/${encodeURIComponent(itemId)}/feedback`, { method: "POST", body: JSON.stringify({ kind, ...(note ? { note } : {}) }) });
export const undoHandled = (id: string) => request<HelmHandledView>(`/handled/${encodeURIComponent(id)}/undo`, { method: "POST" });
export const fetchHelmMemory = (signal?: AbortSignal) => request<{ entries: HelmMemoryEntry[]; sourceNames?: Record<string, string> }>("/memory", { signal });
export const addHelmMemory = (kind: string, text: string) => request<HelmMemoryEntry>("/memory", { method: "POST", body: JSON.stringify({ kind, text }) });
export const updateHelmMemory = (id: string, patch: { text?: string; status?: "active" | "forgotten" }) =>
  request<HelmMemoryEntry>(`/memory/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) });
export const fetchHelmRuns = (signal?: AbortSignal) => request<{ runs: HelmRunView[] }>("/runs", { signal });
export const patchThinkerSettings = (patch: Partial<HelmThinkerSettings>) =>
  request<HelmThinkerSettings>("/thinker/settings", { method: "PATCH", body: JSON.stringify(patch) });
export interface HelmSourceTool { name: string; description?: string; readOnly: boolean; /** Chosen earlier, no longer offered. */ gone?: boolean }
/** Starts the MCP server on the Bridge to read its tools. */
export const fetchSourceTools = (serverId: string) =>
  request<{ serverId: string; name: string; tools: HelmSourceTool[] }>("/sources/tools", { method: "POST", body: JSON.stringify({ serverId }) });

export function useHelmBrief() {
  return useQuery({
    queryKey: helmBriefKey,
    queryFn: ({ signal }) => fetchHelmBrief(signal),
    // While Helm is thinking, check often so the new brief appears as soon as it is written.
    refetchInterval: (query) => (query.state.data?.running ? 5000 : 30000),
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: true,
  });
}

/** Whether the latest brief is new to Tim, for the Home icon. Refreshed by `helm:changed` events. */
export function useHelmBriefStatusQuery() {
  return useQuery({ queryKey: helmBriefStatusKey, queryFn: ({ signal }) => fetchHelmBriefStatus(signal), refetchOnWindowFocus: true });
}

/** The run of the brief the page has loaded, read from the cache without fetching it. */
export function useLoadedHelmBriefRunId(): string | null {
  return useQuery({ queryKey: helmBriefKey, queryFn: ({ signal }) => fetchHelmBrief(signal), enabled: false, select: (data) => data.run?.id ?? null }).data ?? null;
}

export function useHelmMemory() {
  return useQuery({ queryKey: helmMemoryKey, queryFn: ({ signal }) => fetchHelmMemory(signal) });
}

export function useHelmRuns() {
  return useQuery({ queryKey: helmRunsKey, queryFn: ({ signal }) => fetchHelmRuns(signal), refetchInterval: 15000 });
}

export function useInvalidateHelm() {
  const client = useQueryClient();
  return () => Promise.all([
    client.invalidateQueries({ queryKey: ["helm"] }),
    client.invalidateQueries({ queryKey: ["dashboard"] }),
  ]);
}

export function formatAgo(iso: string | null | undefined, now = Date.now()): string {
  if (!iso) return "";
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}

export function formatClock(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  const today = new Date();
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  if (date.toDateString() === today.toDateString()) return time;
  const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
  if (date.toDateString() === tomorrow.toDateString()) return `tomorrow ${time}`;
  return `${date.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

export function formatDuration(run: Pick<HelmRunView, "startedAt" | "finishedAt">): string {
  if (!run.finishedAt) return "";
  const seconds = Math.max(0, Math.round((Date.parse(run.finishedAt) - Date.parse(run.startedAt)) / 1000));
  return seconds < 90 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
}

export function formatCredits(credits: number): string {
  const value = credits < 10 ? credits.toFixed(1) : Math.round(credits).toLocaleString();
  return `${value} credit${value === "1.0" || value === "1" ? "" : "s"}`;
}
