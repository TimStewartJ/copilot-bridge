// The Bridges Helm reads, for its looks and its chat: this one (through its own stores) and peers (through their
// REST API on the tailnet). Peers are only ever reached at the URL Tim configured, never by
// following a redirect, and nothing on a peer changes except on Tim's click.
import type { AppContext } from "../../app-context.js";
import type { HomeInput, HomeSection, HomeSnapshot } from "../../../shared/home.js";
import type { TaskOverview } from "../../../shared/task-overview.js";
import type { HelmPeer } from "../../../shared/helm-thinker.js";
import { buildTaskOverview, toOverviewSessions } from "../../task-overview.js";
import { createHomeReader } from "../../home.js";
import { sendChatMessage } from "../../chat-message-delivery.js";

export interface SourceSession {
  sessionId: string;
  title: string;
  lastActivityAt: string | null;
  linkedTaskIds: string[];
  runState: string;
  needsUserInput: boolean;
  triggeredBy?: string;
  archived: boolean;
}

export interface SourceMessage {
  role: string;
  content: string;
  timestamp?: string;
}

export interface HelmSource {
  id: string;
  label: string;
  local: boolean;
  /** Absolute web base for links to a peer; null for this Bridge (in-app paths). */
  webBase: string | null;
  sessions(): Promise<SourceSession[]>;
  snapshot(section: HomeSection, offset?: number): Promise<HomeSnapshot>;
  overview(): Promise<TaskOverview>;
  input(sessionId: string, kind: "user_input" | "elicitation", requestId: string): Promise<HomeInput | undefined>;
  messages(sessionId: string, limit: number): Promise<SourceMessage[]>;
  answer(sessionId: string, requestId: string, answer: string, wasFreeform: boolean): Promise<void>;
  /** clientMessageId makes a retried send land once. */
  send(sessionId: string, message: string, clientMessageId: string): Promise<void>;
  tick(actionId: string): Promise<void>;
}

export class HelmSourceError extends Error {}

function toSourceSession(raw: any): SourceSession | undefined {
  if (!raw || typeof raw.sessionId !== "string") return undefined;
  return {
    sessionId: raw.sessionId,
    title: typeof raw.summary === "string" && raw.summary.trim() ? raw.summary.trim() : "Untitled conversation",
    lastActivityAt: raw.lastActivityAt ?? raw.lastVisibleActivityAt ?? raw.modifiedTime ?? raw.startTime ?? null,
    linkedTaskIds: Array.isArray(raw.linkedTaskIds) ? raw.linkedTaskIds.filter((id: unknown) => typeof id === "string") : [],
    runState: typeof raw.runState === "string" ? raw.runState : "idle",
    needsUserInput: raw.needsUserInput === true,
    ...(typeof raw.triggeredBy === "string" ? { triggeredBy: raw.triggeredBy } : {}),
    archived: raw.archived === true,
  };
}

function toMessages(raw: unknown): SourceMessage[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry: any) => entry?.type === "message" && typeof entry.content === "string" && entry.content.trim()
    ? [{ role: String(entry.role ?? ""), content: entry.content as string, ...(entry.timestamp ? { timestamp: String(entry.timestamp) } : {}) }]
    : []);
}

export function createLocalSource(ctx: AppContext, readSessions: () => Promise<any[]>, label: string): HelmSource {
  const reader = createHomeReader(ctx as any, readSessions);
  return {
    id: "local",
    label,
    local: true,
    webBase: null,
    async sessions() {
      return (await readSessions()).flatMap((raw) => toSourceSession(raw) ?? []);
    },
    snapshot: (section, offset = 0) => reader.snapshot(section, offset),
    async overview() {
      const parsed = toOverviewSessions(await readSessions());
      return buildTaskOverview(ctx as any, parsed.sessions, Date.now(), undefined, parsed.invalid);
    },
    async input(sessionId, kind, requestId) {
      const native = await ctx.sessionManager.hydratePendingInteractions(sessionId);
      if (kind === "user_input") {
        const request = native.pendingUserInputs.find((candidate) => candidate.requestId === requestId);
        return request ? { kind, sessionId, title: "Conversation", request } : undefined;
      }
      const request = native.pendingElicitations.find((candidate) => candidate.requestId === requestId);
      return request ? { kind, sessionId, title: "Conversation", request } : undefined;
    },
    async messages(sessionId, limit) {
      const { messages } = await ctx.sessionManager.readMessagesFromDisk(sessionId, { limit });
      return toMessages(messages);
    },
    async answer(sessionId, requestId, answer, wasFreeform) {
      await ctx.sessionManager.submitUserInputResponse(sessionId, requestId, { answer, wasFreeform });
    },
    async send(sessionId, message, clientMessageId) {
      await sendChatMessage(ctx, sessionId, message, { queue: "on_failure", clientMessageId });
    },
    async tick(actionId) {
      if (!ctx.checklistStore) throw new HelmSourceError("Checklists are not available on this Bridge.");
      ctx.checklistStore.updateChecklistItem(actionId, { done: true } as any);
    },
  };
}

const PEER_TIMEOUT_MS = 15_000;

export function createPeerSource(peer: HelmPeer, options: { readOnly: boolean; fetchImpl?: typeof fetch }): HelmSource {
  const doFetch = options.fetchImpl ?? fetch;
  async function request<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
    const method = init?.method ?? "GET";
    if (method !== "GET" && options.readOnly) {
      throw new HelmSourceError(`Changes to ${peer.label} are switched off here (staged preview).`);
    }
    let response: Response;
    try {
      response = await doFetch(`${peer.apiUrl}/api${path}`, {
        method,
        redirect: "error",
        signal: AbortSignal.timeout(PEER_TIMEOUT_MS),
        headers: { accept: "application/json", ...(init?.body !== undefined ? { "content-type": "application/json" } : {}) },
        ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
      });
    } catch (error) {
      throw new HelmSourceError(`${peer.label} did not answer: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) {
      const body = await response.json().catch(() => undefined) as { error?: string } | undefined;
      throw new HelmSourceError(`${peer.label} answered ${response.status}${body?.error ? `: ${body.error}` : ""}`);
    }
    return response.json() as Promise<T>;
  }
  const enc = encodeURIComponent;
  return {
    id: peer.id,
    label: peer.label,
    local: false,
    webBase: peer.webUrl,
    async sessions() {
      const body = await request<{ sessions?: unknown[] } | unknown[]>("/sessions");
      const rows = Array.isArray(body) ? body : Array.isArray(body.sessions) ? body.sessions : [];
      return rows.flatMap((raw) => toSourceSession(raw) ?? []);
    },
    snapshot: (section, offset = 0) => request<HomeSnapshot>(`/home?section=${enc(section)}&offset=${Math.max(0, Math.floor(offset))}`),
    overview: () => request<TaskOverview>("/tasks/overview"),
    async input(sessionId, kind, requestId) {
      try {
        return await request<HomeInput>(`/home/inputs/${enc(sessionId)}/${enc(kind)}/${enc(requestId)}`);
      } catch (error) {
        if (error instanceof HelmSourceError && /answered 404/.test(error.message)) return undefined;
        throw error;
      }
    },
    async messages(sessionId, limit) {
      const body = await request<{ messages?: unknown }>(`/sessions/${enc(sessionId)}/messages-fast?limit=${Math.min(200, Math.max(1, limit))}`);
      return toMessages(body.messages);
    },
    async answer(sessionId, requestId, answer, wasFreeform) {
      await request(`/sessions/${enc(sessionId)}/user-input/${enc(requestId)}/respond`, { method: "POST", body: { answer, wasFreeform } });
    },
    async send(sessionId, message, clientMessageId) {
      await request("/chat", { method: "POST", body: { sessionId, prompt: message, clientMessageId } });
    },
    async tick(actionId) {
      await request(`/actions/${enc(actionId)}`, { method: "PATCH", body: { done: true } });
    },
  };
}

/** Web link to a task or conversation on a source: an in-app path here, an absolute URL on a peer. */
export function sourceLink(source: Pick<HelmSource, "webBase">, target: { sessionId?: string; taskId?: string }): string | undefined {
  const path = target.sessionId ? `/sessions/${encodeURIComponent(target.sessionId)}` : target.taskId ? `/tasks/${encodeURIComponent(target.taskId)}` : undefined;
  if (!path) return undefined;
  return source.webBase ? `${source.webBase}${path}` : path;
}
