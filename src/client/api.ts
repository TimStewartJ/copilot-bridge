export interface Session {
  sessionId: string;
  summary?: string;
  startTime?: string;
  modifiedTime?: string;
  diskSizeBytes?: number;
  context?: {
    cwd?: string;
    gitRoot?: string;
    branch?: string;
  };
}

export interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  timestamp?: string;
}

async function apiFetch<T>(path: string, body?: unknown): Promise<T> {
  const opts: RequestInit = body
    ? {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    : {};
  const res = await fetch(path, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

export async function fetchSessions(): Promise<Session[]> {
  const data = await apiFetch<{ sessions: Session[] }>("/api/sessions");
  return data.sessions;
}

export async function createSession(): Promise<string> {
  const data = await apiFetch<{ sessionId: string }>("/api/sessions", {});
  return data.sessionId;
}

export async function fetchMessages(sessionId: string): Promise<ChatMessage[]> {
  const data = await apiFetch<{ messages: ChatMessage[] }>(
    `/api/sessions/${sessionId}/messages`,
  );
  return data.messages;
}

export async function sendChat(
  sessionId: string,
  prompt: string,
): Promise<string> {
  const data = await apiFetch<{ response: string }>("/api/chat", {
    sessionId,
    prompt,
  });
  return data.response;
}
