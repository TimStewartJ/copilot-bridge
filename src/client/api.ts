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
