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

export interface PRLink {
  repoId: string;
  repoName?: string;
  prId: number;
}

export interface Task {
  id: string;
  title: string;
  status: "active" | "paused" | "done" | "archived";
  notes: string;
  priority: number;
  createdAt: string;
  updatedAt: string;
  sessionIds: string[];
  workItemIds: number[];
  pullRequests: PRLink[];
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

export async function fetchMessages(sessionId: string): Promise<{ messages: ChatMessage[]; busy: boolean }> {
  const data = await apiFetch<{ messages: ChatMessage[]; busy: boolean }>(
    `/api/sessions/${sessionId}/messages`,
  );
  return data;
}

export interface StreamEvent {
  type: "thinking" | "delta" | "intent" | "assistant_partial" | "tool_start" | "tool_progress" | "tool_output" | "tool_done" | "title_changed" | "done" | "error";
  content?: string;
  name?: string;
  message?: string;
  intent?: string;
  title?: string;
}

export async function sendChatStreaming(
  sessionId: string,
  prompt: string,
  onEvent: (event: StreamEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch("/api/chat", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sessionId, prompt }),
    signal,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body");

  const decoder = new TextDecoder();
  let buffer = "";

  const flushBuffer = () => {
    if (!buffer.trim()) return;
    for (const line of buffer.split("\n")) {
      if (line.startsWith("data: ")) {
        try {
          const event = JSON.parse(line.slice(6)) as StreamEvent;
          console.log("[stream]", event.type, event.type === "delta" ? `(${event.content?.length ?? 0} chars)` : "");
          onEvent(event);
        } catch { /* skip malformed */ }
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      flushBuffer();
      console.log("[stream] Stream ended");
      break;
    }

    buffer += decoder.decode(value, { stream: true });

    // Parse SSE lines
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? ""; // keep incomplete line in buffer

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        try {
          const event = JSON.parse(line.slice(6)) as StreamEvent;
          console.log("[stream]", event.type, event.type === "delta" ? `(${event.content?.length ?? 0} chars)` : "");
          onEvent(event);
        } catch { /* skip malformed */ }
      }
    }
  }
}

// ── Task API ──────────────────────────────────────────────────────

export async function fetchTasks(): Promise<Task[]> {
  const data = await apiFetch<{ tasks: Task[] }>("/api/tasks");
  return data.tasks;
}

export async function createTask(title: string): Promise<Task> {
  const data = await apiFetch<{ task: Task }>("/api/tasks", { title });
  return data.task;
}

export async function fetchTask(id: string): Promise<Task> {
  const data = await apiFetch<{ task: Task }>(`/api/tasks/${id}`);
  return data.task;
}

export async function updateTask(
  id: string,
  updates: Partial<Pick<Task, "title" | "status" | "notes" | "priority">>,
): Promise<Task> {
  const data = await apiFetch<{ task: Task }>(`/api/tasks/${id}`, {
    ...updates,
    _method: "PATCH",
  });
  return data.task;
}

export async function patchTask(
  id: string,
  updates: Partial<Pick<Task, "title" | "status" | "notes" | "priority">>,
): Promise<Task> {
  const res = await fetch(`/api/tasks/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  const data = await res.json();
  return data.task;
}

export async function deleteTask(id: string): Promise<void> {
  await fetch(`/api/tasks/${id}`, { method: "DELETE" });
}

export async function linkResource(
  taskId: string,
  resource: { type: "session"; sessionId: string } | { type: "workItem"; workItemId: number } | { type: "pr"; repoId: string; repoName?: string; prId: number },
): Promise<Task> {
  const data = await apiFetch<{ task: Task }>(`/api/tasks/${taskId}/link`, resource);
  return data.task;
}

export async function unlinkResource(
  taskId: string,
  resource: { type: "session"; sessionId: string } | { type: "workItem"; workItemId: number } | { type: "pr"; repoId: string; prId: number },
): Promise<Task> {
  const res = await fetch(`/api/tasks/${taskId}/link`, {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(resource),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  const data = await res.json();
  return data.task;
}

export async function createTaskSession(taskId: string): Promise<string> {
  const data = await apiFetch<{ sessionId: string }>(
    `/api/tasks/${taskId}/session`,
    {},
  );
  return data.sessionId;
}
