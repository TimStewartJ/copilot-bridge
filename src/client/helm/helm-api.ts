import { useCallback, useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { API_BASE } from "../api";

export interface HelmConversation {
  sessionId: string;
  title: string | null;
  createdAt: string;
  lastActiveAt: string;
  turnCount: number;
  kept: boolean;
  busy: boolean;
  handsFree: boolean;
  /** When retention deletes it; absent for kept conversations. */
  expiresAt?: string;
}

export type HelmTurnMode = "typed" | "spoken";

export interface HelmState {
  current: HelmConversation | null;
  /** Offered when Helm opened fresh: the most recent conversation with history. */
  resumable: HelmConversation | null;
  recent: HelmConversation[];
  policy: { freshAfterMs: number; retainMs: number; maxConversations: number };
  /** Effort each mode asks for right now (settings, else defaults). */
  reasoningEfforts: Record<HelmTurnMode, string>;
}

async function helmRequest<T>(path: string, init?: RequestInit): Promise<T> {
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

export const fetchHelmState = () => helmRequest<HelmState>("");
export const createHelmConversation = (options: { model?: string } = {}) =>
  helmRequest<HelmConversation>("/conversations", { method: "POST", body: JSON.stringify(options) });
export const startFreshHelm = () => helmRequest<HelmState>("/fresh", { method: "POST" });
export const resumeHelmConversation = (sessionId: string) =>
  helmRequest<HelmConversation>(`/conversations/${encodeURIComponent(sessionId)}/resume`, { method: "POST" });
export const setHelmConversationKept = (sessionId: string, kept: boolean) =>
  helmRequest<HelmConversation>(`/conversations/${encodeURIComponent(sessionId)}`, { method: "PATCH", body: JSON.stringify({ kept }) });
export const deleteHelmConversation = (sessionId: string) =>
  helmRequest<{ ok: true }>(`/conversations/${encodeURIComponent(sessionId)}`, { method: "DELETE" });

export const helmStateQueryKey = ["helm", "state"] as const;

export function useHelmStateQuery() {
  return useQuery({
    queryKey: helmStateQueryKey,
    queryFn: fetchHelmState,
    staleTime: 10_000,
    refetchOnWindowFocus: true,
  });
}

export function useInvalidateHelmState() {
  const queryClient = useQueryClient();
  return useCallback(() => queryClient.invalidateQueries({ queryKey: helmStateQueryKey }), [queryClient]);
}

const HELM_MODEL_STORAGE_KEY = "bridge.helm.model";

/** Model for new Helm conversations; empty means let the server pick a fast one. */
export function useHelmModelPreference(): [string, (model: string) => void] {
  const [model, setModel] = useState("");
  useEffect(() => {
    try {
      setModel(window.localStorage.getItem(HELM_MODEL_STORAGE_KEY) ?? "");
    } catch {
      // Storage may be unavailable; Auto is a fine default.
    }
  }, []);
  const update = useCallback((next: string) => {
    setModel(next);
    try {
      if (next) window.localStorage.setItem(HELM_MODEL_STORAGE_KEY, next);
      else window.localStorage.removeItem(HELM_MODEL_STORAGE_KEY);
    } catch {
      // Ignore storage failures.
    }
  }, []);
  return [model, update];
}

/** "in 13d", "today": how long until retention removes a conversation. */
export function describeHelmExpiry(conversation: Pick<HelmConversation, "kept" | "expiresAt">, now = Date.now()): string {
  if (conversation.kept) return "Kept";
  if (!conversation.expiresAt) return "";
  const remaining = Date.parse(conversation.expiresAt) - now;
  if (!Number.isFinite(remaining)) return "";
  if (remaining <= 0) return "Expires soon";
  const days = Math.floor(remaining / 86_400_000);
  if (days >= 1) return `Expires in ${days}d`;
  const hours = Math.floor(remaining / 3_600_000);
  return hours >= 1 ? `Expires in ${hours}h` : "Expires soon";
}

export function describeDuration(ms: number): string {
  const hours = Math.round(ms / 3_600_000);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.round(ms / 86_400_000);
  return `${days} days`;
}
