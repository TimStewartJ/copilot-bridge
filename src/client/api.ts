export interface Session {
  sessionId: string;
  summary?: string;
  startTime?: string;
  modifiedTime?: string;
  lastVisibleActivityAt?: string;
  diskSizeBytes?: number;
  busy?: boolean;
  hasPlan?: boolean;
  archived?: boolean;
  archivedAt?: string;
  triggeredBy?: "user" | "schedule";
  scheduleId?: string;
  scheduleName?: string;
  scheduleEnabled?: boolean;
  context?: {
    cwd?: string;
    gitRoot?: string;
    branch?: string;
  };
}

export function getSessionActivityTime(session: Pick<Session, "lastVisibleActivityAt" | "modifiedTime" | "startTime">): string | undefined {
  return session.lastVisibleActivityAt ?? session.modifiedTime ?? session.startTime;
}

export interface ToolCall {
  toolCallId: string;
  name: string;
  args?: ToolArgs;
  result?: string;
  success?: boolean;
  parentToolCallId?: string;
  /** Set on sub-agent pseudo-tool entries (the group header) */
  isSubAgent?: boolean;
  childToolCalls?: ToolCall[];
  /** ISO timestamp when the tool call started */
  startedAt?: string;
  /** ISO timestamp when the tool call completed */
  completedAt?: string;
}

export type ToolArgs =
  | string
  | number
  | boolean
  | null
  | ToolArgs[]
  | { [key: string]: ToolArgs };

export interface BlobAttachment {
  type: "blob";
  /** Base64-encoded content (no data-URI prefix) */
  data: string;
  mimeType: string;
  displayName?: string;
}

export interface ChatMessage {
  id?: string;
  role: "user" | "assistant";
  content: string;
  timestamp?: string;
  toolCalls?: ToolCall[];
  attachments?: BlobAttachment[];
}

/** A tool call rendered as its own entry in the chronological chat list */
export interface ChatToolEntry {
  id?: string;
  type: "tool";
  toolCall: ToolCall;
}

/** Union type for chronological chat rendering — either a text message or a tool call */
export type ChatEntry = (ChatMessage & { type?: "message" }) | ChatToolEntry;

export type ProviderName = "ado" | "github";

export interface WorkItemRef {
  id: number;
  provider: ProviderName;
}

export interface PRRef {
  repoId: string;
  repoName?: string;
  prId: number;
  provider: ProviderName;
}

export interface Task {
  id: string;
  title: string;
  status: "active" | "paused" | "done" | "archived";
  groupId?: string;
  cwd?: string;
  notes: string;
  priority: number;
  order: number;
  createdAt: string;
  updatedAt: string;
  sessionIds: string[];
  workItems: WorkItemRef[];
  pullRequests: PRRef[];
  tags?: Tag[];
}

export interface TaskGroup {
  id: string;
  name: string;
  color: string;
  notes: string;
  order: number;
  collapsed: boolean;
  createdAt: string;
  updatedAt: string;
  tags?: Tag[];
}

// ── Tag types ─────────────────────────────────────────────────────

export interface Tag {
  id: string;
  name: string;
  color: string;
  instructions: string;
  order: number;
  createdAt: string;
  updatedAt: string;
}

export interface TagMcpServer {
  serverName: string;
  config: McpServerConfig;
}

// ── Todo types ────────────────────────────────────────────────────

export interface Todo {
  id: string;
  taskId: string | null;
  text: string;
  done: boolean;
  order: number;
  createdAt: string;
  completedAt?: string;
  deadline?: string; // YYYY-MM-DD
}

// ── Enriched types ────────────────────────────────────────────────

export interface EnrichedWorkItem {
  id: number;
  provider: ProviderName;
  title: string | null;
  state: string | null;
  type: string | null;
  assignedTo: string | null;
  areaPath: string | null;
  url: string;
}

export interface EnrichedPR {
  repoId: string;
  repoName: string | null;
  prId: number;
  provider: ProviderName;
  title: string | null;
  status: "active" | "completed" | "abandoned" | null;
  createdBy: string | null;
  reviewerCount: number;
  url: string;
}

export interface EnrichedTaskData {
  task: Task;
  workItems: EnrichedWorkItem[];
  pullRequests: EnrichedPR[];
}

// Derive API base from Vite's BASE_URL — enables staging previews at /staging/<prefix>/
const API_BASE = (import.meta.env.BASE_URL || "/").replace(/\/+$/, "");
export { API_BASE };

async function apiFetch<T>(path: string, body?: unknown): Promise<T> {
  const t0 = performance.now();
  const opts: RequestInit = body
    ? {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }
    : {};
  const res = await fetch(`${API_BASE}${path}`, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  const result = await res.json();
  // Fire-and-forget client timing report (skip telemetry endpoint to avoid recursion)
  if (!path.startsWith("/api/telemetry")) {
    const duration = Math.round(performance.now() - t0);
    reportTiming(`api${path.replace(/\/api/, "")}`, duration).catch(() => {});
  }
  return result;
}

// ── Client telemetry ──────────────────────────────────────────────

/** Fire-and-forget: report a client-side timing span to the server */
export async function reportTiming(
  name: string,
  duration: number,
  opts?: { sessionId?: string; metadata?: Record<string, unknown> },
): Promise<void> {
  try {
    const payload = { name, duration, sessionId: opts?.sessionId, metadata: opts?.metadata };
    await fetch(`${API_BASE}/api/telemetry`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch { /* never throw from telemetry */ }
}

export interface TelemetryStats {
  name: string;
  count: number;
  avg: number;
  min: number;
  max: number;
  p50: number;
  p95: number;
}

export async function fetchTelemetryStats(since?: string): Promise<TelemetryStats[]> {
  const qs = since ? `?since=${encodeURIComponent(since)}` : "";
  return apiFetch<TelemetryStats[]>(`/api/telemetry/stats${qs}`);
}

export async function fetchSessions(includeArchived = false, skipDiskSize = false): Promise<Session[]> {
  const params = new URLSearchParams();
  if (includeArchived) params.set("includeArchived", "true");
  if (skipDiskSize) params.set("skipDiskSize", "true");
  const qs = params.toString() ? `?${params}` : "";
  const data = await apiFetch<{ sessions: Session[] }>(`/api/sessions${qs}`);
  return data.sessions;
}

export async function createSession(): Promise<string> {
  const data = await apiFetch<{ sessionId: string }>("/api/sessions", {});
  return data.sessionId;
}

export async function patchSession(id: string, updates: { archived: boolean }): Promise<void> {
  const res = await fetch(`${API_BASE}/api/sessions/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
}

export async function deleteSession(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/sessions/${id}`, { method: "DELETE" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
}

export type BatchAction = "archive" | "unarchive" | "delete" | "markRead";

export async function batchSessionAction(
  action: BatchAction,
  sessionIds: string[],
): Promise<{ ok: boolean; errors: Record<string, string> }> {
  return apiFetch<{ ok: boolean; errors: Record<string, string> }>("/api/sessions/batch", {
    action,
    sessionIds,
  });
}

export async function duplicateSession(id: string): Promise<string> {
  const data = await apiFetch<{ sessionId: string }>(`/api/sessions/${id}/duplicate`, {});
  return data.sessionId;
}

export async function fetchMessages(
  sessionId: string,
  opts?: { limit?: number; before?: number },
): Promise<{ messages: ChatEntry[]; busy: boolean; total: number; hasMore: boolean }> {
  const params = new URLSearchParams();
  if (opts?.limit != null) params.set("limit", String(opts.limit));
  if (opts?.before != null) params.set("before", String(opts.before));
  const qs = params.toString();
  const data = await apiFetch<{ messages: ChatEntry[]; busy: boolean; total: number; hasMore: boolean }>(
    `/api/sessions/${sessionId}/messages${qs ? `?${qs}` : ""}`,
  );
  return data;
}

/** Fast message loading — reads from disk, no SDK resume needed */
export async function fetchMessagesFast(
  sessionId: string,
  opts?: { limit?: number; before?: number },
): Promise<{ messages: ChatEntry[]; busy: boolean; total: number; hasMore: boolean; warm: boolean }> {
  const params = new URLSearchParams();
  if (opts?.limit != null) params.set("limit", String(opts.limit));
  if (opts?.before != null) params.set("before", String(opts.before));
  const qs = params.toString();
  return apiFetch<{ messages: ChatEntry[]; busy: boolean; total: number; hasMore: boolean; warm: boolean }>(
    `/api/sessions/${sessionId}/messages-fast${qs ? `?${qs}` : ""}`,
  );
}

/** Warm a session — triggers SDK resume, returns when ready */
export async function warmSession(sessionId: string): Promise<void> {
  await apiFetch<{ ready: boolean }>(`/api/sessions/${sessionId}/warm`, {});
}

// ── Task API ──────────────────────────────────────────────────────

export async function fetchTasks(): Promise<Task[]> {
  const data = await apiFetch<{ tasks: Task[] }>("/api/tasks");
  return data.tasks;
}

export async function createTask(title: string, groupId?: string): Promise<Task> {
  const data = await apiFetch<{ task: Task }>("/api/tasks", { title, groupId });
  return data.task;
}

export async function fetchTask(id: string): Promise<Task> {
  const data = await apiFetch<{ task: Task }>(`/api/tasks/${id}`);
  return data.task;
}

export async function updateTask(
  id: string,
  updates: Partial<Pick<Task, "title" | "status" | "notes" | "priority" | "cwd">>,
): Promise<Task> {
  const data = await apiFetch<{ task: Task }>(`/api/tasks/${id}`, {
    ...updates,
    _method: "PATCH",
  });
  return data.task;
}

export async function patchTask(
  id: string,
  updates: Partial<Pick<Task, "title" | "status" | "notes" | "priority" | "cwd" | "groupId">>,
): Promise<Task> {
  const res = await fetch(`${API_BASE}/api/tasks/${id}`, {
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
  await fetch(`${API_BASE}/api/tasks/${id}`, { method: "DELETE" });
}

export async function reorderTasks(taskIds: string[]): Promise<Task[]> {
  const res = await fetch(`${API_BASE}/api/tasks/reorder`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ taskIds }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  const data = await res.json();
  return data.tasks;
}

export async function linkResource(
  taskId: string,
  resource: { type: "session"; sessionId: string } | { type: "workItem"; workItemId: number; provider?: ProviderName } | { type: "pr"; repoId: string; repoName?: string; prId: number; provider?: ProviderName },
): Promise<Task> {
  const data = await apiFetch<{ task: Task }>(`/api/tasks/${taskId}/link`, resource);
  return data.task;
}

export async function unlinkResource(
  taskId: string,
  resource: { type: "session"; sessionId: string } | { type: "workItem"; workItemId: number; provider?: ProviderName } | { type: "pr"; repoId: string; prId: number; provider?: ProviderName },
): Promise<Task> {
  const res = await fetch(`${API_BASE}/api/tasks/${taskId}/link`, {
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

// ── Task Group API ────────────────────────────────────────────────

export async function fetchTaskGroups(): Promise<TaskGroup[]> {
  const data = await apiFetch<{ groups: TaskGroup[] }>("/api/task-groups");
  return data.groups;
}

export async function createTaskGroup(name: string, color?: string): Promise<TaskGroup> {
  const data = await apiFetch<{ group: TaskGroup }>("/api/task-groups", { name, color });
  return data.group;
}

export async function patchTaskGroup(
  id: string,
  updates: Partial<Pick<TaskGroup, "name" | "color" | "collapsed" | "notes">>,
): Promise<TaskGroup> {
  const res = await fetch(`${API_BASE}/api/task-groups/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  const data = await res.json();
  return data.group;
}

export async function deleteTaskGroup(id: string): Promise<void> {
  await fetch(`${API_BASE}/api/task-groups/${id}`, { method: "DELETE" });
}

export async function reorderTaskGroups(groupIds: string[]): Promise<TaskGroup[]> {
  const res = await fetch(`${API_BASE}/api/task-groups/reorder`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ groupIds }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  const data = await res.json();
  return data.groups;
}

// ── Tag API ───────────────────────────────────────────────────────

export async function fetchTags(): Promise<Tag[]> {
  const data = await apiFetch<{ tags: Tag[] }>("/api/tags");
  return data.tags;
}

export async function createTag(name: string, color?: string): Promise<Tag> {
  const data = await apiFetch<{ tag: Tag }>("/api/tags", { name, color });
  return data.tag;
}

export async function patchTag(
  id: string,
  updates: Partial<Pick<Tag, "name" | "color" | "instructions">>,
): Promise<Tag> {
  const res = await fetch(`${API_BASE}/api/tags/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  const data = await res.json();
  return data.tag;
}

export async function deleteTag(id: string): Promise<void> {
  await fetch(`${API_BASE}/api/tags/${id}`, { method: "DELETE" });
}

export async function setTaskTags(taskId: string, tagIds: string[]): Promise<Tag[]> {
  const res = await fetch(`${API_BASE}/api/tasks/${taskId}/tags`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tagIds }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  const data = await res.json();
  return data.tags;
}

export async function setGroupTags(groupId: string, tagIds: string[]): Promise<Tag[]> {
  const res = await fetch(`${API_BASE}/api/task-groups/${groupId}/tags`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tagIds }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  const data = await res.json();
  return data.tags;
}

export async function fetchTagMcpServers(tagId: string): Promise<TagMcpServer[]> {
  const data = await apiFetch<{ servers: TagMcpServer[] }>(`/api/tags/${tagId}/mcp`);
  return data.servers;
}

export async function setTagMcpServer(tagId: string, serverName: string, config: McpServerConfig): Promise<void> {
  const res = await fetch(`${API_BASE}/api/tags/${tagId}/mcp/${encodeURIComponent(serverName)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
}

export async function reorderTags(tagIds: string[]): Promise<Tag[]> {
  const res = await fetch(`${API_BASE}/api/tags/reorder`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ tagIds }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  const data = await res.json();
  return data.tags;
}

export async function removeTagMcpServer(tagId: string, serverName: string): Promise<void> {
  await fetch(`${API_BASE}/api/tags/${tagId}/mcp/${encodeURIComponent(serverName)}`, { method: "DELETE" });
}

export interface RelatedDoc {
  path: string;
  title: string;
  tags: string[];
  folder: string;
  modified: string;
}

export async function fetchRelatedDocs(tagIds: string[]): Promise<RelatedDoc[]> {
  if (tagIds.length === 0) return [];
  const data = await apiFetch<{ docs: RelatedDoc[] }>(`/api/tags/related-docs?tags=${tagIds.join(",")}`);
  return data.docs;
}

// ── Plan API ──────────────────────────────────────────────────────

export interface PlanData {
  content: string | null;
  lastModified: string | null;
}

export async function fetchPlan(sessionId: string): Promise<PlanData> {
  return apiFetch<PlanData>(`/api/sessions/${sessionId}/plan`);
}

// ── Enriched Task API ─────────────────────────────────────────────

export async function fetchEnrichedTask(id: string): Promise<EnrichedTaskData> {
  return apiFetch<EnrichedTaskData>(`/api/tasks/${id}/enriched`);
}

// ── Read State API ────────────────────────────────────────────────

export async function fetchReadState(): Promise<Record<string, string>> {
  return apiFetch<Record<string, string>>("/api/read-state");
}

export async function markSessionRead(sessionId: string): Promise<void> {
  await apiFetch<{ ok: boolean }>(`/api/read-state/${sessionId}`, {});
}

export async function markSessionUnread(sessionId: string): Promise<void> {
  await fetch(`${API_BASE}/api/read-state/${sessionId}`, { method: "DELETE" });
}

// ── Dashboard API ─────────────────────────────────────────────────

export interface DashboardBusySession {
  sessionId: string;
  title: string;
  taskId: string | null;
  intentText: string | null;
}

export interface DashboardUnreadSession {
  sessionId: string;
  title: string;
  taskId: string | null;
  lastVisibleActivityAt?: string;
}

export interface DashboardActiveTask {
  task: Task;
  workItemSummary: { total: number; byState: Record<string, number> };
  prSummary: { total: number; active: number; completed: number };
  todoSummary: { total: number; done: number; open: number; overdue: number };
  hasUnread: boolean;
  hasBusySession: boolean;
  lastActivity: string;
}

export interface DashboardOrphanSession {
  sessionId: string;
  title: string;
  lastVisibleActivityAt?: string;
  branch: string | null;
  busy: boolean;
  unread: boolean;
}

export interface DashboardTodo {
  id: string;
  taskId: string | null;
  text: string;
  done: boolean;
  order: number;
  createdAt: string;
  deadline?: string;
  taskTitle: string | null;
  taskGroupColor: string | null;
  taskOrder: number;
  taskStatus: string | null;
  taskGroupId: string | null;
  taskGroupOrder: number | null;
}

export interface DashboardSchedule extends Schedule {
  taskTitle: string | null;
  taskGroupColor: string | null;
}

export interface DashboardData {
  busySessions: DashboardBusySession[];
  unreadSessions: DashboardUnreadSession[];
  lastActiveTask: DashboardActiveTask | null;
  orphanSessions: DashboardOrphanSession[];
  openTodos: DashboardTodo[];
  completedTodos: DashboardTodo[];
  schedules: DashboardSchedule[];
}

export async function fetchDashboard(): Promise<DashboardData> {
  return apiFetch<DashboardData>("/api/dashboard");
}

// ── Settings API ──────────────────────────────────────────────────

export interface McpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
  tools?: string[];
}

export interface AdoProviderConfig {
  org: string;
  project: string;
}

export interface GitHubProviderConfig {
  owner: string;
  defaultRepo?: string;
}

export interface ProvidersConfig {
  ado?: AdoProviderConfig;
  github?: GitHubProviderConfig;
}

export type ThemePreference = "light" | "dark" | "system";

export interface AppSettings {
  providers?: ProvidersConfig;
  mcpServers: Record<string, McpServerConfig>;
  favicon?: string;
  theme?: ThemePreference;
  identity?: string;
  customInstructions?: string;
  model?: string;
}

export async function fetchSettings(): Promise<AppSettings> {
  return apiFetch<AppSettings>("/api/settings");
}

export async function patchSettings(updates: Partial<AppSettings>): Promise<AppSettings> {
  const res = await fetch(`${API_BASE}/api/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

// ── MCP Status API ───────────────────────────────────────────────

export interface McpServerStatus {
  name: string;
  status: "connected" | "failed" | "pending" | "disabled" | "not_configured" | "unknown";
  error?: string;
  source?: string;
}

export async function fetchMcpStatus(sessionId: string): Promise<McpServerStatus[]> {
  const result = await apiFetch<{ servers: McpServerStatus[] }>(`/api/sessions/${sessionId}/mcp-status`);
  return result.servers;
}

export async function fetchGlobalMcpStatus(): Promise<McpServerStatus[]> {
  const result = await apiFetch<{ servers: McpServerStatus[] }>("/api/mcp-status");
  return result.servers;
}

// ── Models API ──────────────────────────────────────────────────

export interface ModelInfo {
  id: string;
  name: string;
  policy?: { state: "enabled" | "disabled" | "unconfigured" };
  billing?: { multiplier: number };
}

export async function fetchModels(): Promise<ModelInfo[]> {
  const result = await apiFetch<{ models: ModelInfo[] }>("/api/models");
  return result.models;
}

// ── Schedule API ──────────────────────────────────────────────────

export interface Schedule {
  id: string;
  taskId: string;
  name: string;
  prompt: string;
  type: "cron" | "once";
  cron?: string;
  runAt?: string;
  timezone?: string;
  enabled: boolean;
  reuseSession: boolean;
  lastSessionId?: string;
  createdAt: string;
  updatedAt: string;
  lastRunAt?: string;
  nextRunAt?: string;
  runCount: number;
  maxRuns?: number;
  expiresAt?: string;
}

export type ScheduleCreateInput = Pick<Schedule, "taskId" | "name" | "prompt" | "type"> &
  Partial<Pick<Schedule, "cron" | "runAt" | "timezone" | "reuseSession" | "maxRuns" | "expiresAt">>;

export type ScheduleUpdateInput = Partial<Pick<Schedule,
  "name" | "prompt" | "cron" | "runAt" | "timezone" | "enabled" | "reuseSession" | "maxRuns" | "expiresAt"
>>;

export async function fetchSchedules(taskId?: string): Promise<Schedule[]> {
  const qs = taskId ? `?taskId=${taskId}` : "";
  return apiFetch<Schedule[]>(`/api/schedules${qs}`);
}

export async function createSchedule(input: ScheduleCreateInput): Promise<Schedule> {
  return apiFetch<Schedule>("/api/schedules", input);
}

export async function patchSchedule(id: string, updates: ScheduleUpdateInput): Promise<Schedule> {
  const res = await fetch(`${API_BASE}/api/schedules/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

export async function deleteSchedule(id: string): Promise<void> {
  await fetch(`${API_BASE}/api/schedules/${id}`, { method: "DELETE" });
}

export async function triggerSchedule(id: string): Promise<{ sessionId?: string; skipped?: string }> {
  return apiFetch<{ sessionId?: string; skipped?: string }>(`/api/schedules/${id}/trigger`, {});
}

export interface ScheduleSessionsResponse {
  sessions: Session[];
  total: number;
  offset: number;
  limit: number;
}

export async function fetchScheduleSessions(
  scheduleId: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<ScheduleSessionsResponse> {
  const params = new URLSearchParams();
  if (opts.limit) params.set("limit", String(opts.limit));
  if (opts.offset) params.set("offset", String(opts.offset));
  const qs = params.toString();
  return apiFetch<ScheduleSessionsResponse>(`/api/schedules/${scheduleId}/sessions${qs ? `?${qs}` : ""}`);
}

// ── Todo API ──────────────────────────────────────────────────────

export async function fetchTodos(taskId: string): Promise<Todo[]> {
  const data = await apiFetch<{ todos: Todo[] }>(`/api/tasks/${taskId}/todos`);
  return data.todos;
}

export async function createTodo(taskId: string, text: string, deadline?: string): Promise<Todo> {
  const data = await apiFetch<{ todo: Todo }>(`/api/tasks/${taskId}/todos`, { text, deadline });
  return data.todo;
}

export async function createGlobalTodo(text: string, deadline?: string): Promise<Todo> {
  const data = await apiFetch<{ todo: Todo }>(`/api/todos`, { text, deadline });
  return data.todo;
}

export async function patchTodo(
  id: string,
  updates: Partial<Pick<Todo, "text" | "done">> & { deadline?: string | null },
): Promise<Todo> {
  const res = await fetch(`${API_BASE}/api/todos/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  const data = await res.json();
  return data.todo;
}

export async function deleteTodo(id: string): Promise<void> {
  await fetch(`${API_BASE}/api/todos/${id}`, { method: "DELETE" });
}

export async function reorderTodos(taskId: string, todoIds: string[]): Promise<Todo[]> {
  const res = await fetch(`${API_BASE}/api/tasks/${taskId}/todos/reorder`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ todoIds }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  const data = await res.json();
  return data.todos;
}

// ── Docs API ──────────────────────────────────────────────────────

export interface DocTreeNode {
  name: string;
  type: "file" | "folder";
  path: string;
  isDb?: boolean;
  hasIndex?: boolean;
  children?: DocTreeNode[];
}

export interface DocPage {
  path: string;
  title: string;
  tags: string[];
  frontmatter: Record<string, unknown>;
  body: string;
  folder: string;
  created: string;
  modified: string;
}

export interface DocSearchResult {
  path: string;
  title: string;
  snippet: string;
  score: number;
  folder: string;
  tags: string[];
}

export interface DbSchema {
  name: string;
  fields: { name: string; type: string; options?: string[]; required?: boolean }[];
  entryCount?: number;
}

export interface DbEntry {
  path: string;
  slug: string;
  title: string;
  fields: Record<string, unknown>;
  tags?: string[];
  created: string;
  modified: string;
}

export async function fetchDocsTree(): Promise<{ tree: DocTreeNode[]; hasRootIndex: boolean }> {
  return apiFetch<{ tree: DocTreeNode[]; hasRootIndex: boolean }>("/api/docs/tree");
}

export async function searchDocs(query: string, limit = 20, offset = 0): Promise<{ results: DocSearchResult[]; total: number }> {
  return apiFetch<{ results: DocSearchResult[]; total: number }>(`/api/docs/search?q=${encodeURIComponent(query)}&limit=${limit}&offset=${offset}`);
}

export async function fetchDocPage(path: string): Promise<DocPage> {
  return apiFetch<DocPage>(`/api/docs/pages/${path}`);
}

export async function writeDocPage(path: string, content: string): Promise<{ path: string; success: boolean }> {
  const res = await fetch(`${API_BASE}/api/docs/pages/${path}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ content }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

export async function deleteDocPage(path: string): Promise<{ deleted: boolean }> {
  const res = await fetch(`${API_BASE}/api/docs/pages/${path}`, { method: "DELETE" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

export async function fetchDbSchema(folder: string): Promise<DbSchema> {
  return apiFetch<DbSchema>(`/api/docs/schema/${folder}`);
}

export async function fetchDbEntries(
  folder: string,
  options?: { filters?: Record<string, string>; sort?: { field: string; order: "asc" | "desc" } },
): Promise<{ entries: DbEntry[]; total: number }> {
  const params = new URLSearchParams();
  params.set("limit", "10000");
  if (options?.filters) {
    for (const [k, v] of Object.entries(options.filters)) {
      params.set(k, String(v));
    }
  }
  if (options?.sort) {
    params.set("_sort", options.sort.field);
    params.set("_order", options.sort.order);
  }
  const qs = params.toString();
  return apiFetch<{ entries: DbEntry[]; total: number }>(`/api/docs/db/${folder}${qs ? `?${qs}` : ""}`);
}

export async function reindexDocs(): Promise<{ indexed: number }> {
  return apiFetch<{ indexed: number }>("/api/docs/reindex", {});
}

export async function resolveWikilinks(targets: string[]): Promise<Record<string, { path: string; title: string } | null>> {
  return apiFetch<Record<string, { path: string; title: string } | null>>("/api/docs/resolve", { targets });
}
