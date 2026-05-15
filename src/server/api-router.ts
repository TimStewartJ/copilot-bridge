// API route handlers — extracted from index.ts for modularity

import express from "express";
import multer from "multer";
import { existsSync, readFileSync, readdirSync, statSync, mkdirSync, mkdtempSync } from "node:fs";
import { stat as statAsync, readFile, rm } from "node:fs/promises";
import { join, basename, dirname, sep } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import type { AppContext } from "./app-context.js";
import type { McpServerConfig } from "./mcp-config.js";
import {
  clearRestartPending,
  configureRestartStateStore,
  isRestartCutoverInProgress,
  isRestartPendingError,
  ModelRefreshBlockedError,
  RESTART_PENDING_MESSAGE,
  refreshRestartState,
  type SessionRunState,
} from "./session-manager.js";
import * as scheduler from "./scheduler.js";
import type { Schedule } from "./schedule-store.js";
import { enforceScheduleSessionRetention } from "./schedule-session-retention.js";
import { findUnknownFields, formatUnknownFieldsError, normalizeScheduleAutoArchiveKeep } from "./schedule-validation.js";
import { enrichWorkItems, enrichPullRequests, clearProviderCache, setSettingsGetter } from "./providers/index.js";
import { createApiJsonErrorHandler, createRequestTelemetryMiddleware } from "./api-request-telemetry.js";
import { createTranscriptionService, type TranscriptionService } from "./transcription-service.js";
import type { VoiceJobManager } from "./voice-job-manager.js";
import { createBridgeGitRevisionReader } from "./git-revisions.js";
import { readCachedGitWorktreeStatus, readGitWorktreeStatus } from "./git-worktree-status.js";
import { readLauncherLogTail } from "./launcher-log.js";
import { isCanonicalSessionId, resolveOutboundAttachment } from "./outbound-attachments.js";
import {
  feedCardVisualOwner,
  HTML_MIME_TYPE,
  isCanonicalArtifactId,
  loadVisualArtifactMetaForOwner,
  resolveVisualArtifactForOwner,
  sessionVisualOwner,
  type VisualArtifactOwner,
} from "./visual-artifacts.js";
import { createCopilotUsageReader } from "./copilot-usage.js";
import { serializeCopilotUsageSummary } from "./copilot-usage-serializer.js";
import type { CopilotModelMetadataForPricing } from "../shared/copilot-pricing.js";
import { InvalidTaskUpdateError, type Task } from "./task-store.js";
import { FeedCardNotFoundError, FeedCardValidationError, type FeedCardStatus } from "./feed-store.js";
import type { GitWorktreeHead, TaskGitStatusResponse } from "./git-worktree-status.js";
import { UserInputBrokerError } from "./user-input-broker.js";
import { mergeDeferSummaries, type DeferSummary } from "./defer-summary.js";
import { getPushPublicStatus, type BridgePushPayload, type PushNotificationService } from "./push-notification-service.js";
import { isPushSubscriptionInput, type PushSubscriptionInput, type PushSubscriptionStore } from "./push-subscription-store.js";
import { getDeviceHibernateCommand, requestDeviceHibernate, type DeviceHibernateCommand } from "./platform.js";
import { runSessionOverlayReaper } from "./session-overlay-reaper.js";
import { isDisposableTitleSessionId } from "./session-name-generator.js";
import { parseWorkspaceYamlSessionName } from "./session-workspace-yaml.js";
import {
  ChecklistNotFoundError,
  ChecklistValidationError,
  normalizeChecklistItemCreate,
  normalizeChecklistItemUpdate,
  type ChecklistItem,
} from "./checklist-store.js";
import {
  checkForUpdate,
  readUpdateInstallStatus,
  startUpdateInstall,
  UpdateInstallError,
  type UpdateChannel,
} from "./update-service.js";
import {
  DocsSnapshotNotFoundError,
  DocsSnapshotValidationError,
  PRE_DELETE_SNAPSHOT_MIN_INTERVAL_MS,
} from "./docs-snapshot-store.js";
import { DocsStoreValidationError } from "./docs-store.js";

function getDirSize(dirPath: string): number {
  let size = 0;
  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        size += getDirSize(fullPath);
      } else {
        size += statSync(fullPath).size;
      }
    }
  } catch { /* ignore errors */ }
  return size;
}

/** Resolve the .copilot home directory — uses ctx.copilotHome if set, otherwise homedir()/.copilot */
function getCopilotHome(ctx: AppContext): string {
  return ctx.copilotHome ?? join(homedir(), ".copilot");
}

function getErrorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

async function getSessionEventLogSizeBytes(ctx: AppContext, sessionId: string): Promise<number> {
  try {
    const stats = await statAsync(join(getCopilotHome(ctx), "session-state", sessionId, "events.jsonl"));
    return stats.size;
  } catch (error) {
    const code = getErrorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return 0;
    console.warn(
      `[sessions] Failed to stat events.jsonl for ${sessionId}:`,
      error instanceof Error ? error.message : error,
    );
    return 0;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface DashboardChecklistItem extends ChecklistItem {
  taskTitle: string | null;
  taskGroupColor: string | null;
  taskOrder: number;
  taskStatus: string | null;
  taskGroupId: string | null;
  taskGroupOrder: number | null;
}

interface DashboardChecklistData {
  openChecklistItems: DashboardChecklistItem[];
  completedChecklistItems: DashboardChecklistItem[];
}

function toCopilotModelMetadataForPricing(value: unknown): CopilotModelMetadataForPricing | null {
  if (!isRecord(value)) return null;
  let record = value;
  if (typeof record.id !== "string" && typeof record.toJSON === "function") {
    const serialized = record.toJSON();
    if (isRecord(serialized)) record = serialized;
  }
  if (typeof record.id !== "string") return null;
  const id = record.id.trim();
  if (!id) return null;
  const name = typeof record.name === "string" ? record.name.trim() : "";
  return name ? { id, name } : { id };
}

function sanitizeCopilotModelMetadataForPricing(value: unknown): readonly CopilotModelMetadataForPricing[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(toCopilotModelMetadataForPricing)
    .filter((model): model is CopilotModelMetadataForPricing => model !== null);
}

async function listCopilotModelMetadataForPricing(
  ctx: AppContext,
): Promise<readonly CopilotModelMetadataForPricing[]> {
  return sanitizeCopilotModelMetadataForPricing(await ctx.sessionManager.listModels());
}

const UNKNOWN_SCHEDULE_RUN_AT = "0001-01-01T00:00:00.000Z";
const TASK_GIT_STATUS_NOT_CONFIGURED_ERROR = "Task working directory is not configured.";
const SESSION_WORKSPACE_NOT_CONFIGURED_ERROR = "Session workspace is not configured.";

function isPathAtOrUnder(parent: string, candidate: string): boolean {
  const parentWithSeparator = parent.endsWith(sep) ? parent : `${parent}${sep}`;
  return candidate === parent || candidate.startsWith(parentWithSeparator);
}

function isLocalStagingModule(ctx: AppContext): boolean {
  const dataDir = ctx.runtimePaths?.dataDir;
  if (!dataDir) return false;
  const dataFolder = basename(dataDir);
  if (dataFolder !== "data" && dataFolder !== "demo-data") return false;
  try {
    return isPathAtOrUnder(dirname(dataDir), fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

function getSchedulerModule(ctx: AppContext): typeof scheduler {
  if (ctx.scheduler) return ctx.scheduler;
  if (ctx.isStaging) {
    if (!isLocalStagingModule(ctx)) {
      throw new Error("Staging schedules require an isolated scheduler module.");
    }
    scheduler.shutdown();
    scheduler.initialize(ctx.sessionManager, {
      scheduleStore: ctx.scheduleStore,
      taskStore: ctx.taskStore,
      sessionMetaStore: ctx.sessionMetaStore,
      globalBus: ctx.globalBus,
      deferredPromptStore: ctx.deferredPromptStore,
      deferLoopStore: ctx.deferLoopStore,
    });
    ctx.scheduler = scheduler;
  }
  return scheduler;
}
const SESSION_WORKSPACE_BUSY_ERROR = "Cannot change workspace for a busy session.";
const SESSION_WORKSPACE_RESET_NOT_CONFIGURED_ERROR = "Linked task workspace is not configured.";
const SESSION_WORKTREE_SELECTION_UNAVAILABLE_ERROR = "No sibling worktrees are available for this session.";
const SESSION_WORKTREE_SELECTION_INVALID_ERROR = "Selected workspace is not a discovered sibling worktree.";

type SessionWorkspaceSource = "session_workspace" | "workspace_yaml" | "task" | "default" | "none";
type SessionWorkspacePathState = "available" | "missing" | "unconfigured";
type SessionWorkspaceWarningCode = "missing_workspace" | "missing_pinned_workspace";

interface SessionWorkspaceSummaryPayload {
  effectiveCwd?: string;
  taskCwd?: string;
  sessionOverride?: {
    cwd: string;
    updatedAt: string;
  };
  overridesTaskWorkspace: boolean;
}

interface SessionWorkspaceWarningPayload {
  code: SessionWorkspaceWarningCode;
  message: string;
}

interface SessionWorkspaceWorktreePayload {
  cwd: string;
  workspaceKind: "main" | "linked";
  head: GitWorktreeHead;
  selected: boolean;
}

interface SessionWorkspaceDetailsPayload extends SessionWorkspaceSummaryPayload {
  sessionId: string;
  taskId?: string;
  source: SessionWorkspaceSource;
  pathState: SessionWorkspacePathState;
  warnings: SessionWorkspaceWarningPayload[];
  availableWorktrees: SessionWorkspaceWorktreePayload[];
  canResetToTask: boolean;
  runState: SessionRunState;
  busy: boolean;
  gitStatus: TaskGitStatusResponse;
}

type LegacyCompatibleOkGitStatus = Extract<TaskGitStatusResponse, { status: "ok" }> & {
  worktreePath?: string;
  workspaceKind?: "main" | "linked";
  head?: GitWorktreeHead;
  siblingWorktrees?: Array<{
    worktreePath?: string;
    workspaceKind?: "main" | "linked";
    head?: GitWorktreeHead;
  }>;
};

function normalizePushSubscriptionBody(body: unknown): PushSubscriptionInput | undefined {
  if (isPushSubscriptionInput(body)) return body;
  if (!body || typeof body !== "object") return undefined;
  const subscription = (body as Record<string, unknown>).subscription;
  return isPushSubscriptionInput(subscription) ? subscription : undefined;
}

function normalizeEndpointBody(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const endpoint = (body as Record<string, unknown>).endpoint;
  return typeof endpoint === "string" && endpoint.startsWith("https://") ? endpoint : undefined;
}

function getSessionStatus(
  ctx: AppContext,
  sessionId: string,
): { runState: SessionRunState; busy: boolean; pendingUserInputCount: number; needsUserInput: boolean } {
  const runState = ctx.sessionManager.getSessionRunState(sessionId);
  const pendingUserInputCount = ctx.sessionManager.getPendingUserInputCount(sessionId);
  return {
    runState,
    busy: runState !== "idle",
    pendingUserInputCount,
    needsUserInput: pendingUserInputCount > 0,
  };
}

function getSessionDeferSummary(ctx: AppContext, sessionId: string): DeferSummary {
  const summaries: DeferSummary[] = [];
  const oneShotSummary = ctx.deferredPromptStore?.getSummaryForSession(sessionId);
  const intervalSummary = ctx.deferLoopStore?.getSummaryForSession(sessionId);
  if (oneShotSummary) summaries.push(oneShotSummary);
  if (intervalSummary) summaries.push(intervalSummary);
  return mergeDeferSummaries(...summaries);
}

function normalizeWorkspacePath(cwd?: string | null): string | undefined {
  const trimmed = cwd?.trim();
  return trimmed ? trimmed : undefined;
}

function getFsErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function getWorkspaceAvailability(cwd?: string | null): {
  cwd: string;
  available: boolean;
  clearStalePin: boolean;
} | undefined {
  const normalized = normalizeWorkspacePath(cwd);
  if (!normalized) return undefined;
  try {
    return {
      cwd: normalized,
      available: statSync(normalized).isDirectory(),
      clearStalePin: true,
    };
  } catch (error) {
    const code = getFsErrorCode(error);
    return {
      cwd: normalized,
      available: false,
      clearStalePin: code === "ENOENT" || code === "ENOTDIR",
    };
  }
}

function resolveAvailableWorkspaceCwd(cwd?: string | null): string | undefined {
  const availability = getWorkspaceAvailability(cwd);
  return availability?.available ? availability.cwd : undefined;
}

function normalizeWorkspacePathForComparison(cwd: string): string {
  const normalized = cwd.trim().replace(/\\/g, "/");
  if (normalized === "/" || /^[A-Za-z]:\/$/.test(normalized)) return normalized.toLowerCase();
  return normalized.replace(/\/+$/, "").toLowerCase();
}

function parseWorkspaceCwd(content: string): string | undefined {
  for (const line of content.split(/\r?\n/)) {
    if (!line.startsWith("cwd:")) continue;
    const cwd = line.slice(5).trim();
    if (cwd) return cwd;
  }
  return undefined;
}

function getDefaultSessionCwd(ctx: AppContext): string | undefined {
  return ctx.runtimePaths?.demoMode ? ctx.runtimePaths.workspaceDir : undefined;
}

function getLegacySessionWorkspaceCwd(ctx: AppContext, sessionId: string): string | undefined {
  const yamlPath = join(getCopilotHome(ctx), "session-state", sessionId, "workspace.yaml");
  try {
    if (!existsSync(yamlPath)) return undefined;
    return parseWorkspaceCwd(readFileSync(yamlPath, "utf-8"));
  } catch {
    return undefined;
  }
}

function buildSessionWorkspaceSummary(
  ctx: AppContext,
  sessionId: string,
  task?: Pick<Task, "cwd"> | null,
): SessionWorkspaceSummaryPayload & {
  source: SessionWorkspaceSource;
} {
  const sessionOverride = ctx.sessionWorkspaceStore?.getWorkspace(sessionId);
  const overrideAvailability = getWorkspaceAvailability(sessionOverride?.cwd);
  if (sessionOverride && overrideAvailability && !overrideAvailability.available && overrideAvailability.clearStalePin) {
    ctx.sessionWorkspaceStore?.deleteWorkspace(sessionId);
  }
  const overrideCwd = overrideAvailability?.available ? overrideAvailability.cwd : undefined;
  const legacyCwd = resolveAvailableWorkspaceCwd(getLegacySessionWorkspaceCwd(ctx, sessionId));
  const taskCwd = resolveAvailableWorkspaceCwd(task?.cwd);
  const defaultCwd = getDefaultSessionCwd(ctx);
  const effectiveCwd = overrideCwd ?? legacyCwd ?? taskCwd ?? defaultCwd;
  const source: SessionWorkspaceSource = overrideCwd
    ? "session_workspace"
    : legacyCwd
      ? "workspace_yaml"
      : taskCwd
        ? "task"
        : defaultCwd
          ? "default"
          : "none";

  return {
    effectiveCwd,
    taskCwd,
    sessionOverride: sessionOverride && overrideCwd
      ? {
          cwd: sessionOverride.cwd,
          updatedAt: sessionOverride.updatedAt,
        }
      : undefined,
    overridesTaskWorkspace: !!overrideCwd && !!taskCwd && normalizeWorkspacePathForComparison(overrideCwd) !== normalizeWorkspacePathForComparison(taskCwd),
    source,
  };
}

function toUnavailableGitStatus(cwd: string, error: string): TaskGitStatusResponse {
  return {
    status: "unavailable",
    cwd,
    error,
  };
}

function buildWorktreeChoices(
  gitStatus: TaskGitStatusResponse,
  selectedCwd?: string,
): SessionWorkspaceWorktreePayload[] {
  if (gitStatus.status !== "ok") return [];

  const compatStatus = gitStatus as LegacyCompatibleOkGitStatus;
  const primaryWorktreePath = normalizeWorkspacePath(
    typeof compatStatus.worktreePath === "string" ? compatStatus.worktreePath : gitStatus.cwd,
  );
  const workspaceKind = compatStatus.workspaceKind === "linked" ? "linked" : "main";
  const head = compatStatus.head
    ?? (gitStatus.branch?.trim()
      ? { kind: "branch", name: gitStatus.branch.trim() }
      : { kind: "detached", shortSha: "unknown" });

  const selected = selectedCwd ? normalizeWorkspacePathForComparison(selectedCwd) : undefined;
  const byPath = new Map<string, SessionWorkspaceWorktreePayload>();
  const addWorktree = (cwd: string, workspaceKind: "main" | "linked", head: GitWorktreeHead) => {
    const normalizedCwd = normalizeWorkspacePath(cwd);
    if (!normalizedCwd) return;
    const key = normalizeWorkspacePathForComparison(normalizedCwd);
    if (byPath.has(key)) return;
    byPath.set(key, {
      cwd: normalizedCwd,
      workspaceKind,
      head,
      selected: key === selected,
    });
  };

  if (primaryWorktreePath) {
    addWorktree(primaryWorktreePath, workspaceKind, head);
  }
  for (const sibling of compatStatus.siblingWorktrees ?? []) {
    if (!sibling.head) continue;
    addWorktree(
      sibling.worktreePath ?? "",
      sibling.workspaceKind === "linked" ? "linked" : "main",
      sibling.head,
    );
  }
  return [...byPath.values()];
}

async function readSessionWorkspaceGitStatus(
  summary: SessionWorkspaceSummaryPayload & { source: SessionWorkspaceSource },
): Promise<{ gitStatus: TaskGitStatusResponse; availableWorktrees: SessionWorkspaceWorktreePayload[]; pathState: SessionWorkspacePathState; warnings: SessionWorkspaceWarningPayload[] }> {
  const warnings: SessionWorkspaceWarningPayload[] = [];
  if (!summary.effectiveCwd) {
    return {
      gitStatus: {
        status: "not_configured",
        error: SESSION_WORKSPACE_NOT_CONFIGURED_ERROR,
      },
      availableWorktrees: [],
      pathState: "unconfigured",
      warnings,
    };
  }

  let pathState: SessionWorkspacePathState = "available";
  if (!existsSync(summary.effectiveCwd)) {
    pathState = "missing";
    warnings.push({
      code: summary.source === "session_workspace" ? "missing_pinned_workspace" : "missing_workspace",
      message: summary.source === "session_workspace"
        ? `Pinned session workspace does not exist: ${summary.effectiveCwd}`
        : `Workspace path does not exist: ${summary.effectiveCwd}`,
    });
  }

  const gitStatus = pathState === "missing"
    ? toUnavailableGitStatus(summary.effectiveCwd, warnings[0]!.message)
    : await readGitWorktreeStatus(summary.effectiveCwd).catch((error) =>
      toUnavailableGitStatus(summary.effectiveCwd!, error instanceof Error ? error.message : String(error)));

  let availableWorktrees = buildWorktreeChoices(gitStatus, summary.effectiveCwd);
  const shouldFallbackToTaskStatus = availableWorktrees.length === 0
    && !!summary.taskCwd
    && normalizeWorkspacePathForComparison(summary.taskCwd) !== normalizeWorkspacePathForComparison(summary.effectiveCwd);
  if (shouldFallbackToTaskStatus && existsSync(summary.taskCwd!)) {
    const taskGitStatus = await readGitWorktreeStatus(summary.taskCwd!).catch((error) =>
      toUnavailableGitStatus(summary.taskCwd!, error instanceof Error ? error.message : String(error)));
    availableWorktrees = buildWorktreeChoices(taskGitStatus, summary.effectiveCwd);
  }

  return {
    gitStatus,
    availableWorktrees,
    pathState,
    warnings,
  };
}

async function buildSessionWorkspaceDetails(
  ctx: AppContext,
  sessionId: string,
  task?: Task | null,
): Promise<SessionWorkspaceDetailsPayload> {
  const summary = buildSessionWorkspaceSummary(ctx, sessionId, task);
  const { gitStatus, availableWorktrees, pathState, warnings } = await readSessionWorkspaceGitStatus(summary);
  return {
    sessionId,
    taskId: task?.id,
    ...summary,
    pathState,
    warnings,
    availableWorktrees,
    canResetToTask: !!summary.taskCwd,
    ...getSessionStatus(ctx, sessionId),
    gitStatus,
  };
}

function resolveWorkspaceTask(ctx: AppContext, sessionId: string, requestedTaskId?: string): Task | undefined {
  const taskId = normalizeWorkspacePath(requestedTaskId);
  if (!taskId) {
    const linkedTasks = ctx.taskStore.listTasks?.().filter((task) => task.sessionIds.includes(sessionId)) ?? [];
    if (linkedTasks.length === 1) return linkedTasks[0];
    if (linkedTasks.length > 1) return undefined;
    return ctx.taskStore.findTaskBySessionId(sessionId);
  }
  const task = ctx.taskStore.getTask(taskId);
  if (!task) {
    throw new Error("Task not found");
  }
  if (!task.sessionIds.includes(sessionId)) {
    throw new Error("Task is not linked to session");
  }
  return task;
}

function createSessionListTaskLookup(ctx: AppContext, tasks = ctx.taskStore.listTasks?.() ?? []) {
  const linkedTasksBySessionId = new Map<string, Task[]>();
  for (const task of tasks) {
    for (const sessionId of task.sessionIds) {
      const linkedTasks = linkedTasksBySessionId.get(sessionId);
      if (linkedTasks) linkedTasks.push(task);
      else linkedTasksBySessionId.set(sessionId, [task]);
    }
  }

  const resolveTask = (sessionId: string): Task | undefined => {
    const linkedTasks = linkedTasksBySessionId.get(sessionId) ?? [];
    if (linkedTasks.length === 1) return linkedTasks[0];
    if (linkedTasks.length > 1) return undefined;
    return ctx.taskStore.findTaskBySessionId(sessionId);
  };

  const getLinkedTasks = (sessionId: string): Task[] => {
    const linkedTasks = linkedTasksBySessionId.get(sessionId) ?? [];
    if (linkedTasks.length > 0) return linkedTasks;
    const fallbackTask = ctx.taskStore.findTaskBySessionId(sessionId);
    return fallbackTask ? [fallbackTask] : [];
  };

  return { tasks, resolveTask, getLinkedTasks };
}

function isLinkedOnlyToArchivedTasks(linkedTasks: Task[]): boolean {
  return linkedTasks.length > 0 && linkedTasks.every((task) => task.status === "archived");
}

function hasExplicitUnreadActivity(
  readState: Record<string, string>,
  sessionId: string,
  activityTime?: string,
): boolean {
  const lastReadAt = readState[sessionId];
  if (!lastReadAt || !activityTime) return false;
  const activityMs = Date.parse(activityTime);
  const readMs = Date.parse(lastReadAt);
  return Number.isFinite(activityMs) && Number.isFinite(readMs) && activityMs > readMs;
}

function maxIsoTime(...values: Array<string | null | undefined>): string | undefined {
  let latest: { value: string; time: number } | undefined;
  for (const value of values) {
    if (!value) continue;
    const time = Date.parse(value);
    if (!Number.isFinite(time)) continue;
    if (!latest || time > latest.time) latest = { value, time };
  }
  return latest?.value;
}

function shouldIncludeMaterializedSession(opts: {
  includeArchived: boolean;
  archived: boolean;
  linkedTasks: Task[];
  status: ReturnType<typeof getSessionStatus>;
  readState: Record<string, string>;
  sessionId: string;
  lastActivityAt?: string;
  hasSessionName: boolean;
  hasReadState: boolean;
  hasBridgeActivitySignal: boolean;
  hasDeferredWork: boolean;
}): boolean {
  if (!opts.includeArchived && opts.archived) return false;
  if (
    !opts.includeArchived
    && isLinkedOnlyToArchivedTasks(opts.linkedTasks)
    && !opts.status.busy
    && !opts.status.needsUserInput
    && !hasExplicitUnreadActivity(opts.readState, opts.sessionId, opts.lastActivityAt)
  ) {
    return false;
  }
  if (
    !opts.archived
    && opts.linkedTasks.length === 0
    && !opts.hasSessionName
    && !opts.hasBridgeActivitySignal
    && !(opts.hasReadState && opts.lastActivityAt)
    && !opts.hasDeferredWork
    && opts.status.runState === "idle"
    && !opts.status.busy
    && !opts.status.needsUserInput
  ) {
    return false;
  }
  return true;
}

function resolveSessionSummary(
  session: { sessionId: string; summary?: string | null },
  opts: { fallbackSummary?: string } = {},
): string {
  const summary = session.summary ?? undefined;
  return summary || opts.fallbackSummary || "Untitled session";
}

async function readWorkspaceSessionName(sessionStateDir: string, sessionId: string): Promise<string | undefined> {
  const content = await readFile(join(sessionStateDir, sessionId, "workspace.yaml"), "utf-8");
  return parseWorkspaceYamlSessionName(content);
}

function listSessionsFromCliCatalog(ctx: AppContext): any[] | undefined {
  const catalogSessions = ctx.cliSessionCatalog?.listSessions();
  if (!catalogSessions) return undefined;
  const meta = ctx.sessionMetaStore.listMeta();
  return catalogSessions.map((session) => {
    const sessionMeta = meta[session.sessionId];
    const lastVisibleActivityAt = sessionMeta?.lastVisibleActivityAt;
    const lastAttentionAt = sessionMeta?.lastAttentionAt;
    const lastActivityAt = maxIsoTime(lastVisibleActivityAt, lastAttentionAt);
    return {
      ...session,
      lastVisibleActivityAt,
      lastAttentionAt,
      lastActivityAt,
      modifiedTime: lastActivityAt ?? session.modifiedTime ?? session.startTime,
      archived: sessionMeta?.archived ?? false,
      intentText: ctx.eventBusRegistry.getBus(session.sessionId)?.getIntentText() ?? null,
    };
  });
}

const SCHEDULE_CREATE_FIELDS = [
  "taskId",
  "name",
  "prompt",
  "type",
  "cron",
  "runAt",
  "timezone",
  "maxRuns",
  "expiresAt",
  "autoArchiveKeep",
] as const;
const SCHEDULE_UPDATE_FIELDS = [
  "name",
  "prompt",
  "cron",
  "runAt",
  "timezone",
  "enabled",
  "maxRuns",
  "expiresAt",
  "autoArchiveKeep",
] as const;

async function enforceRetentionForSchedule(ctx: AppContext, schedule: Schedule): Promise<void> {
  try {
    await enforceScheduleSessionRetention({
      schedule,
      sessionMetaStore: ctx.sessionMetaStore,
      sessionManager: ctx.sessionManager,
      globalBus: ctx.globalBus,
      deferredPromptStore: ctx.deferredPromptStore,
      deferLoopStore: ctx.deferLoopStore,
    });
  } catch (err) {
    console.warn(`[schedules] Failed to apply retention for "${schedule.name}" (${schedule.id}):`, err);
  }
}

class InvalidWavError extends Error {}

async function cleanupTranscriptionUpload(req: express.Request): Promise<void> {
  const dir = (req as express.Request & { _transcriptionTempDir?: string })._transcriptionTempDir;
  if (!dir) return;
  await rm(dir, { recursive: true, force: true }).catch(() => {});
  delete (req as express.Request & { _transcriptionTempDir?: string })._transcriptionTempDir;
}

async function getWavDurationSeconds(filePath: string): Promise<number> {
  return parseWavDurationSeconds(await readFile(filePath));
}

function parseWavDurationSeconds(buffer: Buffer): number {
  if (buffer.length < 12 || buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new InvalidWavError("Uploaded audio must be a WAV file.");
  }

  let offset = 12;
  let byteRate: number | undefined;
  let dataSize: number | undefined;
  while (offset + 8 <= buffer.length) {
    const chunkId = buffer.toString("ascii", offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);
    const chunkStart = offset + 8;
    if (chunkStart + chunkSize > buffer.length) {
      throw new InvalidWavError("Uploaded WAV data is truncated.");
    }
    if (chunkId === "fmt ") {
      if (chunkSize < 16) {
        throw new InvalidWavError("Uploaded WAV format chunk is invalid.");
      }
      byteRate = buffer.readUInt32LE(chunkStart + 8);
    } else if (chunkId === "data") {
      dataSize = chunkSize;
    }
    offset = chunkStart + chunkSize + (chunkSize % 2);
  }

  if (byteRate === undefined || byteRate <= 0 || dataSize === undefined) {
    throw new InvalidWavError("Uploaded WAV file is missing required audio data.");
  }

  const durationSeconds = dataSize / byteRate;
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) {
    throw new InvalidWavError("Uploaded WAV file does not contain audio samples.");
  }
  return durationSeconds;
}

export function createApiRouter(ctx: AppContext): express.Router {
  configureRestartStateStore(ctx.runtimePaths);
  const router = express.Router();
  const schedulerModule = () => getSchedulerModule(ctx);
  const transcriptionService =
    (ctx as AppContext & { transcriptionService?: TranscriptionService }).transcriptionService ?? createTranscriptionService();
  const voiceJobManager = ensureVoiceJobManager(ctx, transcriptionService);
  const getBridgeGitRevisions = createBridgeGitRevisionReader();
  const copilotUsageReader = createCopilotUsageReader({
    copilotHome: getCopilotHome(ctx),
    modelMetadataProvider: () => listCopilotModelMetadataForPricing(ctx),
  });
  router.use(createRequestTelemetryMiddleware(ctx.telemetryStore));

  // ── File upload (multipart) — must be before JSON body parser ──
  const uploadStorage = multer.diskStorage({
    destination: (req, _file, cb) => {
      const sessionId = req.body?.sessionId;
      if (!sessionId || !isCanonicalSessionId(sessionId)) {
        return cb(new Error("Valid sessionId is required"), "");
      }
      const filesDir = join(getCopilotHome(ctx), "session-state", sessionId, "files");
      mkdirSync(filesDir, { recursive: true });
      (req as any)._uploadDir = filesDir;
      cb(null, filesDir);
    },
    filename: (req, file, cb) => {
      const dir = (req as any)._uploadDir as string;
      const safe = basename(file.originalname).replace(/\.\./g, "_") || "attachment";
      if (!existsSync(join(dir, safe))) return cb(null, safe);
      const dot = safe.lastIndexOf(".");
      const stem = dot > 0 ? safe.slice(0, dot) : safe;
      const ext = dot > 0 ? safe.slice(dot) : "";
      let i = 1;
      while (existsSync(join(dir, `${stem} (${i})${ext}`))) i++;
      cb(null, `${stem} (${i})${ext}`);
    },
  });
  const upload = multer({ storage: uploadStorage, limits: { fileSize: 10 * 1024 * 1024 } });
  const transcribeUpload = multer({
    storage: multer.diskStorage({
      destination: (req, _file, cb) => {
        const dir = mkdtempSync(join(tmpdir(), "bridge-transcribe-"));
        (req as express.Request & { _transcriptionTempDir?: string })._transcriptionTempDir = dir;
        cb(null, dir);
      },
      filename: (_req, file, cb) => {
        const safe = basename(file.originalname).replace(/\.\./g, "_") || "voice-input.wav";
        cb(null, safe);
      },
    }),
    limits: { fileSize: 25 * 1024 * 1024 },
  });

  router.post("/upload", (req, res, next) => {
    upload.single("file")(req, res, (err) => {
      if (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return res.status(400).json({ error: msg });
      }
      if (!req.file) {
        return res.status(400).json({ error: "No file provided" });
      }
      console.log(`[web] [${(req.body?.sessionId ?? "").slice(0, 8)}] Uploaded: ${req.file.filename} (${req.file.mimetype}, ${req.file.size} bytes)`);
      res.json({
        displayName: req.file.filename,
        mimeType: req.file.mimetype,
        size: req.file.size,
      });
    });
  });

  router.post("/transcribe", (req, res) => {
    transcribeUpload.single("audio")(req, res, async (err) => {
      if (err) {
        await cleanupTranscriptionUpload(req);
        const msg = err instanceof Error ? err.message : String(err);
        return res.status(400).json({ error: msg });
      }
      if (!req.file) {
        await cleanupTranscriptionUpload(req);
        return res.status(400).json({ error: "No audio file provided" });
      }

      try {
        const status = transcriptionService.getStatus();
        if (!status.available) {
          return res.status(503).json({ error: status.reason ?? "Voice input is unavailable." });
        }

        const durationSeconds = await getWavDurationSeconds(req.file.path);
        if (durationSeconds > status.maxDurationSeconds) {
          return res.status(400).json({ error: `Audio exceeds ${status.maxDurationSeconds} seconds.` });
        }

        const workingDir = (req as express.Request & { _transcriptionTempDir?: string })._transcriptionTempDir ?? dirname(req.file.path);
        const result = await transcriptionService.transcribe({
          filePath: req.file.path,
          workingDir,
        });
        console.log(`[web] Transcribed voice input via ${result.provider}`);
        return res.json(result);
      } catch (error) {
        return res.status(error instanceof InvalidWavError ? 400 : 500).json({
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        await cleanupTranscriptionUpload(req);
      }
    });
  });

  router.get("/transcribe/status", (_req, res) => {
    try {
      res.json(transcriptionService.getStatus());
    } catch (error) {
      res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
    }
  });

  router.post("/voice-jobs", (req, res) => {
    transcribeUpload.single("audio")(req, res, async (err) => {
      if (err) {
        await cleanupTranscriptionUpload(req);
        const msg = err instanceof Error ? err.message : String(err);
        return res.status(400).json({ error: msg });
      }
      if (!req.file) {
        await cleanupTranscriptionUpload(req);
        return res.status(400).json({ error: "No audio file provided" });
      }

      const composerKey = String(req.body?.composerKey ?? "").trim();
      const taskId = String(req.body?.taskId ?? "").trim() || undefined;
      const sessionId = String(req.body?.sessionId ?? "").trim() || undefined;
      if (!composerKey) {
        await cleanupTranscriptionUpload(req);
        return res.status(400).json({ error: "composerKey is required" });
      }

      try {
        const status = transcriptionService.getStatus();
        if (!status.available) {
          return res.status(503).json({ error: status.reason ?? "Voice input is unavailable." });
        }

        const durationSeconds = await getWavDurationSeconds(req.file.path);
        if (durationSeconds > status.maxDurationSeconds) {
          return res.status(400).json({ error: `Audio exceeds ${status.maxDurationSeconds} seconds.` });
        }

        const job = await voiceJobManager.acceptVoiceJob({
          composerKey,
          taskId,
          targetSessionId: sessionId,
          sourceFilePath: req.file.path,
          originalFilename: req.file.originalname,
        });
        return res.status(202).json(job);
      } catch (error) {
        if (isRestartPendingError(error)) {
          res.set("Retry-After", "5");
          return res.status(503).json({ error: RESTART_PENDING_MESSAGE });
        }
        return res.status(error instanceof InvalidWavError ? 400 : 500).json({
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        await cleanupTranscriptionUpload(req);
      }
    });
  });

  router.get("/voice-jobs/latest", (req, res) => {
    const composerKey = String(req.query.composerKey ?? "").trim();
    if (!composerKey) {
      return res.status(400).json({ error: "composerKey is required" });
    }

    const job = voiceJobManager.findLatestRelevantForComposer(composerKey);
    if (!job) {
      return res.status(404).json({ error: "Voice job not found" });
    }
    res.json(job);
  });

  router.get("/voice-jobs/:id", (req, res) => {
    const job = voiceJobManager.getVoiceJob(req.params.id);
    if (!job) {
      return res.status(404).json({ error: "Voice job not found" });
    }
    res.json(job);
  });

  router.post("/voice-jobs/:id/recovered", (req, res) => {
    const job = voiceJobManager.markRecovered(req.params.id);
    if (!job) {
      return res.status(404).json({ error: "Voice job not found" });
    }
    res.json(job);
  });

  // JSON body parser — after upload route so multipart isn't rejected
  router.use(express.json({ limit: "20mb" }));
  router.use(createApiJsonErrorHandler());

  // Wire settings getter for providers (so they can resolve without module-level imports)
  setSettingsGetter(() => ctx.settingsStore.getSettings());

  // ── Enriched session list cache ─────────────────────────────────
  // Caches the enriched session list (plan checks, workspace summaries, metadata).
  // Invalidated by structural changes; volatile run-state fields are refreshed on read.
  let enrichedSessionCache: { data: any[]; timestamp: number; includesArchived: boolean } | null = null;
  type SessionCacheBuild = { generation: number; promise: Promise<any[]> };
  let activeSessionCacheBuild: SessionCacheBuild | null = null;
  let allSessionCacheBuild: SessionCacheBuild | null = null;
  const ENRICHED_CACHE_TTL = 30_000; // 30 seconds
  let enrichedSessionCacheGeneration = 0;

  function recordSessionCacheSpan(name: string, duration: number, metadata: Record<string, unknown>): void {
    try {
      ctx.telemetryStore?.recordSpan({ name, duration, metadata, source: "server" });
    } catch { /* telemetry should never break core flow */ }
  }

  function invalidateEnrichedCache(reason: string, opts: { rawDisk?: boolean } = {}) {
    const hadCache = enrichedSessionCache !== null;
    const hadActiveBuild = activeSessionCacheBuild !== null;
    const hadAllBuild = allSessionCacheBuild !== null;
    enrichedSessionCache = null;
    enrichedSessionCacheGeneration += 1;
    recordSessionCacheSpan("session.enrichedList.invalidate", 0, {
      reason,
      rawDisk: opts.rawDisk === true,
      generation: enrichedSessionCacheGeneration,
      hadCache,
      hadActiveBuild,
      hadAllBuild,
    });
    if (opts.rawDisk) ctx.sessionManager.invalidateSessionListCache(reason);
  }

  function setSessionArchived(sessionId: string, archived: boolean) {
    ctx.sessionMetaStore.setArchived(sessionId, archived);
    ctx.globalBus.emit({ type: "session:archived", sessionId, archived });
  }

  function materializeSessionList(
    sessions: any[],
    includeArchived: boolean,
    taskLookup = createSessionListTaskLookup(ctx),
  ): any[] {
    const currentMeta = ctx.sessionMetaStore.listMeta();
    const readState = ctx.readStateStore.getReadState();
    const publicSessions = sessions.flatMap((s: any) => {
      const id = s.sessionId;
      const status = getSessionStatus(ctx, id);
      const linkedTask = taskLookup.resolveTask(id);
      const linkedTasks = taskLookup.getLinkedTasks(id);
      const sessionMeta = currentMeta[id];
      const archived = sessionMeta?.archived ?? s.archived ?? false;
      const lastVisibleActivityAt = sessionMeta?.lastVisibleActivityAt ?? s.lastVisibleActivityAt;
      const lastAttentionAt = sessionMeta?.lastAttentionAt ?? s.lastAttentionAt;
      const lastActivityAt = maxIsoTime(lastVisibleActivityAt, lastAttentionAt);
      const deferSummary = getSessionDeferSummary(ctx, id);
      if (!shouldIncludeMaterializedSession({
        includeArchived,
        archived,
        linkedTasks,
        status,
        readState,
        sessionId: id,
        lastActivityAt,
        hasSessionName: typeof s.summary === "string" && s.summary.trim().length > 0,
        hasReadState: !!readState[id],
        hasBridgeActivitySignal: !!sessionMeta?.lastVisibleActivityAt || !!sessionMeta?.lastAttentionAt,
        hasDeferredWork: deferSummary.count > 0,
      })) return [];
      const summary = resolveSessionSummary(s, {
        fallbackSummary: linkedTask || status.runState !== "idle" ? "New session" : undefined,
      });

      return [{
        ...s,
        summary,
        lastVisibleActivityAt,
        lastAttentionAt,
        lastActivityAt,
        modifiedTime: lastActivityAt ?? s.modifiedTime,
        ...status,
        deferSummary,
        archived,
      }];
    });
    publicSessions.sort((a: any, b: any) => (b.modifiedTime ?? "").localeCompare(a.modifiedTime ?? ""));
    return publicSessions;
  }

  function getReusableSessionCacheBuild(build: SessionCacheBuild | null): Promise<any[]> | null {
    return build?.generation === enrichedSessionCacheGeneration ? build.promise : null;
  }

  async function getEnrichedSessionList(includeArchived: boolean): Promise<any[]> {
    const now = Date.now();
    const cacheValid = enrichedSessionCache
      && (!includeArchived || enrichedSessionCache.includesArchived)
      && (now - enrichedSessionCache.timestamp) < ENRICHED_CACHE_TTL;

    if (cacheValid) {
      recordSessionCacheSpan("session.enrichedList.cache", 0, {
        result: "hit",
        includeArchived,
        cacheIncludesArchived: enrichedSessionCache!.includesArchived,
        count: enrichedSessionCache!.data.length,
      });
      return enrichedSessionCache!.data;
    }

    const existingBuild = includeArchived
      ? getReusableSessionCacheBuild(allSessionCacheBuild)
      : (getReusableSessionCacheBuild(allSessionCacheBuild) ?? getReusableSessionCacheBuild(activeSessionCacheBuild));
    if (existingBuild) {
      const tWait = Date.now();
      const sessions = await existingBuild;
      recordSessionCacheSpan("session.enrichedList.cache", Date.now() - tWait, {
        result: "coalesced",
        includeArchived,
        count: sessions.length,
      });
      return sessions;
    }

    recordSessionCacheSpan("session.enrichedList.cache", 0, {
      result: enrichedSessionCache ? "stale" : "miss",
      includeArchived,
      cacheIncludesArchived: enrichedSessionCache?.includesArchived,
    });

    const buildGeneration = enrichedSessionCacheGeneration;
    const buildIncludesArchived = includeArchived;
    const tBuild = Date.now();
    const build = (async () => {
      const catalogSessions = listSessionsFromCliCatalog(ctx);
      const usingCliCatalog = catalogSessions !== undefined;
      const sessions = (catalogSessions ?? await ctx.sessionManager.listSessionsFromDisk({ includeArchived: buildIncludesArchived }))
        .filter((session: any) => !isDisposableTitleSessionId(session.sessionId));
      const sessionStateDir = join(getCopilotHome(ctx), "session-state");
      const meta = ctx.sessionMetaStore.listMeta();
      const readState = ctx.readStateStore.getReadState();
      const taskLookup = createSessionListTaskLookup(ctx);
      let overlayDurationMs = 0;
      let overlayReadCount = 0;
      let overlayHitCount = 0;
      let overlayMismatchCount = 0;
      let overlayErrorCount = 0;

      const overlayWorkspaceSessionName = async (session: any): Promise<any> => {
        if (!usingCliCatalog) return session;
        const start = Date.now();
        overlayReadCount += 1;
        try {
          const workspaceName = await readWorkspaceSessionName(sessionStateDir, session.sessionId);
          if (!workspaceName) return session;
          overlayHitCount += 1;
          const dbSummary = typeof session.summary === "string" && session.summary.trim()
            ? session.summary.trim()
            : undefined;
          if (dbSummary && dbSummary !== workspaceName) overlayMismatchCount += 1;
          return { ...session, summary: workspaceName };
        } catch (error) {
          if (getErrorCode(error) !== "ENOENT") overlayErrorCount += 1;
          return session;
        } finally {
          overlayDurationMs += Date.now() - start;
        }
      };

      const enriched = await Promise.all(
        sessions
          .map((s: any) => {
            const id = s.sessionId;
            const status = getSessionStatus(ctx, id);
            const linkedTask = taskLookup.resolveTask(id);
            const linkedTasks = taskLookup.getLinkedTasks(id);
            return { session: s, linkedTask, linkedTasks, status };
          })
          .map(async ({ session: s, linkedTask, linkedTasks, status }) => {
            const id = s.sessionId;
            const archived = meta[id]?.archived === true;
            const lastVisibleActivityAt = meta[id]?.lastVisibleActivityAt ?? s.lastVisibleActivityAt;
            const lastAttentionAt = meta[id]?.lastAttentionAt ?? s.lastAttentionAt;
            const lastActivityAt = maxIsoTime(lastVisibleActivityAt, lastAttentionAt);
            const deferSummary = getSessionDeferSummary(ctx, id);
            const shouldBuildDetails = shouldIncludeMaterializedSession({
              includeArchived: buildIncludesArchived,
              archived,
              linkedTasks,
              status,
              readState,
              sessionId: id,
              lastActivityAt,
              hasSessionName: typeof s.summary === "string" && s.summary.trim().length > 0,
              hasReadState: !!readState[id],
              hasBridgeActivitySignal: !!meta[id]?.lastVisibleActivityAt || !!meta[id]?.lastAttentionAt,
              hasDeferredWork: deferSummary.count > 0,
            });

            if (!shouldBuildDetails) {
              return {
                ...s,
                ...status,
                lastVisibleActivityAt,
                lastAttentionAt,
                lastActivityAt,
                modifiedTime: lastActivityAt ?? s.modifiedTime,
                archived,
                archivedAt: meta[id]?.archivedAt ?? null,
                triggeredBy: meta[id]?.triggeredBy,
                scheduleId: meta[id]?.scheduleId,
                scheduleName: meta[id]?.scheduleName,
              };
            }

            const namedSession = await overlayWorkspaceSessionName(s);
            const hasPlan = await statAsync(join(sessionStateDir, id, "plan.md")).then(() => true, () => false);
            const eventLogSizeBytes = typeof s.eventLogSizeBytes === "number"
              ? s.eventLogSizeBytes
              : await getSessionEventLogSizeBytes(ctx, id);
            const archivedAt = meta[id]?.archivedAt ?? null;
            const { source: _workspaceSource, ...workspace } = buildSessionWorkspaceSummary(ctx, id, linkedTask);
            const context = {
              ...(s.context ?? {}),
              ...(workspace.effectiveCwd ? { cwd: workspace.effectiveCwd } : {}),
            };
            return {
              ...namedSession,
              eventLogSizeBytes,
              context: Object.keys(context).length > 0 ? context : undefined,
              workspace,
              ...status,
              lastVisibleActivityAt,
              lastAttentionAt,
              lastActivityAt,
              modifiedTime: lastActivityAt ?? s.modifiedTime,
              hasPlan,
              archived,
              archivedAt,
              triggeredBy: meta[id]?.triggeredBy,
              scheduleId: meta[id]?.scheduleId,
              scheduleName: meta[id]?.scheduleName,
              scheduleEnabled: meta[id]?.scheduleId
                ? (ctx.scheduleStore.getSchedule(meta[id]!.scheduleId!)?.enabled ?? false)
                : undefined,
            };
          }),
      );
      if (usingCliCatalog) {
        recordSessionCacheSpan("session.workspaceNameOverlay", overlayDurationMs, {
          readCount: overlayReadCount,
          hitCount: overlayHitCount,
          mismatchCount: overlayMismatchCount,
          errorCount: overlayErrorCount,
          candidateCount: sessions.length,
          includeArchived: buildIncludesArchived,
        });
      }

      const stored = buildGeneration === enrichedSessionCacheGeneration;
      if (stored) {
        enrichedSessionCache = { data: enriched, timestamp: Date.now(), includesArchived: buildIncludesArchived };
      }
      recordSessionCacheSpan("session.enrichedList.build", Date.now() - tBuild, {
        result: stored ? "stored" : "discarded",
        includeArchived: buildIncludesArchived,
        count: enriched.length,
        generation: buildGeneration,
        currentGeneration: enrichedSessionCacheGeneration,
      });
      return enriched;
    })().finally(() => {
      if (buildIncludesArchived) {
        if (allSessionCacheBuild?.promise === build) allSessionCacheBuild = null;
      } else if (activeSessionCacheBuild?.promise === build) {
        activeSessionCacheBuild = null;
      }
    });

    const buildRecord = { generation: buildGeneration, promise: build };
    if (buildIncludesArchived) allSessionCacheBuild = buildRecord;
    else activeSessionCacheBuild = buildRecord;
    return build;
  }

  // Invalidate on session lifecycle events
  ctx.globalBus.subscribe((event: any) => {
    switch (event.type) {
      case "session:title":
        invalidateEnrichedCache("bus:session:title");
        break;
      case "session:archived":
        invalidateEnrichedCache("bus:session:archived", { rawDisk: true });
        break;
      case "task:changed":
        invalidateEnrichedCache("bus:task:changed");
        break;
      case "schedule:changed":
        invalidateEnrichedCache("bus:schedule:changed");
        break;
      case "sessions:changed":
        invalidateEnrichedCache("bus:sessions:changed");
        break;
    }
  });

  // ── Session routes ──────────────────────────────────────────────

  router.get("/sessions", async (req, res) => {
    try {
      const includeArchived = req.query.includeArchived === "true";
      const enriched = await getEnrichedSessionList(includeArchived);
      res.json({ sessions: materializeSessionList(enriched, includeArchived) });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.get("/busy", (_req, res) => {
    const sessions = ctx.sessionManager.getSessionActivity();
    res.json({
      busy: sessions.length > 0,
      count: sessions.length,
      sessionIds: sessions.map((s) => s.id),
      sessions,
    });
  });

  router.get("/health", (_req, res) => {
    res.json({ ok: true });
  });

  router.post("/maintenance/session-overlay-reaper", (req, res) => {
    try {
      const body = req.body ?? {};
      const minimumAgeMs = typeof body.minimumAgeMs === "number" && Number.isFinite(body.minimumAgeMs) && body.minimumAgeMs >= 0
        ? body.minimumAgeMs
        : undefined;
      const minimumAgeHours = typeof body.minimumAgeHours === "number" && Number.isFinite(body.minimumAgeHours) && body.minimumAgeHours >= 0
        ? body.minimumAgeHours
        : undefined;
      const report = runSessionOverlayReaper(ctx, {
        dryRun: body.dryRun !== false,
        cleanupDeletedScheduleRuns: body.cleanupDeletedScheduleRuns === true,
        minimumAgeMs: minimumAgeMs ?? (minimumAgeHours === undefined ? undefined : minimumAgeHours * 60 * 60 * 1000),
      });

      if (!report.dryRun && (report.reaped > 0 || report.deletedScheduleRuns.deleted > 0)) {
        invalidateEnrichedCache("maintenance:session-overlay-reaper");
        ctx.globalBus.emit({ type: "sessions:changed" });
      }

      res.json(report);
    } catch (err) {
      console.error("[maintenance] Session overlay reaper failed:", err);
      res.status(500).json({ error: "Failed to run session overlay reaper" });
    }
  });

  router.get("/push/status", (_req, res) => {
    try {
      res.json(getPushPublicStatus(ensurePushSubscriptionStore(ctx)));
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.post("/push/subscriptions", (req, res) => {
    const subscription = normalizePushSubscriptionBody(req.body);
    if (!subscription) {
      return res.status(400).json({ error: "Valid push subscription is required." });
    }

    try {
      const saved = ensurePushSubscriptionStore(ctx).upsertSubscription(subscription, req.get("user-agent") ?? undefined);
      res.status(201).json({
        ok: true,
        subscription: {
          id: saved.id,
          endpoint: saved.endpoint,
          createdAt: saved.createdAt,
          updatedAt: saved.updatedAt,
          lastSeenAt: saved.lastSeenAt,
        },
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.delete("/push/subscriptions", (req, res) => {
    const endpoint = normalizeEndpointBody(req.body);
    if (!endpoint) {
      return res.status(400).json({ error: "Valid push subscription endpoint is required." });
    }

    try {
      res.json({ ok: true, deleted: ensurePushSubscriptionStore(ctx).deleteSubscription(endpoint) });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.post("/push/test", async (req, res) => {
    const endpoint = normalizeEndpointBody(req.body);
    const payload: BridgePushPayload = {
      title: "Copilot Bridge test",
      body: "Push notifications are working.",
      url: "./",
      tag: "bridge-test-notification",
      data: { eventType: "push:test" },
      suppressIfFocused: false,
    };

    try {
      const pushNotificationService = ensurePushNotificationService(ctx);
      const result = endpoint
        ? await pushNotificationService.sendToEndpoint(endpoint, payload)
        : await pushNotificationService.sendToAll(payload);
      res.json({ ok: true, result });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/copilot-usage", async (req, res) => {
    try {
      const refresh = req.query.refresh === "1";
      const summary = await copilotUsageReader.readSummary({ refresh });
      res.json(serializeCopilotUsageSummary(summary));
    } catch (err) {
      console.error("[copilot-usage] Error:", err);
      res.status(500).json({
        error: err instanceof Error ? err.message : "Unable to read local Copilot usage history.",
      });
    }
  });

  // POST /shutdown — graceful shutdown: abort active sessions, stop SDK, exit
  router.post("/shutdown", async (_req, res) => {
    if (ctx.isStaging) return res.status(404).json({ error: "Not available in staging" });
    console.log("[web] Graceful shutdown requested via API");
    res.json({ ok: true, message: "Shutting down..." });
    try {
      schedulerModule().setGlobalPause(true);
      ctx.deferredPromptRunner?.shutdown();
      ctx.deferLoopRunner?.shutdown();
      await ctx.sessionManager.gracefulShutdown();
      schedulerModule().shutdown();
    } catch (err) {
      console.error("[web] Error during graceful shutdown:", err);
    }
    process.exit(0);
  });

  router.post("/device/hibernate", (_req, res) => {
    if (ctx.isStaging) return res.status(404).json({ error: "Not available in staging" });
    let hibernateCommand: DeviceHibernateCommand;
    try {
      hibernateCommand = getDeviceHibernateCommand();
    } catch (error) {
      return res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
    }
    console.log("[device] Hibernate requested via API");
    res.on("finish", () => {
      setTimeout(() => {
        void requestDeviceHibernate(hibernateCommand).catch((error) => {
          console.error("[device] Hibernate request failed:", error);
        });
      }, 250);
    });
    res.status(202).json({
      ok: true,
      message: "Hibernate requested. This device may sleep shortly.",
    });
  });

  // POST /restart-clear — manual escape hatch to dismiss a stale restart banner
  router.post("/restart-clear", (_req, res) => {
    if (ctx.isStaging) return res.status(404).json({ error: "Not available in staging" });
    clearRestartPending();
    res.json({ ok: true });
  });

  // GET /status-stream — global SSE for session lifecycle events
  router.get("/status-stream", (req, res) => {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.flushHeaders?.();

    let closed = false;

    const heartbeat = setInterval(() => {
      if (closed || res.writableEnded) return;
      try { res.write(`: heartbeat\n\n`); } catch { close(); }
    }, 15_000);

    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      unsub();
      if (!res.writableEnded) res.end();
    };

    const unsub = ctx.globalBus.subscribe((event) => {
      if (closed || res.writableEnded) return;
      try { res.write(`data: ${JSON.stringify(event)}\n\n`); } catch { close(); }
    });

    try { res.write(`: connected\n\n`); }
    catch { close(); }

    void refreshRestartState()
      .then((restartState) => {
        if (closed || res.writableEnded) return;
        if (restartState.phase !== "idle") {
          try { res.write(`data: ${JSON.stringify({ type: "server:restart-pending", waitingSessions: restartState.waitingSessions })}\n\n`); }
          catch { close(); }
          return;
        }
        try { res.write(`data: ${JSON.stringify({ type: "server:restart-cleared" })}\n\n`); }
        catch { close(); }
      })
      .catch(() => {
        close();
      });

    res.on("error", () => { close(); });
    req.on("close", () => { close(); });
  });

  router.get("/sessions/:id/messages", async (req, res) => {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
      const before = req.query.before ? parseInt(req.query.before as string, 10) : undefined;
      const { messages, total, hasMore, lastVisibleActivityAt } = await ctx.sessionManager.getSessionMessages(
        req.params.id,
        { limit, before },
      );
      res.json({ messages, ...getSessionStatus(ctx, req.params.id), total, hasMore, lastVisibleActivityAt });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/sessions/:id/attachments/:attachmentId", (req, res) => {
    if (!isCanonicalSessionId(req.params.id)) {
      return res.status(400).json({ error: "Valid sessionId is required" });
    }
    const attachmentId = String(req.params.attachmentId ?? "").trim();
    if (!attachmentId) {
      return res.status(400).json({ error: "attachmentId is required" });
    }
    if (basename(attachmentId) !== attachmentId || attachmentId.includes("..")) {
      return res.status(400).json({ error: "attachmentId is invalid" });
    }

    const attachment = resolveOutboundAttachment(getCopilotHome(ctx), req.params.id, attachmentId);
    if (!attachment.ok) {
      return res.status(attachment.error === "Attachment path is unsafe" ? 403 : 404).json({ error: attachment.error });
    }

    const onSendError = (err: NodeJS.ErrnoException | null) => {
      if (!err || res.headersSent) return;
      const errWithStatus = err as NodeJS.ErrnoException & { statusCode?: number };
      const statusCode = typeof errWithStatus.statusCode === "number"
        ? errWithStatus.statusCode
        : 500;
      res.status(statusCode).json({ error: err.message });
    };

    res.type(attachment.value.mimeType);
    if (attachment.value.inline) {
      return res.sendFile(attachment.value.filePath, { dotfiles: "allow" }, onSendError);
    }
    return res.download(attachment.value.filePath, attachment.value.displayName, { dotfiles: "allow" }, onSendError);
  });

  function sendVisualArtifact(owner: VisualArtifactOwner, artifactId: string, res: express.Response, mode: "inline" | "download"): void {
    const resolved = resolveVisualArtifactForOwner(getCopilotHome(ctx), owner, artifactId);
    if (!resolved.ok) {
      const status = resolved.error.includes("unsafe") ? 403 : 404;
      res.status(status).json({ error: resolved.error });
      return;
    }
    const onErr = (err: NodeJS.ErrnoException | null) => {
      if (!err || res.headersSent) return;
      res.status((err as any).statusCode ?? 500).json({ error: err.message });
    };
    if (mode === "download") {
      res.download(resolved.value.filePath, resolved.value.displayName, { dotfiles: "allow" }, onErr);
      return;
    }
    res.type(resolved.value.mimeType);
    if (resolved.value.mimeType === HTML_MIME_TYPE) {
      res.setHeader(
        "Content-Security-Policy",
        "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'",
      );
      res.setHeader("Referrer-Policy", "no-referrer");
      res.setHeader("X-Content-Type-Options", "nosniff");
    }
    res.sendFile(resolved.value.filePath, { dotfiles: "allow" }, onErr);
  }

  function sendVisualMeta(owner: VisualArtifactOwner, artifactId: string, res: express.Response): void {
    const meta = loadVisualArtifactMetaForOwner(getCopilotHome(ctx), owner, artifactId);
    if (!meta.ok) {
      res.status(meta.error.includes("invalid") ? 400 : 404).json({ error: meta.error });
      return;
    }
    res.json(meta.value);
  }

  // Visual artifact routes — serve published visual artifacts by artifactId (UUID)
  // GET /sessions/:id/visuals/:artifactId — serve artifact inline
  router.get("/sessions/:id/visuals/:artifactId", (req, res) => {
    if (!isCanonicalSessionId(req.params.id)) {
      return res.status(400).json({ error: "Valid sessionId is required" });
    }
    const artifactId = String(req.params.artifactId ?? "").trim();
    if (!isCanonicalArtifactId(artifactId)) {
      return res.status(400).json({ error: "artifactId must be a valid UUID" });
    }
    return sendVisualArtifact(sessionVisualOwner(req.params.id), artifactId, res, "inline");
  });

  // GET /sessions/:id/visuals/:artifactId/download — force-download the image
  router.get("/sessions/:id/visuals/:artifactId/download", (req, res) => {
    if (!isCanonicalSessionId(req.params.id)) {
      return res.status(400).json({ error: "Valid sessionId is required" });
    }
    const artifactId = String(req.params.artifactId ?? "").trim();
    if (!isCanonicalArtifactId(artifactId)) {
      return res.status(400).json({ error: "artifactId must be a valid UUID" });
    }
    return sendVisualArtifact(sessionVisualOwner(req.params.id), artifactId, res, "download");
  });

  // GET /sessions/:id/visuals/:artifactId/meta — return visual artifact metadata as JSON
  router.get("/sessions/:id/visuals/:artifactId/meta", (req, res) => {
    if (!isCanonicalSessionId(req.params.id)) {
      return res.status(400).json({ error: "Valid sessionId is required" });
    }
    const artifactId = String(req.params.artifactId ?? "").trim();
    if (!isCanonicalArtifactId(artifactId)) {
      return res.status(400).json({ error: "artifactId must be a valid UUID" });
    }
    return sendVisualMeta(sessionVisualOwner(req.params.id), artifactId, res);
  });

  // Fast message loading — reads events.jsonl directly from disk, no SDK resume needed
  router.get("/sessions/:id/messages-fast", async (req, res) => {
    try {
      const limit = req.query.limit ? parseInt(req.query.limit as string, 10) : undefined;
      const before = req.query.before ? parseInt(req.query.before as string, 10) : undefined;
      const { messages, total, hasMore, lastVisibleActivityAt } = await ctx.sessionManager.readMessagesFromDisk(
        req.params.id,
        { limit, before },
      );
      const warm = ctx.sessionManager.isSessionWarm(req.params.id);
      res.json({ messages, ...getSessionStatus(ctx, req.params.id), total, hasMore, lastVisibleActivityAt, warm });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Warm a session — triggers background SDK resume, returns when ready
  router.post("/sessions/:id/warm", async (req, res) => {
    try {
      await ctx.sessionManager.warmSession(req.params.id);
      res.json({ ready: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Reload a session with fresh config — evicts cached object, then resumes it
  router.post("/sessions/:id/reload", async (req, res) => {
    try {
      if (ctx.sessionManager.isSessionBusy(req.params.id)) {
        return res.status(409).json({ error: "Cannot reload a busy session" });
      }
      const servers = await ctx.sessionManager.reloadSession(req.params.id);
      res.json({ ready: true, servers });
    } catch (err) {
      if (err instanceof Error && err.message === "Cannot reload a busy session") {
        return res.status(409).json({ error: err.message });
      }
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  const VALID_REASONING_EFFORTS = new Set(["low", "medium", "high", "xhigh"]);

  // GET /sessions/:id/model — derive current model/reasoning for a session on demand
  router.get("/sessions/:id/model", async (req, res) => {
    const sessionId = req.params.id;
    if (!isCanonicalSessionId(sessionId)) {
      return res.status(400).json({ error: "Valid sessionId is required" });
    }
    try {
      const result = await ctx.sessionManager.getSessionModelState(sessionId);
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // PATCH /sessions/:id/model — explicitly switch the model for a single session
  router.patch("/sessions/:id/model", async (req, res) => {
    const sessionId = req.params.id;
    if (!isCanonicalSessionId(sessionId)) {
      return res.status(400).json({ error: "Valid sessionId is required" });
    }
    const { model, reasoningEffort } = req.body ?? {};
    const normalizedModel = typeof model === "string" ? model.trim() : "";

    if (!normalizedModel) {
      return res.status(400).json({ error: "model must be a non-empty string" });
    }
    if (reasoningEffort !== undefined && !VALID_REASONING_EFFORTS.has(reasoningEffort)) {
      return res.status(400).json({
        error: `reasoningEffort must be one of: ${[...VALID_REASONING_EFFORTS].join(", ")}`,
      });
    }

    try {
      const result = await ctx.sessionManager.setSessionModel(sessionId, normalizedModel, reasoningEffort);
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/busy/i.test(message)) return res.status(409).json({ error: message });
      if (/restart/i.test(message)) return res.status(503).json({ error: message });
      res.status(500).json({ error: message });
    }
  });

  router.post("/sessions", async (req, res) => {
    if (isRestartCutoverInProgress(await refreshRestartState())) {
      res.set("Retry-After", "5");
      return res.status(503).json({ error: RESTART_PENDING_MESSAGE });
    }
    try {
      const { name } = req.body ?? {};
      const result = await ctx.sessionManager.createSession();
      invalidateEnrichedCache("route:session:create");
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  async function finishForkedSession(sourceId: string, forkedSessionId: string, opts: { bounded?: boolean } = {}) {
    let originalTitle = ctx.sessionTitles.getTitle(sourceId);
    if (!originalTitle) {
      const sourceSession = ctx.cliSessionCatalog?.getSession(sourceId)
        ?? (await ctx.sessionManager.listSessionsFromDisk())
          .find((session: any) => session.sessionId === sourceId);
      originalTitle = sourceSession ? resolveSessionSummary(sourceSession) : undefined;
    }

    invalidateEnrichedCache("route:session:fork");
    for (const linkedTask of ctx.taskStore.listTasks().filter((task) => task.sessionIds.includes(sourceId))) {
      ctx.taskStore.linkSession(linkedTask.id, forkedSessionId);
    }

    let warmed = false;
    try {
      await ctx.sessionManager.warmSession(forkedSessionId);
      warmed = true;
    } catch (error) {
      console.warn(
        `[sessions] Fork ${forkedSessionId.slice(0, 8)} created but could not be warmed:`,
        error instanceof Error ? error.message : error,
      );
    }

    if (originalTitle) {
      const forkTitle = `${opts.bounded ? "Fork from" : "Fork of"} ${originalTitle}`.slice(0, 100).trim();
      if (warmed) {
        try {
          await ctx.sessionManager.setSessionName(forkedSessionId, forkTitle);
        } catch (error) {
          console.warn(
            `[sessions] Fork ${forkedSessionId.slice(0, 8)} created but could not be renamed:`,
            error instanceof Error ? error.message : error,
          );
        }
      } else {
        console.warn(
          `[sessions] Fork ${forkedSessionId.slice(0, 8)} rename skipped because warm resume failed`,
        );
      }
    }
    ctx.globalBus.emit({ type: "sessions:changed", sessionId: forkedSessionId });
  }

  function handleForkError(res: express.Response, err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    if (/not found or has no persisted events/i.test(message) || /no persisted events/i.test(message)) {
      return res.status(400).json({ error: "Cannot fork a session before it has persisted conversation history." });
    }
    if (/event.*not found|toEventId.*not found/i.test(message)) {
      return res.status(400).json({ error: message });
    }
    if (/session .*not found|session not found/i.test(message)) {
      return res.status(404).json({ error: message });
    }
    if (/fork is not available/i.test(message)) {
      return res.status(501).json({ error: message });
    }
    return res.status(500).json({ error: message });
  }

  // POST /sessions/:id/fork — create a native SDK fork, optionally before a raw event boundary
  router.post("/sessions/:id/fork", async (req, res) => {
    const sourceId = req.params.id;
    try {
      if (isRestartCutoverInProgress(await refreshRestartState())) {
        res.set("Retry-After", "5");
        return res.status(503).json({ error: RESTART_PENDING_MESSAGE });
      }
      if (ctx.sessionManager.isSessionBusy(sourceId)) {
        return res.status(409).json({ error: "Cannot fork a busy session" });
      }
      const toEventId = isRecord(req.body) && typeof req.body.toEventId === "string"
        ? req.body.toEventId.trim()
        : undefined;
      if (isRecord(req.body) && req.body.toEventId !== undefined && !toEventId) {
        return res.status(400).json({ error: "toEventId must be a non-empty string when provided" });
      }
      const result = await ctx.sessionManager.forkSession(sourceId, toEventId ? { toEventId } : {});
      await finishForkedSession(sourceId, result.sessionId, { bounded: Boolean(toEventId) });

      res.json(result);
    } catch (err) {
      handleForkError(res, err);
    }
  });

  // POST /chat — fire and forget, starts work in background
  router.post("/chat", async (req, res) => {
    const { sessionId, prompt, attachments } = req.body;

    if (!sessionId || !prompt) {
      return res.status(400).json({ error: "sessionId and prompt are required" });
    }

    if (isRestartCutoverInProgress(await refreshRestartState())) {
      res.set("Retry-After", "5");
      return res.status(503).json({ error: RESTART_PENDING_MESSAGE });
    }

    if (ctx.sessionManager.isSessionBusy(sessionId)) {
      return res.status(429).json({ error: "Session is busy, please wait" });
    }

    // Auto-unarchive if user sends a message to an archived session
    const meta = ctx.sessionMetaStore.getMeta(sessionId);
    if (meta?.archived) {
      setSessionArchived(sessionId, false);
      console.log(`[web] [${sessionId.slice(0, 8)}] auto-unarchived (user sent message)`);
    }

    const attachCount = Array.isArray(attachments) ? attachments.length : 0;
    console.log(`[web] [${sessionId.slice(0, 8)}] "${prompt.slice(0, 80)}"${attachCount ? ` (+${attachCount} attachment${attachCount > 1 ? "s" : ""})` : ""}`);

    try {
      ctx.sessionManager.startWork(sessionId, prompt, attachments);
      res.status(202).json({ status: "accepted" });
    } catch (err) {
      if (isRestartPendingError(err)) {
        res.set("Retry-After", "5");
        return res.status(503).json({ error: RESTART_PENDING_MESSAGE });
      }
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/sessions/:id/fleet", async (req, res) => {
    const sessionId = req.params.id;
    const prompt = typeof req.body?.prompt === "string" ? req.body.prompt : undefined;

    if (req.body?.prompt !== undefined && typeof req.body.prompt !== "string") {
      return res.status(400).json({ error: "prompt must be a string when provided" });
    }
    if (!ctx.sessionManager.hasPlan(sessionId)) {
      return res.status(409).json({ error: "Session has no plan to run with Fleet" });
    }
    if (isRestartCutoverInProgress(await refreshRestartState())) {
      res.set("Retry-After", "5");
      return res.status(503).json({ error: RESTART_PENDING_MESSAGE });
    }
    if (ctx.sessionManager.isSessionBusy(sessionId)) {
      return res.status(429).json({ error: "Session is busy, please wait" });
    }

    const meta = ctx.sessionMetaStore.getMeta(sessionId);
    if (meta?.archived) {
      setSessionArchived(sessionId, false);
      console.log(`[web] [${sessionId.slice(0, 8)}] auto-unarchived (fleet run)`);
    }

    console.log(`[web] [${sessionId.slice(0, 8)}] starting Fleet${prompt?.trim() ? `: "${prompt.trim().slice(0, 80)}"` : ""}`);

    try {
      ctx.sessionManager.startFleet(sessionId, prompt);
      res.status(202).json({ status: "accepted" });
    } catch (err) {
      if (isRestartPendingError(err)) {
        res.set("Retry-After", "5");
        return res.status(503).json({ error: RESTART_PENDING_MESSAGE });
      }
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/sessions/:sessionId/user-input/:requestId/respond", async (req, res) => {
    try {
      const response = await ctx.sessionManager.submitUserInputResponse(
        req.params.sessionId,
        req.params.requestId,
        req.body,
      );
      res.json(response);
    } catch (err) {
      if (err instanceof UserInputBrokerError) {
        return res.status(err.statusCode).json({ error: err.message, code: err.code });
      }
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // POST /sessions/:id/abort — abort an in-progress session turn
  router.post("/sessions/:id/abort", async (req, res) => {
    const sessionId = req.params.id;
    try {
      const aborted = await ctx.sessionManager.abortSession(sessionId);
      if (aborted) {
        res.json({ status: "aborted" });
      } else {
        res.status(409).json({ error: "Session is not busy" });
      }
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /sessions/:id/stream — SSE stream with snapshot + live events
  router.get("/sessions/:id/stream", (req, res) => {
    const sessionId = req.params.id;
    const streamStart = Date.now();
    let firstEventSent = false;

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    let closed = false;
    let unsub: (() => void) | null = null;

    // SSE heartbeat — keeps connection alive through proxies/tunnels
    const heartbeat = setInterval(() => {
      if (closed || res.writableEnded) return;
      try {
        res.write(`: heartbeat\n\n`);
      } catch {
        close();
      }
    }, 15_000);

    const close = () => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      if (unsub) unsub();
      if (!res.writableEnded) res.end();
    };

    const sendEvent = (event: any) => {
      if (closed || res.writableEnded) return;
      const normalized = event.type === "snapshot" && event.complete
        ? event.terminalType === "error" || event.errorMessage
          ? { type: "error", message: event.errorMessage ?? "Unknown session error", timestamp: event.terminalTimestamp, turnId: event.turnId }
          : event.terminalType === "aborted"
            ? { type: "aborted", content: event.finalContent, timestamp: event.terminalTimestamp, turnId: event.turnId }
            : event.terminalType === "shutdown"
              ? { type: "shutdown", content: event.finalContent, timestamp: event.terminalTimestamp, turnId: event.turnId }
            : { type: "done", content: event.finalContent, timestamp: event.terminalTimestamp, turnId: event.turnId }
        : event;
      if (!firstEventSent) {
        firstEventSent = true;
        ctx.telemetryStore?.recordSpan({
          name: "sse.firstEvent",
          sessionId,
          duration: Date.now() - streamStart,
          metadata: { eventType: normalized.type },
          source: "server",
        });
      }
      try {
        res.write(`data: ${JSON.stringify(normalized)}\n\n`);
      } catch {
        close();
        return;
      }
      if (normalized.type === "done" || normalized.type === "error" || normalized.type === "aborted" || normalized.type === "shutdown") {
        close();
      }
    };

    const attachToBus = (targetBus: NonNullable<typeof bus>) => {
      unsub = targetBus.subscribe(sendEvent);
    };

    // Prevent unhandled 'error' events on the response from crashing the process
    res.on("error", () => { close(); });
    req.on("close", () => { close(); });

    const bus = ctx.eventBusRegistry.getBus(sessionId);

    if (!bus) {
      if (ctx.sessionManager.isSessionBusy(sessionId)) {
        sendEvent({ type: "thinking" });
        // Poll for bus — it should appear shortly after POST /api/chat
        const pollStart = Date.now();
        const waitForBus = setInterval(() => {
          if (closed) { clearInterval(waitForBus); return; }
          const newBus = ctx.eventBusRegistry.getBus(sessionId);
          if (newBus) {
            clearInterval(waitForBus);
            attachToBus(newBus);
          } else if (Date.now() - pollStart > 10_000) {
            clearInterval(waitForBus);
            sendEvent({ type: "error", message: "Timed out waiting for session to start" });
          }
        }, 500);
      } else {
        sendEvent({ type: "idle" });
        close();
      }
      return;
    }

    // Subscribe — sends snapshot then streams live events
    attachToBus(bus);
  });

  // GET /sessions/:id/plan — read plan.md from session state directory
  router.get("/sessions/:id/plan", (_req, res) => {
    const sessionId = _req.params.id;
    const planPath = join(getCopilotHome(ctx), "session-state", sessionId, "plan.md");

    try {
      if (!existsSync(planPath)) {
        return res.json({ content: null, lastModified: null });
      }
      const content = readFileSync(planPath, "utf-8");
      const lastModified = statSync(planPath).mtime.toISOString();
      res.json({ content, lastModified });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /sessions/:id/mcp-status — get MCP server connection status for a session
  router.get("/sessions/:id/mcp-status", async (req, res) => {
    try {
      const servers = await ctx.sessionManager.getMcpStatus(req.params.id);
      res.json({ servers });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });
  // POST /sessions/:id/mcp-login - begin OAuth for a remote MCP server attached to this session
  router.post("/sessions/:id/mcp-login", async (req, res) => {
    if (!isRecord(req.body)) return res.status(400).json({ error: "request body is required" });
    const { serverName, forceReauth } = req.body;
    if (typeof serverName !== "string" || !serverName.trim()) {
      return res.status(400).json({ error: "serverName is required" });
    }
    if (forceReauth !== undefined && typeof forceReauth !== "boolean") {
      return res.status(400).json({ error: "forceReauth must be a boolean" });
    }

    try {
      const result = await ctx.sessionManager.loginMcpServer(req.params.id, serverName, { forceReauth });
      res.json(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (/busy session/i.test(message)) return res.status(409).json({ error: message });
      if (/not configured for this session/i.test(message)) return res.status(404).json({ error: message });
      res.status(500).json({ error: message });
    }
  });


  // PATCH /sessions/:id — update session metadata (archive/unarchive)
  router.patch("/sessions/:id", (req, res) => {
    const { archived } = req.body;
    if (typeof archived !== "boolean") {
      return res.status(400).json({ error: "archived (boolean) is required" });
    }
    try {
      setSessionArchived(req.params.id, archived);
      res.json({ ok: true, archived });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.get("/sessions/:id/workspace", async (req, res) => {
    try {
      const task = resolveWorkspaceTask(ctx, req.params.id, typeof req.query.taskId === "string" ? req.query.taskId : undefined);
      res.json(await buildSessionWorkspaceDetails(ctx, req.params.id, task));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(message === "Task not found" ? 404 : 400).json({ error: message });
    }
  });

  router.put("/sessions/:id/workspace/path", async (req, res) => {
    const cwd = normalizeWorkspacePath(req.body?.cwd);
    if (!cwd) {
      return res.status(400).json({ error: "cwd is required" });
    }
    if (ctx.sessionManager.isSessionBusy(req.params.id)) {
      return res.status(409).json({ error: SESSION_WORKSPACE_BUSY_ERROR });
    }
    try {
      const task = resolveWorkspaceTask(ctx, req.params.id, typeof req.query.taskId === "string" ? req.query.taskId : undefined);
      ctx.sessionManager.setSessionWorkspace(req.params.id, cwd);
      invalidateEnrichedCache("route:session-workspace:set");
      res.json(await buildSessionWorkspaceDetails(ctx, req.params.id, task));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(message === "Task not found" ? 404 : 400).json({ error: message });
    }
  });

  router.put("/sessions/:id/workspace/worktree", async (req, res) => {
    const cwd = normalizeWorkspacePath(req.body?.cwd);
    if (!cwd) {
      return res.status(400).json({ error: "cwd is required" });
    }
    if (ctx.sessionManager.isSessionBusy(req.params.id)) {
      return res.status(409).json({ error: SESSION_WORKSPACE_BUSY_ERROR });
    }
    try {
      const task = resolveWorkspaceTask(ctx, req.params.id, typeof req.query.taskId === "string" ? req.query.taskId : undefined);
      const details = await buildSessionWorkspaceDetails(ctx, req.params.id, task);
      if (details.availableWorktrees.length === 0) {
        return res.status(409).json({ error: SESSION_WORKTREE_SELECTION_UNAVAILABLE_ERROR });
      }
      const requestedCwd = normalizeWorkspacePathForComparison(cwd);
      const matchesKnownWorktree = details.availableWorktrees.some((worktree) =>
        normalizeWorkspacePathForComparison(worktree.cwd) === requestedCwd);
      if (!matchesKnownWorktree) {
        return res.status(400).json({ error: SESSION_WORKTREE_SELECTION_INVALID_ERROR });
      }
      ctx.sessionManager.setSessionWorkspace(req.params.id, cwd);
      invalidateEnrichedCache("route:session-workspace:set-worktree");
      res.json(await buildSessionWorkspaceDetails(ctx, req.params.id, task));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(message === "Task not found" ? 404 : 400).json({ error: message });
    }
  });

  router.delete("/sessions/:id/workspace", async (req, res) => {
    if (ctx.sessionManager.isSessionBusy(req.params.id)) {
      return res.status(409).json({ error: SESSION_WORKSPACE_BUSY_ERROR });
    }
    try {
      const requestedTaskId = typeof req.query.taskId === "string" ? req.query.taskId : undefined;
      const task = resolveWorkspaceTask(ctx, req.params.id, requestedTaskId);
      if (requestedTaskId) {
        const taskCwd = normalizeWorkspacePath(task?.cwd);
        if (!taskCwd) {
          return res.status(409).json({ error: SESSION_WORKSPACE_RESET_NOT_CONFIGURED_ERROR });
        }
        ctx.sessionManager.resetSessionWorkspace(req.params.id, { taskId: requestedTaskId, taskCwd });
      } else {
        ctx.sessionManager.resetSessionWorkspace(req.params.id);
      }
      invalidateEnrichedCache("route:session-workspace:reset");
      res.json(await buildSessionWorkspaceDetails(ctx, req.params.id, task));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(message === "Task not found" ? 404 : 400).json({ error: message });
    }
  });

  // DELETE /sessions/:id — permanently delete a session
  router.delete("/sessions/:id", async (req, res) => {
    const sessionId = req.params.id;
    try {
      await ctx.sessionManager.deleteSession(sessionId);
      invalidateEnrichedCache("route:session:delete");
      ctx.sessionMetaStore.deleteMeta(sessionId);
      // Unlink from any tasks that reference this session
      const tasks = ctx.taskStore.listTasks();
      for (const task of tasks) {
        if (task.sessionIds.includes(sessionId)) {
          ctx.taskStore.unlinkSession(task.id, sessionId);
        }
      }
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /sessions/batch — bulk actions on multiple sessions
  router.post("/sessions/batch", async (req, res) => {
    const { action, sessionIds } = req.body;
    const validActions = ["archive", "unarchive", "delete", "markRead"];
    if (!validActions.includes(action)) {
      return res.status(400).json({ error: `action must be one of: ${validActions.join(", ")}` });
    }
    if (!Array.isArray(sessionIds) || sessionIds.length === 0) {
      return res.status(400).json({ error: "sessionIds array is required" });
    }
    const errors: Record<string, string> = {};
    for (const sid of sessionIds) {
      try {
        switch (action) {
          case "archive":
            setSessionArchived(sid, true);
            break;
          case "unarchive":
            setSessionArchived(sid, false);
            break;
          case "delete": {
            await ctx.sessionManager.deleteSession(sid);
            invalidateEnrichedCache("route:session-batch:delete");
            ctx.sessionMetaStore.deleteMeta(sid);
            const tasks = ctx.taskStore.listTasks();
            for (const task of tasks) {
              if (task.sessionIds.includes(sid)) {
                ctx.taskStore.unlinkSession(task.id, sid);
              }
            }
            break;
          }
          case "markRead":
            ctx.readStateStore.markRead(sid, resolveReadThroughActivityAt(sid));
            break;
        }
      } catch (err) {
        errors[sid] = String(err);
      }
    }
    if (action === "markRead" && sessionIds.length > 0) {
      ctx.globalBus.emit({ type: "readstate:changed", readState: ctx.readStateStore.getReadState() });
    }
    res.json({ ok: Object.keys(errors).length === 0, errors });
  });

  // ── Task Group routes ─────────────────────────────────────────────

  router.get("/task-groups", (_req, res) => {
    const groups = ctx.taskGroupStore.listGroups();
    const groupsWithTags = groups.map((g) => ({
      ...g,
      tags: ctx.tagStore?.getEntityTags("task_group", g.id) ?? [],
    }));
    res.json({ groups: groupsWithTags });
  });

  router.post("/task-groups", (req, res) => {
    const { name, color } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });
    try {
      const group = ctx.taskGroupStore.createGroup(name, color);
      res.json({ group });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  router.patch("/task-groups/:id", (req, res) => {
    try {
      const group = ctx.taskGroupStore.updateGroup(req.params.id, req.body);
      const tags = ctx.tagStore?.getEntityTags("task_group", group.id) ?? [];
      res.json({ group: { ...group, tags } });
    } catch (err) {
      res.status(404).json({ error: String(err) });
    }
  });

  router.delete("/task-groups/:id", (req, res) => {
    // Ungroup any tasks that belong to this group
    const tasks = ctx.taskStore.listTasks().filter((t) => t.groupId === req.params.id);
    for (const t of tasks) ctx.taskStore.updateTask(t.id, { groupId: undefined });
    ctx.tagStore?.setEntityTags("task_group", req.params.id, []);
    ctx.taskGroupStore.deleteGroup(req.params.id);
    res.json({ success: true });
  });

  router.put("/task-groups/reorder", (req, res) => {
    const { groupIds } = req.body;
    if (!Array.isArray(groupIds)) return res.status(400).json({ error: "groupIds array is required" });
    try {
      const groups = ctx.taskGroupStore.reorderGroups(groupIds);
      res.json({ groups });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  // ── MCP server registry routes ───────────────────────────────────

  const getMcpServerStore = () => ctx.mcpServerStore ?? ctx.settingsStore.getMcpServerStore();

  router.get("/mcp-servers", (_req, res) => {
    const mcpServerStore = getMcpServerStore();
    if (!mcpServerStore) return res.status(501).json({ error: "MCP server registry not available" });
    res.json({ servers: mcpServerStore.listMcpServers() });
  });

  router.post("/mcp-servers", (req, res) => {
    const mcpServerStore = getMcpServerStore();
    if (!mcpServerStore) return res.status(501).json({ error: "MCP server registry not available" });
    if (!isRecord(req.body)) return res.status(400).json({ error: "request body is required" });
    const { name, config, enabledByDefault } = req.body;
    if (typeof name !== "string") return res.status(400).json({ error: "name is required" });
    if (enabledByDefault !== undefined && typeof enabledByDefault !== "boolean") {
      return res.status(400).json({ error: "enabledByDefault must be a boolean" });
    }

    try {
      const server = mcpServerStore.createMcpServer({ name, config: config as McpServerConfig, enabledByDefault });
      console.log("[mcp] MCP server registry changed — evicting cached sessions");
      ctx.sessionManager.evictAllCachedSessions();
      res.status(201).json({ server });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.patch("/mcp-servers/:id", (req, res) => {
    const mcpServerStore = getMcpServerStore();
    if (!mcpServerStore) return res.status(501).json({ error: "MCP server registry not available" });
    if (!isRecord(req.body)) return res.status(400).json({ error: "request body is required" });

    const updates: { name?: string; config?: McpServerConfig; enabledByDefault?: boolean } = {};
    if ("name" in req.body) {
      if (typeof req.body.name !== "string") return res.status(400).json({ error: "name must be a string" });
      updates.name = req.body.name;
    }
    if ("config" in req.body) updates.config = req.body.config as McpServerConfig;
    if ("enabledByDefault" in req.body) {
      if (typeof req.body.enabledByDefault !== "boolean") {
        return res.status(400).json({ error: "enabledByDefault must be a boolean" });
      }
      updates.enabledByDefault = req.body.enabledByDefault;
    }

    try {
      const server = mcpServerStore.updateMcpServer(req.params.id, updates);
      console.log("[mcp] MCP server registry changed — evicting cached sessions");
      ctx.sessionManager.evictAllCachedSessions();
      res.json({ server });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(/not found/i.test(message) ? 404 : 400).json({ error: message });
    }
  });

  router.delete("/mcp-servers/:id", (req, res) => {
    const mcpServerStore = getMcpServerStore();
    if (!mcpServerStore) return res.status(501).json({ error: "MCP server registry not available" });
    if (!mcpServerStore.getMcpServer(req.params.id)) {
      return res.status(404).json({ error: "MCP server not found" });
    }

    ctx.tagStore?.removeTagMcpServerRefsByServerId(req.params.id);
    mcpServerStore.deleteMcpServer(req.params.id);
    console.log("[mcp] MCP server registry changed — evicting cached sessions");
    ctx.sessionManager.evictAllCachedSessions();
    res.json({ success: true });
  });

  // ── Tag routes ──────────────────────────────────────────────────

  router.get("/tags", (_req, res) => {
    res.json({ tags: ctx.tagStore?.listTags() ?? [] });
  });

  router.post("/tags", (req, res) => {
    if (!ctx.tagStore) return res.status(501).json({ error: "Tags not available" });
    const { name, color } = req.body;
    if (!name) return res.status(400).json({ error: "name is required" });
    try {
      const tag = ctx.tagStore.createTag(name, color);
      res.json({ tag });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  router.patch("/tags/:id", (req, res) => {
    if (!ctx.tagStore) return res.status(501).json({ error: "Tags not available" });
    try {
      // Capture old name before update for doc tag rename propagation
      const oldTag = ctx.tagStore.getTag(req.params.id);
      const tag = ctx.tagStore.updateTag(req.params.id, req.body);

      // Propagate tag rename to doc frontmatter
      if (req.body.name !== undefined && oldTag && oldTag.name !== tag.name && ctx.docsStore) {
        const updated = ctx.docsStore.renameTagInDocs(oldTag.name, tag.name);
        if (updated > 0) {
          console.log(`[tags] Renamed tag in ${updated} doc(s): "${oldTag.name}" → "${tag.name}"`);
          ctx.docsIndex?.reindex();
        }
      }

      // Evict cached sessions if name or instructions changed
      if (req.body.instructions !== undefined || req.body.name !== undefined) {
        console.log("[tags] Tag changed — evicting cached sessions");
        ctx.sessionManager.evictAllCachedSessions();
      }
      res.json({ tag });
    } catch (err) {
      res.status(404).json({ error: String(err) });
    }
  });

  router.delete("/tags/:id", (req, res) => {
    if (!ctx.tagStore) return res.status(501).json({ error: "Tags not available" });
    ctx.tagStore.deleteTag(req.params.id);
    console.log("[tags] Tag deleted — evicting cached sessions");
    ctx.sessionManager.evictAllCachedSessions();
    res.json({ success: true });
  });

  router.put("/tags/reorder", (req, res) => {
    if (!ctx.tagStore) return res.status(501).json({ error: "Tags not available" });
    const { tagIds } = req.body;
    if (!Array.isArray(tagIds)) return res.status(400).json({ error: "tagIds array is required" });
    try {
      const tags = ctx.tagStore.reorderTags(tagIds);
      res.json({ tags });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  // Tag MCP servers
  router.get("/tags/:id/mcp", (req, res) => {
    if (!ctx.tagStore) return res.status(501).json({ error: "Tags not available" });
    res.json({ servers: ctx.tagStore.getTagMcpServers(req.params.id) });
  });

  const replaceTagMcpServerSelection = (req: express.Request<{ id: string }>, res: express.Response) => {
    if (!ctx.tagStore) return res.status(501).json({ error: "Tags not available" });
    const serverIds = isRecord(req.body) ? req.body.serverIds : undefined;
    if (!Array.isArray(serverIds) || !serverIds.every((serverId) => typeof serverId === "string")) {
      return res.status(400).json({ error: "serverIds array is required" });
    }
    try {
      const servers = ctx.tagStore.replaceTagMcpServerRefs(req.params.id, serverIds);
      console.log("[tags] Tag MCP server selection changed — evicting cached sessions");
      ctx.sessionManager.evictAllCachedSessions();
      res.json({ servers });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  };

  router.put("/tags/:id/mcp", replaceTagMcpServerSelection);
  router.put("/tags/:id/mcp-servers", replaceTagMcpServerSelection);

  router.post("/tags/:id/mcp-refs/:serverId", (req, res) => {
    if (!ctx.tagStore) return res.status(501).json({ error: "Tags not available" });
    try {
      const server = ctx.tagStore.addTagMcpServerRef(req.params.id, req.params.serverId);
      console.log("[tags] Tag MCP server selection changed — evicting cached sessions");
      ctx.sessionManager.evictAllCachedSessions();
      res.json({ server });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  router.delete("/tags/:id/mcp-refs/:serverId", (req, res) => {
    if (!ctx.tagStore) return res.status(501).json({ error: "Tags not available" });
    ctx.tagStore.removeTagMcpServerRef(req.params.id, req.params.serverId);
    console.log("[tags] Tag MCP server selection changed — evicting cached sessions");
    ctx.sessionManager.evictAllCachedSessions();
    res.json({ success: true });
  });

  router.put("/tags/:id/mcp/:serverName", (req, res) => {
    if (!ctx.tagStore) return res.status(501).json({ error: "Tags not available" });
    try {
      ctx.tagStore.setTagMcpServer(req.params.id, req.params.serverName, req.body);
      console.log("[tags] Tag MCP server changed — evicting cached sessions");
      ctx.sessionManager.evictAllCachedSessions();
      res.json({ success: true });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  router.delete("/tags/:id/mcp/:serverName", (req, res) => {
    if (!ctx.tagStore) return res.status(501).json({ error: "Tags not available" });
    ctx.tagStore.removeTagMcpServer(req.params.id, req.params.serverName);
    console.log("[tags] Tag MCP server removed — evicting cached sessions");
    ctx.sessionManager.evictAllCachedSessions();
    res.json({ success: true });
  });

  // Related docs by tag
  router.get("/tags/related-docs", (req, res) => {
    if (!ctx.tagStore || !ctx.docsIndex) return res.json({ docs: [] });
    const tagIds = (req.query.tags as string || "").split(",").filter(Boolean);
    if (tagIds.length === 0) return res.json({ docs: [] });
    const tagNames = tagIds
      .map((id) => ctx.tagStore!.getTag(id))
      .filter(Boolean)
      .map((t) => t!.name);
    const docs = ctx.docsIndex.findDocsByTagNames(tagNames);
    res.json({ docs });
  });

  // Set tags on a task
  router.put("/tasks/:id/tags", (req, res) => {
    if (!ctx.tagStore) return res.status(501).json({ error: "Tags not available" });
    const { tagIds } = req.body;
    if (!Array.isArray(tagIds)) return res.status(400).json({ error: "tagIds array is required" });
    try {
      ctx.tagStore.setEntityTags("task", req.params.id, tagIds);
      const tags = ctx.tagStore.getEntityTags("task", req.params.id);
      console.log("[tags] Task tags changed — evicting cached sessions");
      ctx.sessionManager.evictAllCachedSessions();
      res.json({ tags });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  // Set tags on a task group
  router.put("/task-groups/:id/tags", (req, res) => {
    if (!ctx.tagStore) return res.status(501).json({ error: "Tags not available" });
    const { tagIds } = req.body;
    if (!Array.isArray(tagIds)) return res.status(400).json({ error: "tagIds array is required" });
    try {
      ctx.tagStore.setEntityTags("task_group", req.params.id, tagIds);
      const tags = ctx.tagStore.getEntityTags("task_group", req.params.id);
      console.log("[tags] Group tags changed — evicting cached sessions");
      ctx.sessionManager.evictAllCachedSessions();
      res.json({ tags });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  // ── Task routes ───────────────────────────────────────────────────

  router.get("/tasks", (_req, res) => {
    const tasks = ctx.taskStore.listTasks();
    const tasksWithTags = tasks.map((t) => ({
      ...t,
      tags: ctx.tagStore?.getEntityTags("task", t.id) ?? [],
    }));
    res.json({ tasks: tasksWithTags });
  });

  router.put("/tasks/reorder", (req, res) => {
    const { taskIds } = req.body;
    if (!Array.isArray(taskIds)) return res.status(400).json({ error: "taskIds array is required" });
    try {
      const tasks = ctx.taskStore.reorderTasks(taskIds);
      res.json({ tasks });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  router.post("/tasks", (req, res) => {
    const { title, groupId, kind } = req.body;
    if (!title) return res.status(400).json({ error: "title is required" });
    try {
      const task = ctx.taskStore.createTask(title, groupId, kind);
      res.json({ task });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(err instanceof InvalidTaskUpdateError ? 400 : 500).json({ error: message });
    }
  });

  router.get("/tasks/:id", (req, res) => {
    const task = ctx.taskStore.getTask(req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });
    const tags = ctx.tagStore?.getEntityTags("task", task.id) ?? [];
    res.json({ task: { ...task, tags } });
  });

  router.get("/tasks/:id/git-status", async (req, res) => {
    const task = ctx.taskStore.getTask(req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });
    const taskCwd = task.cwd?.trim();
    if (!taskCwd) {
      return res.json({
        status: "not_configured",
        error: TASK_GIT_STATUS_NOT_CONFIGURED_ERROR,
      });
    }

    try {
      const forceRefresh = req.query.refresh === "1" || req.query.refresh === "true";
      res.json(await readCachedGitWorktreeStatus(taskCwd, { forceRefresh }));
    } catch (error) {
      res.json({
        status: "unavailable",
        cwd: taskCwd,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  // Enriched task data — fetches work item + PR metadata from configured providers
  router.get("/tasks/:id/enriched", async (req, res) => {
    const task = ctx.taskStore.getTask(req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });

    try {
      const [workItems, pullRequests] = await Promise.all([
        enrichWorkItems(task.workItems),
        enrichPullRequests(task.pullRequests),
      ]);
      res.json({ task, workItems, pullRequests });
    } catch (err) {
      console.error("[enriched] Error:", err);
      res.json({ task, workItems: [], pullRequests: [] });
    }
  });

  router.get("/tasks/:id/session-storage", (req, res) => {
    try {
      const task = ctx.taskStore.getTask(req.params.id);
      if (!task) return res.status(404).json({ error: "Task not found" });

      const sessionStateDir = join(getCopilotHome(ctx), "session-state");
      const sessions = task.sessionIds.map((sessionId) => {
        const diskSizeBytes = isCanonicalSessionId(sessionId)
          ? getDirSize(join(sessionStateDir, sessionId))
          : 0;
        return { sessionId, diskSizeBytes };
      });
      const totalDiskSizeBytes = sessions.reduce((sum, session) => sum + session.diskSizeBytes, 0);
      res.json({ taskId: task.id, totalDiskSizeBytes, sessions });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.patch("/tasks/:id", (req, res) => {
    try {
      const task = ctx.taskStore.updateTask(req.params.id, {
        title: req.body?.title,
        kind: req.body?.kind,
        muted: req.body?.muted,
        status: req.body?.status,
        completionAction: req.body?.completionAction,
        notes: req.body?.notes,
        priority: req.body?.priority,
        cwd: req.body?.cwd,
        groupId: req.body?.groupId,
        doneWhen: req.body?.doneWhen,
        nextAction: req.body?.nextAction,
        waitingOn: req.body?.waitingOn,
        nextTouchAt: req.body?.nextTouchAt,
      });
      res.json({ task });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const status = err instanceof InvalidTaskUpdateError
        ? 400
        : /Task .* not found/.test(message)
          ? 404
          : 400;
      res.status(status).json({ error: message });
    }
  });

  router.delete("/tasks/:id", (req, res) => {
    ctx.tagStore?.setEntityTags("task", req.params.id, []);
    ctx.taskStore.deleteTask(req.params.id);
    res.json({ ok: true });
  });

  router.post("/tasks/:id/link", (req, res) => {
    const { type, sessionId, workItemId, provider, repoId, repoName, prId } = req.body;
    try {
      let task;
      switch (type) {
        case "session":
          task = ctx.taskStore.linkSession(req.params.id, sessionId);
          break;
        case "workItem":
          task = ctx.taskStore.linkWorkItem(req.params.id, String(workItemId), provider ?? "ado");
          break;
        case "pr":
          task = ctx.taskStore.linkPR(req.params.id, { repoId, repoName, prId: Number(prId), provider: provider ?? "ado" });
          break;
        default:
          return res.status(400).json({ error: `Unknown link type: ${type}` });
      }
      res.json({ task });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  router.delete("/tasks/:id/link", (req, res) => {
    const { type, sessionId, workItemId, provider, repoId, prId } = req.body;
    try {
      let task;
      switch (type) {
        case "session":
          task = ctx.taskStore.unlinkSession(req.params.id, sessionId);
          break;
        case "workItem":
          task = ctx.taskStore.unlinkWorkItem(req.params.id, String(workItemId), provider);
          break;
        case "pr":
          task = ctx.taskStore.unlinkPR(req.params.id, repoId, Number(prId), provider);
          break;
        default:
          return res.status(400).json({ error: `Unknown link type: ${type}` });
      }
      res.json({ task });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  // Create a session linked to a task with pre-loaded context
  router.post("/tasks/:id/session", async (req, res) => {
    const task = ctx.taskStore.getTask(req.params.id);
    if (!task) return res.status(404).json({ error: "Task not found" });

    try {
      if (isRestartCutoverInProgress(await refreshRestartState())) {
        return res.status(503).json({ error: RESTART_PENDING_MESSAGE });
      }
      const prDescriptions = task.pullRequests.map(
        (pr) => `${pr.repoName || pr.repoId} PR #${pr.prId}`,
      );
      const group = task.groupId ? ctx.taskGroupStore.getGroup(task.groupId) : undefined;
      const groupNotes = group?.notes?.trim() ? { groupName: group.name, notes: group.notes } : null;
      const result = await ctx.sessionManager.createTaskSession(
        task.id,
        task.title,
        task.workItems,
        prDescriptions,
        task.notes,
        task.cwd,
        undefined,
        groupNotes,
      );
      invalidateEnrichedCache("route:task-session:create");

      // Auto-link session to task
      ctx.taskStore.linkSession(task.id, result.sessionId);

      res.json(result);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Checklist routes ─────────────────────────────────────────────

  function sendChecklistError(res: express.Response, error: unknown): void {
    if (error instanceof ChecklistValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    if (error instanceof ChecklistNotFoundError) {
      res.status(404).json({ error: error.message });
      return;
    }
    console.error("[checklist] Error:", error);
    res.status(500).json({ error: error instanceof Error ? error.message : String(error) });
  }

  router.get("/tasks/:taskId/checklist-items", (req, res) => {
    res.json({ checklistItems: ctx.checklistStore.listChecklistItems(req.params.taskId) });
  });

  router.post("/tasks/:taskId/checklist-items", (req, res) => {
    try {
      const { text, deadline } = normalizeChecklistItemCreate(req.body);
      const checklistItem = ctx.checklistStore.createChecklistItem(req.params.taskId, text, deadline);
      res.json({ checklistItem });
    } catch (err) {
      sendChecklistError(res, err);
    }
  });

  router.post("/checklist-items", (req, res) => {
    try {
      const { text, deadline } = normalizeChecklistItemCreate(req.body);
      const checklistItem = ctx.checklistStore.createChecklistItem(null, text, deadline);
      res.json({ checklistItem });
    } catch (err) {
      sendChecklistError(res, err);
    }
  });

  router.patch("/checklist-items/:id", (req, res) => {
    try {
      const updates = normalizeChecklistItemUpdate(req.body);
      const checklistItem = ctx.checklistStore.updateChecklistItem(req.params.id, updates);
      res.json({ checklistItem });
    } catch (err) {
      sendChecklistError(res, err);
    }
  });

  router.delete("/checklist-items/:id", (req, res) => {
    try {
      ctx.checklistStore.deleteChecklistItem(req.params.id);
      res.json({ ok: true });
    } catch (err) {
      sendChecklistError(res, err);
    }
  });

  router.put("/tasks/:taskId/checklist-items/reorder", (req, res) => {
    const { checklistItemIds } = req.body;
    if (!Array.isArray(checklistItemIds)) return res.status(400).json({ error: "checklistItemIds array is required" });
    const checklistItems = ctx.checklistStore.reorderChecklistItems(req.params.taskId, checklistItemIds);
    res.json({ checklistItems });
  });

  router.get("/checklist-items/open", (_req, res) => {
    res.json({ checklistItems: ctx.checklistStore.listAllOpenChecklistItems() });
  });

  // ── Feed card routes ──────────────────────────────────────────────

  function parseFeedBody(body: unknown): Record<string, unknown> {
    if (!isRecord(body)) throw new FeedCardValidationError("Request body must be an object");
    return body;
  }

  function parseFeedQueryString(field: string, value: unknown): string | undefined {
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value !== "string") throw new FeedCardValidationError(`${field} must be a string`);
    return value;
  }

  function parseFeedStatus(value: unknown): FeedCardStatus | undefined {
    const status = parseFeedQueryString("status", value);
    if (status === undefined) return undefined;
    if (status === "active" || status === "done" || status === "dismissed") return status;
    throw new FeedCardValidationError("status must be one of: active, done, dismissed");
  }

  function parseFeedLimit(value: unknown): number | undefined {
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value !== "string") throw new FeedCardValidationError("limit must be a positive integer");
    const limit = Number(value);
    if (!Number.isInteger(limit) || limit < 1) throw new FeedCardValidationError("limit must be a positive integer");
    return limit;
  }

  function parseFeedBoolean(field: string, value: unknown): boolean | undefined {
    if (value === undefined || value === null || value === "") return undefined;
    if (value === "true") return true;
    if (value === "false") return false;
    throw new FeedCardValidationError(`${field} must be true or false`);
  }

  function sendFeedError(res: express.Response, error: unknown): void {
    if (error instanceof FeedCardValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    if (error instanceof FeedCardNotFoundError) {
      res.status(404).json({ error: error.message });
      return;
    }
    console.error("[feed] Error:", error);
    res.status(500).json({ error: String(error) });
  }

  router.get("/feed", (req, res) => {
    try {
      const t0 = Date.now();
      const cards = ctx.feedStore.listCards({
        status: parseFeedStatus(req.query.status),
        kind: parseFeedQueryString("kind", req.query.kind),
        taskId: parseFeedQueryString("taskId", req.query.taskId),
        sessionId: parseFeedQueryString("sessionId", req.query.sessionId),
        limit: parseFeedLimit(req.query.limit),
        includeDismissed: parseFeedBoolean("includeDismissed", req.query.includeDismissed),
      });
      res.json({ cards });
      ctx.telemetryStore?.recordSpan({ name: "feed.list", duration: Date.now() - t0, source: "server" });
    } catch (error) {
      sendFeedError(res, error);
    }
  });

  router.post("/feed", (req, res) => {
    try {
      const t0 = Date.now();
      const result = ctx.feedStore.saveCard(parseFeedBody(req.body));
      res.status(result.created ? 201 : 200).json(result);
      ctx.telemetryStore?.recordSpan({ name: "feed.save", duration: Date.now() - t0, source: "server" });
    } catch (error) {
      sendFeedError(res, error);
    }
  });

  router.patch("/feed/:id", (req, res) => {
    try {
      const t0 = Date.now();
      const card = ctx.feedStore.updateCardById(req.params.id, parseFeedBody(req.body));
      res.json({ card });
      ctx.telemetryStore?.recordSpan({ name: "feed.update", duration: Date.now() - t0, source: "server" });
    } catch (error) {
      sendFeedError(res, error);
    }
  });

  function getFeedVisualOwner(req: express.Request, res: express.Response): VisualArtifactOwner | undefined {
    const cardId = String(req.params.id ?? "").trim();
    const artifactId = String(req.params.artifactId ?? "").trim();
    if (!isCanonicalArtifactId(cardId)) {
      res.status(400).json({ error: "Feed card id must be a valid UUID" });
      return undefined;
    }
    if (!isCanonicalArtifactId(artifactId)) {
      res.status(400).json({ error: "artifactId must be a valid UUID" });
      return undefined;
    }
    const card = ctx.feedStore.getCard(cardId);
    if (!card || card.visual?.artifactId !== artifactId) {
      res.status(404).json({ error: "Feed visual artifact not found" });
      return undefined;
    }
    return feedCardVisualOwner(cardId);
  }

  router.get("/feed/:id/visuals/:artifactId", (req, res) => {
    const owner = getFeedVisualOwner(req, res);
    if (!owner) return;
    return sendVisualArtifact(owner, req.params.artifactId, res, "inline");
  });

  router.get("/feed/:id/visuals/:artifactId/download", (req, res) => {
    const owner = getFeedVisualOwner(req, res);
    if (!owner) return;
    return sendVisualArtifact(owner, req.params.artifactId, res, "download");
  });

  router.get("/feed/:id/visuals/:artifactId/meta", (req, res) => {
    const owner = getFeedVisualOwner(req, res);
    if (!owner) return;
    return sendVisualMeta(owner, req.params.artifactId, res);
  });

  router.delete("/feed/:id", (req, res) => {
    try {
      const t0 = Date.now();
      const deleted = ctx.feedStore.deleteCardById(req.params.id);
      if (!deleted) throw new FeedCardNotFoundError(`Feed card ${req.params.id} not found`);
      res.json({ ok: true });
      ctx.telemetryStore?.recordSpan({ name: "feed.delete", duration: Date.now() - t0, source: "server" });
    } catch (error) {
      sendFeedError(res, error);
    }
  });

  // ── Read State routes ─────────────────────────────────────────────

  router.get("/read-state", (_req, res) => {
    res.json(ctx.readStateStore.getReadState());
  });

  function parseReadThroughActivityAt(raw: unknown): string | undefined {
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw !== "string") throw new Error("readThroughActivityAt must be an ISO timestamp");
    const time = Date.parse(raw);
    if (!Number.isFinite(time)) throw new Error("readThroughActivityAt must be an ISO timestamp");
    return new Date(time).toISOString();
  }

  function resolveReadThroughActivityAt(sessionId: string, requested?: string): string {
    const meta = ctx.sessionMetaStore.getMeta(sessionId);
    const latestActivityAt = maxIsoTime(meta?.lastVisibleActivityAt, meta?.lastAttentionAt);
    const latestActivityTime = latestActivityAt ? Date.parse(latestActivityAt) : Number.NaN;
    const latestActivity = Number.isFinite(latestActivityTime)
      ? new Date(latestActivityTime).toISOString()
      : undefined;

    if (!requested) return latestActivity ?? new Date().toISOString();

    const requestedTime = Date.parse(requested);
    if (latestActivity && Number.isFinite(latestActivityTime) && requestedTime > latestActivityTime) {
      return latestActivity;
    }

    const maxFutureSkewMs = 5_000;
    const maxAllowedTime = Date.now() + maxFutureSkewMs;
    return new Date(Math.min(requestedTime, maxAllowedTime)).toISOString();
  }

  router.post("/read-state/:sessionId", (req, res) => {
    let requestedReadThrough: string | undefined;
    try {
      const body = req.body && typeof req.body === "object" ? req.body as Record<string, unknown> : {};
      requestedReadThrough = parseReadThroughActivityAt(body.readThroughActivityAt);
    } catch (err) {
      return res.status(400).json({ error: err instanceof Error ? err.message : "Invalid readThroughActivityAt" });
    }

    const readThroughActivityAt = resolveReadThroughActivityAt(req.params.sessionId, requestedReadThrough);
    const ts = ctx.readStateStore.markRead(req.params.sessionId, readThroughActivityAt);
    ctx.globalBus.emit({ type: "readstate:changed", readState: ctx.readStateStore.getReadState() });
    res.json({ ok: true, lastReadAt: ts, readThroughActivityAt });
  });

  router.delete("/read-state/:sessionId", (req, res) => {
    ctx.readStateStore.markUnread(req.params.sessionId);
    ctx.globalBus.emit({ type: "readstate:changed", readState: ctx.readStateStore.getReadState() });
    res.json({ ok: true });
  });

  // ── Dashboard endpoint ───────────────────────────────────────────

  const buildDashboardChecklistData = (tasks: Task[] = ctx.taskStore.listTasks()): DashboardChecklistData => {
    if (!ctx.taskGroupStore || !ctx.checklistStore) {
      throw new Error("Dashboard checklist stores are not configured.");
    }

    const taskById = new Map(tasks.map((task) => [task.id, task]));
    const taskGroups = ctx.taskGroupStore.listGroups();
    const taskGroupOrderById = new Map(taskGroups.map((group) => [group.id, group.order]));

    const enrichChecklistItem = (checklistItem: ChecklistItem): DashboardChecklistItem => {
      const task = checklistItem.taskId ? taskById.get(checklistItem.taskId) : null;
      const taskGroupId = task?.groupId ?? null;
      const taskGroup = taskGroupId ? ctx.taskGroupStore?.getGroup(taskGroupId) : null;
      return {
        ...checklistItem,
        taskTitle: task?.title ?? (checklistItem.taskId ? "Unknown" : null),
        taskGroupColor: taskGroup?.color ?? null,
        taskOrder: task?.order ?? 0,
        taskStatus: task?.status ?? null,
        taskGroupId,
        taskGroupOrder: taskGroupId ? taskGroupOrderById.get(taskGroupId) ?? null : null,
      };
    };

    return {
      openChecklistItems: ctx.checklistStore.listAllOpenChecklistItems().map(enrichChecklistItem),
      completedChecklistItems: ctx.checklistStore.listRecentlyCompletedChecklistItems().map(enrichChecklistItem),
    };
  };

  router.get("/dashboard/checklist", (_req, res) => {
    try {
      const t0 = Date.now();
      res.json(buildDashboardChecklistData());
      ctx.telemetryStore?.recordSpan({ name: "dashboard.checklist", duration: Date.now() - t0, source: "server" });
    } catch (err) {
      console.error("[dashboard:checklist] Error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  router.get("/dashboard", async (_req, res) => {
    try {
      if (!ctx.taskGroupStore || !ctx.scheduleStore || !ctx.checklistStore) {
        throw new Error("Dashboard stores are not configured.");
      }
      const t0 = Date.now();
      const readState = ctx.readStateStore.getReadState();
      const tasks = ctx.taskStore.listTasks();
      const taskLookup = createSessionListTaskLookup(ctx, tasks);
      const taskSessionIds = new Set(tasks.flatMap((t) => t.sessionIds));

      const enrichedSessions = materializeSessionList(
        await getEnrichedSessionList(false),
        false,
        taskLookup,
      );

      const sessionById = new Map(enrichedSessions.map((s: any) => [s.sessionId, s]));

      // Helper: is session unread?
      const isUnread = (sessionId: string, activityTime?: string): boolean => {
        if (!activityTime) return false;
        const lastRead = readState[sessionId];
        if (!lastRead) return true;
        return new Date(activityTime).getTime() > new Date(lastRead).getTime();
      };
      // Busy sessions
      const busySessions = enrichedSessions
        .filter((s: any) => s.busy)
        .map((s: any) => {
          const taskId = taskLookup.resolveTask(s.sessionId)?.id;
          const bus = ctx.eventBusRegistry.getBus(s.sessionId);
          return {
            sessionId: s.sessionId,
            title: s.summary,
            taskId: taskId ?? null,
            intentText: bus?.getIntentText() ?? null,
            runState: s.runState,
            busy: s.busy,
          };
        });

      // Active tasks with enrichment
      const activeTasks = tasks.filter((t) => t.status === "active");

      // Batch-fetch all work items across all active tasks
      const allWorkItemRefs = activeTasks.flatMap((t) => t.workItems);
      const uniqueWIRefs = allWorkItemRefs.filter((ref, i, arr) =>
        arr.findIndex((r) => r.id === ref.id && r.provider === ref.provider) === i,
      );
      const allPRs = activeTasks.flatMap((t) => t.pullRequests);
      const uniquePRs = allPRs.filter((pr, i, arr) =>
        arr.findIndex((p) => p.repoId === pr.repoId && p.prId === pr.prId && p.provider === pr.provider) === i,
      );

      const [allWorkItems, allEnrichedPRs] = await Promise.all([
        enrichWorkItems(uniqueWIRefs),
        enrichPullRequests(uniquePRs),
      ]);

      const wiMap = new Map(allWorkItems.map((wi) => [`${wi.provider}:${wi.id}`, wi]));
      const prMap = new Map(allEnrichedPRs.map((pr) => [`${pr.provider}:${pr.repoId}:${pr.prId}`, pr]));

      const activeTaskEntries = activeTasks.map((task) => {
        // Work item state summary
        const byState: Record<string, number> = {};
        for (const wiRef of task.workItems) {
          const wi = wiMap.get(`${wiRef.provider}:${wiRef.id}`);
          const state = wi?.state ?? "Unknown";
          byState[state] = (byState[state] ?? 0) + 1;
        }

        // PR status summary
        let prActive = 0;
        let prCompleted = 0;
        let prUnknown = 0;
        for (const pr of task.pullRequests) {
          const enriched = prMap.get(`${pr.provider}:${pr.repoId}:${pr.prId}`);
          if (enriched?.status === "active") prActive++;
          else if (enriched?.status === "completed") prCompleted++;
          else if (enriched?.status === null || enriched === undefined) prUnknown++;
        }

        // Last activity across task sessions
        const sessionTimes = task.sessionIds
          .map((sid) => sessionById.get(sid)?.lastActivityAt)
          .filter(Boolean) as string[];
        const lastActivity = sessionTimes.length > 0
          ? sessionTimes.sort((a, b) => new Date(b).getTime() - new Date(a).getTime())[0]
          : task.updatedAt;

        // Has busy session?
        const hasBusySession = task.sessionIds.some((sid) =>
          sessionById.get(sid)?.busy,
        );

        // Checklist summary
        const checklistItems = ctx.checklistStore.listChecklistItems(task.id);
        const checklistDone = checklistItems.filter((t) => t.done).length;
        const today = new Date().toISOString().slice(0, 10);
        const checklistOverdue = checklistItems.filter((t) => !t.done && t.deadline && t.deadline < today).length;

        return {
          task,
          workItemSummary: { total: task.workItems.length, byState },
          prSummary: { total: task.pullRequests.length, active: prActive, completed: prCompleted, unknown: prUnknown },
          checklistSummary: {
            total: checklistItems.length,
            done: checklistDone,
            open: checklistItems.length - checklistDone,
            overdue: checklistOverdue,
          },
          hasBusySession,
          lastActivity,
        };
      });

      // Sort: busy first, then most recent
      activeTaskEntries.sort((a, b) => {
        if (a.hasBusySession !== b.hasBusySession) return a.hasBusySession ? -1 : 1;
        return new Date(b.lastActivity).getTime() - new Date(a.lastActivity).getTime();
      });

      // Last active task (most recently updated active task)
      const lastActiveTask = activeTaskEntries[0] ?? null;

      const nowMs = Date.now();
      const staleCutoffMs = nowMs - 7 * 24 * 60 * 60 * 1000;
      const isDueNow = (nextTouchAt?: string) => {
        if (!nextTouchAt) return false;
        const dueAt = Date.parse(nextTouchAt);
        return Number.isFinite(dueAt) && dueAt <= nowMs;
      };
      const isStale = (lastActivity: string) => {
        const lastActivityMs = Date.parse(lastActivity);
        return Number.isFinite(lastActivityMs) && lastActivityMs < staleCutoffMs;
      };
      const closeableMomentumTasks = activeTaskEntries.filter((entry) => entry.task.kind === "task");
      const taskMomentum = {
        needsDecision: activeTaskEntries.filter((entry) =>
          !entry.task.nextAction
          && !entry.task.waitingOn
          && !entry.task.nextTouchAt,
        ),
        followUpNow: activeTaskEntries.filter((entry) => isDueNow(entry.task.nextTouchAt)),
        waiting: activeTaskEntries.filter((entry) => !!entry.task.waitingOn),
        candidateToClose: closeableMomentumTasks.filter((entry) =>
          entry.checklistSummary.open === 0
          && !entry.hasBusySession
          && entry.prSummary.active === 0
          && entry.prSummary.unknown === 0,
        ),
        stale: activeTaskEntries.filter((entry) =>
          !entry.hasBusySession
          && !entry.task.nextTouchAt
          && isStale(entry.lastActivity),
        ),
      };

      // Orphan sessions: not linked to any task, unread or active in last 24h
      const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
      const orphanSessions = enrichedSessions
        .filter((s: any) => {
          if (taskSessionIds.has(s.sessionId)) return false;
          const unread = isUnread(s.sessionId, s.lastActivityAt);
          const recent = s.lastActivityAt && new Date(s.lastActivityAt).getTime() > oneDayAgo;
          return s.busy || unread || recent;
        })
        .map((s: any) => ({
          sessionId: s.sessionId,
          title: s.summary,
          lastVisibleActivityAt: s.lastVisibleActivityAt,
          lastAttentionAt: s.lastAttentionAt,
          lastActivityAt: s.lastActivityAt,
          branch: s.context?.branch ?? null,
          runState: s.runState ?? "idle",
          busy: s.busy ?? false,
          unread: isUnread(s.sessionId, s.lastActivityAt),
        }));
      const dashboardChecklistData = buildDashboardChecklistData(tasks);

      // Active schedules
      const allSchedules = ctx.scheduleStore.listSchedules();
      const dashboardSchedules = allSchedules.map((sched) => {
        const task = tasks.find((t) => t.id === sched.taskId);
        return {
          ...sched,
          taskTitle: task?.title ?? null,
          taskGroupColor: task?.groupId
            ? ctx.taskGroupStore.getGroup(task.groupId)?.color ?? null
            : null,
        };
      });

      res.json({
        busySessions,
        lastActiveTask,
        orphanSessions,
        openChecklistItems: dashboardChecklistData.openChecklistItems,
        completedChecklistItems: dashboardChecklistData.completedChecklistItems,
        schedules: dashboardSchedules,
        taskMomentum: {
          summary: {
            needsDecision: taskMomentum.needsDecision.length,
            followUpNow: taskMomentum.followUpNow.length,
            waiting: taskMomentum.waiting.length,
            candidateToClose: taskMomentum.candidateToClose.length,
            stale: taskMomentum.stale.length,
          },
          ...taskMomentum,
        },
      });
      ctx.telemetryStore?.recordSpan({ name: "dashboard", duration: Date.now() - t0, source: "server" });
    } catch (err) {
      console.error("[dashboard] Error:", err);
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Schedule routes ───────────────────────────────────────────────

  router.get("/schedules", (_req, res) => {
    const taskId = typeof _req.query.taskId === "string" ? _req.query.taskId : undefined;
    res.json(ctx.scheduleStore.listSchedules(taskId));
  });

  router.post("/schedules", async (req, res) => {
    try {
      const unknownFields = findUnknownFields(req.body, SCHEDULE_CREATE_FIELDS);
      if (unknownFields.length > 0) {
        return res.status(400).json({ error: formatUnknownFieldsError(unknownFields) });
      }
      const { taskId, name, prompt, type, cron: cronExpr, runAt, timezone, maxRuns, expiresAt, autoArchiveKeep } = req.body;
      const autoArchiveKeepProvided = Object.prototype.hasOwnProperty.call(req.body, "autoArchiveKeep");
      const normalizedAutoArchiveKeep = normalizeScheduleAutoArchiveKeep(autoArchiveKeep);
      if (!normalizedAutoArchiveKeep.ok) {
        return res.status(400).json({ error: normalizedAutoArchiveKeep.error });
      }
      if (!taskId || !name || !prompt || !type) {
        return res.status(400).json({ error: "taskId, name, prompt, and type are required" });
      }
      if (type === "cron" && !cronExpr) {
        return res.status(400).json({ error: "cron expression is required for cron schedules" });
      }
      if (type === "once" && !runAt) {
        return res.status(400).json({ error: "runAt is required for one-shot schedules" });
      }
      if (!ctx.taskStore.getTask(taskId)) {
        return res.status(404).json({ error: "Task not found" });
      }

      if (timezone && !schedulerModule().isValidTimezone(timezone)) {
        return res.status(400).json({ error: `Invalid timezone: ${timezone}` });
      }

      const schedule = ctx.scheduleStore.createSchedule({
        taskId,
        name,
        prompt,
        type,
        cron: cronExpr,
        runAt,
        timezone,
        maxRuns,
        expiresAt,
        autoArchiveKeep: normalizedAutoArchiveKeep.value ?? undefined,
      });
      if (autoArchiveKeepProvided && schedule.autoArchiveKeep !== undefined) {
        await enforceRetentionForSchedule(ctx, schedule);
      }

      // Register cron job or arm one-shot timer
      if (schedule.type === "cron") {
        schedulerModule().registerSchedule(schedule.id);
      } else if (schedule.type === "once" && schedule.runAt) {
        schedulerModule().armOneShot(schedule.id, schedule.runAt);
      }

      console.log(`[schedules] Created schedule "${schedule.name}" (${schedule.type})`);
      ctx.globalBus.emit({ type: "schedule:changed", taskId: schedule.taskId, scheduleId: schedule.id });
      res.status(201).json(schedule);
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  router.patch("/schedules/:id", async (req, res) => {
    try {
      const unknownFields = findUnknownFields(req.body, SCHEDULE_UPDATE_FIELDS);
      if (unknownFields.length > 0) {
        return res.status(400).json({ error: formatUnknownFieldsError(unknownFields) });
      }
      if (req.body.timezone && !schedulerModule().isValidTimezone(req.body.timezone)) {
        return res.status(400).json({ error: `Invalid timezone: ${req.body.timezone}` });
      }
      const existing = ctx.scheduleStore.getSchedule(req.params.id);
      if (!existing) return res.status(404).json({ error: "Schedule not found" });

      const updates = { ...req.body };
      const autoArchiveKeepProvided = Object.prototype.hasOwnProperty.call(req.body, "autoArchiveKeep");
      if (autoArchiveKeepProvided) {
        const normalizedAutoArchiveKeep = normalizeScheduleAutoArchiveKeep(req.body.autoArchiveKeep);
        if (!normalizedAutoArchiveKeep.ok) {
          return res.status(400).json({ error: normalizedAutoArchiveKeep.error });
        }
        updates.autoArchiveKeep = normalizedAutoArchiveKeep.value;
      }

      const schedule = ctx.scheduleStore.updateSchedule(req.params.id, updates);
      if (autoArchiveKeepProvided && schedule.autoArchiveKeep !== undefined) {
        await enforceRetentionForSchedule(ctx, schedule);
      }

      // Re-register cron job if timing or enabled state changed
      if (schedule.type === "cron") {
        if (schedule.enabled) {
          schedulerModule().registerSchedule(schedule.id);
        } else {
          schedulerModule().unregisterSchedule(schedule.id);
        }
      } else if (schedule.type === "once" && req.body.runAt && schedule.enabled) {
        schedulerModule().armOneShot(schedule.id, schedule.runAt!);
      }

      console.log(`[schedules] Updated schedule "${schedule.name}"`);
      ctx.globalBus.emit({ type: "schedule:changed", taskId: schedule.taskId, scheduleId: schedule.id });
      res.json(schedule);
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  router.delete("/schedules/:id", (req, res) => {
    try {
      const schedule = ctx.scheduleStore.getSchedule(req.params.id);
      const taskId = schedule?.taskId;
      schedulerModule().unregisterSchedule(req.params.id);
      ctx.scheduleStore.deleteSchedule(req.params.id);
      console.log(`[schedules] Deleted schedule ${req.params.id}`);
      ctx.globalBus.emit({ type: "schedule:changed", taskId, scheduleId: req.params.id });
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  router.post("/schedules/:id/trigger", async (req, res) => {
    try {
      const result = await schedulerModule().triggerSchedule(req.params.id, { source: "manual" });
      res.json(result);
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  router.get("/schedules/:id/sessions", async (req, res) => {
    try {
      const schedule = ctx.scheduleStore.getSchedule(req.params.id);
      if (!schedule) return res.status(404).json({ error: "Schedule not found" });

      const limit = Math.min(Number(req.query.limit) || 20, 100);
      const offset = Number(req.query.offset) || 0;

      const allRuns = ctx.sessionMetaStore.listScheduleRuns(req.params.id);
      const pageRuns = allRuns.slice(offset, offset + limit);

      const sessions = await ctx.sessionManager.listSessionsFromDisk();
      const sessionMap = new Map(sessions.map((s: any) => [s.sessionId, s]));
      const meta = ctx.sessionMetaStore.listMeta();
      const sessionStateDir = join(getCopilotHome(ctx), "session-state");

      const enriched = await Promise.all(
        pageRuns.map(async (run) => {
          const s = sessionMap.get(run.sessionId);
          const archived = meta[run.sessionId]?.archived === true;
          const summary = s?.summary ?? run.sessionId;
          const status = s
            ? getSessionStatus(ctx, run.sessionId)
            : { runState: "idle" as const, busy: false, pendingUserInputCount: 0, needsUserInput: false };
          const hasPlan = await statAsync(join(sessionStateDir, run.sessionId, "plan.md")).then(() => true, () => false);
          let diskSize = 0;
          try { diskSize = getDirSize(join(sessionStateDir, run.sessionId)); } catch {}
          return {
            ...s,
            runId: run.id,
            recordedAt: run.recordedAt,
            recordedAtKnown: run.recordedAt !== UNKNOWN_SCHEDULE_RUN_AT,
            sessionId: run.sessionId,
            summary,
            ...status,
            hasPlan,
            archived,
            diskSizeBytes: diskSize,
            missing: !s,
          };
        }),
      );
      res.json({
        sessions: enriched,
        total: allRuns.length,
        offset,
        limit,
      });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.get("/schedules/status", (_req, res) => {
    res.json({
      globalPause: schedulerModule().isGlobalPaused(),
      scheduleCount: ctx.scheduleStore.listSchedules().length,
      enabledCount: ctx.scheduleStore.getEnabledSchedules().length,
    });
  });

  router.post("/schedules/pause", (req, res) => {
    const { paused } = req.body;
    schedulerModule().setGlobalPause(paused !== false);
    res.json({ globalPause: schedulerModule().isGlobalPaused() });
  });

  // ── Server info ─────────────────────────────────────────────────

  router.get("/server/timezone", (_req, res) => {
    res.json({ timezone: Intl.DateTimeFormat().resolvedOptions().timeZone });
  });

  router.get("/server/launcher-log", (req, res) => {
    try {
      if (ctx.isStaging) {
        return res.json({
          status: "unavailable",
          error: "Launcher log is unavailable in staging previews.",
        });
      }
      if (!ctx.launcherLogPath) {
        return res.json({
          status: "unavailable",
          error: "Launcher log is unavailable because this server was not started by the launcher.",
        });
      }
      const rawLines = Array.isArray(req.query.lines) ? req.query.lines[0] : req.query.lines;
      const parsedLines = Number.parseInt(String(rawLines ?? ""), 10);
      res.json(readLauncherLogTail(ctx.launcherLogPath, {
        lines: Number.isFinite(parsedLines) ? parsedLines : undefined,
      }));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/server/commits", async (req, res) => {
    try {
      const refresh = Array.isArray(req.query.refresh) ? req.query.refresh[0] : req.query.refresh;
      const forceRefresh = /^(1|true|yes|on)$/i.test(String(refresh ?? ""));
      res.json(await getBridgeGitRevisions({ forceRefresh }));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // Update checks

  function getUpdateChannel(value: unknown): UpdateChannel | undefined {
    const raw = Array.isArray(value) ? value[0] : value;
    if (raw === undefined || raw === null || raw === "") return undefined;
    if (raw === "stable" || raw === "preview") return raw;
    throw new UpdateInstallError(`Unsupported update channel "${String(raw)}". Expected "stable" or "preview".`, 400);
  }

  function rejectCrossSiteUpdateMutation(req: express.Request, res: express.Response): boolean {
    const secFetchSite = req.get("sec-fetch-site")?.toLowerCase();
    if (secFetchSite && secFetchSite !== "same-origin" && secFetchSite !== "same-site" && secFetchSite !== "none") {
      res.status(403).json({ error: "Update installation must be started from the Bridge UI." });
      return true;
    }
    const origin = req.get("origin");
    const host = req.get("host");
    if (origin && host) {
      try {
        if (new URL(origin).host !== host) {
          res.status(403).json({ error: "Update installation must be started from the Bridge UI." });
          return true;
        }
      } catch {
        res.status(403).json({ error: "Update installation origin is invalid." });
        return true;
      }
    }
    return false;
  }

  router.get("/updates/check", async (req, res) => {
    try {
      const channel = getUpdateChannel(req.query.channel);
      res.json(await checkForUpdate({
        channel,
        runtimePaths: ctx.runtimePaths,
        env: process.env,
      }));
    } catch (err) {
      const statusCode = err instanceof UpdateInstallError ? err.statusCode : 500;
      res.status(statusCode).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.get("/updates/install-status", (_req, res) => {
    try {
      const runtimePaths = ctx.runtimePaths;
      if (!runtimePaths) {
        return res.status(500).json({ error: "Runtime paths are not configured." });
      }
      res.json(readUpdateInstallStatus({ runtimePaths }));
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/updates/install", async (req, res) => {
    if (rejectCrossSiteUpdateMutation(req, res)) return;
    try {
      const runtimePaths = ctx.runtimePaths;
      if (!runtimePaths) {
        return res.status(500).json({ error: "Runtime paths are not configured." });
      }
      const channel = getUpdateChannel(req.body?.channel);
      res.status(202).json(await startUpdateInstall({
        channel,
        runtimePaths,
        env: process.env,
      }));
    } catch (err) {
      const statusCode = err instanceof UpdateInstallError ? err.statusCode : 500;
      res.status(statusCode).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── Settings routes ───────────────────────────────────────────────

  router.get("/settings", (_req, res) => {
    try {
      res.json(ctx.settingsStore.getSettings());
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  router.patch("/settings", async (req, res) => {
    try {
      const prev = ctx.settingsStore.getSettings();
      const updated = ctx.settingsStore.updateSettings(req.body);
      clearProviderCache();

      const mcpChanged = JSON.stringify(prev.mcpServers) !== JSON.stringify(updated.mcpServers);
      const modelChanged = prev.model !== updated.model;
      const reasoningChanged = prev.reasoningEffort !== updated.reasoningEffort;

      // MCP server changes can't be hot-swapped on a live session — evict so the
      // next resume rebuilds with the new MCP config.
      if (mcpChanged) {
        console.log("[settings] MCP servers changed — evicting cached sessions for re-resume");
        ctx.sessionManager.evictAllCachedSessions();
      } else if (modelChanged || reasoningChanged) {
        // Model/reasoning changes apply to future sessions only. Existing cached
        // sessions keep the model already persisted in their SDK state.
        const reasons = [
          modelChanged ? "model" : null,
          reasoningChanged ? "reasoning effort" : null,
        ].filter(Boolean).join(" & ");
        console.log(`[settings] ${reasons} changed — applies to new sessions only`);
      }

      console.log("[settings] Settings updated");
      res.json(updated);
    } catch (err) {
      res.status(400).json({ error: String(err) });
    }
  });

  // GET /mcp-status — global MCP server status from any recent session
  router.get("/mcp-status", (_req, res) => {
    try {
      const servers = ctx.sessionManager.getLatestMcpStatus();
      res.json({ servers });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // GET /models — list available models from the Copilot SDK
  router.get("/models", async (_req, res) => {
    try {
      const models = await ctx.sessionManager.listModels();
      res.json({ models });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // POST /models/refresh — rotate the SDK client to refresh its cached model list
  router.post("/models/refresh", async (_req, res) => {
    try {
      const result = await ctx.sessionManager.refreshModels();
      res.json(result);
    } catch (err) {
      if (err instanceof ModelRefreshBlockedError) {
        res.status(409).json({
          error: err.message,
          activeSessions: err.activeSessions,
        });
        return;
      }
      res.status(500).json({ error: String(err) });
    }
  });

  // ── Docs / Knowledge Base ─────────────────────────────────────────

  if (ctx.docsStore && ctx.docsIndex) {
    const docs = ctx.docsStore;
    const docsIdx = ctx.docsIndex;
    const docsSnapshots = ctx.docsSnapshotStore;
    const createPreDeleteDocsSnapshot = () => {
      if (!docsSnapshots) return;
      try {
        docsSnapshots.createSnapshot({
          reason: "pre-delete",
          allowEmpty: false,
          skipIfRecentMs: PRE_DELETE_SNAPSHOT_MIN_INTERVAL_MS,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Cannot delete docs page because pre-delete snapshot failed: ${message}`);
      }
    };

    router.get("/docs/tree", (_req, res) => {
      try {
        const tree = docs.listTree();
        const hasRootIndex = docs.readPage("index") !== null;
        res.json({ tree, hasRootIndex });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    router.get("/docs/search", (req, res) => {
      try {
        const q = String(req.query.q || "");
        const limit = Math.min(Number(req.query.limit) || 50, 200);
        const offset = Number(req.query.offset) || 0;
        res.json(docsIdx.search(q, limit, offset));
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    // Wikilink resolution
    router.get("/docs/resolve", (req, res) => {
      try {
        const target = String(req.query.target || "");
        if (!target) return res.status(400).json({ error: "target is required" });
        const resolved = docsIdx.resolveWikilink(target);
        if (!resolved) return res.status(404).json({ error: "Page not found", target });
        res.json(resolved);
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    router.post("/docs/resolve", (req, res) => {
      try {
        const { targets } = req.body;
        if (!Array.isArray(targets)) return res.status(400).json({ error: "targets array is required" });
        res.json(docsIdx.resolveWikilinks(targets));
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    router.post("/docs/reindex", (_req, res) => {
      try {
        const result = docsIdx.reindex();
        res.json(result);
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    router.get("/docs/snapshots", (_req, res) => {
      if (!docsSnapshots) return res.status(501).json({ error: "Docs snapshots not available" });
      try {
        res.json({ snapshots: docsSnapshots.listSnapshots() });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    router.post("/docs/snapshots", (req, res) => {
      if (!docsSnapshots) return res.status(501).json({ error: "Docs snapshots not available" });
      try {
        const reason = typeof req.body?.reason === "string" && req.body.reason.trim()
          ? req.body.reason.trim()
          : "manual";
        const result = docsSnapshots.createSnapshot({ reason, allowEmpty: true });
        res.json(result);
      } catch (err: any) {
        res.status(400).json({ error: err.message || String(err) });
      }
    });

    router.post("/docs/snapshots/:id/restore", (req, res) => {
      if (!docsSnapshots) return res.status(501).json({ error: "Docs snapshots not available" });
      if (req.body?.confirm !== true) {
        return res.status(400).json({ error: "confirm: true is required to restore a docs snapshot" });
      }
      try {
        const result = docsSnapshots.restoreSnapshot(String(req.params.id));
        let reindexed = true;
        let reindexError: string | undefined;
        try {
          docsIdx.reindex();
        } catch (error) {
          reindexed = false;
          reindexError = error instanceof Error ? error.message : String(error);
          console.warn(`[docs-snapshots] Restore succeeded but reindex failed: ${reindexError}`);
        }
        res.json({ success: true, reindexed, ...(reindexError ? { reindexError } : {}), ...result });
      } catch (err: any) {
        if (err instanceof DocsSnapshotNotFoundError) return res.status(404).json({ error: err.message });
        if (err instanceof DocsSnapshotValidationError) return res.status(422).json({ error: err.message });
        res.status(500).json({ error: err.message || String(err) });
      }
    });

    // Page CRUD — explicit sub-path to avoid wildcard conflicts
    router.get("/docs/pages/*path", (req, res) => {
      try {
        const raw = (req.params as any).path;
        const pagePath = Array.isArray(raw) ? raw.join("/") : String(raw);
        const page = docs.readPage(pagePath);
        if (!page) return res.status(404).json({ error: "Page not found" });
        res.json(page);
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    router.put("/docs/pages/*path", (req, res) => {
      try {
        const raw = (req.params as any).path;
        const pagePath = Array.isArray(raw) ? raw.join("/") : String(raw);
        const { content } = req.body;
        if (typeof content !== "string") return res.status(400).json({ error: "content is required" });
        const page = docs.writePage(pagePath, content);
        docsIdx.indexPage(page);
        res.json({ path: page.path, success: true });
      } catch (err: any) {
        res.status(400).json({ error: err.message || String(err) });
      }
    });

    router.delete("/docs/pages/*path", (req, res) => {
      try {
        const raw = (req.params as any).path;
        const pagePath = Array.isArray(raw) ? raw.join("/") : String(raw);
        const result = docs.deleteUserPage(pagePath, createPreDeleteDocsSnapshot);
        if (result.deleted) {
          docsIdx.removePage(result.path);
        }
        res.json(result);
      } catch (err: any) {
        const message = err?.message || String(err);
        res.status(err instanceof DocsStoreValidationError ? 400 : 500).json({ error: message });
      }
    });

    // DB collection routes — use wildcard (*) to support nested folders (e.g. areas/cooking/recipes)
    const paramPath = (raw: any): string => Array.isArray(raw) ? raw.join("/") : String(raw);

    router.get("/docs/schema/*folder", (req, res) => {
      try {
        const folder = paramPath((req.params as any).folder);
        const schema = docs.readSchema(folder);
        if (!schema) return res.status(404).json({ error: "Schema not found" });
        const entries = docs.listDbEntries(folder);
        res.json({ ...schema, entryCount: entries.length });
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    router.put("/docs/schema/*folder", (req, res) => {
      try {
        const folder = paramPath((req.params as any).folder);
        const { name, fields } = req.body;
        if (!name || !Array.isArray(fields)) return res.status(400).json({ error: "name and fields are required" });
        const schema = docs.writeSchema(folder, { name, fields });
        res.json({ ...schema, success: true });
      } catch (err: any) {
        res.status(400).json({ error: err.message || String(err) });
      }
    });

    router.get("/docs/db/*folder", (req, res) => {
      try {
        const folder = paramPath((req.params as any).folder);
        const limit = Math.min(Number(req.query.limit) || 10000, 10000);
        const offset = Number(req.query.offset) || 0;
        const sortField = req.query._sort as string | undefined;
        const sortOrder = (req.query._order as string | undefined) === "asc" ? "asc" as const : "desc" as const;
        const includeBody = ["1", "true", "yes", "on"].includes(String(req.query._includeBody ?? "").toLowerCase());

        // Extract field filters from query (skip meta params)
        const filters: Record<string, any> = {};
        for (const [key, value] of Object.entries(req.query)) {
          if (key.startsWith("_") || key === "limit" || key === "offset") continue;
          filters[key] = value;
        }

        const result = docsIdx.queryByFolder(
          folder,
          Object.keys(filters).length ? filters : undefined,
          sortField ? { field: sortField, order: sortOrder } : undefined,
          limit,
          offset,
          includeBody,
        );
        res.json(result);
      } catch (err) {
        res.status(500).json({ error: String(err) });
      }
    });

    router.post("/docs/db/*folder", (req, res) => {
      try {
        const folder = paramPath((req.params as any).folder);
        const { fields, body } = docs.normalizeDbEntryInput(req.body ?? {}, "add", folder);
        const entry = docs.addDbEntry(folder, fields, body);
        // Index the new page
        const page = docs.readPage(entry.path);
        if (page) docsIdx.indexPage(page);
        res.json({ path: entry.path, slug: entry.slug, success: true });
      } catch (err: any) {
        res.status(400).json({ error: err.message || String(err) });
      }
    });

    router.patch("/docs/db/*path", (req, res) => {
      try {
        const fullPath = paramPath((req.params as any).path);
        const lastSlash = fullPath.lastIndexOf("/");
        if (lastSlash === -1) return res.status(400).json({ error: "Path must be folder/slug" });
        const folder = fullPath.slice(0, lastSlash);
        const slug = fullPath.slice(lastSlash + 1);
        const { fields, body } = docs.normalizeDbEntryInput(req.body ?? {}, "update", folder);
        const entry = docs.updateDbEntry(folder, slug, fields, body);
        // Re-index the updated page
        const page = docs.readPage(entry.path);
        if (page) docsIdx.indexPage(page);
        res.json({ path: entry.path, success: true });
      } catch (err: any) {
        res.status(400).json({ error: err.message || String(err) });
      }
    });
  }

  // ── Telemetry routes ────────────────────────────────────────────

  const parseTelemetrySpan = (
    span: any,
  ): { id?: string; name: string; sessionId?: string; duration: number; metadata?: Record<string, unknown> } | null => {
    if (!span || typeof span !== "object") return null;
    if (!span.name || typeof span.name !== "string" || typeof span.duration !== "number") return null;
    if (span.id != null && typeof span.id !== "string") return null;
    if (span.sessionId != null && typeof span.sessionId !== "string") return null;
    if (span.metadata != null && (typeof span.metadata !== "object" || Array.isArray(span.metadata))) return null;
    return {
      ...(span.id != null ? { id: span.id } : {}),
      name: span.name,
      duration: span.duration,
      ...(span.sessionId != null ? { sessionId: span.sessionId } : {}),
      ...(span.metadata != null ? { metadata: span.metadata } : {}),
    };
  };

  router.post("/telemetry", (req, res) => {
    if (!ctx.telemetryStore) return res.status(501).json({ error: "Telemetry not available" });
    const span = parseTelemetrySpan(req.body);
    if (!span) {
      return res.status(400).json({ error: "name (string) and duration (number) are required" });
    }
    ctx.telemetryStore.recordSpan({ ...span, ingestKey: span.id, source: "client" });
    res.json({ ok: true });
  });

  router.post("/telemetry/batch", (req, res) => {
    if (!ctx.telemetryStore) return res.status(501).json({ error: "Telemetry not available" });
    const { spans } = req.body ?? {};
    if (!Array.isArray(spans)) {
      return res.status(400).json({ error: "spans array is required" });
    }

    const parsed = spans.map(parseTelemetrySpan);
    const invalidIndex = parsed.findIndex((span) => span == null);
    if (invalidIndex >= 0) {
      return res.status(400).json({ error: `Invalid telemetry span at index ${invalidIndex}` });
    }

    ctx.telemetryStore.recordSpans(parsed.map((span) => ({
      ...span!,
      ingestKey: span!.id,
      source: "client",
    })));
    res.json({ ok: true, accepted: parsed.length });
  });

  router.get("/telemetry", (_req, res) => {
    if (!ctx.telemetryStore) return res.status(501).json({ error: "Telemetry not available" });
    const { name, sessionId, source, limit, since } = _req.query as Record<string, string>;
    const spans = ctx.telemetryStore.querySpans({
      name, sessionId, source: source as any,
      limit: limit ? parseInt(limit, 10) : undefined,
      since,
    });
    res.json(spans);
  });

  router.get("/telemetry/stats", (_req, res) => {
    if (!ctx.telemetryStore) return res.status(501).json({ error: "Telemetry not available" });
    const { since } = _req.query as Record<string, string>;
    const stats = ctx.telemetryStore.getStats({ since });
    res.json(stats);
  });

  router.delete("/telemetry", (_req, res) => {
    if (!ctx.telemetryStore) return res.status(501).json({ error: "Telemetry not available" });
    const pruned = ctx.telemetryStore.pruneOldSpans(0);
    res.json({ pruned });
  });

  return router;
}

function ensureVoiceJobManager(ctx: AppContext, transcriptionService: TranscriptionService): VoiceJobManager {
  void transcriptionService;
  return ctx.voiceJobManager;
}

function ensurePushSubscriptionStore(ctx: AppContext): PushSubscriptionStore {
  if (!ctx.pushSubscriptionStore) {
    throw new Error("Push subscription store is not configured.");
  }
  return ctx.pushSubscriptionStore;
}

function ensurePushNotificationService(ctx: AppContext): PushNotificationService {
  if (!ctx.pushNotificationService) {
    throw new Error("Push notification service is not configured.");
  }
  return ctx.pushNotificationService;
}
