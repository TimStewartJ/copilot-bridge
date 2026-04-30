import { createTelemetryBatcher } from "./telemetry-batcher";
import type { TaskGitStatusResponse, GitWorktreeHead } from "../server/git-worktree-status.js";
import type {
  NativeUserInputResponse as NativeUserInputResponseType,
  UserInputAnswerEndpointPayload as UserInputAnswerEndpointPayloadType,
  UserInputRequestId as UserInputRequestIdType,
} from "../server/user-input-types.js";
export type { McpServerConfig } from "../mcp-config";
export type {
  NativeUserInputRequest,
  NativeUserInputResponse,
  PendingUserInputRequestView,
  UserInputAnswerEndpointPayload,
  UserInputChoice,
  UserInputRequestId,
  UserInputSnapshotState,
  UserInputStreamEvent,
} from "../server/user-input-types.js";

export interface SessionWorkspaceOverride {
  cwd: string;
  updatedAt: string;
}

export interface SessionWorkspaceSummary {
  effectiveCwd?: string;
  taskCwd?: string;
  sessionOverride?: SessionWorkspaceOverride;
  overridesTaskWorkspace: boolean;
}

export type SessionWorkspaceSource = "session_workspace" | "workspace_yaml" | "task" | "default" | "none";
export type SessionWorkspacePathState = "available" | "missing" | "unconfigured";
export type SessionWorkspaceWarningCode = "missing_workspace" | "missing_pinned_workspace";

export interface SessionWorkspaceWarning {
  code: SessionWorkspaceWarningCode;
  message: string;
}

export interface SessionWorkspaceWorktree {
  cwd: string;
  workspaceKind: "main" | "linked";
  head: GitWorktreeHead;
  selected: boolean;
}

export interface SessionWorkspaceDetails extends SessionWorkspaceSummary {
  sessionId: string;
  taskId?: string;
  source: SessionWorkspaceSource;
  pathState: SessionWorkspacePathState;
  warnings: SessionWorkspaceWarning[];
  availableWorktrees: SessionWorkspaceWorktree[];
  canResetToTask: boolean;
  runState: SessionRunState;
  busy: boolean;
  gitStatus: TaskGitStatus;
}

/** Content-free defer indicator data for a single session. */
export interface DeferSummary {
  count: number;
  nextRunAt: string | null;
}

export interface Session {
  sessionId: string;
  summary?: string;
  intentText?: string | null;
  startTime?: string;
  modifiedTime?: string;
  lastVisibleActivityAt?: string;
  diskSizeBytes?: number;
  eventLogSizeBytes?: number;
  runState?: SessionRunState;
  busy?: boolean;
  pendingUserInputCount?: number;
  needsUserInput?: boolean;
  hasPlan?: boolean;
  archived?: boolean;
  archivedAt?: string;
  triggeredBy?: "user" | "schedule";
  scheduleId?: string;
  scheduleName?: string;
  scheduleEnabled?: boolean;
  deferSummary: DeferSummary;
  context?: {
    cwd?: string;
    gitRoot?: string;
    branch?: string;
  };
  workspace?: SessionWorkspaceSummary;
  isOptimistic?: boolean;
  optimisticUntil?: number;
}

export type SessionRunState = "busy" | "stalled" | "idle";

export function getSessionRunState(session: Pick<Session, "runState" | "busy">): SessionRunState {
  if (session.runState) return session.runState;
  return session.busy ? "busy" : "idle";
}

export function isSessionActive(session: Pick<Session, "runState" | "busy">): boolean {
  return getSessionRunState(session) !== "idle";
}

export function getSessionActivityTime(session: Pick<Session, "lastVisibleActivityAt" | "modifiedTime" | "startTime">): string | undefined {
  return session.lastVisibleActivityAt ?? session.modifiedTime ?? session.startTime;
}

export interface ToolCall {
  toolCallId: string;
  name: string;
  args?: ToolArgs;
  result?: string;
  /** Latest non-final progress or partial output surfaced while the tool is running */
  progressText?: string;
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

export interface UploadedAttachment {
  type: "uploaded";
  displayName: string;
  mimeType: string;
  size: number;
  /** Client-only: object URL for preview (not persisted) */
  previewUrl?: string;
}

/** A file attachment as recorded by the CLI in events.jsonl */
export interface FileRefAttachment {
  type: "file";
  path: string;
  displayName?: string;
}

export type Attachment = BlobAttachment | UploadedAttachment | FileRefAttachment;

export interface ChatMessage {
  id?: string;
  turnId?: string;
  role: "user" | "assistant";
  content: string;
  timestamp?: string;
  toolCalls?: ToolCall[];
  attachments?: Attachment[];
}

/** A tool call rendered as its own entry in the chronological chat list */
export interface ChatToolEntry {
  id?: string;
  type: "tool";
  turnId?: string;
  toolCall: ToolCall;
  liveSource?: "snapshot" | "event";
}

/** A published visual artifact rendered as an inline card */
export interface VisualArtifact {
  artifactId: string;
  kind: "image" | "mermaid" | "vega-lite" | "html";
  title: string;
  displayName: string;
  mimeType: string;
  size: number;
  /** URL for inline rendering (image/html) or source retrieval (mermaid/vega-lite/html) */
  url: string;
  downloadUrl: string;
  caption?: string;
  altText?: string;
  /** Optional live-stream source text; history replay fetches source from url. */
  source?: string;
}

/** A visual artifact entry in the chronological chat list */
export interface ChatVisualEntry {
  id?: string;
  type: "visual";
  visual: VisualArtifact;
  timestamp?: string;
}

/** Union type for chronological chat rendering — either a text message, a tool call, or a visual artifact */
export type ChatEntry = (ChatMessage & { type?: "message" }) | ChatToolEntry | ChatVisualEntry;

export type ProviderName = "ado" | "github" | "linear";

export interface WorkItemRef {
  id: string;
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
  kind: "task" | "ongoing";
  status: "active" | "done" | "archived";
  groupId?: string;
  cwd?: string;
  notes: string;
  doneWhen?: string;
  nextAction?: string;
  waitingOn?: string;
  nextTouchAt?: string;
  priority: number;
  order: number;
  createdAt: string;
  completedAt?: string;
  updatedAt: string;
  sessionIds: string[];
  workItems: WorkItemRef[];
  pullRequests: PRRef[];
  tags?: Tag[];
}

export type TaskCompletionAction = "complete-and-archive";

export interface TaskPatch {
  title?: Task["title"];
  kind?: Task["kind"];
  status?: Task["status"];
  notes?: Task["notes"];
  priority?: Task["priority"];
  cwd?: Task["cwd"];
  groupId?: Task["groupId"];
  doneWhen?: Task["doneWhen"] | null;
  nextAction?: Task["nextAction"] | null;
  waitingOn?: Task["waitingOn"] | null;
  nextTouchAt?: Task["nextTouchAt"] | null;
  completionAction?: TaskCompletionAction;
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

// ── Checklist item types ──────────────────────────────────────────

export interface ChecklistItem {
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
  id: string;
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

export interface TaskSessionStorage {
  taskId: string;
  totalDiskSizeBytes: number;
  sessions: Array<{ sessionId: string; diskSizeBytes: number }>;
}

export type TaskGitStatus = TaskGitStatusResponse;

// Derive API base from Vite's BASE_URL — enables staging previews at /staging/<prefix>/
const API_BASE = (import.meta.env.BASE_URL || "/").replace(/\/+$/, "");
export { API_BASE };
const telemetryBatcher = createTelemetryBatcher({ apiBase: API_BASE });

export async function uploadFile(sessionId: string, file: File): Promise<UploadedAttachment> {
  const form = new FormData();
  form.append("sessionId", sessionId);
  form.append("file", file);
  const res = await fetch(`${API_BASE}/api/upload`, { method: "POST", body: form });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "Upload failed" }));
    throw new Error(err.error || "Upload failed");
  }
  const data = await res.json();
  return {
    type: "uploaded",
    displayName: data.displayName,
    mimeType: data.mimeType,
    size: data.size,
  };
}

async function apiFetch<T>(path: string, body?: unknown, options?: { signal?: AbortSignal }): Promise<T> {
  const t0 = performance.now();
  const opts: RequestInit = body
    ? {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: options?.signal,
      }
    : {
        signal: options?.signal,
      };
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
  telemetryBatcher.enqueue({ name, duration, sessionId: opts?.sessionId, metadata: opts?.metadata });
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

export async function fetchSessions(includeArchived = false): Promise<Session[]> {
  const params = new URLSearchParams();
  if (includeArchived) params.set("includeArchived", "true");
  const qs = params.toString() ? `?${params}` : "";
  const data = await apiFetch<{ sessions: Session[] }>(`/api/sessions${qs}`);
  return data.sessions;
}

export async function fetchTaskSessionStorage(
  taskId: string,
  options?: { signal?: AbortSignal },
): Promise<TaskSessionStorage> {
  return apiFetch<TaskSessionStorage>(
    `/api/tasks/${encodeURIComponent(taskId)}/session-storage`,
    undefined,
    options,
  );
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

// ── Session model ─────────────────────────────────────────────────

export type SessionModelSource = "live" | "events" | "unknown";

export interface SessionModelState {
  model?: string;
  reasoningEffort?: string;
  source: SessionModelSource;
}

export interface SessionModelSwitchResult {
  model: string;
  reasoningEffort?: string;
  modelId?: string;
}

/** Derive the current model / reasoning effort for a session on demand. */
export async function fetchSessionModelState(sessionId: string): Promise<SessionModelState> {
  return apiFetch<SessionModelState>(`/api/sessions/${sessionId}/model`);
}

/**
 * Explicitly switch the model for a single session.
 * Omit reasoningEffort to keep the session's current reasoning effort when known.
 */
export async function patchSessionModel(
  sessionId: string,
  model: string,
  reasoningEffort?: string,
): Promise<SessionModelSwitchResult> {
  const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/model`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, ...(reasoningEffort !== undefined ? { reasoningEffort } : {}) }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
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

export async function sendChatMessage(sessionId: string, prompt: string, attachments?: Attachment[]): Promise<void> {
  const res = await fetch(`${API_BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      sessionId,
      prompt,
      ...(attachments?.length ? { attachments } : {}),
    }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
}

export async function fetchMessages(
  sessionId: string,
  opts?: { limit?: number; before?: number },
): Promise<{ messages: ChatEntry[]; runState: SessionRunState; busy: boolean; total: number; hasMore: boolean; lastVisibleActivityAt?: string }> {
  const params = new URLSearchParams();
  if (opts?.limit != null) params.set("limit", String(opts.limit));
  if (opts?.before != null) params.set("before", String(opts.before));
  const qs = params.toString();
  const data = await apiFetch<{ messages: ChatEntry[]; runState: SessionRunState; busy: boolean; total: number; hasMore: boolean; lastVisibleActivityAt?: string }>(
    `/api/sessions/${sessionId}/messages${qs ? `?${qs}` : ""}`,
  );
  return data;
}

/** Fast message loading — reads from disk, no SDK resume needed */
export async function fetchMessagesFast(
  sessionId: string,
  opts?: { limit?: number; before?: number },
): Promise<{ messages: ChatEntry[]; runState: SessionRunState; busy: boolean; total: number; hasMore: boolean; warm: boolean; lastVisibleActivityAt?: string }> {
  const params = new URLSearchParams();
  if (opts?.limit != null) params.set("limit", String(opts.limit));
  if (opts?.before != null) params.set("before", String(opts.before));
  const qs = params.toString();
  return apiFetch<{ messages: ChatEntry[]; runState: SessionRunState; busy: boolean; total: number; hasMore: boolean; warm: boolean; lastVisibleActivityAt?: string }>(
    `/api/sessions/${sessionId}/messages-fast${qs ? `?${qs}` : ""}`,
  );
}

/** Warm a session — triggers SDK resume, returns when ready */
export async function warmSession(sessionId: string): Promise<void> {
  await apiFetch<{ ready: boolean }>(`/api/sessions/${sessionId}/warm`, {});
}

export interface ReloadSessionResult {
  ready: boolean;
  servers: McpServerStatus[];
}

/** Force a cached session to re-resume with fresh config */
export async function reloadSession(sessionId: string): Promise<ReloadSessionResult> {
  return apiFetch<ReloadSessionResult>(`/api/sessions/${sessionId}/reload`, {});
}

// ── User Input API ─────────────────────────────────────────────────

export async function submitUserInputResponse(
  sessionId: string,
  requestId: UserInputRequestIdType,
  payload: UserInputAnswerEndpointPayloadType,
): Promise<NativeUserInputResponseType> {
  return apiFetch<NativeUserInputResponseType>(
    `/api/sessions/${encodeURIComponent(sessionId)}/user-input/${encodeURIComponent(requestId)}/respond`,
    payload,
  );
}

function buildSessionWorkspaceQuery(taskId?: string): string {
  if (!taskId) return "";
  const params = new URLSearchParams();
  params.set("taskId", taskId);
  return `?${params.toString()}`;
}

async function parseApiResponse<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

export async function fetchSessionWorkspace(
  sessionId: string,
  options?: { taskId?: string; signal?: AbortSignal },
): Promise<SessionWorkspaceDetails> {
  const qs = buildSessionWorkspaceQuery(options?.taskId);
  return apiFetch<SessionWorkspaceDetails>(`/api/sessions/${sessionId}/workspace${qs}`, undefined, { signal: options?.signal });
}

export async function setSessionWorkspacePath(
  sessionId: string,
  cwd: string,
  options?: { taskId?: string },
): Promise<SessionWorkspaceDetails> {
  const qs = buildSessionWorkspaceQuery(options?.taskId);
  const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/workspace/path${qs}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd }),
  });
  return parseApiResponse<SessionWorkspaceDetails>(res);
}

export async function selectSessionWorkspace(
  sessionId: string,
  cwd: string,
  options?: { taskId?: string },
): Promise<SessionWorkspaceDetails> {
  const qs = buildSessionWorkspaceQuery(options?.taskId);
  const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/workspace/worktree${qs}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd }),
  });
  return parseApiResponse<SessionWorkspaceDetails>(res);
}

export async function resetSessionWorkspace(
  sessionId: string,
  options?: { taskId?: string },
): Promise<SessionWorkspaceDetails> {
  const qs = buildSessionWorkspaceQuery(options?.taskId);
  const res = await fetch(`${API_BASE}/api/sessions/${sessionId}/workspace${qs}`, {
    method: "DELETE",
  });
  return parseApiResponse<SessionWorkspaceDetails>(res);
}

// ── Task API ──────────────────────────────────────────────────────

export async function fetchTasks(): Promise<Task[]> {
  const data = await apiFetch<{ tasks: Task[] }>("/api/tasks");
  return data.tasks;
}

export async function createTask(
  title: string,
  options: {
    groupId?: string;
    kind?: Task["kind"];
  } = {},
): Promise<Task> {
  const data = await apiFetch<{ task: Task }>("/api/tasks", { title, ...options });
  return data.task;
}

export async function fetchTask(id: string): Promise<Task> {
  const data = await apiFetch<{ task: Task }>(`/api/tasks/${id}`);
  return data.task;
}

export async function fetchTaskGitStatus(
  id: string,
  options?: { signal?: AbortSignal },
): Promise<TaskGitStatus> {
  return apiFetch<TaskGitStatus>(`/api/tasks/${id}/git-status`, undefined, options);
}

export async function updateTask(
  id: string,
  updates: TaskPatch,
): Promise<Task> {
  const data = await apiFetch<{ task: Task }>(`/api/tasks/${id}`, {
    ...updates,
    _method: "PATCH",
  });
  return data.task;
}

export async function patchTask(
  id: string,
  updates: TaskPatch,
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
  resource: { type: "session"; sessionId: string } | { type: "workItem"; workItemId: string; provider?: ProviderName } | { type: "pr"; repoId: string; repoName?: string; prId: number; provider?: ProviderName },
): Promise<Task> {
  const data = await apiFetch<{ task: Task }>(`/api/tasks/${taskId}/link`, resource);
  return data.task;
}

export async function unlinkResource(
  taskId: string,
  resource: { type: "session"; sessionId: string } | { type: "workItem"; workItemId: string; provider?: ProviderName } | { type: "pr"; repoId: string; prId: number; provider?: ProviderName },
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

export async function startFleetRun(sessionId: string, prompt?: string): Promise<void> {
  await apiFetch<{ status: string }>(`/api/sessions/${sessionId}/fleet`, prompt?.trim() ? { prompt } : {});
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

export function markSessionReadOnPageHide(
  sessionId: string,
  options: {
    navigator?: Pick<Navigator, "sendBeacon">;
    fetchFn?: typeof fetch;
  } = {},
): void {
  const endpoint = `${API_BASE}/api/read-state/${sessionId}`;
  const nav = options.navigator ?? (typeof navigator !== "undefined" ? navigator : undefined);
  if (nav?.sendBeacon?.(endpoint)) return;

  const fetchFn = options.fetchFn ?? (typeof fetch !== "undefined" ? fetch.bind(globalThis) : undefined);
  if (!fetchFn) return;
  void fetchFn(endpoint, { method: "POST", keepalive: true }).catch(() => {});
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
  runState: SessionRunState;
  busy: boolean;
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
  checklistSummary: { total: number; done: number; open: number; overdue: number };
  hasUnread: boolean;
  hasBusySession: boolean;
  lastActivity: string;
}

export interface DashboardOrphanSession {
  sessionId: string;
  title: string;
  lastVisibleActivityAt?: string;
  branch: string | null;
  runState: SessionRunState;
  busy: boolean;
  unread: boolean;
}

export interface DashboardChecklistItem {
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
  openChecklistItems: DashboardChecklistItem[];
  completedChecklistItems: DashboardChecklistItem[];
  schedules: DashboardSchedule[];
  taskMomentum: DashboardTaskMomentum;
}

export interface DashboardTaskMomentumSummary {
  needsDecision: number;
  followUpNow: number;
  waiting: number;
  candidateToClose: number;
  stale: number;
}

export interface DashboardTaskMomentum {
  summary: DashboardTaskMomentumSummary;
  needsDecision: DashboardActiveTask[];
  followUpNow: DashboardActiveTask[];
  waiting: DashboardActiveTask[];
  candidateToClose: DashboardActiveTask[];
  stale: DashboardActiveTask[];
}

export async function fetchDashboard(): Promise<DashboardData> {
  return apiFetch<DashboardData>("/api/dashboard");
}

export type CopilotUsageSkipReason = "no_events" | "no_shutdown" | "empty_model_metrics" | "parse_error";

export interface CopilotUsageTotals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  totalTokens: number;
}

export interface CopilotUsageModelRow extends CopilotUsageTotals {
  model: string;
  sessions: number;
}

export interface CopilotUsageSessionRow extends CopilotUsageTotals {
  sessionId: string;
  shutdownAt: string | null;
  models: CopilotUsageModelRow[];
}

export interface CopilotUsageCoverage {
  sessionsSeen: number;
  sessionsWithEvents: number;
  sessionsIncluded: number;
  sessionsSkipped: number;
  skippedByReason: Record<CopilotUsageSkipReason, number>;
  earliestIncludedAt: string | null;
  latestIncludedAt: string | null;
  earliestSkippedAt: string | null;
  latestSkippedAt: string | null;
}

export interface CopilotUsageSummary {
  generatedAt: string;
  totals: CopilotUsageTotals;
  coverage: CopilotUsageCoverage;
  models: CopilotUsageModelRow[];
  sessions: CopilotUsageSessionRow[];
}

export async function fetchCopilotUsage(options?: { refresh?: boolean; signal?: AbortSignal }): Promise<CopilotUsageSummary> {
  const params = new URLSearchParams();
  if (options?.refresh) {
    params.set("refresh", "1");
  }
  const query = params.toString();
  return apiFetch<CopilotUsageSummary>(`/api/copilot-usage${query ? `?${query}` : ""}`, undefined, {
    signal: options?.signal,
  });
}

// ── Settings API ──────────────────────────────────────────────────

export interface AdoProviderConfig {
  org: string;
  project: string;
}

export interface GitHubProviderConfig {
  owner: string;
  defaultRepo?: string;
}

export interface LinearProviderConfig {
  apiKey: string;
  workspace: string;
}

export interface ProvidersConfig {
  ado?: AdoProviderConfig;
  github?: GitHubProviderConfig;
  linear?: LinearProviderConfig;
}

export type ThemePreference = "light" | "dark" | "system";
export type ReasoningEffort = "low" | "medium" | "high" | "max" | "xhigh";

export interface AppSettings {
  providers?: ProvidersConfig;
  mcpServers: Record<string, McpServerConfig>;
  favicon?: string;
  theme?: ThemePreference;
  identity?: string;
  customInstructions?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
}

export function serializeSettingsPatch(updates: Partial<AppSettings>): string {
  const normalized: Record<string, unknown> = { ...updates };
  if ("model" in updates && updates.model === undefined) {
    normalized.model = "";
  }
  if ("reasoningEffort" in updates && updates.reasoningEffort === undefined) {
    normalized.reasoningEffort = "";
  }
  return JSON.stringify(normalized);
}

export async function fetchSettings(): Promise<AppSettings> {
  return apiFetch<AppSettings>("/api/settings");
}

export async function patchSettings(updates: Partial<AppSettings>): Promise<AppSettings> {
  const res = await fetch(`${API_BASE}/api/settings`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: serializeSettingsPatch(updates),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

// ── Transcription API ───────────────────────────────────────────────

export interface TranscriptionStatus {
  available: boolean;
  provider: "disabled" | "whisper.cpp";
  label: string;
  reason?: string;
  maxDurationSeconds: number;
}

export interface TranscriptionResult {
  text: string;
  provider: Exclude<TranscriptionStatus["provider"], "disabled">;
}

export type VoiceJobStatus = "accepted" | "transcribing" | "sending" | "done" | "error" | "recovered";

export interface VoiceJobStatusResponse {
  id: string;
  composerKey: string;
  taskId?: string;
  targetSessionId?: string;
  status: VoiceJobStatus;
  transcript?: string;
  error?: string;
  safeToLeave: true;
  createdAt: string;
  updatedAt: string;
}

export interface CreateVoiceJobRequest {
  composerKey: string;
  sessionId?: string;
  taskId?: string;
}

export async function fetchTranscriptionStatus(): Promise<TranscriptionStatus> {
  return apiFetch<TranscriptionStatus>("/api/transcribe/status");
}

export async function transcribeAudio(audio: Blob, filename = "voice-input.wav"): Promise<TranscriptionResult> {
  const form = new FormData();
  form.append("audio", audio, filename);

  const res = await fetch(`${API_BASE}/api/transcribe`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

export async function createVoiceJob(
  request: CreateVoiceJobRequest,
  audio: Blob,
  options?: { signal?: AbortSignal; filename?: string },
): Promise<VoiceJobStatusResponse> {
  const form = new FormData();
  form.append("audio", audio, options?.filename ?? "voice-input.wav");
  form.append("composerKey", request.composerKey);
  if (request.sessionId) form.append("sessionId", request.sessionId);
  if (request.taskId) form.append("taskId", request.taskId);

  const res = await fetch(`${API_BASE}/api/voice-jobs`, {
    method: "POST",
    body: form,
    signal: options?.signal,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

export async function fetchVoiceJob(jobId: string): Promise<VoiceJobStatusResponse | null> {
  const res = await fetch(`${API_BASE}/api/voice-jobs/${jobId}`);
  if (res.status === 404) return null;
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

export async function fetchLatestVoiceJob(composerKey: string): Promise<VoiceJobStatusResponse | null> {
  const qs = new URLSearchParams({ composerKey }).toString();
  const res = await fetch(`${API_BASE}/api/voice-jobs/latest?${qs}`);
  if (res.status === 404) return null;
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

export async function markVoiceJobRecovered(jobId: string): Promise<VoiceJobStatusResponse | null> {
  const res = await fetch(`${API_BASE}/api/voice-jobs/${jobId}/recovered`, {
    method: "POST",
  });
  if (res.status === 404) return null;
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
  supportedReasoningEfforts?: ReasoningEffort[];
  defaultReasoningEffort?: ReasoningEffort;
}

export async function fetchModels(): Promise<ModelInfo[]> {
  const result = await apiFetch<{ models: ModelInfo[] }>("/api/models");
  return result.models;
}

// ── Server Info ───────────────────────────────────────────────────

export async function fetchServerTimezone(): Promise<string> {
  const result = await apiFetch<{ timezone: string }>("/api/server/timezone");
  return result.timezone;
}

export interface BridgeCommitSnapshotOk {
  status: "ok";
  ref: string;
  sha: string;
  shortSha: string;
  message: string;
}

export interface BridgeCommitSnapshotUnavailable {
  status: "unavailable";
  ref: string;
  error: string;
}

export type BridgeCommitSnapshot = BridgeCommitSnapshotOk | BridgeCommitSnapshotUnavailable;

export interface BridgeCommitComparisonOk {
  status: "ok";
  ahead: number;
  behind: number;
}

export interface BridgeCommitComparisonUnavailable {
  status: "unavailable";
  error: string;
}

export type BridgeCommitComparison = BridgeCommitComparisonOk | BridgeCommitComparisonUnavailable;

export interface BridgeCommitMetadata {
  local: BridgeCommitSnapshot;
  remote: BridgeCommitSnapshot;
  running: BridgeCommitSnapshot;
  comparisons: {
    localVsRemote: BridgeCommitComparison;
    runningVsLocal: BridgeCommitComparison;
  };
}

export async function fetchBridgeCommitMetadata(forceRefresh = false): Promise<BridgeCommitMetadata> {
  const suffix = forceRefresh ? "?refresh=1" : "";
  return apiFetch<BridgeCommitMetadata>(`/api/server/commits${suffix}`);
}

export interface LauncherLogTailOk {
  status: "ok";
  lines: string[];
}

export interface LauncherLogTailUnavailable {
  status: "unavailable";
  error: string;
}

export type LauncherLogTail = LauncherLogTailOk | LauncherLogTailUnavailable;

export async function fetchLauncherLogTail(lines = 8): Promise<LauncherLogTail> {
  return apiFetch<LauncherLogTail>(`/api/server/launcher-log?lines=${lines}`);
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
  Partial<Pick<Schedule, "cron" | "runAt" | "timezone" | "maxRuns" | "expiresAt">>;

export type ScheduleUpdateInput = Partial<Pick<Schedule,
  "name" | "prompt" | "cron" | "runAt" | "timezone" | "enabled" | "maxRuns" | "expiresAt"
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

export interface ScheduleRun extends Session {
  runId: number;
  recordedAt: string;
  recordedAtKnown?: boolean;
  missing?: boolean;
}

export interface ScheduleSessionsResponse {
  sessions: ScheduleRun[];
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

// ── Checklist item API ────────────────────────────────────────────

export async function fetchChecklistItems(taskId: string): Promise<ChecklistItem[]> {
  const data = await apiFetch<{ checklistItems: ChecklistItem[] }>(`/api/tasks/${taskId}/checklist-items`);
  return data.checklistItems;
}

export async function fetchOpenChecklistItems(): Promise<ChecklistItem[]> {
  const data = await apiFetch<{ checklistItems: ChecklistItem[] }>("/api/checklist-items/open");
  return data.checklistItems;
}

export async function createChecklistItem(taskId: string, text: string, deadline?: string): Promise<ChecklistItem> {
  const data = await apiFetch<{ checklistItem: ChecklistItem }>(`/api/tasks/${taskId}/checklist-items`, { text, deadline });
  return data.checklistItem;
}

export async function createGlobalChecklistItem(text: string, deadline?: string): Promise<ChecklistItem> {
  const data = await apiFetch<{ checklistItem: ChecklistItem }>(`/api/checklist-items`, { text, deadline });
  return data.checklistItem;
}

export async function patchChecklistItem(
  id: string,
  updates: Partial<Pick<ChecklistItem, "text" | "done">> & { deadline?: string | null },
): Promise<ChecklistItem> {
  const res = await fetch(`${API_BASE}/api/checklist-items/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  const data = await res.json();
  return data.checklistItem;
}

export async function deleteChecklistItem(id: string): Promise<void> {
  await fetch(`${API_BASE}/api/checklist-items/${id}`, { method: "DELETE" });
}

export async function reorderChecklistItems(taskId: string, checklistItemIds: string[]): Promise<ChecklistItem[]> {
  const res = await fetch(`${API_BASE}/api/tasks/${taskId}/checklist-items/reorder`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ checklistItemIds }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  const data = await res.json();
  return data.checklistItems;
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
  isDbItem: boolean;
  isFolderIndex: boolean;
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
