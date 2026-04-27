import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { Routes, Route, useNavigate, useParams, useLocation, useNavigationType } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { queryKeys } from "./queryClient";
import {
  createSession,
  patchSession,
  fetchTasks,
  createTask,
  fetchTask,
  patchTask,
  deleteTask,
  deleteSession,
  duplicateSession,
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
  isSessionActive,
  markSessionReadOnPageHide,
  API_BASE,
  sendChatMessage,
  type ChecklistItem,
  type EnrichedTaskData,
  type Session,
  type Task,
  type TaskGroup,
  type McpServerStatus,
} from "./api";
import { useReadState } from "./useReadState";
import { usePageAttention } from "./usePageAttention";
import { useBackgroundVoiceJobs, type StartBackgroundVoiceJobOptions, type VoiceBackgroundJob } from "./hooks/useBackgroundVoiceJobs";
import { useDrafts } from "./useDrafts";
import { useStatusStream } from "./useStatusStream";
import { getComposerKeyFromPathname, getDraftComposerKey } from "./lib/composer-key";
import { getMobileRouteMeta } from "./lib/mobile-route-meta";
import { createBridgeMobileScrollRestoreState, getMobileScrollRestorationPolicy } from "./lib/mobile-scroll-restoration";
import { getSessionPath, type SessionNavigationTarget } from "./lib/session-path";
import { createDeferredTaskChangeInvalidator } from "./lib/task-change-invalidation";
import { reduceRestartBannerState, type RestartBannerState } from "./lib/restart-banner-state";
import { buildTaskDashboardSearch } from "./task-detail-focus";
import { useSettingsQuery } from "./hooks/queries/useSettings";
import { useTasksQuery } from "./hooks/queries/useTasks";
import { useTaskGroupsQuery } from "./hooks/queries/useTaskGroups";
import { mergeActiveAndArchivedSessions, useSessionsQuery } from "./hooks/queries/useSessions";
import { useOpenChecklistItemsQuery } from "./hooks/queries/useChecklistItems";
import useTaskIndicators, { countChatTabUnread, countTaskTabUnread } from "./hooks/useTaskIndicators";
import { getHomeChecklistIndicator } from "./checklist-helpers";
import TaskRail from "./components/TaskRail";
import TaskPanel from "./components/TaskPanel";
import TaskDashboard from "./components/TaskDashboard";
import TaskList from "./components/TaskList";
import ChatView from "./components/ChatView";
import Dashboard from "./components/Dashboard";
import SettingsView from "./components/SettingsView";
import DocsView from "./components/DocsView";
import SessionList from "./components/SessionList";
import RestartBanner from "./components/RestartBanner";
import PullToRefresh, { type PullToRefreshScrollRestoration } from "./components/PullToRefresh";
import TaskCompletionToast from "./components/TaskCompletionToast";
import { MobileBottomNav } from "./components/MobileBottomNav";
import { MobileDetailHeader } from "./components/MobileDetailHeader";
import { useIsMobile } from "./useIsMobile";
import { useFavicon } from "./useFavicon";
import { getLastViewedSession, setLastViewedSession, clearLastViewedSession, getLastViewedDoc, getLastActiveTask, setLastActiveTask, clearLastActiveTask, getLastActiveQuickChat, setLastActiveQuickChat, clearLastActiveQuickChat } from "./last-viewed";
import { createTaskCompletionFeedback, type TaskCompletionFeedback } from "./lib/task-completion-feedback";

const SESSION_BUSY_SIGNAL_GRACE_MS = 10_000;
const OPTIMISTIC_SESSION_TTL_MS = 2 * 60_000;
const TASK_COMPLETION_TOAST_MS = 6_000;

function isTaskCompleted(task: Pick<Task, "status" | "completedAt">): boolean {
  return task.status === "done" || Boolean(task.completedAt);
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
  const sessions = useMemo(
    () => mergeActiveAndArchivedSessions(activeSessions, archivedQuerySessions, archivedLoaded, restoringArchivedSessionIds),
    [activeSessions, archivedQuerySessions, archivedLoaded, restoringArchivedSessionIds],
  );
  const archivedLoading = archivedLoaded && !archivedSessionsFetched;
  const { data: tasks = [] } = useTasksQuery();
  const { data: taskGroups = [] } = useTaskGroupsQuery();
  const { data: openChecklistItems = [] } = useOpenChecklistItemsQuery();

  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [taskNotFound, setTaskNotFound] = useState(false);
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
    phase: null,
    waitingSessions: 0,
    shouldReload: false,
    reconnectedSincePending: false,
  });
  const [sessionReloads, setSessionReloads] = useState<Record<string, { token: number; servers: McpServerStatus[] }>>({});
  const [taskCompletionFeedback, setTaskCompletionFeedback] = useState<TaskCompletionFeedback | null>(null);
  const [undoingTaskCompletionId, setUndoingTaskCompletionId] = useState<string | null>(null);
  // Incremented per-session when an external source (e.g. schedule) starts work
  const [sessionBusySignals, setSessionBusySignals] = useState<Record<string, number>>({});
  const sessionBusyHintExpiresAtRef = useRef<Record<string, number>>({});

  // Settings query (shared with useTheme, SettingsView, etc.)
  const { data: settings } = useSettingsQuery();
  useFavicon(settings?.favicon);

  // Buffer task:changed SSE invalidations during optimistic task mutations so
  // concurrent server-side checklist changes are flushed instead of dropped.
  const taskChangeInvalidator = useMemo(
    () => createDeferredTaskChangeInvalidator(queryClient),
    [queryClient],
  );


  // Derive active IDs and mode from URL
  const mobileRouteMeta = getMobileRouteMeta(location.pathname, location.search);
  const activeSessionId = mobileRouteMeta.sessionId;
  const activeTaskId = mobileRouteMeta.taskId;
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
  const mobileTaskDashboardScrollRestoration = activeTaskId
    && mobileScrollRestorationPolicy?.key === `mobile:task-dashboard:${activeTaskId}`
    ? mobileScrollRestorationPolicy
    : undefined;

  // Sync selectedTask when activeTaskId changes
  useEffect(() => {
    if (activeTaskId) {
      setTaskNotFound(false);
      // Try local cache first
      const cached = tasks.find((t) => t.id === activeTaskId);
      if (cached) {
        setSelectedTask(cached);
      } else {
        fetchTask(activeTaskId).then(setSelectedTask).catch(() => {
          setSelectedTask(null);
          setTaskNotFound(true);
        });
      }
    } else {
      setTaskNotFound(false);
    }
  }, [activeTaskId]);

  // Auto-expand quick chats section when entering quick-chats mode on desktop
  useEffect(() => {
    if (!isMobile && quickChatsMode) {
      persistQuickChatsExpanded(true);
    }
  }, [quickChatsMode, isMobile]);

  // Keep selectedTask in sync with tasks list updates
  useEffect(() => {
    if (selectedTask) {
      const updated = tasks.find((t) => t.id === selectedTask.id);
      if (updated) setSelectedTask(updated);
    }
  }, [tasks]);

  const { isUnread, markRead, markUnread, unreadCount, applyServerState } = useReadState();
  // Ref for read-state SSE handler (avoids stale closure in useCallback)
  const applyServerStateRef = useRef(applyServerState);
  applyServerStateRef.current = applyServerState;
  const { getDraft, setDraft, setDraftImmediate, clearDraft, hasDraft } = useDrafts(sessions);
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
    if (sessionIds.length === 0) return;
    const targetIds = new Set(sessionIds);
    queryClient.setQueriesData<Session[]>({ queryKey: ["sessions"] }, (prev) =>
      prev?.map((s) => targetIds.has(s.sessionId) ? { ...s, ...patch } : s),
    );
  }, [queryClient]);
  const patchSessionInCache = useCallback((sessionId: string, patch: Partial<Session>) => {
    patchSessionsInCache([sessionId], patch);
  }, [patchSessionsInCache]);
  const buildTaskCompletionFeedback = useCallback((
    task: Task,
    previousStatus: Exclude<Task["status"], "done">,
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

  useStatusStream(useCallback((event) => {
    switch (event.type) {
      case "session:busy":
        if (event.sessionId) {
          patchSessionInCache(event.sessionId, { runState: "busy", busy: true });
          bumpSessionBusySignal(event.sessionId);
        }
        invalidateDashboard();
        break;
      case "session:stalled":
        if (event.sessionId) {
          patchSessionInCache(event.sessionId, { runState: "stalled", busy: true });
        }
        invalidateDashboard();
        break;
      case "session:idle":
        if (event.sessionId) {
          clearSessionBusyHint(event.sessionId);
          patchSessionInCache(event.sessionId, { runState: "idle", busy: false, intentText: null });
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
      case "server:restart-pending":
        setRestartBanner((prev) => reduceRestartBannerState(prev, {
          type: "server:restart-pending",
          waitingSessions: event.waitingSessions,
        }));
        break;
      case "server:restart-cleared":
        setRestartBanner((prev) => reduceRestartBannerState(prev, { type: "server:restart-cleared" }));
        break;
      case "schedule:triggered":
        // Schedule started work — refresh session list, task data, and schedule run history
        invalidateSessions();
        invalidateTasks();
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
      case "readstate:changed":
        if (event.readState) applyServerStateRef.current(event.readState);
        break;
      case "status:connected":
        setRestartBanner((prev) => reduceRestartBannerState(prev, { type: "status:connected" }));
        // Refresh sessions and lightweight Home urgency data on reconnect.
        invalidateSessions();
        invalidateDashboard();
        invalidateOpenChecklistItems();
        break;
    }
  }, [bumpSessionBusySignal, clearSessionBusyHint, patchSessionInCache, trackArchiveTransition, invalidateAllSessionQueries, invalidateDashboard, invalidateOpenChecklistItems, invalidateSessions, invalidateTasks, queryClient, taskChangeInvalidator]));

  useEffect(() => {
    if (!restartBanner.shouldReload) return;
    const timer = window.setTimeout(() => window.location.reload(), 1000);
    return () => clearTimeout(timer);
  }, [restartBanner.shouldReload]);

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
      setUndoingTaskCompletionId((current) => (current && reopenedTaskIds.has(current) ? null : current));
    }

    if (completedTasks.length > 0) {
      completedTasks.sort((left, right) => right.sortTime - left.sortTime);
      setTaskCompletionFeedback(completedTasks[0].feedback);
      setUndoingTaskCompletionId(null);
    }

    previousTasksRef.current = new Map(tasks.map((task) => [task.id, task]));
  }, [tasks, buildTaskCompletionFeedback]);

  useEffect(() => {
    if (!taskCompletionFeedback) return;
    const timer = window.setTimeout(() => {
      setTaskCompletionFeedback((current) => current?.taskId === taskCompletionFeedback.taskId ? null : current);
      setUndoingTaskCompletionId((current) => current === taskCompletionFeedback.taskId ? null : current);
    }, TASK_COMPLETION_TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [taskCompletionFeedback]);

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
      markRead(previousSessionId);
    }
    previousActiveSessionIdRef.current = activeSessionId;
  }, [activeSessionId, pageHasAttention, markRead]);

  useEffect(() => {
    if (!activeSessionId || !pageHasAttention) {
      dwelledSessionIdRef.current = null;
      return;
    }

    dwelledSessionIdRef.current = null;
    const timer = window.setTimeout(() => {
      if (!pageHasAttentionRef.current) return;
      dwelledSessionIdRef.current = activeSessionId;
      markRead(activeSessionId);
    }, 2000);

    return () => {
      window.clearTimeout(timer);
    };
  }, [activeSessionId, pageHasAttention, markRead]);

  useEffect(() => {
    if (!activeSessionId) return;

    const onPageHide = () => {
      if (!pageHasAttentionRef.current) return;
      if (dwelledSessionIdRef.current !== activeSessionId) return;
      markSessionReadOnPageHide(activeSessionId);
    };

    window.addEventListener("pagehide", onPageHide);
    return () => {
      window.removeEventListener("pagehide", onPageHide);
    };
  }, [activeSessionId]);

  // Track last-active task and quick chat for tab restore
  useEffect(() => {
    if (activeTaskId) setLastActiveTask(activeTaskId);
  }, [activeTaskId]);
  useEffect(() => {
    if (activeSessionId && !activeTaskId && quickChatsMode) {
      setLastActiveQuickChat(activeSessionId);
    }
  }, [activeSessionId, activeTaskId, quickChatsMode]);

  // Re-mark the active session as read when its activity timestamp advances
  // (e.g., busy→idle transition) while the user is still viewing it.
  const activeSessionActivity = useMemo(() => {
    if (!activeSessionId) return undefined;
    const session = sessions.find((s) => s.sessionId === activeSessionId);
    if (!session || isSessionActive(session)) return undefined;
    return getSessionActivityTime(session);
  }, [activeSessionId, sessions]);

  useEffect(() => {
    if (
      !pageHasAttention ||
      !activeSessionId ||
      !activeSessionActivity ||
      dwelledSessionIdRef.current !== activeSessionId
    ) {
      return;
    }
    if (isUnread(activeSessionId, activeSessionActivity)) {
      markRead(activeSessionId);
    }
  }, [activeSessionId, activeSessionActivity, isUnread, markRead, pageHasAttention]);

  // Optimistic insert
  const addOptimisticSession = useCallback((sessionId: string) => {
    const now = new Date();
    const timestamp = now.toISOString();
    queryClient.setQueriesData<Session[]>({ queryKey: ["sessions"] }, (prev) => {
      if (!prev || prev.some((s) => s.sessionId === sessionId)) return prev;
      return [{
        sessionId,
        summary: "New session",
        modifiedTime: timestamp,
        lastVisibleActivityAt: timestamp,
        runState: "idle",
        busy: false,
        diskSizeBytes: 0,
        isOptimistic: true,
        optimisticUntil: now.getTime() + OPTIMISTIC_SESSION_TTL_MS,
      }, ...prev];
    });
  }, [queryClient]);

  // Sessions not linked to any task
  const globalSessions = useMemo(() => {
    const taskSessionIds = new Set(tasks.flatMap((t) => t.sessionIds));
    return sessions.filter((s) => !taskSessionIds.has(s.sessionId));
  }, [sessions, tasks]);
  const navTaskIndicators = useTaskIndicators(tasks, sessions, isUnread, activeSessionId);
  const mobileTaskUnreadCount = useMemo(() => {
    return countTaskTabUnread(tasks, navTaskIndicators);
  }, [tasks, navTaskIndicators]);
  const mobileChatUnreadCount = useMemo(() => {
    return countChatTabUnread(globalSessions, isUnread);
  }, [globalSessions, isUnread]);
  const homeChecklistIndicator = useMemo(() => {
    return getHomeChecklistIndicator(openChecklistItems);
  }, [openChecklistItems]);

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
      if (task && task.sessionIds.length > 0) {
        const lastViewed = getLastViewedSession(id);
        const targetSessionId =
          lastViewed && task.sessionIds.includes(lastViewed)
            ? lastViewed
            : task.sessionIds[task.sessionIds.length - 1];
        navigate(`/tasks/${id}/sessions/${targetSessionId}${checklistItemParam}`);
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

  const handleGoHome = () => {
    setSelectedTask(null);
    navigate("/");
  };

  const handleOpenQuickChatsList = () => {
    setSelectedTask(null);
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
  const isDashboardActive = location.pathname === "/" || location.pathname === "/dashboard";

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
      setSelectedTask(null);
      navigate("/");
    } else {
      handleSelectQuickChats();
    }
  };

  const handleMobileTab = useCallback((tab: "home" | "tasks" | "chats" | "docs" | "settings") => {
    switch (tab) {
      case "home": navigate("/dashboard"); break;
      case "tasks": handleGoHome(); break;
      case "chats": handleOpenQuickChatsList(); break;
      case "docs": handleOpenDocsRoot(); break;
      case "settings": handleOpenSettings(); break;
    }
  }, [navigate, handleGoHome, handleOpenQuickChatsList, handleOpenDocsRoot, handleOpenSettings]);

  const handleMobileUp = useCallback(() => {
    const upTarget = mobileRouteMeta.upTarget;
    if (!upTarget) return;
    navigate(upTarget.to, { state: createBridgeMobileScrollRestoreState() });
  }, [mobileRouteMeta.upTarget, navigate]);

  const handleSelectSession = (sessionId: string) => {
    navigate(getSessionPath({ sessionId, taskId: activeTaskId }));
  };

  const handleNewSession = (taskId: string) => {
    navigate(`/tasks/${taskId}/sessions/new`);
  };

  const handleNewQuickChat = () => {
    navigate(`/sessions/new`);
  };

  const navigateToSession = useCallback((sessionId: string, taskId?: string, replace = false) => {
    navigate(getSessionPath({ sessionId, taskId }), { replace });
  }, [navigate]);

  const handleSelectDashboardSession = useCallback((target: SessionNavigationTarget) => {
    navigate(getSessionPath(target));
  }, [navigate]);

  // Actually create a session on the server (called on first message send)
  const materializeSession = useCallback(async (taskId?: string): Promise<string> => {
    if (taskId) {
      const sessionId = await createTaskSession(taskId);
      addOptimisticSession(sessionId);
      const addSession = (t: Task) =>
        t.id === taskId ? { ...t, sessionIds: [...t.sessionIds, sessionId] } : t;
      queryClient.setQueryData<Task[]>(queryKeys.tasks, (prev) => prev?.map(addSession));
      setSelectedTask((prev) => (prev ? addSession(prev) : prev));
      return sessionId;
    } else {
      const sessionId = await createSession();
      addOptimisticSession(sessionId);
      return sessionId;
    }
  }, [addOptimisticSession, queryClient]);

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
    reviewInstead,
    clearVoiceJobError,
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
  });

  const handleNewTask = async (groupId?: string) => {
    try {
      const task = await createTask("New Task", { groupId });
      queryClient.setQueryData<Task[]>(queryKeys.tasks, (prev) => prev ? [task, ...prev] : [task]);
      setSelectedTask(task);
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
      if (updates.status || updates.kind !== undefined || updates.completionAction) {
        // When status, kind, or completion changes, refetch all tasks since ordering can shift
        await queryClient.refetchQueries({ queryKey: queryKeys.tasks });
      } else {
        queryClient.setQueryData<Task[]>(queryKeys.tasks, (prev) =>
          prev?.map((t) => (t.id === taskId ? updated : t)),
        );
      }
      setSelectedTask((prev) => (prev?.id === taskId ? updated : prev));
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

  const handleDeleteTask = async (taskId: string) => {
    try {
      await deleteTask(taskId);
      clearLastActiveTask(taskId);
      setSelectedTask(null);
      navigate("/");
      await invalidateTasks();
    } catch (err) {
      console.error("Failed to delete task:", err);
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
    queryClient.setQueryData<Task[]>(queryKeys.tasks, (prev) =>
      prev?.map((t) => (t.id === taskId ? { ...t, groupId } : t)),
    );
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

  const dismissTaskCompletionFeedback = useCallback((taskId?: string) => {
    setTaskCompletionFeedback((current) => {
      if (!current) return current;
      if (taskId && current.taskId !== taskId) return current;
      return null;
    });
    setUndoingTaskCompletionId((current) => (taskId ? (current === taskId ? null : current) : null));
  }, []);

  const handleUndoTaskCompletion = useCallback(async () => {
    if (!taskCompletionFeedback) return;
    setUndoingTaskCompletionId(taskCompletionFeedback.taskId);
    const updated = await handleUpdateTask(taskCompletionFeedback.taskId, {
      status: taskCompletionFeedback.previousStatus,
    });
    if (updated) {
      dismissTaskCompletionFeedback(taskCompletionFeedback.taskId);
    } else {
      setUndoingTaskCompletionId(null);
    }
  }, [dismissTaskCompletionFeedback, handleUpdateTask, taskCompletionFeedback]);

  const handleMoveAndReorder = async (taskId: string, groupId: string | undefined, taskIds: string[]) => {
    // Single optimistic update: group move + reorder combined
    queryClient.setQueryData<Task[]>(queryKeys.tasks, (prev) => {
      if (!prev) return prev;
      const withGroup = prev.map((t) => (t.id === taskId ? { ...t, groupId } : t));
      const map = new Map(withGroup.map((t) => [t.id, t]));
      const reordered = taskIds.map((id, i) => {
        const t = map.get(id);
        return t ? { ...t, order: i } : null;
      }).filter(Boolean) as Task[];
      const reorderedIds = new Set(taskIds);
      const rest = withGroup.filter((t) => !reorderedIds.has(t.id));
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
      queryClient.setQueryData<Task[]>(queryKeys.tasks, (prev) =>
        prev?.map((t) => (t.id === taskId ? { ...t, tags } : t)),
      );
      setSelectedTask((prev) => (prev?.id === taskId ? { ...prev, tags } : prev));
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
    clearDraft(sessionId);
    clearDraftSessionBySessionId(sessionId);
    clearLastViewedSession(sessionId);
    clearLastActiveQuickChat(sessionId);
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

  const handleDuplicateSession = async (sessionId: string) => {
    try {
      const newId = await duplicateSession(sessionId);
      addOptimisticSession(newId);
      // Navigate to the new session in the same context
      const linkedTaskId = tasks.find((t) => t.sessionIds.includes(sessionId))?.id;
      if (linkedTaskId) {
        // Update task to include the new session
        queryClient.setQueryData<Task[]>(queryKeys.tasks, (prev) =>
          prev?.map((t) =>
            t.id === linkedTaskId ? { ...t, sessionIds: [...t.sessionIds, newId] } : t,
          ),
        );
        setSelectedTask((prev) =>
          prev?.id === linkedTaskId ? { ...prev, sessionIds: [...prev.sessionIds, newId] } : prev,
        );
        navigate(`/tasks/${linkedTaskId}/sessions/${newId}`);
      } else {
        navigate(`/sessions/${newId}`);
      }
      await Promise.all([invalidateAllSessionQueries(), invalidateTasks()]);
    } catch (err) {
      console.error("Failed to duplicate session:", err);
    }
  };

  const handleReloadSession = async (sessionId: string) => {
    try {
      const result = await reloadSession(sessionId);
      setSessionReloads((prev) => ({
        ...prev,
        [sessionId]: {
          token: (prev[sessionId]?.token ?? 0) + 1,
          servers: result.servers,
        },
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
    for (const id of unreadIds) markRead(id);
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
      for (const id of sessionIds) markRead(id);
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
        clearDraft(id);
        clearDraftSessionBySessionId(id);
        clearLastViewedSession(id);
        clearLastActiveQuickChat(id);
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
  }, [activeSessionId, activeTaskId, selectedTask, sessions, globalSessions, navigate, markRead, clearDraft, clearDraftSessionBySessionId, clearLastViewedSession, clearLastActiveQuickChat, patchSessionsInCache, invalidateAllSessionQueries, invalidateTasks]);

  // ── Mobile: detect breakpoint ─────────────────────────────────
  // On mobile (< md / 768px), we show stacked full-screen views.
  // The route determines which level of the hierarchy is visible.

  const isMobileRoute = {
    dashboard: mobileRouteMeta.route === "dashboard",
    taskList: mobileRouteMeta.route === "task-list" || mobileRouteMeta.route === "chat-list",
    taskDashboard: mobileRouteMeta.route === "task-dashboard",
    taskPanel: mobileRouteMeta.route === "task-session",
    chat: mobileRouteMeta.route === "task-session" || mobileRouteMeta.route === "quick-chat",
    settings: mobileRouteMeta.route === "settings",
    docs: mobileRouteMeta.route === "docs-root" || mobileRouteMeta.route === "docs-detail",
  };

  return (
    <div
      className="flex flex-col h-dvh bg-bg-primary text-text-primary"
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
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
        onGoHome={handleGoHome}
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
        onDuplicateSession={handleDuplicateSession}
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
      {/* Desktop: visible when a session is active or quick chats (not on task dashboard or home) */}
      {/* Mobile: show task list at / only */}
      {(() => {
        const showDesktopPanel = !!activeSessionId && !!activeTaskId;
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
                  onDuplicateSession={handleDuplicateSession}
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
              <div className="hidden md:flex md:shrink-0 min-w-0 min-h-0">
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
                  onDuplicateSession={handleDuplicateSession}
                  onReloadSession={handleReloadSession}
                  onMarkUnread={markUnread}
                  hasDraft={hasDraft}
                  onMoveTaskToGroup={handleMoveTaskToGroup}
                  onRefresh={async () => { await Promise.all([invalidateTasks(), invalidateAllSessionQueries(), invalidateTaskGroups()]); }}
                  onViewDashboard={(taskId, options) => navigate(
                    `/tasks/${taskId}${buildTaskDashboardSearch(options)}`,
                  )}
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
        {restartBanner.phase && <RestartBanner phase={restartBanner.phase} waitingSessions={restartBanner.waitingSessions} />}

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
                  onSelectSession={handleSelectDashboardSession}
                  onNewSession={handleNewQuickChat}
                  onResumeTask={handleResumeTask}
                />
              }
            />
            <Route
              path="dashboard"
              element={
                <Dashboard
                  onSelectTask={handleSelectTask}
                  onSelectSession={handleSelectDashboardSession}
                  onNewSession={handleNewQuickChat}
                  onResumeTask={handleResumeTask}
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
                    onDuplicateSession={handleDuplicateSession}
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
                  <div className="flex-1 flex items-center justify-center text-text-muted text-sm">
                    Loading…
                  </div>
                )
              }
            />
            <Route
              path="tasks/:taskId/sessions/:sessionId"
              element={
                <SessionRoute
                  sessions={sessions}
                  onMessageSent={invalidateSessions}
                  getDraft={getDraft}
                  getDraftSession={getDraftSession}
                  setDraft={setDraft}
                  clearDraft={clearDraft}
                  clearDraftSession={clearDraftSession}
                  clearDraftSessionBySessionId={clearDraftSessionBySessionId}
                  materializeSession={materializeSession}
                  getVoiceJob={getJobForComposer}
                  startBackgroundVoiceJob={startBackgroundVoiceJob}
                  reviewVoiceJob={reviewInstead}
                  clearVoiceJobError={clearVoiceJobError}
                  sessionReloads={sessionReloads}
                  sessionBusySignals={sessionBusySignals}
                />
              }
            />
            <Route
              path="sessions/:sessionId"
              element={
                <SessionRoute
                  sessions={sessions}
                  onMessageSent={invalidateSessions}
                  getDraft={getDraft}
                  getDraftSession={getDraftSession}
                  setDraft={setDraft}
                  clearDraft={clearDraft}
                  clearDraftSession={clearDraftSession}
                  clearDraftSessionBySessionId={clearDraftSessionBySessionId}
                  materializeSession={materializeSession}
                  getVoiceJob={getJobForComposer}
                  startBackgroundVoiceJob={startBackgroundVoiceJob}
                  reviewVoiceJob={reviewInstead}
                  clearVoiceJobError={clearVoiceJobError}
                  sessionReloads={sessionReloads}
                  sessionBusySignals={sessionBusySignals}
                />
              }
            />
            <Route path="docs/*" element={<DocsView />} />
            <Route path="settings" element={<SettingsView />} />
          </Routes>
        </main>
      </div>
      </div>{/* ← close row wrapper */}

      {taskCompletionFeedback && (
        <TaskCompletionToast
          feedback={taskCompletionFeedback}
          undoing={undoingTaskCompletionId === taskCompletionFeedback.taskId}
          onUndo={() => { void handleUndoTaskCompletion(); }}
          onDismiss={() => dismissTaskCompletionFeedback(taskCompletionFeedback.taskId)}
        />
      )}

      {/* ── Mobile bottom navigation ──────────────────────── */}
      {isMobile && mobileRouteMeta.showBottomNav && (
        <MobileBottomNav
          activeTab={mobileActiveTab}
          onSelectTab={handleMobileTab}
          homeChecklistIndicator={homeChecklistIndicator}
          taskUnreadCount={mobileTaskUnreadCount}
          chatUnreadCount={mobileChatUnreadCount}
        />
      )}
    </div>
  );
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
        onDuplicateSession,
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
  onDuplicateSession?: (sessionId: string) => void;
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
            onDuplicateSession={onDuplicateSession}
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
  getDraft,
  getDraftSession,
  setDraft,
  clearDraft,
  clearDraftSession,
  clearDraftSessionBySessionId,
  materializeSession,
  getVoiceJob,
  startBackgroundVoiceJob,
  reviewVoiceJob,
  clearVoiceJobError,
  sessionReloads,
  sessionBusySignals,
}: {
  sessions: Session[];
  onMessageSent: () => void;
  getDraft: (composerKey: string) => import("./useDrafts").Draft | null;
  getDraftSession: (composerKey: string) => string | null;
  setDraft: (composerKey: string, text: string, attachments?: import("./api").Attachment[]) => void;
  clearDraft: (composerKey: string) => void;
  clearDraftSession: (composerKey: string) => void;
  clearDraftSessionBySessionId: (sessionId: string) => void;
  materializeSession: (taskId?: string) => Promise<string>;
  getVoiceJob: (composerKey: string) => VoiceBackgroundJob | null;
  startBackgroundVoiceJob: (options: StartBackgroundVoiceJobOptions) => Promise<void>;
  reviewVoiceJob: (composerKey: string) => void;
  clearVoiceJobError: (composerKey: string) => void;
  sessionReloads: Record<string, { token: number; servers: McpServerStatus[] }>;
  sessionBusySignals: Record<string, number>;
}) {
  const { sessionId: rawSessionId, taskId } = useParams<{ sessionId: string; taskId: string }>();
  const navigate = useNavigate();

  const draftRouteKey = getDraftComposerKey(taskId);
  const isDraftRoute = rawSessionId === "new";
  const mappedDraftSessionId = getDraftSession(draftRouteKey);
  const validMappedDraftSessionId = mappedDraftSessionId && sessions.some((session) => session.sessionId === mappedDraftSessionId)
    ? mappedDraftSessionId
    : null;
  const sessionId = isDraftRoute ? validMappedDraftSessionId : (rawSessionId ?? null);
  const composerKey = sessionId ?? draftRouteKey;
  const isDraft = sessionId === null;
  const sessionReload = sessionId ? sessionReloads[sessionId] : undefined;
  const busySignal = sessionId ? sessionBusySignals[sessionId] ?? 0 : 0;
  const hasPlan = sessions.find((s) => s.sessionId === sessionId)?.hasPlan;
  const draft = getDraft(composerKey);
  const voiceJob = getVoiceJob(composerKey);

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
  const onCreateAndSend = useCallback(async (prompt: string, attachments?: import("./api").Attachment[]) => {
    const newSessionId = await materializeSession(taskId);
    // Send the message BEFORE navigating so the session is busy when
    // ChatView's effect reconnects the stream (avoids idle-close race).
    await sendChatMessage(newSessionId, prompt, attachments);
    clearDraft(composerKey);
    // Navigate to real session URL (replace draft URL in history)
    const path = taskId
      ? `/tasks/${taskId}/sessions/${newSessionId}`
      : `/sessions/${newSessionId}`;
    navigate(path, { replace: true });
  }, [clearDraft, composerKey, materializeSession, navigate, taskId]);

  return (
    <ChatView
      // No `key` here — the component must survive draft→real session transitions
      // so the optimistic user message is preserved and the wasDraft recovery path
      // in ChatView fires correctly. Session/draft-composer resets are handled
      // inside ChatView so draft→real transitions can still stay mounted.
      composerKey={composerKey}
      sessionId={sessionId}
      hasPlan={hasPlan}
        onMessageSent={handleMessageSent}
      draft={draft}
      onDraftChange={handleDraftChange}
      onDraftClear={handleDraftClear}
      onCreateAndSend={isDraft ? onCreateAndSend : undefined}
      voiceJob={voiceJob}
      onSubmitVoiceCapture={startBackgroundVoiceJob}
      onReviewVoiceJob={reviewVoiceJob}
      onClearVoiceJobError={clearVoiceJobError}
      reloadToken={sessionReload?.token ?? 0}
      reloadMcpServers={sessionReload?.servers}
      busySignal={busySignal}
    />
  );
}
