import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { Routes, Route, useNavigate, useParams, useLocation, useNavigationType } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "./queryClient";
import {
  createSession,
  patchSession,
  createTask,
  patchTask,
  deleteTask,
  deleteSession,
  startSessionFork,
  waitForSessionFork,
  reloadSession,
  createTaskSession,
  linkResource,
  reorderTasks,
  reorderTaskGroups,
  fetchTaskGroups,
  createTaskGroup,
  patchTaskGroup,
  deleteTaskGroup,
  batchSessionAction,
  setTaskTags,
  setGroupTags,
  getSessionActivityTime,
  getSessionReadThroughActivityTime,
  isSessionActive,
  markSessionReadOnPageHide,
  getTaskDeletionPreview,
  ApiError,
  API_BASE,
  type ChecklistItem,
  type EnrichedTaskData,
  type Session,
  type SessionDisposition,
  type Task,
  type TaskDeletionErrorBody,
  type TaskDeletionPreview,
  type TaskGroup,
  type CreateSessionOptions,
} from "./api";
import { useReadState } from "./useReadState";
import { usePageAttention } from "./usePageAttention";
import { useBackgroundVoiceJobs, type StartBackgroundVoiceJobOptions, type VoiceBackgroundJob, type VoiceSessionActivity, type VoiceSessionSettled } from "./hooks/useBackgroundVoiceJobs";
import {
  useDrafts,
  type DraftLaunchOptions,
} from "./useDrafts";
import { useStatusStream } from "./useStatusStream";
import { getComposerKeyFromPathname, getDraftComposerKey } from "./lib/composer-key";
import { getRememberedDashboardPath, isDashboardRoutePath } from "./lib/dashboard-routes";
import { getMobileRouteMeta } from "./lib/mobile-route-meta";
import { createBridgeMobileScrollRestoreState, getMobileScrollRestorationPolicy } from "./lib/mobile-scroll-restoration";
import { getSessionPath, getTaskChatPath, getTaskDraftSessionPath } from "./lib/session-path";
import { getQuickChatSessions } from "./lib/quick-chat-sessions";
import { buildOptimisticSessionModelState } from "./lib/session-model";
import { createDeferredTaskChangeInvalidator } from "./lib/task-change-invalidation";
import { setTaskInQueryCaches, updateTaskInQueryCaches } from "./lib/task-query-cache";
import { reduceRestartBannerState, type RestartBannerState } from "./lib/restart-banner-state";
import { createBackendStatusBannerState, reduceBackendStatusBannerState } from "./lib/backend-status-banner-state";
import { cleanupFailedFirstSendSession, sendMaterializedFirstPrompt } from "./first-send-session-cleanup";
import { useRestartStatusQuery } from "./hooks/queries/useRestartStatus";
import { useSettingsQuery } from "./hooks/queries/useSettings";
import { useModelsQuery } from "./hooks/queries/useModels";
import { useSessionModelQuery } from "./hooks/queries/useSessionModel";
import { useTaskAgentDefinitionsQuery } from "./hooks/queries/useTaskAgentDefinitions";
import { useModelPresets } from "./hooks/useModelPresets";
import {
  buildNewSessionCreateOptions,
  resolveNewSessionLaunchState,
} from "./lib/new-session-launch";
import type { ModelPresetSelection } from "./lib/model-presets";
import type { ModelPresetSlot } from "../shared/model-presets.js";
import type { CopilotContextTier } from "../shared/copilot-context.js";
import { useTasksQuery } from "./hooks/queries/useTasks";
import { useActiveTask } from "./hooks/queries/useActiveTask";
import { useTaskGroupsQuery } from "./hooks/queries/useTaskGroups";
import { mergeActiveAndArchivedSessions, patchSessionQueryData, useSessionsQuery } from "./hooks/queries/useSessions";
import { useExternalSessionUseQuery } from "./hooks/queries/useExternalSessionUse";
import { useOpenChecklistItemsQuery } from "./hooks/queries/useChecklistItems";
import useTaskIndicators, {
  summarizeChatTabAttention,
  summarizeTaskTabAttention,
} from "./hooks/useTaskIndicators";
import { getHomeChecklistIndicator } from "./checklist-helpers";
import TaskRail from "./components/TaskRail";
import TaskPanel, { TaskPanelRouteSkeleton } from "./components/TaskPanel";
import TaskDashboard, { TaskDashboardRouteSkeleton } from "./components/TaskDashboard";
import TaskList from "./components/TaskList";
import ConfirmTaskDeleteDialog, { useTaskDeletionProgress } from "./components/ConfirmTaskDeleteDialog";
import ChatView from "./components/ChatView";
import NewSessionLaunchPanel from "./components/NewSessionLaunchPanel";
import SessionModelSummary from "./components/SessionModelSummary";
import Dashboard from "./components/Dashboard";
import SettingsView from "./components/SettingsView";
import DocsView from "./components/DocsView";
import SessionList from "./components/SessionList";
import RestartBanner from "./components/RestartBanner";
import BackendStatusBanner from "./components/BackendStatusBanner";
import PullToRefresh, { type PullToRefreshScrollRestoration } from "./components/PullToRefresh";
import { MobileBottomNav } from "./components/MobileBottomNav";
import { MobileDetailHeader } from "./components/MobileDetailHeader";
import { useIsMobile } from "./useIsMobile";
import { useFavicon } from "./useFavicon";
import { useDocumentTitle } from "./useDocumentTitle";
import { resolveDocumentTitle } from "./lib/document-title";
import { getLastViewedSession, setLastViewedSession, clearLastViewedSession, getLastViewedDoc, getLastActiveTask, setLastActiveTask, clearLastActiveTask, getLastActiveQuickChat, setLastActiveQuickChat, clearLastActiveQuickChat } from "./last-viewed";
import { createTaskCompletionFeedback, createTaskCompletionToast, type TaskCompletionFeedback } from "./lib/task-completion-feedback";
import { useToast } from "./useToast";
import { DEFAULT_SEND_MODE, type SendMode } from "../shared/send-mode.js";

const SESSION_BUSY_SIGNAL_GRACE_MS = 10_000;
const OPTIMISTIC_SESSION_TTL_MS = 2 * 60_000;

interface StartPromptSessionOptions {
  navigateOnError?: boolean;
}

function isTaskCompleted(task: Pick<Task, "completedAt">): boolean {
  return Boolean(task.completedAt);
}

function getSuccessfulBatchSessionIds(sessionIds: string[], errors: Record<string, string>): string[] {
  const failedIds = new Set(Object.keys(errors));
  return sessionIds.filter((sessionId) => !failedIds.has(sessionId));
}

export default function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const navigationType = useNavigationType();
  const isMobile = useIsMobile();
  const { hasAttention: pageHasAttention, hasAttentionRef: pageHasAttentionRef } = usePageAttention();
  const queryClient = useQueryClient();
  const { showToast, dismissToast } = useToast();
  const monitoredForkJobIdsRef = useRef(new Set<string>());

  // ── React Query data ────────────────────────────────────────
  const [archivedLoaded, setArchivedLoaded] = useState(false);
  const [restoringArchivedSessionIds, setRestoringArchivedSessionIds] = useState<Set<string>>(new Set());
  const {
    data: activeSessions = [],
  } = useSessionsQuery(false);
  const {
    data: archivedQuerySessions = [],
    isFetched: archivedSessionsFetched,
  } = useSessionsQuery(true, {
    enabled: archivedLoaded,
    refetchInterval: false,
    refetchOnWindowFocus: false,
  });
  const activeSessionIds = useMemo(
    () => activeSessions
      .filter((session) => !session.isOptimistic)
      .map((session) => session.sessionId)
      .sort(),
    [activeSessions],
  );
  const externalSessionUseQuery = useExternalSessionUseQuery(activeSessionIds);
  const externalSessionUseStatus = externalSessionUseQuery.data?.status;
  const externalSessionUseIds = externalSessionUseQuery.data?.inUse;
  const externallyInUseSessionIds = useMemo(
    () => new Set(
      externalSessionUseStatus === "available"
        ? externalSessionUseIds
        : [],
    ),
    [externalSessionUseIds, externalSessionUseStatus],
  );
  const sessions = useMemo(
    () => mergeActiveAndArchivedSessions(
      activeSessions,
      archivedQuerySessions,
      archivedLoaded,
      restoringArchivedSessionIds,
    ).map((session) => ({
      ...session,
      externallyInUse: externallyInUseSessionIds.has(session.sessionId),
    })),
    [activeSessions, archivedQuerySessions, archivedLoaded, externallyInUseSessionIds, restoringArchivedSessionIds],
  );
  const archivedLoading = archivedLoaded && !archivedSessionsFetched;
  const tasksQuery = useTasksQuery();
  const tasks = tasksQuery.data ?? [];
  const { data: taskGroups = [] } = useTaskGroupsQuery();
  const { data: openChecklistItems = [] } = useOpenChecklistItemsQuery();

  const [railExpanded, setRailExpanded] = useState(true);
  const [quickChatsExpanded, setQuickChatsExpanded] = useState(() => {
    try { return localStorage.getItem("bridge-quick-chats-expanded") === "true"; } catch { return false; }
  });
  const persistQuickChatsExpanded = useCallback((v: boolean | ((prev: boolean) => boolean)) => {
    setQuickChatsExpanded((prev) => {
      const next = typeof v === "function" ? v(prev) : v;
      try { localStorage.setItem("bridge-quick-chats-expanded", String(next)); } catch {}
      return next;
    });
  }, []);
  const [restartBanner, setRestartBanner] = useState<RestartBannerState>({
    phase: null, restartPhase: "idle",
    waitingSessions: 0, canAcceptNewWork: true,
    shouldReload: false,
    reconnectedSincePending: false,
    pendingSnapshotSeen: false,
    pendingServerInstanceId: null,
  });
  const [backendStatusBanner, setBackendStatusBanner] = useState(createBackendStatusBannerState);
  const [sessionReloadSignals, setSessionReloadSignals] = useState<Record<string, number>>({});
  const [taskCompletionFeedback, setTaskCompletionFeedback] = useState<TaskCompletionFeedback | null>(null);
  // Incremented per-session when an external source (e.g. schedule) starts work
  const [sessionBusySignals, setSessionBusySignals] = useState<Record<string, number>>({});
  const [sessionHistorySignals, setSessionHistorySignals] = useState<Record<string, number>>({});
  const sessionBusyHintExpiresAtRef = useRef<Record<string, number>>({});

  // Settings query (shared with useTheme, SettingsView, etc.)
  const { data: settings, isLoading: settingsLoading } = useSettingsQuery();
  const { data: restartStatus, refetch: refetchRestartStatus } = useRestartStatusQuery();
  useFavicon(settings?.favicon);

  // Buffer task:changed SSE invalidations during optimistic task mutations so
  // concurrent server-side checklist changes are flushed instead of dropped.
  const taskChangeInvalidator = useMemo(
    () => createDeferredTaskChangeInvalidator(queryClient),
    [queryClient],
  );

  useEffect(() => {
    if (!restartStatus) return;
    setRestartBanner((prev) => reduceRestartBannerState(prev, {
      type: "snapshot:restart-status",
      pending: restartStatus.pending, phase: restartStatus.phase,
      waitingSessions: restartStatus.waitingSessions, canAcceptNewWork: restartStatus.canAcceptNewWork,
      serverInstanceId: restartStatus.serverInstanceId,
    }));
  }, [restartStatus?.pending, restartStatus?.phase, restartStatus?.waitingSessions, restartStatus?.canAcceptNewWork, restartStatus?.requestedAt, restartStatus?.serverInstanceId]);

  // Derive active IDs and mode from URL
  const mobileRouteMeta = getMobileRouteMeta(location.pathname, location.search);
  const activeSessionId = mobileRouteMeta.sessionId;
  const activeTaskId = mobileRouteMeta.taskId;
  const { task: selectedTask, taskNotFound } = useActiveTask(
    activeTaskId,
    tasks,
    !tasksQuery.isPending,
  );
  const activeComposerKey = getComposerKeyFromPathname(location.pathname);
  const quickChatsRoute = mobileRouteMeta.route === "chat-list";
  const quickChatsMode = quickChatsRoute || mobileRouteMeta.route === "quick-chat";
  const mobileScrollRestorationPolicy = isMobile
    ? getMobileScrollRestorationPolicy(mobileRouteMeta, {
        navigationType,
        locationState: location.state,
      })
    : null;
  const mobileDashboardScrollRestoration = mobileScrollRestorationPolicy?.key === "mobile:dashboard"
    ? mobileScrollRestorationPolicy
    : undefined;
  const mobileTaskListScrollRestoration = mobileScrollRestorationPolicy?.key === "mobile:tasks:list"
    || mobileScrollRestorationPolicy?.key === "mobile:chats:list"
    ? mobileScrollRestorationPolicy
    : undefined;
  const mobileTaskCockpitScrollRestoration = activeTaskId
    && mobileScrollRestorationPolicy?.key === `mobile:task-cockpit:${activeTaskId}`
    ? mobileScrollRestorationPolicy
    : undefined;
  const mobileTaskDashboardScrollRestoration = activeTaskId
    && mobileScrollRestorationPolicy?.key === `mobile:task-dashboard:${activeTaskId}`
    ? mobileScrollRestorationPolicy
    : undefined;

  // Auto-expand quick chats section when entering quick-chats mode on desktop
  useEffect(() => {
    if (!isMobile && quickChatsMode) {
      persistQuickChatsExpanded(true);
    }
  }, [quickChatsMode, isMobile]);

  const { isUnread, markRead, markUnread, unreadCount, applyServerState } = useReadState();
  const renderedReadThroughRef = useRef<Record<string, string>>({});
  const [renderedReadThroughState, setRenderedReadThroughState] = useState<Record<string, string>>({});
  const rememberRenderedReadThrough = useCallback((sessionId: string, readThroughActivityAt: string) => {
    const readThroughTime = Date.parse(readThroughActivityAt);
    if (!Number.isFinite(readThroughTime)) return;
    const normalizedReadThrough = new Date(readThroughTime).toISOString();
    const current = renderedReadThroughRef.current[sessionId];
    const currentTime = current ? Date.parse(current) : Number.NaN;
    if (Number.isFinite(currentTime) && currentTime >= readThroughTime) return;

    renderedReadThroughRef.current = {
      ...renderedReadThroughRef.current,
      [sessionId]: normalizedReadThrough,
    };
    setRenderedReadThroughState((prev) => {
      const prevTime = prev[sessionId] ? Date.parse(prev[sessionId]) : Number.NaN;
      if (Number.isFinite(prevTime) && prevTime >= readThroughTime) return prev;
      return { ...prev, [sessionId]: normalizedReadThrough };
    });
  }, []);
  const markReadThroughRendered = useCallback((sessionId: string) => {
    const session = sessions.find((candidate) => candidate.sessionId === sessionId);
    const readThroughActivityAt = getSessionReadThroughActivityTime(
      session,
      renderedReadThroughRef.current[sessionId],
    );
    if (!readThroughActivityAt || !isUnread(sessionId, readThroughActivityAt)) return;
    markRead(sessionId, readThroughActivityAt);
  }, [isUnread, markRead, sessions]);
  // Ref for read-state SSE handler (avoids stale closure in useCallback)
  const applyServerStateRef = useRef(applyServerState);
  applyServerStateRef.current = applyServerState;
  const {
    getDraft,
    setDraft,
    setDraftImmediate,
    setDraftLaunchOptions,
    clearDraft,
    hasDraft,
  } = useDrafts(sessions);
  const [draftSessionMap, setDraftSessionMap] = useState<Record<string, string>>({});

  const getDraftSession = useCallback((composerKey: string) => {
    return draftSessionMap[composerKey] ?? null;
  }, [draftSessionMap]);

  const rememberDraftSession = useCallback((composerKey: string, sessionId: string) => {
    setDraftSessionMap((prev) => (
      prev[composerKey] === sessionId
        ? prev
        : { ...prev, [composerKey]: sessionId }
    ));
  }, []);

  const clearDraftSession = useCallback((composerKey: string) => {
    setDraftSessionMap((prev) => {
      if (!(composerKey in prev)) return prev;
      const next = { ...prev };
      delete next[composerKey];
      return next;
    });
  }, []);

  const clearDraftSessionBySessionId = useCallback((sessionId: string) => {
    setDraftSessionMap((prev) => {
      let changed = false;
      const next: Record<string, string> = {};

      for (const [composerKey, mappedSessionId] of Object.entries(prev)) {
        if (mappedSessionId === sessionId) {
          changed = true;
          continue;
        }
        next[composerKey] = mappedSessionId;
      }

      return changed ? next : prev;
    });
  }, []);

  // Helper to invalidate session/task/group queries
  const invalidateSessions = useCallback(() =>
    queryClient.invalidateQueries({ queryKey: queryKeys.sessions({ includeArchived: false }), exact: true }), [queryClient]);
  const invalidateAllSessionQueries = useCallback(() =>
    queryClient.invalidateQueries({ queryKey: ["sessions"] }), [queryClient]);
  const invalidateTasks = useCallback(() =>
    queryClient.invalidateQueries({ queryKey: queryKeys.tasks }), [queryClient]);
  const invalidateDashboard = useCallback(() =>
    queryClient.invalidateQueries({ queryKey: queryKeys.dashboard }), [queryClient]);
  const invalidateFeed = useCallback(() =>
    queryClient.invalidateQueries({ queryKey: queryKeys.feed() }), [queryClient]);
  const invalidateOpenChecklistItems = useCallback(() =>
    queryClient.invalidateQueries({ queryKey: queryKeys.openChecklistItems }), [queryClient]);
  const invalidateTaskGroups = useCallback(() =>
    queryClient.invalidateQueries({ queryKey: queryKeys.taskGroups }), [queryClient]);

  const requestArchivedSessions = useCallback(() => {
    if (archivedLoaded) return;
    setArchivedLoaded(true);
  }, [archivedLoaded]);

  const trackArchiveTransition = useCallback((sessionId: string, archived: boolean) => {
    setRestoringArchivedSessionIds((prev) => {
      const next = new Set(prev);
      if (archived) next.delete(sessionId);
      else next.add(sessionId);
      return next.size === prev.size && [...next].every((id) => prev.has(id)) ? prev : next;
    });
  }, []);

  useEffect(() => {
    if (restoringArchivedSessionIds.size === 0) return;
    const activeSessionIds = new Set(activeSessions.map((session) => session.sessionId));
    setRestoringArchivedSessionIds((prev) => {
      const next = new Set([...prev].filter((sessionId) => !activeSessionIds.has(sessionId)));
      return next.size === prev.size ? prev : next;
    });
  }, [activeSessions, restoringArchivedSessionIds]);

  // Real-time status updates via SSE
  const patchSessionsInCache = useCallback((sessionIds: string[], patch: Partial<Session>) => {
    patchSessionQueryData(queryClient, sessionIds, patch);
  }, [queryClient]);
  const patchSessionInCache = useCallback((sessionId: string, patch: Partial<Session>) => {
    patchSessionsInCache([sessionId], patch);
  }, [patchSessionsInCache]);
  const buildTaskCompletionFeedback = useCallback((
    task: Task,
    previousStatus: Task["status"],
  ) => {
    const checklistItems = queryClient.getQueryData<ChecklistItem[]>(queryKeys.taskChecklistItems(task.id)) ?? [];
    const enriched = queryClient.getQueryData<EnrichedTaskData>(queryKeys.taskEnriched(task.id));

    return createTaskCompletionFeedback({
      task,
      previousStatus,
      checklistItems,
      linkedSessions: sessions.filter((session) => task.sessionIds.includes(session.sessionId)),
      pullRequests: enriched?.pullRequests,
    });
  }, [queryClient, sessions]);
  const bumpSessionBusySignal = useCallback((sessionId?: string) => {
    if (!sessionId) return;
    sessionBusyHintExpiresAtRef.current[sessionId] = Date.now() + SESSION_BUSY_SIGNAL_GRACE_MS;
    setSessionBusySignals((prev) => ({
      ...prev,
      [sessionId]: (prev[sessionId] ?? 0) + 1,
    }));
  }, []);
  const clearSessionBusyHint = useCallback((sessionId?: string) => {
    if (!sessionId) return;
    delete sessionBusyHintExpiresAtRef.current[sessionId];
  }, []);
  const bumpSessionHistorySignal = useCallback((sessionId?: string) => {
    if (!sessionId) return;
    setSessionHistorySignals((prev) => ({
      ...prev,
      [sessionId]: (prev[sessionId] ?? 0) + 1,
    }));
  }, []);

  useStatusStream(useCallback((event) => {
    switch (event.type) {
      case "session:busy":
        if (event.sessionId) {
          patchSessionInCache(event.sessionId, { runState: "busy" });
          bumpSessionBusySignal(event.sessionId);
        }
        invalidateDashboard();
        break;
      case "session:stalled":
        if (event.sessionId) {
          patchSessionInCache(event.sessionId, { runState: "stalled" });
        }
        invalidateDashboard();
        break;
      case "session:idle":
        if (event.sessionId) {
          clearSessionBusyHint(event.sessionId);
          patchSessionInCache(event.sessionId, { runState: "idle", intentText: null });
        }
        // Reload to pick up updated visible activity timestamps so unread dots appear immediately
        invalidateSessions();
        invalidateDashboard();
        break;
      case "session:intent":
        if (event.sessionId) {
          patchSessionInCache(event.sessionId, { intentText: event.intent ?? null });
        }
        invalidateDashboard();
        break;
      case "session:title":
        if (event.sessionId && event.title) {
          patchSessionInCache(event.sessionId, { summary: event.title });
        }
        invalidateDashboard();
        break;
      case "session:archived":
        if (event.sessionId && typeof event.archived === "boolean") {
          trackArchiveTransition(event.sessionId, event.archived);
          patchSessionInCache(event.sessionId, { archived: event.archived });
        }
        invalidateAllSessionQueries();
        break;
      case "session:agents":
        if (event.sessionId && event.backgroundAgents) {
          patchSessionInCache(event.sessionId, { backgroundAgents: event.backgroundAgents });
        }
        break;
      case "sessions:changed":
        invalidateAllSessionQueries();
        invalidateDashboard();
        break;
      case "session:user-input":
        if (event.sessionId) {
          const pendingUserInputCount = event.pendingUserInputCount ?? 0;
          patchSessionInCache(event.sessionId, {
            pendingUserInputCount,
            needsUserInput: event.needsUserInput ?? pendingUserInputCount > 0,
          });
        }
        invalidateDashboard();
        break;
      case "session:defer-summary":
        if (event.sessionId && event.deferSummary) {
          patchSessionInCache(event.sessionId, { deferSummary: event.deferSummary });
        }
        break;
      case "session:history-truncated":
        if (event.sessionId) {
          bumpSessionHistorySignal(event.sessionId);
        }
        break;
      case "server:restart-pending":
        void queryClient.invalidateQueries({ queryKey: queryKeys.restartStatus });
        setRestartBanner((prev) => reduceRestartBannerState(prev, {
          type: "server:restart-pending", phase: event.phase,
          waitingSessions: event.waitingSessions, canAcceptNewWork: event.canAcceptNewWork,
          serverInstanceId: event.serverInstanceId,
        }));
        break;
      case "server:restart-cleared":
        void queryClient.invalidateQueries({ queryKey: queryKeys.restartStatus });
        setRestartBanner((prev) => reduceRestartBannerState(prev, {
          type: "server:restart-cleared",
          serverInstanceId: event.serverInstanceId,
        }));
        break;
      case "backend:status":
        void queryClient.invalidateQueries({ queryKey: queryKeys.bridgeRuntimeStatus });
        setBackendStatusBanner((prev) => reduceBackendStatusBannerState(prev, {
          type: "backend:status",
          agentBackend: event.agentBackend,
        }));
        break;
      case "schedule:triggered":
        // Schedule started work — refresh session list, task data, and schedule run history
        invalidateSessions();
        invalidateTasks();
        if (event.taskId) {
          queryClient.invalidateQueries({ queryKey: queryKeys.task(event.taskId) });
        }
        if (event.scheduleId) {
          queryClient.invalidateQueries({ queryKey: queryKeys.scheduleSessions(event.scheduleId) });
        }
        if (event.sessionId) {
          bumpSessionBusySignal(event.sessionId);
        }
        break;
      case "schedule:changed":
        queryClient.invalidateQueries({ queryKey: ["task"] });
        break;
      case "task:changed":
        taskChangeInvalidator.handleTaskChange(event.taskId);
        break;
      case "management-job:changed":
        void queryClient.invalidateQueries({ queryKey: queryKeys.managementJobsRoot });
        break;
      case "feed:changed":
        invalidateFeed();
        break;
      case "readstate:changed":
        if (event.readState) applyServerStateRef.current(event.readState);
        break;
      case "status:connected":
        void refetchRestartStatus();
        setRestartBanner((prev) => reduceRestartBannerState(prev, { type: "status:connected" }));
        // Refresh sessions and lightweight Home urgency data on reconnect.
        invalidateSessions();
        invalidateDashboard();
        invalidateFeed();
        invalidateOpenChecklistItems();
        break;
    }
  }, [bumpSessionBusySignal, bumpSessionHistorySignal, clearSessionBusyHint, patchSessionInCache, trackArchiveTransition, invalidateAllSessionQueries, invalidateDashboard, invalidateFeed, invalidateOpenChecklistItems, invalidateSessions, invalidateTasks, queryClient, refetchRestartStatus, taskChangeInvalidator]));
  useEffect(() => {
    if (!restartBanner.shouldReload) return;
    const timer = window.setTimeout(() => window.location.reload(), 1000);
    return () => clearTimeout(timer);
  }, [restartBanner.shouldReload]);

  useEffect(() => {
    if (backendStatusBanner.recoveryExpiresAt === null) return;
    const delayMs = Math.max(0, backendStatusBanner.recoveryExpiresAt - Date.now());
    const timer = window.setTimeout(() => {
      setBackendStatusBanner((prev) => reduceBackendStatusBannerState(prev, { type: "tick" }));
    }, delayMs);
    return () => clearTimeout(timer);
  }, [backendStatusBanner.recoveryExpiresAt]);

  const previousTasksRef = useRef<Map<string, Task>>(new Map());

  useEffect(() => {
    const previousTasks = previousTasksRef.current;
    const reopenedTaskIds = new Set<string>();
    const completedTasks: Array<{ feedback: TaskCompletionFeedback; sortTime: number }> = [];
    for (const task of tasks) {
      const previousTask = previousTasks.get(task.id);
      if (!previousTask) continue;
      if (!isTaskCompleted(previousTask) && isTaskCompleted(task)) {
        completedTasks.push({
          feedback: buildTaskCompletionFeedback(task, previousTask.status),
          sortTime: new Date(task.completedAt ?? task.updatedAt).getTime(),
        });
        continue;
      }

      if (isTaskCompleted(previousTask) && !isTaskCompleted(task)) {
        reopenedTaskIds.add(task.id);
      }
    }

    if (reopenedTaskIds.size > 0) {
      setTaskCompletionFeedback((current) => (current && reopenedTaskIds.has(current.taskId) ? null : current));
      for (const taskId of reopenedTaskIds) dismissToast(`task-completion-${taskId}`);
    }

    if (completedTasks.length > 0) {
      completedTasks.sort((left, right) => right.sortTime - left.sortTime);
      setTaskCompletionFeedback(completedTasks[0].feedback);
    }

    previousTasksRef.current = new Map(tasks.map((task) => [task.id, task]));
  }, [tasks, buildTaskCompletionFeedback, dismissToast]);

  const previousActiveSessionIdRef = useRef<string | null>(null);
  const dwelledSessionIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!activeSessionId || !activeTaskId) return;
    setLastViewedSession(activeTaskId, activeSessionId);
  }, [activeSessionId, activeTaskId]);

  // Background tabs should not clear unread state just because they still
  // have the session selected.
  useEffect(() => {
    const previousSessionId = previousActiveSessionIdRef.current;
    if (
      pageHasAttention &&
      previousSessionId &&
      previousSessionId !== activeSessionId &&
      dwelledSessionIdRef.current === previousSessionId
    ) {
      markReadThroughRendered(previousSessionId);
    }
    previousActiveSessionIdRef.current = activeSessionId;
  }, [activeSessionId, pageHasAttention, markReadThroughRendered]);

  useEffect(() => {
    if (!activeSessionId || !pageHasAttention) {
      dwelledSessionIdRef.current = null;
      return;
    }

    dwelledSessionIdRef.current = null;
    const timer = window.setTimeout(() => {
      if (!pageHasAttentionRef.current) return;
      dwelledSessionIdRef.current = activeSessionId;
      markReadThroughRendered(activeSessionId);
    }, 2000);

    return () => {
      window.clearTimeout(timer);
    };
  }, [activeSessionId, pageHasAttention, markReadThroughRendered]);

  useEffect(() => {
    if (!activeSessionId) return;

    const onPageHide = () => {
      if (!pageHasAttentionRef.current) return;
      if (dwelledSessionIdRef.current !== activeSessionId) return;
      const session = sessions.find((candidate) => candidate.sessionId === activeSessionId);
      const readThroughActivityAt = getSessionReadThroughActivityTime(
        session,
        renderedReadThroughRef.current[activeSessionId],
      );
      if (!readThroughActivityAt) return;
      markSessionReadOnPageHide(activeSessionId, { readThroughActivityAt });
    };

    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [activeSessionId, sessions]);

  // Track last-active task and quick chat for tab restore
  useEffect(() => {
    if (activeTaskId) setLastActiveTask(activeTaskId);
  }, [activeTaskId]);
  useEffect(() => {
    if (activeSessionId && !activeTaskId && quickChatsMode) {
      setLastActiveQuickChat(activeSessionId);
    }
  }, [activeSessionId, activeTaskId, quickChatsMode]);

  const activeRenderedReadThrough = activeSessionId ? renderedReadThroughState[activeSessionId] : undefined;
  const activeReadThroughActivityAt = activeSessionId
    ? getSessionReadThroughActivityTime(
      sessions.find((candidate) => candidate.sessionId === activeSessionId),
      activeRenderedReadThrough,
    )
    : undefined;

  useEffect(() => {
    if (
      !pageHasAttention ||
      !activeSessionId ||
      !activeReadThroughActivityAt ||
      dwelledSessionIdRef.current !== activeSessionId
    ) {
      return;
    }
    markReadThroughRendered(activeSessionId);
  }, [activeSessionId, activeReadThroughActivityAt, markReadThroughRendered, pageHasAttention]);

  // Optimistic insert
  const addOptimisticSession = useCallback((sessionId: string, overrides: Partial<Session> = {}) => {
    const now = new Date();
    const timestamp = now.toISOString();
    queryClient.setQueryData<Session[]>(queryKeys.sessions({ includeArchived: false }), (prev) => {
      if (!prev || prev.some((s) => s.sessionId === sessionId)) return prev;
      const baseSession: Session = {
        sessionId,
        summary: "New session",
        modifiedTime: timestamp,
        lastVisibleActivityAt: timestamp,
        runState: "idle",
        eventLogSizeBytes: 0,
        deferSummary: { count: 0, nextRunAt: null },
        isOptimistic: true,
        optimisticUntil: now.getTime() + OPTIMISTIC_SESSION_TTL_MS,
      };
      const optimisticSession: Session = {
        ...baseSession,
        ...overrides,
        sessionId,
        deferSummary: overrides.deferSummary ?? baseSession.deferSummary,
        isOptimistic: true,
        optimisticUntil: overrides.optimisticUntil ?? baseSession.optimisticUntil,
      };
      return [{
        ...optimisticSession,
      }, ...prev];
    });
  }, [queryClient]);

  const linkOptimisticTaskSession = useCallback((taskId: string, sessionId: string) => {
    const addSessionToTask = (task: Task): Task =>
      task.id === taskId && !task.sessionIds.includes(sessionId)
        ? { ...task, sessionIds: [...task.sessionIds, sessionId] }
        : task;

    updateTaskInQueryCaches(queryClient, taskId, addSessionToTask);
  }, [queryClient]);

  const patchVoiceSessionActivityInCache = useCallback((activity: VoiceSessionActivity) => {
    const intent = getVoiceSessionIntent(activity.status);
    queryClient.setQueriesData<Session[]>({ queryKey: ["sessions"] }, (prev) => {
      if (!prev) return prev;
      let changed = false;
      const next = prev.map((session) => {
        if (session.sessionId !== activity.sessionId) return session;
        changed = true;
        const existingIntent = session.intentText?.trim() ?? "";
        const preserveExistingIntent = isSessionActive(session)
          && existingIntent.length > 0
          && !isVoiceSessionIntent(existingIntent);
        return {
          ...session,
          runState: session.runState === "stalled" ? "stalled" as const : "busy" as const,
          intentText: preserveExistingIntent ? session.intentText : intent,
        };
      });
      return changed ? next : prev;
    });
  }, [queryClient]);

  const handleVoiceSessionActivity = useCallback((activity: VoiceSessionActivity) => {
    const intent = getVoiceSessionIntent(activity.status);
    addOptimisticSession(activity.sessionId, {
      runState: "busy",
      intentText: intent,
    });
    patchVoiceSessionActivityInCache(activity);
    if (activity.statusChanged !== false) {
      bumpSessionBusySignal(activity.sessionId);
    }
    if (activity.taskId) {
      linkOptimisticTaskSession(activity.taskId, activity.sessionId);
    }
  }, [addOptimisticSession, bumpSessionBusySignal, linkOptimisticTaskSession, patchVoiceSessionActivityInCache]);

  const handleVoiceSessionSettled = useCallback((settled: VoiceSessionSettled) => {
    if (settled.status !== "done") {
      clearSessionBusyHint(settled.sessionId);
    }
    void invalidateSessions();
    if (settled.taskId) {
      void invalidateTasks();
    }
  }, [clearSessionBusyHint, invalidateSessions, invalidateTasks]);

  // Sessions not linked to any task
  const globalSessions = useMemo(() => {
    return getQuickChatSessions(sessions, tasks);
  }, [sessions, tasks]);
  const navTaskIndicators = useTaskIndicators(tasks, sessions, isUnread, activeSessionId);
  const mobileTaskAttention = useMemo(() => {
    return summarizeTaskTabAttention(tasks, navTaskIndicators);
  }, [tasks, navTaskIndicators]);
  const mobileChatAttention = useMemo(() => {
    return summarizeChatTabAttention(globalSessions, isUnread, activeSessionId);
  }, [globalSessions, isUnread, activeSessionId]);
  const homeChecklistIndicator = useMemo(() => {
    return getHomeChecklistIndicator(openChecklistItems);
  }, [openChecklistItems]);

  // ── Browser tab title ────────────────────────────────────────
  // DocsView publishes its resolved page title upward; everything else is
  // derived from the route plus the task/session it points at.
  const [docTitle, setDocTitle] = useState<string | null>(null);
  const activeSessionForTitle = activeSessionId
    ? sessions.find((s) => s.sessionId === activeSessionId)
    : undefined;
  const documentTitle = resolveDocumentTitle({
    route: mobileRouteMeta.route,
    pathname: location.pathname,
    isDraft: mobileRouteMeta.isDraft,
    taskTitle: selectedTask?.id === activeTaskId ? selectedTask?.title : null,
    sessionLabel: activeSessionForTitle?.summary || activeSessionForTitle?.intentText,
    docTitle,
    docPath: mobileRouteMeta.docPath,
    unreadCount: mobileTaskAttention.count + mobileChatAttention.count,
  });
  useDocumentTitle(documentTitle);

  const [archivingIds, setArchivingIds] = useState<Set<string>>(new Set());
  const [exitingIds, setExitingIds] = useState<Set<string>>(new Set());
  const EXIT_ANIM_MS = 300;

  // Given a list of sessions, return the next active sibling when one is removed
  const getNextSessionId = useCallback((removedId: string): string | null => {
    // Determine the right scope: task-linked sessions or orphan sessions
    const activeTask = location.pathname.match(/^\/tasks\/([^/]+)/)?.[1] ?? null;
    const scopedSessions = activeTask
      ? sessions.filter((s) => tasks.find((t) => t.id === activeTask)?.sessionIds.includes(s.sessionId))
      : globalSessions;
    const visible = scopedSessions.filter((s) => !s.archived && !archivingIds.has(s.sessionId) && s.sessionId !== removedId);
    if (visible.length === 0) return null;
    // Find position of removed session in original list, pick the next one (below), else previous (above)
    const allVisible = scopedSessions.filter((s) => !s.archived && !archivingIds.has(s.sessionId));
    const idx = allVisible.findIndex((s) => s.sessionId === removedId);
    if (idx >= 0 && idx < allVisible.length - 1) return allVisible[idx + 1].sessionId;
    if (idx > 0) return allVisible[idx - 1].sessionId;
    return visible[0].sessionId;
  }, [sessions, tasks, globalSessions, archivingIds, location.pathname]);

  // ── Navigation handlers ───────────────────────────────────────

  const handleSelectTask = (id: string, opts?: { checklistItemId?: string }) => {
    const checklistItemParam = opts?.checklistItemId ? `?checklistItem=${opts.checklistItemId}` : "";
    if (!isMobile) {
      const task = tasks.find((t) => t.id === id);
      if (task) {
        navigate(`${getTaskChatPath({
          task,
          sessions,
          lastViewedSessionId: getLastViewedSession(id),
        })}${checklistItemParam}`);
        return;
      }
    }
    navigate(`/tasks/${id}${checklistItemParam}`);
  };

  const handleSelectQuickChats = () => {
    const lastChatId = getLastActiveQuickChat();
    // Validate the remembered chat still exists as an orphan (not linked to a task)
    const isValidQuickChat = lastChatId &&
      globalSessions.some((s) => s.sessionId === lastChatId && !s.archived) &&
      !tasks.some((t) => t.sessionIds.includes(lastChatId));

    if (isValidQuickChat) {
      navigate(`/sessions/${lastChatId}`);
    } else {
      navigate("/chats");
    }
    if (!railExpanded) setRailExpanded(true);
  };

  const handleOpenTaskList = useCallback(() => {
    navigate("/");
  }, [navigate]);

  const handleOpenDashboard = useCallback(() => {
    navigate(getRememberedDashboardPath(location.pathname));
  }, [location.pathname, navigate]);

  const handleOpenQuickChatsList = () => {
    navigate("/chats");
  };

  const handleOpenSettings = () => {
    navigate("/settings");
  };

  const handleOpenDocsRoot = useCallback(() => {
    navigate("/docs");
  }, [navigate]);

  const handleOpenDocs = useCallback(() => {
    const lastDoc = getLastViewedDoc();
    if (lastDoc) {
      // Stored as "path" or "path?db" for DB folders
      const isDb = lastDoc.endsWith("?db");
      const docPath = isDb ? lastDoc.slice(0, -3) : lastDoc;
      navigate(isDb ? `/docs/${docPath}?db` : `/docs/${docPath}`);
    } else {
      handleOpenDocsRoot();
    }
  }, [handleOpenDocsRoot, navigate]);

  const isDocsActive = mobileRouteMeta.activeTab === "docs";
  const isDashboardActive = location.pathname === "/" || isDashboardRoutePath(location.pathname);

  // ── Mobile bottom nav state ──────────────────────────────────
  const mobileActiveTab = mobileRouteMeta.activeTab;

  const handleRailTabChange = (tab: "tasks" | "chats") => {
    if (tab === "tasks") {
      const lastTaskId = getLastActiveTask();
      if (lastTaskId) {
        const task = tasks.find((t) => t.id === lastTaskId);
        if (task) {
          handleSelectTask(lastTaskId);
          return;
        }
      }
      handleOpenTaskList();
    } else {
      handleSelectQuickChats();
    }
  };

  const handleMobileTab = useCallback((tab: "home" | "tasks" | "chats" | "docs" | "settings") => {
    switch (tab) {
      case "home": handleOpenDashboard(); break;
      case "tasks": handleOpenTaskList(); break;
      case "chats": handleOpenQuickChatsList(); break;
      case "docs": handleOpenDocsRoot(); break;
      case "settings": handleOpenSettings(); break;
    }
  }, [handleOpenDashboard, handleOpenTaskList, handleOpenQuickChatsList, handleOpenDocsRoot, handleOpenSettings]);

  const handleMobileUp = useCallback(() => {
    const upTarget = mobileRouteMeta.upTarget;
    if (!upTarget) return;
    navigate(upTarget.to, { state: createBridgeMobileScrollRestoreState() });
  }, [mobileRouteMeta.upTarget, navigate]);

  const handleSelectSession = (sessionId: string) => {
    navigate(getSessionPath({ sessionId, taskId: activeTaskId }));
  };

  const handleNewSession = (taskId: string) => {
    navigate(getTaskDraftSessionPath(taskId));
  };

  const handleNewQuickChat = () => {
    navigate(`/sessions/new`);
  };

  const navigateToSession = useCallback((sessionId: string, taskId?: string, replace = false) => {
    navigate(getSessionPath({ sessionId, taskId }), { replace });
  }, [navigate]);

  const addPendingPromptSession = useCallback((sessionId: string) => {
    addOptimisticSession(sessionId, { runState: "busy" });
    bumpSessionBusySignal(sessionId);
    markRead(sessionId);
  }, [addOptimisticSession, bumpSessionBusySignal, markRead]);
  const clearPendingPromptSession = useCallback((sessionId: string) => {
    clearSessionBusyHint(sessionId);
    patchSessionInCache(sessionId, { runState: "idle", intentText: null });
  }, [clearSessionBusyHint, patchSessionInCache]);

  const cleanupRejectedFirstSendSession = useCallback((sessionId: string, taskId?: string) =>
    cleanupFailedFirstSendSession({
      sessionId,
      taskId,
      queryClient,
      clearPendingPromptSession,
      clearDraft,
      clearDraftSessionBySessionId,
      clearLastViewedSession,
      clearLastActiveQuickChat,
      invalidateAllSessionQueries,
      invalidateTasks,
    }), [
      clearDraft,
      clearDraftSessionBySessionId,
      clearPendingPromptSession,
      invalidateAllSessionQueries,
      invalidateTasks,
      queryClient,
    ]);

  // Actually create a session on the server (called on first message send)
  const materializeSession = useCallback(async (
    taskId?: string,
    options?: CreateSessionOptions,
  ): Promise<string> => {
    if (taskId) {
      const sessionId = await createTaskSession(taskId, options);
      addPendingPromptSession(sessionId);
      const addSession = (t: Task) =>
        t.id === taskId ? { ...t, sessionIds: [...t.sessionIds, sessionId] } : t;
      updateTaskInQueryCaches(queryClient, taskId, addSession);
      return sessionId;
    } else {
      const sessionId = await createSession(options);
      addPendingPromptSession(sessionId);
      return sessionId;
    }
  }, [addPendingPromptSession, queryClient]);

  const handleStartPromptSession = useCallback(async (
    prompt: string,
    taskId?: string,
    options?: StartPromptSessionOptions,
  ) => {
    const newSessionId = await materializeSession(taskId);
    // Send before navigating so the destination reconnect sees an active stream.
    await sendMaterializedFirstPrompt({
      sessionId: newSessionId,
      prompt,
      onRejected: async () => {
        await cleanupRejectedFirstSendSession(newSessionId, taskId);
        if (options?.navigateOnError === false) {
          return;
        }

        setDraftImmediate(getDraftComposerKey(taskId), prompt);
        navigate(taskId ? getTaskDraftSessionPath(taskId) : "/sessions/new");
      },
    });
    return newSessionId;
  }, [cleanupRejectedFirstSendSession, materializeSession, navigate, setDraftImmediate]);

  const isSessionBusy = useCallback((sessionId: string) => {
    const busyHintExpiresAt = sessionBusyHintExpiresAtRef.current[sessionId];
    if (busyHintExpiresAt && busyHintExpiresAt > Date.now()) {
      return true;
    }
    if (busyHintExpiresAt) {
      delete sessionBusyHintExpiresAtRef.current[sessionId];
    }
    return sessions.some((session) => session.sessionId === sessionId && isSessionActive(session));
  }, [sessions]);

  const {
    getJobForComposer,
    startBackgroundVoiceJob,
    retryVoiceJobUpload,
    reviewInstead,
    clearVoiceJobError,
    discardVoiceRecording,
    migrateVoiceRecording,
  } = useBackgroundVoiceJobs({
    activeComposerKey,
    getDraft,
    setDraft,
    setDraftImmediate,
    clearDraft,
    rememberDraftSession,
    clearDraftSession,
    materializeSession,
    isSessionBusy,
    navigateToSession,
    refreshSessions: () => {
      void invalidateSessions();
    },
    refreshTasks: () => {
      void invalidateTasks();
    },
    onVoiceSessionActivity: handleVoiceSessionActivity,
    onVoiceSessionSettled: handleVoiceSessionSettled,
  });

  /**
   * Drops every piece of client-side state keyed to a composer that is going away for good.
   * Session deletion has more than one entry point, so all per-composer stores are retired here
   * to keep them from drifting apart.
   */
  const retireComposer = useCallback((sessionId: string) => {
    clearDraft(sessionId);
    discardVoiceRecording(sessionId);
    clearDraftSessionBySessionId(sessionId);
    clearLastViewedSession(sessionId);
    clearLastActiveQuickChat(sessionId);
  }, [clearDraft, clearDraftSessionBySessionId, discardVoiceRecording]);

  const handleNewTask = async (groupId?: string) => {
    try {
      const task = await createTask("New Task", { groupId });
      queryClient.setQueryData<Task[]>(queryKeys.tasks, (prev) => prev ? [task, ...prev] : [task]);
      navigate(`/tasks/${task.id}/sessions/new`);
    } catch (err) {
      console.error("Failed to create task:", err);
    }
  };

  const handleUpdateTask = async (
    taskId: string,
    updates: Parameters<typeof patchTask>[1],
  ): Promise<Task | null> => {
    try {
      const updated = await patchTask(taskId, updates);
      setTaskInQueryCaches(queryClient, updated);
      if (updates.status || updates.kind !== undefined || updates.completionAction) {
        // When status, kind, or completion changes, refetch all tasks since ordering can shift
        await queryClient.refetchQueries({ queryKey: queryKeys.tasks });
      }
      return updated;
    } catch (err) {
      console.error("Failed to update task:", err);
      return null;
    }
  };

  const handleReorderTasks = async (taskIds: string[]) => {
    // Optimistic: reorder in cache immediately
    queryClient.setQueryData<Task[]>(queryKeys.tasks, (prev) => {
      if (!prev) return prev;
      const map = new Map(prev.map((t) => [t.id, t]));
      const reordered = taskIds.map((id, i) => {
        const t = map.get(id);
        return t ? { ...t, order: i } : null;
      }).filter(Boolean) as Task[];
      const reorderedIds = new Set(taskIds);
      const rest = prev.filter((t) => !reorderedIds.has(t.id));
      return [...reordered, ...rest];
    });
    taskChangeInvalidator.beginTaskMutation();
    try {
      await reorderTasks(taskIds);
    } catch (err) {
      console.error("Failed to reorder tasks:", err);
      await queryClient.refetchQueries({ queryKey: queryKeys.tasks });
    } finally {
      taskChangeInvalidator.endTaskMutation();
    }
  };

  // Deleting a task used to silently orphan its linked sessions. The dialog
  // makes the caller choose, and the server refuses a disposition-less delete
  // whenever sessions are linked, so no entry point can skip the decision.
  const [pendingTaskDeletion, setPendingTaskDeletion] = useState<{
    task: Task;
    preview?: TaskDeletionPreview;
    previewError?: string;
    busy?: SessionDisposition;
    actionError?: string;
    /** Keeps polling after a lost response, while the server may still be working. */
    monitoring?: boolean;
  } | null>(null);

  const deletionProgress = useTaskDeletionProgress(
    pendingTaskDeletion?.task.id,
    pendingTaskDeletion?.busy === "delete" || pendingTaskDeletion?.monitoring === true,
    getTaskDeletionPreview,
  );

  const finishTaskDeletion = useCallback(async (taskId: string) => {
    setPendingTaskDeletion(null);
    clearLastActiveTask(taskId);
    navigate("/");
    await Promise.all([invalidateTasks(), invalidateAllSessionQueries()]);
  }, [navigate, invalidateTasks, invalidateAllSessionQueries]);

  // A delete that outlived its HTTP response still finishes server-side; the
  // poll noticing the task is gone stands in for the reply that never arrived.
  useEffect(() => {
    const taskId = pendingTaskDeletion?.task.id;
    if (!taskId || !deletionProgress.taskGone) return;
    void finishTaskDeletion(taskId);
  }, [deletionProgress.taskGone, pendingTaskDeletion?.task.id, finishTaskDeletion]);

  const handleDeleteTask = async (taskId: string) => {
    const task = tasks.find((t) => t.id === taskId);
    if (!task) return;
    setPendingTaskDeletion({ task });
    try {
      const preview = await getTaskDeletionPreview(taskId);
      setPendingTaskDeletion((prev) => (prev?.task.id === taskId ? { ...prev, preview } : prev));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setPendingTaskDeletion((prev) =>
        prev?.task.id === taskId ? { ...prev, previewError: message } : prev);
    }
  };

  const handleConfirmTaskDeletion = async (sessionDisposition: SessionDisposition) => {
    const pending = pendingTaskDeletion;
    if (!pending) return;
    const taskId = pending.task.id;
    setPendingTaskDeletion({ ...pending, busy: sessionDisposition, actionError: undefined });
    try {
      await deleteTask(taskId, { sessionDisposition, fingerprint: pending.preview?.fingerprint });
      await finishTaskDeletion(taskId);
    } catch (err) {
      console.error("Failed to delete task:", err);
      const apiError = err instanceof ApiError ? err : undefined;
      const details = apiError?.details as TaskDeletionErrorBody | undefined;
      const message = details?.message ?? (err instanceof Error ? err.message : String(err));
      // A transport failure (or a run already in flight) does not mean the
      // server stopped working, so keep polling instead of going idle. The task
      // always survives a failed disposition, so retrying from here is safe.
      const stillRunning = apiError === undefined || details?.error === "deletion_in_progress";
      setPendingTaskDeletion((prev) => prev && prev.task.id === taskId
        ? {
          ...prev,
          busy: undefined,
          monitoring: stillRunning,
          actionError: message,
          preview: details?.preview ?? prev.preview,
        }
        : prev);
      await Promise.all([invalidateTasks(), invalidateAllSessionQueries()]);
    }
  };

  // ── Task Group handlers ─────────────────────────────────────────

  const handleCreateGroup = async (name: string, color?: string) => {
    try {
      const group = await createTaskGroup(name, color);
      queryClient.setQueryData<TaskGroup[]>(queryKeys.taskGroups, (prev) =>
        prev ? [...prev, group] : [group],
      );
      return group;
    } catch (err) {
      console.error("Failed to create group:", err);
      return null;
    }
  };

  const handleUpdateGroup = async (groupId: string, updates: Partial<Pick<TaskGroup, "name" | "color" | "collapsed" | "notes">>) => {
    try {
      const updated = await patchTaskGroup(groupId, updates);
      queryClient.setQueryData<TaskGroup[]>(queryKeys.taskGroups, (prev) =>
        prev?.map((g) => (g.id === groupId ? updated : g)),
      );
    } catch (err) {
      console.error("Failed to update group:", err);
    }
  };

  const handleDeleteGroup = async (groupId: string) => {
    try {
      await deleteTaskGroup(groupId);
      queryClient.setQueryData<TaskGroup[]>(queryKeys.taskGroups, (prev) =>
        prev?.filter((g) => g.id !== groupId),
      );
      // Tasks in this group become ungrouped — refetch
      await queryClient.refetchQueries({ queryKey: queryKeys.tasks });
    } catch (err) {
      console.error("Failed to delete group:", err);
    }
  };

  const handleReorderGroups = async (groupIds: string[]) => {
    // Optimistic update
    queryClient.setQueryData<TaskGroup[]>(queryKeys.taskGroups, (prev) => {
      if (!prev) return prev;
      const map = new Map(prev.map((g) => [g.id, g]));
      const reordered = groupIds.map((id, i) => {
        const g = map.get(id);
        return g ? { ...g, order: i } : null;
      }).filter(Boolean) as TaskGroup[];
      const reorderedIds = new Set(groupIds);
      const rest = prev.filter((g) => !reorderedIds.has(g.id));
      return [...reordered, ...rest];
    });
    try {
      await reorderTaskGroups(groupIds);
    } catch (err) {
      console.error("Failed to reorder groups:", err);
      await queryClient.refetchQueries({ queryKey: queryKeys.taskGroups });
    }
  };

  const handleMoveTaskToGroup = async (taskId: string, groupId: string | undefined) => {
    // Optimistic update
    updateTaskInQueryCaches(queryClient, taskId, (task) => ({ ...task, groupId }));
    taskChangeInvalidator.beginTaskMutation();
    try {
      await patchTask(taskId, { groupId: groupId ?? ("" as any) });
    } catch (err) {
      console.error("Failed to move task to group:", err);
      await queryClient.refetchQueries({ queryKey: queryKeys.tasks });
    } finally {
      taskChangeInvalidator.endTaskMutation();
    }
  };

  const dismissTaskCompletionFeedback = useCallback((taskId: string) => {
    setTaskCompletionFeedback((current) => (current?.taskId === taskId ? null : current));
    dismissToast(`task-completion-${taskId}`);
  }, [dismissToast]);

  const handleUndoTaskCompletion = useCallback(async (feedback: TaskCompletionFeedback) => {
    const updated = await handleUpdateTask(feedback.taskId, {
      status: feedback.previousStatus,
    });
    if (updated) {
      dismissTaskCompletionFeedback(feedback.taskId);
    } else {
      showToast({
        tone: "error",
        title: `Could not reopen ${feedback.taskTitle}`,
        description: "The task could not be reopened. Try again from the task panel.",
      });
      dismissToast(`task-completion-${feedback.taskId}`);
    }
  }, [dismissTaskCompletionFeedback, dismissToast, handleUpdateTask, showToast]);

  // `handleUpdateTask` is recreated every render, so route the undo through a ref
  // to keep the toast effect keyed purely on newly completed tasks. Without this
  // the effect re-fires each render and keeps resetting the auto-dismiss timer.
  const undoTaskCompletionRef = useRef(handleUndoTaskCompletion);
  useEffect(() => {
    undoTaskCompletionRef.current = handleUndoTaskCompletion;
  });

  useEffect(() => {
    if (!taskCompletionFeedback) return;
    showToast(createTaskCompletionToast(
      taskCompletionFeedback,
      () => undoTaskCompletionRef.current(taskCompletionFeedback),
    ));
  }, [taskCompletionFeedback, showToast]);

  const handleMoveAndReorder = async (taskId: string, groupId: string | undefined, taskIds: string[]) => {
    updateTaskInQueryCaches(queryClient, taskId, (task) => ({ ...task, groupId }));
    queryClient.setQueryData<Task[]>(queryKeys.tasks, (prev) => {
      if (!prev) return prev;
      const map = new Map(prev.map((t) => [t.id, t]));
      const reordered = taskIds.map((id, i) => {
        const t = map.get(id);
        return t ? { ...t, order: i } : null;
      }).filter(Boolean) as Task[];
      const reorderedIds = new Set(taskIds);
      const rest = prev.filter((t) => !reorderedIds.has(t.id));
      return [...reordered, ...rest];
    });
    taskChangeInvalidator.beginTaskMutation();
    try {
      await patchTask(taskId, { groupId: groupId ?? ("" as any) });
      await reorderTasks(taskIds);
    } catch (err) {
      console.error("Failed to move and reorder:", err);
      await queryClient.refetchQueries({ queryKey: queryKeys.tasks });
    } finally {
      taskChangeInvalidator.endTaskMutation();
    }
  };

  // ── Tag handlers ────────────────────────────────────────────────

  const handleSetTaskTags = async (taskId: string, tagIds: string[]) => {
    try {
      const tags = await setTaskTags(taskId, tagIds);
      updateTaskInQueryCaches(queryClient, taskId, (task) => ({ ...task, tags }));
    } catch (err) {
      console.error("Failed to set task tags:", err);
    }
  };

  const handleSetGroupTags = async (groupId: string, tagIds: string[]) => {
    try {
      const tags = await setGroupTags(groupId, tagIds);
      queryClient.setQueryData<TaskGroup[]>(queryKeys.taskGroups, (prev) =>
        prev?.map((g) => (g.id === groupId ? { ...g, tags } : g)),
      );
    } catch (err) {
      console.error("Failed to set group tags:", err);
    }
  };

  const handleArchiveSession = async (sessionId: string, archived: boolean) => {
    const nextId = archived && activeSessionId === sessionId ? getNextSessionId(sessionId) : null;
    // Animate out before removing
    setExitingIds((prev) => new Set(prev).add(sessionId));
    if (archived && activeSessionId === sessionId) {
      if (nextId) {
        navigate(activeTaskId ? `/tasks/${activeTaskId}/sessions/${nextId}` : `/sessions/${nextId}`);
      } else if (activeTaskId) {
        navigate(`/tasks/${activeTaskId}`);
      } else {
        navigate("/");
      }
    }
    await new Promise((r) => setTimeout(r, EXIT_ANIM_MS));
    setArchivingIds((prev) => new Set(prev).add(sessionId));
    try {
      await patchSession(sessionId, { archived });
      trackArchiveTransition(sessionId, archived);
      patchSessionInCache(sessionId, {
        archived,
        archivedAt: archived ? new Date().toISOString() : undefined,
      });
      await invalidateAllSessionQueries();
    } catch (err) {
      console.error("Failed to archive session:", err);
    } finally {
      setArchivingIds((prev) => {
        const next = new Set(prev);
        next.delete(sessionId);
        return next;
      });
      setExitingIds((prev) => {
        const next = new Set(prev);
        next.delete(sessionId);
        return next;
      });
    }
  };

  const handleDeleteSession = async (sessionId: string) => {
    retireComposer(sessionId);
    const nextId = activeSessionId === sessionId ? getNextSessionId(sessionId) : null;
    // Animate out before removing
    setExitingIds((prev) => new Set(prev).add(sessionId));
    if (activeSessionId === sessionId) {
      if (nextId) {
        navigate(activeTaskId ? `/tasks/${activeTaskId}/sessions/${nextId}` : `/sessions/${nextId}`);
      } else if (activeTaskId) {
        navigate(`/tasks/${activeTaskId}`);
      } else {
        navigate("/");
      }
    }
    await new Promise((r) => setTimeout(r, EXIT_ANIM_MS));
    try {
      await deleteSession(sessionId);
      await Promise.all([invalidateAllSessionQueries(), invalidateTasks()]);
    } catch (err) {
      console.error("Failed to delete session:", err);
    } finally {
      setExitingIds((prev) => {
        const next = new Set(prev);
        next.delete(sessionId);
        return next;
      });
    }
  };

  const handleForkSession = async (sessionId: string, opts?: { toEventId?: string }) => {
    const linkedTaskId = tasks.find((task) => task.sessionIds.includes(sessionId))?.id;
    try {
      const accepted = await startSessionFork(sessionId, opts);
      const toastId = `session-fork-${accepted.job.id}`;
      showToast({
        id: toastId,
        tone: "info",
        title: accepted.reused ? "Fork already in progress" : "Creating fork in background",
        description: "Large sessions can take a while. You can keep using the app while the copy finishes.",
        loading: true,
        durationMs: 0,
      });

      if (monitoredForkJobIdsRef.current.has(accepted.job.id)) return;
      monitoredForkJobIdsRef.current.add(accepted.job.id);
      void waitForSessionFork(accepted.job.id, accepted.job)
        .then((completed) => {
          if (completed.status === "failed" || !completed.sessionId) {
            throw new Error(completed.error ?? "Session fork failed");
          }

          const newId = completed.sessionId;
          addOptimisticSession(newId, { summary: opts?.toEventId ? "Fork from session" : "Fork of session" });
          if (linkedTaskId) linkOptimisticTaskSession(linkedTaskId, newId);
          void Promise.all([invalidateAllSessionQueries(), invalidateTasks()]).catch((error) => {
            console.error("Failed to refresh sessions after fork:", error);
          });

          const destination = linkedTaskId
            ? `/tasks/${linkedTaskId}/sessions/${newId}`
            : `/sessions/${newId}`;
          showToast({
            id: toastId,
            tone: "success",
            title: "Fork ready",
            description: "The new session is ready when you are.",
            durationMs: 15_000,
            action: {
              label: "Open fork",
              icon: "open",
              onAction: () => {
                navigate(destination);
                dismissToast(toastId);
              },
            },
          });
        })
        .catch((error) => {
          const statusUnavailable = error instanceof ApiError && error.status === 404;
          console.error(statusUnavailable ? "Lost session fork status:" : "Failed to finish session fork:", error);
          showToast({
            id: toastId,
            tone: statusUnavailable ? "info" : "error",
            title: statusUnavailable ? "Fork status unavailable" : "Fork failed",
            description: statusUnavailable
              ? "The server stopped tracking this background fork. Check Sessions before trying again."
              : error instanceof Error ? error.message : String(error),
            footnote: statusUnavailable
              ? "The fork may still have completed."
              : "The original session was not changed.",
            durationMs: statusUnavailable ? 0 : 12_000,
          });
        })
        .finally(() => {
          monitoredForkJobIdsRef.current.delete(accepted.job.id);
        });
    } catch (err) {
      console.error("Failed to start session fork:", err);
      showToast({
        tone: "error",
        title: "Could not start fork",
        description: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  };

  const handleReloadSession = async (sessionId: string) => {
    try {
      const result = await reloadSession(sessionId);
      const mcpStatusQueryKey = queryKeys.mcpStatus(sessionId);
      await queryClient.cancelQueries({ queryKey: mcpStatusQueryKey, exact: true });
      queryClient.setQueryData(mcpStatusQueryKey, result.servers);
      setSessionReloadSignals((prev) => ({
        ...prev,
        [sessionId]: (prev[sessionId] ?? 0) + 1,
      }));
    } catch (err) {
      console.error("Failed to reload session MCPs:", err);
    }
  };

  const handleResumeTask = async (taskId: string, sessionId?: string) => {
    if (sessionId) {
      navigate(`/tasks/${taskId}/sessions/${sessionId}`);
    } else {
      await handleNewSession(taskId);
    }
  };

  const handleLinkToTask = async (sessionId: string, taskId: string) => {
    await linkResource(taskId, { type: "session", sessionId });
    await invalidateTasks();
    // Update URL to reflect the new task context
    if (activeSessionId === sessionId && !activeTaskId) {
      navigate(`/tasks/${taskId}/sessions/${sessionId}`, { replace: true });
    }
  };

  // ── Bulk actions for quick chats ──────────────────────────────
  const handleMarkAllRead = useCallback(() => {
    const unreadIds = globalSessions
      .filter((s) => !s.archived && isUnread(s.sessionId, getSessionActivityTime(s)))
      .map((s) => s.sessionId);
    if (unreadIds.length === 0) return;
    // Mark each read locally (instant UI update)
    for (const id of unreadIds) {
      const session = globalSessions.find((s) => s.sessionId === id);
      markRead(id, session ? getSessionActivityTime(session) : undefined);
    }
    // Batch sync to server
    batchSessionAction("markRead", unreadIds).catch(() => {});
  }, [globalSessions, isUnread, markRead]);

  const handleBulkAction = useCallback(async (action: import("./api").BatchAction, sessionIds: string[]) => {
    if (sessionIds.length === 0) return;

    // If active session is in the set and we're archiving/deleting, navigate to best fallback
    if ((action === "archive" || action === "delete") && activeSessionId && sessionIds.includes(activeSessionId)) {
      const bulkSet = new Set(sessionIds);
      const nextId = (() => {
        // Find the next sibling session not in the bulk set
        const pool = activeTaskId
          ? sessions.filter((s) => !s.archived && selectedTask?.sessionIds.includes(s.sessionId))
          : globalSessions.filter((s) => !s.archived);
        const remaining = pool.filter((s) => !bulkSet.has(s.sessionId));
        return remaining.length > 0 ? remaining[remaining.length - 1].sessionId : null;
      })();
      if (nextId) {
        navigate(activeTaskId ? `/tasks/${activeTaskId}/sessions/${nextId}` : `/sessions/${nextId}`);
      } else if (activeTaskId) {
        navigate(`/tasks/${activeTaskId}`);
      } else {
        navigate("/");
      }
    }

    if (action === "markRead") {
      for (const id of sessionIds) {
        const session = sessions.find((s) => s.sessionId === id);
        markRead(id, session ? getSessionActivityTime(session) : undefined);
      }
    }

    if (action === "archive") {
      // Animate out
      setExitingIds((prev) => {
        const next = new Set(prev);
        for (const id of sessionIds) next.add(id);
        return next;
      });
      await new Promise((r) => setTimeout(r, EXIT_ANIM_MS));
      setArchivingIds((prev) => {
        const next = new Set(prev);
        for (const id of sessionIds) next.add(id);
        return next;
      });
    }

    if (action === "delete") {
      for (const id of sessionIds) {
        retireComposer(id);
      }
      setExitingIds((prev) => {
        const next = new Set(prev);
        for (const id of sessionIds) next.add(id);
        return next;
      });
      await new Promise((r) => setTimeout(r, EXIT_ANIM_MS));
    }

    try {
      const result = await batchSessionAction(action, sessionIds);
      if (action === "archive" || action === "unarchive") {
        const successfulIds = getSuccessfulBatchSessionIds(sessionIds, result.errors);
        for (const id of successfulIds) trackArchiveTransition(id, action === "archive");
        patchSessionsInCache(successfulIds, {
          archived: action === "archive",
          archivedAt: action === "archive" ? new Date().toISOString() : undefined,
        });
      }
      if (Object.keys(result.errors).length > 0) {
        console.error(`Bulk ${action} partially failed:`, result.errors);
      }
      await Promise.all([invalidateAllSessionQueries(), invalidateTasks()]);
    } catch (err) {
      console.error(`Bulk ${action} failed:`, err);
    } finally {
      setArchivingIds((prev) => {
        const next = new Set(prev);
        for (const id of sessionIds) next.delete(id);
        return next;
      });
      setExitingIds((prev) => {
        const next = new Set(prev);
        for (const id of sessionIds) next.delete(id);
        return next;
      });
    }
  }, [activeSessionId, activeTaskId, selectedTask, sessions, globalSessions, navigate, markRead, retireComposer, patchSessionsInCache, invalidateAllSessionQueries, invalidateTasks]);

  // ── Mobile: detect breakpoint ─────────────────────────────────
  // On mobile (< md / 768px), we show stacked full-screen views.
  // The route determines which level of the hierarchy is visible.

  const isMobileRoute = {
    dashboard: mobileRouteMeta.route === "dashboard",
    taskList: mobileRouteMeta.route === "task-list" || mobileRouteMeta.route === "chat-list",
    taskDashboard: mobileRouteMeta.route === "task-dashboard" || mobileRouteMeta.route === "task-cockpit",
    taskPanel: mobileRouteMeta.route === "task-session",
    chat: mobileRouteMeta.route === "task-session" || mobileRouteMeta.route === "quick-chat",
    settings: mobileRouteMeta.route === "settings",
    docs: mobileRouteMeta.route === "docs-root" || mobileRouteMeta.route === "docs-detail",
  };
  const newWorkDisabledByRestart = restartBanner.phase === "pending" && !restartBanner.canAcceptNewWork;
  const newWorkDisabledByRestartHint = newWorkDisabledByRestart
    ? "Bridge is restarting; new messages and chats will resume after reconnect."
    : undefined;

  return (
    <div
      className="flex flex-col h-dvh bg-bg-primary text-text-primary"
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      {restartBanner.phase && (
        <RestartBanner
          phase={restartBanner.phase}
          restartPhase={restartBanner.restartPhase}
          waitingSessions={restartBanner.waitingSessions}
          canAcceptNewWork={restartBanner.canAcceptNewWork}
        />
      )}
      {backendStatusBanner.banner && (
        <BackendStatusBanner
          banner={backendStatusBanner.banner}
          onDismiss={() => setBackendStatusBanner((prev) => reduceBackendStatusBannerState(prev, { type: "dismiss" }))}
        />
      )}

      {/* Row wrapper: TaskRail + sidebar + main content fill space above mobile nav */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
      {/* ── Task Rail (desktop only) ──────────────────────── */}
      <TaskRail
        tasks={tasks}
        taskGroups={taskGroups}
        activeTaskId={activeTaskId}
        onSelectTask={handleSelectTask}
        onNewTask={handleNewTask}
        isQuickChatsActive={quickChatsMode && !activeTaskId}
        onGoHome={handleOpenDashboard}
        onOpenSettings={handleOpenSettings}
        onOpenDocs={handleOpenDocs}
        isDocsActive={isDocsActive}
        isDashboardActive={isDashboardActive}
        homeChecklistIndicator={homeChecklistIndicator}
        expanded={railExpanded}
        onToggleExpanded={() => setRailExpanded((v) => !v)}
        sessions={sessions}
        isUnread={isUnread}
        markRead={markRead}
        onUpdateTask={handleUpdateTask}
        onDeleteTask={handleDeleteTask}
        onReorderTasks={handleReorderTasks}
        onCreateGroup={handleCreateGroup}
        onUpdateGroup={handleUpdateGroup}
        onDeleteGroup={handleDeleteGroup}
        onReorderGroups={handleReorderGroups}
        onSetGroupTags={handleSetGroupTags}
        onMoveTaskToGroup={handleMoveTaskToGroup}
        onMoveAndReorder={handleMoveAndReorder}
        orphanSessions={globalSessions}
        activeSessionId={activeSessionId}
        onSelectSession={(id) => navigate(`/sessions/${id}`)}
        onNewQuickChat={handleNewQuickChat}
        onArchiveSession={handleArchiveSession}
        onDeleteSession={handleDeleteSession}
        onForkSession={handleForkSession}
        onReloadSession={handleReloadSession}
        onLinkToTask={handleLinkToTask}
        onMarkUnread={markUnread}
        onMarkAllQuickChatsRead={handleMarkAllRead}
        onRequestArchived={requestArchivedSessions}
        archivedLoaded={archivedLoaded}
        archivedLoading={archivedLoading}
        archivingIds={archivingIds}
        exitingIds={exitingIds}
        hasDraft={hasDraft}
        onBulkAction={handleBulkAction}
        onRailTabChange={handleRailTabChange}
      />

      {/* ── Task Panel / Mobile Task List ─────────────────── */}
      {/* Desktop: visible for active task sessions and the non-duplicative task overview. */}
      {/* Mobile: show task list at / only */}
      {(() => {
        const showDesktopPanel = !!selectedTask
          && !!activeTaskId
          && (!!activeSessionId || mobileRouteMeta.route === "task-dashboard");
        const showMobileTaskList = isMobileRoute.taskList;
        const showOuterContainer = showDesktopPanel || showMobileTaskList;
        return showOuterContainer ? (
          <div className={`
            md:shrink-0 min-w-0 min-h-0 overflow-hidden
            ${showMobileTaskList ? "flex flex-1 md:flex-none" : "hidden md:flex"}
          `.trim()}>
            {/* Mobile task list — full screen at / */}
            {showMobileTaskList && (
              <div className="md:hidden min-w-0 min-h-0 flex flex-col flex-1">
                <MobileTaskListView
                  tasks={tasks}
                  activeTaskId={activeTaskId}
                  onSelectTask={handleSelectTask}
                  onNewTask={handleNewTask}
                  sessions={sessions}
                  isUnread={isUnread}
                  markRead={markRead}
                  onUpdateTask={handleUpdateTask}
                  onDeleteTask={handleDeleteTask}
                  onReorderTasks={handleReorderTasks}
                  quickChatsMode={quickChatsMode}
                  taskGroups={taskGroups}
                  onMoveTaskToGroup={handleMoveTaskToGroup}
                  onMoveAndReorder={handleMoveAndReorder}
                  onCreateGroup={handleCreateGroup}
                  onUpdateGroup={handleUpdateGroup}
                  onDeleteGroup={handleDeleteGroup}
                  onReorderGroups={handleReorderGroups}
                  orphanSessions={globalSessions}
                  activeSessionId={activeSessionId}
                  onSelectSession={(id) => navigate(`/sessions/${id}`)}
                  onNewQuickChat={handleNewQuickChat}
                  onArchiveSession={handleArchiveSession}
                  archivingIds={archivingIds}
                  exitingIds={exitingIds}
                  allTasks={tasks}
                  onLinkToTask={handleLinkToTask}
                  onDeleteSession={handleDeleteSession}
                  onForkSession={handleForkSession}
                  onReloadSession={handleReloadSession}
                  markUnread={markUnread}
                  onRefresh={async () => { await Promise.all([invalidateTasks(), invalidateAllSessionQueries(), invalidateTaskGroups()]); }}
                  hasDraft={hasDraft}
                  onMarkAllRead={handleMarkAllRead}
                  onBulkAction={handleBulkAction}
                  onRequestArchived={requestArchivedSessions}
                  archivedLoaded={archivedLoaded}
                  archivedLoading={archivedLoading}
                  scrollRestoration={mobileTaskListScrollRestoration}
                />
              </div>
            )}

            {/* Desktop panel (only when inside a session or quick chats) */}
            {showDesktopPanel && (
              <div className="hidden md:flex md:w-64 md:shrink-0 min-w-0 min-h-0 border-r border-border bg-bg-secondary">
                <TaskPanel
                  task={selectedTask}
                  taskGroups={taskGroups}
                  sessions={sessions}
                  activeSessionId={activeSessionId}
                  onSelectSession={handleSelectSession}
                  onNewSession={handleNewSession}
                  onUpdateTask={handleUpdateTask}
                  onTasksChanged={invalidateTasks}
                  isUnread={isUnread}
                  onArchiveSession={handleArchiveSession}
                  archivingIds={archivingIds}
                  exitingIds={exitingIds}
                  tasks={tasks}
                  onLinkToTask={handleLinkToTask}
                  onDeleteTask={handleDeleteTask}
                  onDeleteSession={handleDeleteSession}
                  onForkSession={handleForkSession}
                  onReloadSession={handleReloadSession}
                  onMarkUnread={markUnread}
                  hasDraft={hasDraft}
                  onMoveTaskToGroup={handleMoveTaskToGroup}
                  onRefresh={async () => { await Promise.all([invalidateTasks(), invalidateAllSessionQueries(), invalidateTaskGroups()]); }}
                  onViewDashboard={(taskId) => navigate(`/tasks/${taskId}/overview`)}
                  onMarkAllRead={handleMarkAllRead}
                  onBulkAction={handleBulkAction}
                  onRequestArchived={requestArchivedSessions}
                  archivedLoaded={archivedLoaded}
                  archivedLoading={archivedLoading}
                  onSetTaskTags={handleSetTaskTags}
                />
              </div>
            )}
          </div>
        ) : null;
      })()}

      {/* ── Main content area ─────────────────────────────── */}
      <div className={`
        flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden
        ${/* Desktop: always visible */""}
        ${/* Mobile: visible for chat, settings, and task dashboard */""}
        ${isMobileRoute.dashboard || isMobileRoute.chat || isMobileRoute.settings || isMobileRoute.taskDashboard || isMobileRoute.docs ? "flex" : "hidden md:flex"}
      `.trim()}>
        {mobileRouteMeta.showSharedHeader && (
          <MobileDetailHeader
            onBack={handleMobileUp}
            upLabel={mobileRouteMeta.upTarget?.label}
            title={mobileRouteMeta.detailHeader?.title}
            metadata={mobileRouteMeta.detailHeader?.metadata}
          />
        )}

        <main className="flex-1 flex flex-col min-h-0">
          <Routes>
            <Route
              index
              element={
                <Dashboard
                  onSelectTask={handleSelectTask}
                  onSelectSession={navigateToSession}
                  onStartPromptSession={handleStartPromptSession}
                  tasks={tasks}
                  taskGroups={taskGroups}
                />
              }
            />
            <Route
              path="dashboard"
              element={
                <Dashboard
                  onSelectTask={handleSelectTask}
                  onSelectSession={navigateToSession}
                  onStartPromptSession={handleStartPromptSession}
                  tasks={tasks}
                  taskGroups={taskGroups}
                  scrollRestoration={mobileDashboardScrollRestoration}
                />
              }
            />
            <Route
              path="dashboard/checklist"
              element={
                <Dashboard
                  onSelectTask={handleSelectTask}
                  onSelectSession={navigateToSession}
                  onStartPromptSession={handleStartPromptSession}
                  tasks={tasks}
                  taskGroups={taskGroups}
                  scrollRestoration={mobileDashboardScrollRestoration}
                />
              }
            />
            <Route
              path="dashboard/feed"
              element={
                <Dashboard
                  onSelectTask={handleSelectTask}
                  onSelectSession={navigateToSession}
                  onStartPromptSession={handleStartPromptSession}
                  tasks={tasks}
                  taskGroups={taskGroups}
                  scrollRestoration={mobileDashboardScrollRestoration}
                />
              }
            />
            <Route
              path="chats"
              element={
                <div className="flex-1 flex items-center justify-center text-text-muted text-sm">
                  Select a chat or start a new one
                </div>
              }
            />
            <Route
              path="tasks/:taskId"
              element={
                selectedTask ? (
                  <TaskPanel
                    task={selectedTask}
                    taskGroups={taskGroups}
                    sessions={sessions}
                    activeSessionId={activeSessionId}
                    onSelectSession={handleSelectSession}
                    onNewSession={handleNewSession}
                    onUpdateTask={handleUpdateTask}
                    onTasksChanged={invalidateTasks}
                    isUnread={isUnread}
                    onArchiveSession={handleArchiveSession}
                    archivingIds={archivingIds}
                    exitingIds={exitingIds}
                    tasks={tasks}
                    onLinkToTask={handleLinkToTask}
                    onDeleteTask={handleDeleteTask}
                    onDeleteSession={handleDeleteSession}
                    onForkSession={handleForkSession}
                    onReloadSession={handleReloadSession}
                    onMarkUnread={markUnread}
                    hasDraft={hasDraft}
                    onMoveTaskToGroup={handleMoveTaskToGroup}
                    onRefresh={async () => { await Promise.all([invalidateTasks(), invalidateAllSessionQueries(), invalidateTaskGroups()]); }}
                    onViewDashboard={(taskId) => navigate(`/tasks/${taskId}/overview`)}
                    onMarkAllRead={handleMarkAllRead}
                    onBulkAction={handleBulkAction}
                    onRequestArchived={requestArchivedSessions}
                    archivedLoaded={archivedLoaded}
                    archivedLoading={archivedLoading}
                    onSetTaskTags={handleSetTaskTags}
                    scrollRestoration={mobileTaskCockpitScrollRestoration}
                  />
                ) : taskNotFound ? (
                  <div className="flex-1 flex flex-col items-center justify-center gap-3">
                    <div className="text-text-muted text-sm">Task not found</div>
                    <button
                      onClick={() => navigate("/")}
                      className="hidden text-xs text-accent hover:text-accent-hover md:inline-block"
                    >
                      ← Back to Home
                    </button>
                  </div>
                ) : (
                  <TaskPanelRouteSkeleton />
                )
              }
            />
            <Route
              path="tasks/:taskId/sessions/:sessionId"
              element={
                <SessionRoute
                  sessions={sessions}
                  onMessageSent={invalidateSessions}
                  onRenderedReadThrough={rememberRenderedReadThrough}
                  getDraft={getDraft}
                  getDraftSession={getDraftSession}
                  setDraft={setDraft}
                  setDraftLaunchOptions={setDraftLaunchOptions}
                  clearDraft={clearDraft}
                  clearDraftSession={clearDraftSession}
                  clearDraftSessionBySessionId={clearDraftSessionBySessionId}
                  materializeSession={materializeSession}
                  cleanupFailedFirstSendSession={cleanupRejectedFirstSendSession}
                  getVoiceJob={getJobForComposer}
                  startBackgroundVoiceJob={startBackgroundVoiceJob}
                  retryVoiceJobUpload={retryVoiceJobUpload}
                  reviewVoiceJob={reviewInstead}
                  clearVoiceJobError={clearVoiceJobError}
                  discardVoiceRecording={discardVoiceRecording}
                  migrateVoiceRecording={migrateVoiceRecording}
                  sessionReloadSignals={sessionReloadSignals}
                  sessionBusySignals={sessionBusySignals}
                  onForkSession={handleForkSession}
                  sessionHistorySignals={sessionHistorySignals}
                  newWorkDisabled={newWorkDisabledByRestart}
                  newWorkDisabledHint={newWorkDisabledByRestartHint}
                  defaultModelId={settings?.model}
                  defaultReasoningEffort={settings?.reasoningEffort}
                  defaultContextTier={settings?.contextTier}
                  launchDefaultsLoading={settingsLoading}
                />
              }
            />
            <Route
              path="tasks/:taskId/overview"
              element={
                selectedTask ? (
                  <TaskDashboard
                    task={selectedTask}
                    taskGroups={taskGroups}
                    sessions={sessions}
                    onSelectSession={(id) => navigate(`/tasks/${activeTaskId}/sessions/${id}`)}
                    onNewSession={handleNewSession}
                    onUpdateTask={handleUpdateTask}
                    onUpdateGroup={handleUpdateGroup}
                    onTasksChanged={invalidateTasks}
                    isUnread={isUnread}
                    onSetTaskTags={handleSetTaskTags}
                    onRefresh={async () => { await Promise.all([invalidateTasks(), invalidateAllSessionQueries(), invalidateTaskGroups()]); }}
                    onDeleteSession={handleDeleteSession}
                    onForkSession={handleForkSession}
                    onReloadSession={handleReloadSession}
                    onArchiveSession={handleArchiveSession}
                    archivingIds={archivingIds}
                    exitingIds={exitingIds}
                    onBulkAction={handleBulkAction}
                    onMarkUnread={markUnread}
                    hasDraft={hasDraft}
                    onRequestArchived={requestArchivedSessions}
                    archivedLoaded={archivedLoaded}
                    archivedLoading={archivedLoading}
                    scrollRestoration={mobileTaskDashboardScrollRestoration}
                  />
                ) : taskNotFound ? (
                  <div className="flex-1 flex flex-col items-center justify-center gap-3">
                    <div className="text-text-muted text-sm">Task not found</div>
                    <button
                      onClick={() => navigate("/")}
                      className="hidden text-xs text-accent hover:text-accent-hover md:inline-block"
                    >
                      ← Back to Home
                    </button>
                  </div>
                ) : (
                  <TaskDashboardRouteSkeleton />
                )
              }
            />
            <Route
              path="sessions/:sessionId"
              element={
                <SessionRoute
                  sessions={sessions}
                  onMessageSent={invalidateSessions}
                  onRenderedReadThrough={rememberRenderedReadThrough}
                  getDraft={getDraft}
                  getDraftSession={getDraftSession}
                  setDraft={setDraft}
                  setDraftLaunchOptions={setDraftLaunchOptions}
                  clearDraft={clearDraft}
                  clearDraftSession={clearDraftSession}
                  clearDraftSessionBySessionId={clearDraftSessionBySessionId}
                  materializeSession={materializeSession}
                  cleanupFailedFirstSendSession={cleanupRejectedFirstSendSession}
                  getVoiceJob={getJobForComposer}
                  startBackgroundVoiceJob={startBackgroundVoiceJob}
                  retryVoiceJobUpload={retryVoiceJobUpload}
                  reviewVoiceJob={reviewInstead}
                  clearVoiceJobError={clearVoiceJobError}
                  discardVoiceRecording={discardVoiceRecording}
                  migrateVoiceRecording={migrateVoiceRecording}
                  sessionReloadSignals={sessionReloadSignals}
                  sessionBusySignals={sessionBusySignals}
                  onForkSession={handleForkSession}
                  sessionHistorySignals={sessionHistorySignals}
                  newWorkDisabled={newWorkDisabledByRestart}
                  newWorkDisabledHint={newWorkDisabledByRestartHint}
                  defaultModelId={settings?.model}
                  defaultReasoningEffort={settings?.reasoningEffort}
                  defaultContextTier={settings?.contextTier}
                  launchDefaultsLoading={settingsLoading}
                />
              }
            />
            <Route path="docs/*" element={<DocsView onDocTitleChange={setDocTitle} />} />
            <Route path="settings" element={<SettingsView />} />
          </Routes>
        </main>
      </div>
      </div>{/* ← close row wrapper */}

      {pendingTaskDeletion && (
        <ConfirmTaskDeleteDialog
          task={pendingTaskDeletion.task}
          preview={pendingTaskDeletion.preview}
          previewError={pendingTaskDeletion.previewError}
          progressRemaining={deletionProgress.remaining}
          busy={pendingTaskDeletion.busy}
          actionError={pendingTaskDeletion.actionError}
          onConfirm={handleConfirmTaskDeletion}
          onClose={() => setPendingTaskDeletion(null)}
        />
      )}

      {/* ── Mobile bottom navigation ──────────────────────── */}
      {isMobile && mobileRouteMeta.showBottomNav && (
        <MobileBottomNav
          activeTab={mobileActiveTab}
          onSelectTab={handleMobileTab}
          homeChecklistIndicator={homeChecklistIndicator}
          taskAttention={mobileTaskAttention}
          chatAttention={mobileChatAttention}
        />
      )}
    </div>
  );
}

function getVoiceSessionIntent(status: VoiceSessionActivity["status"]): string {
  if (status === "uploading") return "Uploading voice input";
  if (status === "sending") return "Sending voice message";
  return "Processing voice input";
}

function isVoiceSessionIntent(intent: string): boolean {
  return intent === "Uploading voice input"
    || intent === "Processing voice input"
    || intent === "Sending voice message";
}

// ── Mobile Task List View ────────────────────────────────────────
// Full-screen view on mobile showing either the task list or quick chats

function MobileTaskListView({
  tasks,
  activeTaskId,
  onSelectTask,
  onNewTask,
  sessions,
  isUnread,
  markRead,
  onUpdateTask,
  onDeleteTask,
  onReorderTasks,
  quickChatsMode,
  taskGroups,
  onMoveTaskToGroup,
  onMoveAndReorder,
  onCreateGroup,
  onUpdateGroup,
  onDeleteGroup,
  onReorderGroups,
  orphanSessions,
  activeSessionId,
  onSelectSession,
  onNewQuickChat,
  onArchiveSession,
  archivingIds,
  exitingIds,
  allTasks,
  onLinkToTask,
        onDeleteSession,
        onForkSession,
        onReloadSession,
        markUnread,
  onRefresh,
  hasDraft,
  onMarkAllRead,
  onBulkAction,
  onRequestArchived,
  archivedLoaded,
  archivedLoading,
  scrollRestoration,
}: {
  tasks: Task[];
  activeTaskId: string | null;
  onSelectTask: (id: string) => void;
  onNewTask: (groupId?: string) => void;
  sessions: Session[];
  isUnread?: (sessionId: string, modifiedTime?: string) => boolean;
  markRead?: (sessionId: string) => void;
  onUpdateTask?: (
    taskId: string,
    updates: {
      title?: Task["title"];
      status?: Task["status"];
      nextTouchAt?: Task["nextTouchAt"] | null;
    },
  ) => void;
  onDeleteTask?: (taskId: string) => void;
  onReorderTasks?: (taskIds: string[]) => void;
  quickChatsMode: boolean;
  taskGroups?: TaskGroup[];
  onMoveTaskToGroup?: (taskId: string, groupId: string | undefined) => void;
  onMoveAndReorder?: (taskId: string, groupId: string | undefined, taskIds: string[]) => void;
  onCreateGroup?: (name: string, color?: string) => Promise<TaskGroup | null>;
  onUpdateGroup?: (groupId: string, updates: Partial<Pick<TaskGroup, "name" | "color" | "collapsed" | "notes">>) => void;
  onDeleteGroup?: (groupId: string) => void;
  onReorderGroups?: (groupIds: string[]) => void;
  orphanSessions: Session[];
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onNewQuickChat: () => void;
  onArchiveSession: (id: string, archived: boolean) => void;
  archivingIds: Set<string>;
  exitingIds: Set<string>;
  allTasks: Task[];
  onLinkToTask: (sessionId: string, taskId: string) => void;
  onDeleteSession?: (sessionId: string) => void;
  onForkSession?: (sessionId: string) => void;
  onReloadSession?: (sessionId: string) => void;
  markUnread?: (sessionId: string) => void;
  onRefresh: () => Promise<void>;
  hasDraft?: (sessionId: string) => boolean;
  onMarkAllRead?: () => void;
  onBulkAction?: (action: import("./api").BatchAction, sessionIds: string[]) => void;
  onRequestArchived?: () => void;
  archivedLoaded?: boolean;
  archivedLoading?: boolean;
  scrollRestoration?: PullToRefreshScrollRestoration;
}){
  return (
    <div className="flex flex-col h-full bg-bg-secondary min-w-0 overflow-hidden">
      {/* Header */}
      <div className="p-4 border-b border-border flex items-center justify-between">
        <span className="text-sm font-semibold text-text-primary">
          {quickChatsMode ? "Quick Chats" : "Tasks"}
        </span>
      </div>

      {/* Content — pull-to-refresh wraps both tabs */}
      <div className="flex-1 min-h-0 relative">
      <PullToRefresh
        onRefresh={onRefresh}
        className="absolute inset-0 overflow-x-hidden min-w-0"
        scrollRestoration={scrollRestoration}
      >
        {quickChatsMode ? (
          <SessionList
            variant="compact"
            sessions={orphanSessions}
            activeSessionId={activeSessionId}
            onSelectSession={onSelectSession}
            onNewSession={onNewQuickChat}
            newButtonLabel="+ Quick Chat"
            isUnread={isUnread}
            onArchiveSession={onArchiveSession}
            archivingIds={archivingIds}
            exitingIds={exitingIds}
            tasks={allTasks}
            onLinkToTask={onLinkToTask}
            onDeleteSession={onDeleteSession}
            onForkSession={onForkSession}
            onReloadSession={onReloadSession}
            onMarkUnread={markUnread}
            onMarkAllRead={onMarkAllRead}
            hasDraft={hasDraft}
            onBulkAction={onBulkAction}
            onRequestArchived={onRequestArchived}
            archivedLoaded={archivedLoaded}
            archivedLoading={archivedLoading}
            className="min-w-0 overflow-x-hidden p-2 space-y-0.5"
          />
        ) : (
          <TaskList
            tasks={tasks}
            taskGroups={taskGroups}
            activeTaskId={activeTaskId}
            activeSessionId={activeSessionId}
            onSelectTask={onSelectTask}
            onNewTask={onNewTask}
            sessions={sessions}
            isUnread={isUnread}
            markRead={markRead}
            onUpdateTask={onUpdateTask}
            onDeleteTask={onDeleteTask}
            onReorderTasks={onReorderTasks}
            onMoveTaskToGroup={onMoveTaskToGroup}
            onMoveAndReorder={onMoveAndReorder}
            onCreateGroup={onCreateGroup}
            onUpdateGroup={onUpdateGroup}
            onDeleteGroup={onDeleteGroup}
            onReorderGroups={onReorderGroups}
            className="p-2 space-y-2"
          />
        )}
      </PullToRefresh>
      </div>
    </div>
  );
}

// Thin wrapper to extract sessionId from URL and pass hasPlan + draft props
function SessionRoute({
  sessions,
  onMessageSent,
  onRenderedReadThrough,
  getDraft,
  getDraftSession,
  setDraft,
  setDraftLaunchOptions,
  clearDraft,
  clearDraftSession,
  clearDraftSessionBySessionId,
  materializeSession,
  cleanupFailedFirstSendSession,
  getVoiceJob,
  startBackgroundVoiceJob,
  retryVoiceJobUpload,
  reviewVoiceJob,
  clearVoiceJobError,
  discardVoiceRecording,
  migrateVoiceRecording,
  sessionReloadSignals,
  sessionBusySignals,
  onForkSession,
  sessionHistorySignals,
  newWorkDisabled,
  newWorkDisabledHint,
  defaultModelId,
  defaultReasoningEffort,
  defaultContextTier,
  launchDefaultsLoading,
}: {
  sessions: Session[];
  onMessageSent: () => void;
  onRenderedReadThrough: (sessionId: string, readThroughActivityAt: string) => void;
  getDraft: (composerKey: string) => import("./useDrafts").Draft | null;
  getDraftSession: (composerKey: string) => string | null;
  setDraft: (composerKey: string, text: string, attachments?: import("./api").Attachment[]) => void;
  setDraftLaunchOptions: (
    composerKey: string,
    update: DraftLaunchOptions | undefined | (
      (current: DraftLaunchOptions | undefined) => DraftLaunchOptions | undefined
    ),
  ) => void;
  clearDraft: (composerKey: string) => void;
  clearDraftSession: (composerKey: string) => void;
  clearDraftSessionBySessionId: (sessionId: string) => void;
  materializeSession: (taskId?: string, options?: CreateSessionOptions) => Promise<string>;
  cleanupFailedFirstSendSession: (sessionId: string, taskId?: string) => Promise<void>;
  getVoiceJob: (composerKey: string) => VoiceBackgroundJob | null;
  startBackgroundVoiceJob: (options: StartBackgroundVoiceJobOptions) => Promise<void>;
  retryVoiceJobUpload: (composerKey: string) => void;
  reviewVoiceJob: (composerKey: string) => void;
  clearVoiceJobError: (composerKey: string) => void;
  discardVoiceRecording: (composerKey: string) => void;
  migrateVoiceRecording: (fromComposerKey: string, toComposerKey: string) => void;
  sessionReloadSignals: Record<string, number>;
  sessionBusySignals: Record<string, number>;
  onForkSession?: (sessionId: string, opts?: { toEventId?: string }) => Promise<void> | void;
  sessionHistorySignals: Record<string, number>;
  newWorkDisabled?: boolean;
  newWorkDisabledHint?: string;
  defaultModelId?: string;
  defaultReasoningEffort?: string;
  defaultContextTier?: CopilotContextTier;
  launchDefaultsLoading: boolean;
}) {
  const { sessionId: rawSessionId, taskId } = useParams<{ sessionId: string; taskId: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [launchMode, setLaunchMode] = useState<SendMode>(DEFAULT_SEND_MODE);

  const draftRouteKey = getDraftComposerKey(taskId);
  const isDraftRoute = rawSessionId === "new";
  const mappedDraftSessionId = getDraftSession(draftRouteKey);
  const validMappedDraftSessionId = mappedDraftSessionId && sessions.some((session) => session.sessionId === mappedDraftSessionId)
    ? mappedDraftSessionId
    : null;
  const sessionId = isDraftRoute ? validMappedDraftSessionId : (rawSessionId ?? null);
  const composerKey = sessionId ?? draftRouteKey;
  const isDraft = sessionId === null;
  const modelsQuery = useModelsQuery({ enabled: isDraft || Boolean(sessionId) });
  const taskAgentDefinitionsQuery = useTaskAgentDefinitionsQuery(taskId);
  const sessionModelQuery = useSessionModelQuery(sessionId);
  const sessionReloadToken = sessionId ? sessionReloadSignals[sessionId] ?? 0 : 0;
  const busySignal = sessionId ? sessionBusySignals[sessionId] ?? 0 : 0;
  const historySignal = sessionId ? sessionHistorySignals[sessionId] ?? 0 : 0;
  const activeSession = sessions.find((s) => s.sessionId === sessionId);
  const hasPlan = activeSession?.hasPlan;
  const activeSessionActivityAt = activeSession?.lastVisibleActivityAt;
  const draft = getDraft(composerKey);
  const draftLaunch = draft?.launch;
  const voiceJob = getVoiceJob(composerKey);
  const previousDraftRouteKeyRef = useRef(draftRouteKey);
  // Shared with the change-model dialog; only the draft route needs settings,
  // and cached settings are still read when fetching is disabled.
  const modelPresetMemory = useModelPresets({ enabled: isDraft });
  const { presets } = modelPresetMemory;
  const rememberedLaunchSelection = !draftLaunch?.model
    ? modelPresetMemory.resolveRememberedSelection(modelsQuery.data ?? [])
    : null;
  const effectiveSelectedModelId = draftLaunch?.model
    || rememberedLaunchSelection?.modelId
    || "";
  const launchState = resolveNewSessionLaunchState({
    models: modelsQuery.data ?? [],
    selectedModelId: effectiveSelectedModelId,
    defaultModelId,
    defaultReasoningEffort,
    defaultContextTier,
    reasoningEffortSelection: draftLaunch?.reasoningEffort ?? (
      rememberedLaunchSelection?.reasoningEffort
        ? {
          modelId: rememberedLaunchSelection.modelId,
          value: rememberedLaunchSelection.reasoningEffort,
        }
        : undefined
    ),
    contextTierSelection: draftLaunch?.contextTier ?? (
      rememberedLaunchSelection?.contextTier
        ? {
          modelId: rememberedLaunchSelection.modelId,
          value: rememberedLaunchSelection.contextTier,
        }
        : undefined
    ),
  });
  const selectedPresetSlot = draftLaunch?.presetSlot ?? rememberedLaunchSelection?.slot;
  const activePresetSlot = selectedPresetSlot
    ?? modelPresetMemory.findSlotForModel(launchState.modelKey, launchState.availableModels);
  const rememberModelPreset = modelPresetMemory.remember;
  const launchCreateOptions = useMemo(
    () => ({
      ...buildNewSessionCreateOptions(launchState),
      ...(taskId && draftLaunch?.agent ? { agent: draftLaunch.agent } : {}),
    }),
    [
      launchState.modelForCreate,
      launchState.selectedContextTier,
      launchState.selectedReasoningEffort,
      draftLaunch?.agent,
      taskId,
    ],
  );
  const launchConfigurationLoading = isDraft && (launchDefaultsLoading || modelsQuery.isLoading);

  useEffect(() => {
    if (!sessionId || !activeSession || activeSession.isOptimistic) return;
    void sessionModelQuery.refetch();
  }, [activeSession?.isOptimistic, sessionId, sessionModelQuery.refetch]);

  const resetLaunchOptions = useCallback(() => {
    setLaunchMode(DEFAULT_SEND_MODE);
  }, []);

  /**
   * A model choice is explicit draft state. Effort and context selections follow
   * the selected preset, while each selection remains scoped to its model id.
   */
  const applyLaunchSelection = useCallback((selection: ModelPresetSelection) => {
    const reasoningEffortSelection = selection.reasoningEffort
      ? { modelId: selection.modelId, value: selection.reasoningEffort }
      : undefined;
    const contextTierSelection = selection.contextTier
      ? { modelId: selection.modelId, value: selection.contextTier }
      : undefined;
    const nextLaunchState = resolveNewSessionLaunchState({
      models: launchState.availableModels,
      selectedModelId: selection.modelId,
      defaultModelId,
      defaultReasoningEffort,
      defaultContextTier,
      reasoningEffortSelection,
      contextTierSelection,
    });
    setDraftLaunchOptions(composerKey, (current) => ({
      ...(current?.agent ? { agent: current.agent } : {}),
      model: selection.modelId,
      presetSlot: selection.slot,
      ...(reasoningEffortSelection ? { reasoningEffort: reasoningEffortSelection } : {}),
      ...(contextTierSelection ? { contextTier: contextTierSelection } : {}),
    }));
    rememberModelPreset({
      slot: selection.slot,
      modelId: selection.modelId,
      reasoningEffort: nextLaunchState.selectedReasoningEffort,
      contextTier: nextLaunchState.selectedContextTier,
    });
  }, [
    composerKey,
    defaultContextTier,
    defaultModelId,
    defaultReasoningEffort,
    launchState.availableModels,
    rememberModelPreset,
    setDraftLaunchOptions,
  ]);

  const handleLaunchPresetChange = useCallback((slot: ModelPresetSlot) => {
    const selection = modelPresetMemory.selectPreset(slot, {
      models: launchState.availableModels,
      selectedModelId: launchState.modelKey,
      selectedPresetSlot: activePresetSlot,
    });
    if (selection) applyLaunchSelection(selection);
  }, [
    activePresetSlot,
    applyLaunchSelection,
    launchState.availableModels,
    launchState.modelKey,
    modelPresetMemory,
  ]);

  const handleLaunchModelChange = useCallback((slot: ModelPresetSlot, modelId: string) => {
    applyLaunchSelection(modelPresetMemory.selectModel(slot, modelId));
  }, [applyLaunchSelection, modelPresetMemory]);

  const handleLaunchReasoningEffortChange = useCallback((reasoningEffort?: string) => {
    if (!reasoningEffort) return;
    setDraftLaunchOptions(composerKey, (current) => {
      const next = { ...(current ?? {}) };
      next.reasoningEffort = {
        modelId: launchState.modelKey,
        value: reasoningEffort,
      };
      return next;
    });
    if (activePresetSlot) {
      rememberModelPreset({
        slot: activePresetSlot,
        modelId: launchState.modelKey,
        reasoningEffort,
        contextTier: launchState.selectedContextTier,
      });
    }
  }, [
    activePresetSlot,
    composerKey,
    launchState.modelKey,
    launchState.selectedContextTier,
    rememberModelPreset,
    setDraftLaunchOptions,
  ]);

  const handleLaunchContextTierChange = useCallback((contextTier?: CopilotContextTier) => {
    if (!contextTier) return;
    setDraftLaunchOptions(composerKey, (current) => {
      const next = { ...(current ?? {}) };
      next.contextTier = {
        modelId: launchState.modelKey,
        value: contextTier,
      };
      return next;
    });
    if (activePresetSlot) {
      rememberModelPreset({
        slot: activePresetSlot,
        modelId: launchState.modelKey,
        reasoningEffort: launchState.selectedReasoningEffort,
        contextTier,
      });
    }
  }, [
    activePresetSlot,
    composerKey,
    launchState.modelKey,
    launchState.selectedReasoningEffort,
    rememberModelPreset,
    setDraftLaunchOptions,
  ]);

  const handleLaunchAgentChange = useCallback((agent?: string) => {
    setDraftLaunchOptions(composerKey, (current) => {
      const next = { ...(current ?? {}) };
      if (agent) next.agent = agent;
      else delete next.agent;
      return Object.keys(next).length > 0 ? next : undefined;
    });
  }, [composerKey, setDraftLaunchOptions]);

  useEffect(() => {
    const selectedAgent = draftLaunch?.agent;
    if (!selectedAgent || taskAgentDefinitionsQuery.isLoading) return;
    const available = taskAgentDefinitionsQuery.data
      ?.some((definition) => definition.name === selectedAgent && definition.userInvocable) === true;
    if (!available) handleLaunchAgentChange(undefined);
  }, [
    draftLaunch?.agent,
    handleLaunchAgentChange,
    taskAgentDefinitionsQuery.data,
    taskAgentDefinitionsQuery.isLoading,
  ]);

  useEffect(() => {
    if (previousDraftRouteKeyRef.current === draftRouteKey) return;
    previousDraftRouteKeyRef.current = draftRouteKey;
    resetLaunchOptions();
  }, [draftRouteKey, resetLaunchOptions]);

  useEffect(() => {
    if (!isDraftRoute || !validMappedDraftSessionId) return;
    const path = taskId
      ? `/tasks/${taskId}/sessions/${validMappedDraftSessionId}`
      : `/sessions/${validMappedDraftSessionId}`;
    navigate(path, { replace: true });
  }, [isDraftRoute, navigate, taskId, validMappedDraftSessionId]);

  const handleDraftChange = useCallback(
    (text: string, attachments?: import("./api").Attachment[]) => {
      setDraft(composerKey, text, attachments);
    },
    [composerKey, setDraft],
  );
  const handleDraftClear = useCallback(() => {
    clearDraft(composerKey);
    if (sessionId) {
      clearDraftSessionBySessionId(sessionId);
    }
  }, [clearDraft, clearDraftSessionBySessionId, composerKey, sessionId]);

  const handleMessageSent = useCallback(() => {
    if (sessionId) {
      clearDraftSessionBySessionId(sessionId);
    }
    onMessageSent();
  }, [clearDraftSessionBySessionId, onMessageSent, sessionId]);

  // Create session on first message, then redirect to real URL
  const onCreateAndSend = useCallback(async (
    prompt: string,
    attachments?: import("./api").Attachment[],
    mode?: SendMode,
  ) => {
    const createOptions = launchCreateOptions;
    const newSessionId = await materializeSession(taskId, createOptions);
    const optimisticModelState = buildOptimisticSessionModelState(createOptions, defaultModelId);
    if (optimisticModelState) {
      queryClient.setQueryData(queryKeys.sessionModel(newSessionId), optimisticModelState);
    }
    const path = taskId
      ? `/tasks/${taskId}/sessions/${newSessionId}`
      : `/sessions/${newSessionId}`;
    // Keep any unsent recording attached to the conversation it was made for.
    migrateVoiceRecording(composerKey, newSessionId);
    const delivery = sendMaterializedFirstPrompt({
      sessionId: newSessionId,
      prompt,
      attachments,
      mode,
      onRejected: async () => {
        await cleanupFailedFirstSendSession(newSessionId, taskId);
        migrateVoiceRecording(newSessionId, composerKey);
        navigate(taskId ? getTaskDraftSessionPath(taskId) : "/sessions/new", { replace: true });
      },
    });
    navigate(path, { replace: true });
    await delivery;
    clearDraft(composerKey);
    resetLaunchOptions();
  }, [
    cleanupFailedFirstSendSession,
    clearDraft,
    composerKey,
    defaultModelId,
    launchCreateOptions,
    materializeSession,
    migrateVoiceRecording,
    navigate,
    queryClient,
    resetLaunchOptions,
    taskId,
  ]);

  const handleSubmitVoiceCapture = useCallback((capture: {
    composerKey: string;
    audio: Blob;
    submitMode: import("./lib/voice-submit-mode").VoiceSubmitMode;
  }) => startBackgroundVoiceJob({
    ...capture,
    ...(isDraft && Object.keys(launchCreateOptions).length > 0
      ? { sessionOptions: launchCreateOptions }
      : {}),
  }), [isDraft, launchCreateOptions, startBackgroundVoiceJob]);

  const draftEmptyState = isDraft ? (
    <NewSessionLaunchPanel
      models={launchState.availableModels}
      modelsLoading={modelsQuery.isLoading || launchDefaultsLoading}
      modelsError={modelsQuery.error instanceof Error ? modelsQuery.error.message : undefined}
      defaultModelId={defaultModelId}
      presets={presets}
      selectedModelId={launchState.modelKey}
      selectedPresetSlot={activePresetSlot}
      reasoningEffortOptions={launchState.reasoningEffortOptions}
      selectedReasoningEffort={launchState.selectedReasoningEffort}
      contextOptions={launchState.contextOptions}
      selectedContextTier={launchState.selectedContextTier}
      mode={launchMode}
      agentDefinitions={taskId ? taskAgentDefinitionsQuery.data ?? [] : undefined}
      agentDefinitionsLoading={taskId ? taskAgentDefinitionsQuery.isLoading : undefined}
      selectedAgentName={draftLaunch?.agent}
      onPresetChange={handleLaunchPresetChange}
      onModelChange={handleLaunchModelChange}
      onReasoningEffortChange={handleLaunchReasoningEffortChange}
      onContextTierChange={handleLaunchContextTierChange}
      onModeChange={setLaunchMode}
      onAgentChange={handleLaunchAgentChange}
    />
  ) : undefined;

  return (
    <ChatView
      // No `key` here — the component must survive draft→real session transitions
      // so pending first-send work can hand off to the real session without a
      // remount. Session and draft-composer resets are handled inside ChatView.
      composerKey={composerKey}
      sessionId={sessionId}
      hasPlan={hasPlan}
      sessionModelSummary={sessionId ? (
        <SessionModelSummary
          state={sessionModelQuery.data}
          models={modelsQuery.data}
          loading={sessionModelQuery.isLoading || sessionModelQuery.isFetching}
          error={sessionModelQuery.error instanceof Error ? sessionModelQuery.error.message : undefined}
          onRetry={() => {
            void sessionModelQuery.refetch();
          }}
        />
      ) : undefined}
      onMessageSent={handleMessageSent}
      onRenderedReadThrough={onRenderedReadThrough}
      draft={draft}
      onDraftChange={handleDraftChange}
      onDraftClear={handleDraftClear}
      onCreateAndSend={isDraft ? onCreateAndSend : undefined}
      emptyState={draftEmptyState}
      defaultSendMode={isDraft ? launchMode : DEFAULT_SEND_MODE}
      voiceJob={voiceJob}
      onSubmitVoiceCapture={handleSubmitVoiceCapture}
      onReviewVoiceJob={reviewVoiceJob}
      onClearVoiceJobError={clearVoiceJobError}
      onDiscardVoiceRecording={discardVoiceRecording}
      onRetryVoiceJobUpload={retryVoiceJobUpload}
      reloadToken={sessionReloadToken}
      busySignal={busySignal}
      historySignal={historySignal}
      activeSessionActivityAt={activeSessionActivityAt}
      externallyInUse={activeSession?.externallyInUse}
      backgroundAgents={activeSession?.backgroundAgents}
      onForkSession={onForkSession}
      newWorkDisabled={newWorkDisabled || launchConfigurationLoading}
      newWorkDisabledHint={newWorkDisabled
        ? newWorkDisabledHint
        : launchConfigurationLoading
          ? "Loading model defaults…"
          : newWorkDisabledHint}
    />
  );
}
