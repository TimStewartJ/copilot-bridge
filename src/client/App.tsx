import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { Routes, Route, useNavigate, useParams, useLocation } from "react-router-dom";
import {
  fetchSessions,
  createSession,
  patchSession,
  fetchTasks,
  createTask,
  fetchTask,
  patchTask,
  deleteTask,
  deleteSession,
  duplicateSession,
  createTaskSession,
  linkResource,
  reorderTasks,
  reorderTaskGroups,
  fetchTaskGroups,
  createTaskGroup,
  patchTaskGroup,
  deleteTaskGroup,
  batchSessionAction,
  fetchTags,
  setTaskTags,
  setGroupTags,
  API_BASE,
  type Session,
  type Task,
  type TaskGroup,
  type Tag,
} from "./api";
import { useReadState } from "./useReadState";
import { useDrafts } from "./useDrafts";
import { useStatusStream } from "./useStatusStream";
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
import PullToRefresh from "./components/PullToRefresh";
import { MobileBottomNav } from "./components/MobileBottomNav";
import { useIsMobile } from "./useIsMobile";
import { useFavicon } from "./useFavicon";
import { fetchSettings } from "./api";
import { getLastViewedSession, setLastViewedSession, clearLastViewedSession, getLastViewedDoc } from "./last-viewed";
import { useAppBack } from "./hooks/useAppBack";

export default function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const isMobile = useIsMobile();
  const { goBack } = useAppBack();

  const [sessions, setSessions] = useState<Session[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [taskGroups, setTaskGroups] = useState<TaskGroup[]>([]);
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
  const [restartPhase, setRestartPhase] = useState<"pending" | "reconnected" | null>(null);
  const [restartWaiting, setRestartWaiting] = useState(0);
  const [faviconKey, setFaviconKey] = useState<string | undefined>();
  const [scheduleVersion, setScheduleVersion] = useState(0);
  const [allTags, setAllTags] = useState<Tag[]>([]);

  // Apply favicon from settings on load
  useFavicon(faviconKey);
  useEffect(() => {
    fetchSettings().then((s) => setFaviconKey(s.favicon)).catch(() => {});
  }, []);

  // Track optimistic sessions that the server doesn't know about yet
  const optimisticIdsRef = useRef(new Set<string>());

  // Track whether archived sessions have been fetched
  const archivedLoadedRef = useRef(false);

  // Guard: skip SSE-driven loadTasks() while a task mutation is in-flight
  const taskMutationInFlight = useRef(0);

  // Derive active IDs and mode from URL
  const activeSessionId =
    location.pathname.match(/^\/tasks\/[^/]+\/sessions\/(.+)/)?.[1] ??
    location.pathname.match(/^\/sessions\/(.+)/)?.[1] ??
    null;
  const activeTaskId = location.pathname.match(/^\/tasks\/([^/]+)/)?.[1] ?? null;
  const quickChatsRoute = location.pathname === "/chats";
  // Also treat as quick-chats mode when viewing a session not linked to any task
  const quickChatsMode = quickChatsRoute || (
    !!activeSessionId && !activeTaskId &&
    !tasks.some((t) => t.sessionIds.includes(activeSessionId))
  );

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

  const { isUnread, markRead, markUnread, unreadCount } = useReadState(sessions, archivedLoadedRef.current);
  const { getDraft, setDraft, clearDraft, hasDraft } = useDrafts(sessions);

  const loadSessions = async () => {
    try {
      const includeArchived = archivedLoadedRef.current;
      const serverSessions = await fetchSessions(includeArchived);
      setSessions((prev) => {
        const serverIds = new Set(serverSessions.map((s) => s.sessionId));
        for (const id of serverIds) optimisticIdsRef.current.delete(id);
        const survivors = prev.filter(
          (s) => optimisticIdsRef.current.has(s.sessionId) && !serverIds.has(s.sessionId),
        );
        return [...survivors, ...serverSessions];
      });
    } catch (err) {
      console.error("Failed to load sessions:", err);
    }
  };

  const requestArchivedSessions = useCallback(async () => {
    if (archivedLoadedRef.current) return;
    archivedLoadedRef.current = true;
    await loadSessions();
  }, []);

  const loadTasks = async () => {
    try {
      setTasks(await fetchTasks());
    } catch (err) {
      console.error("Failed to load tasks:", err);
    }
  };

  const loadTaskGroups = async () => {
    try {
      setTaskGroups(await fetchTaskGroups());
    } catch (err) {
      console.error("Failed to load task groups:", err);
    }
  };

  const loadTags = async () => {
    try {
      setAllTags(await fetchTags());
    } catch (err) {
      console.error("Failed to load tags:", err);
    }
  };

  useEffect(() => {
    loadSessions();
    loadTasks();
    loadTaskGroups();
    loadTags();
  }, []);

  // Real-time status updates via SSE
  useStatusStream(useCallback((event) => {
    switch (event.type) {
      case "session:busy":
        setSessions((prev) =>
          prev.map((s) => s.sessionId === event.sessionId ? { ...s, busy: true } : s),
        );
        break;
      case "session:idle":
        setSessions((prev) =>
          prev.map((s) => s.sessionId === event.sessionId ? { ...s, busy: false } : s),
        );
        break;
      case "session:title":
        if (event.title) {
          setSessions((prev) =>
            prev.map((s) => s.sessionId === event.sessionId ? { ...s, summary: event.title } : s),
          );
        }
        break;
      case "session:archived":
        if (typeof event.archived === "boolean") {
          setSessions((prev) =>
            prev.map((s) => s.sessionId === event.sessionId ? { ...s, archived: event.archived! } : s),
          );
        }
        break;
      case "server:restart-pending":
        setRestartPhase("pending");
        setRestartWaiting(event.waitingSessions ?? 0);
        break;
      case "server:restart-cleared":
        setRestartPhase((prev) => {
          if (prev !== "pending") return prev;
          return "reconnected";
        });
        setRestartWaiting(0);
        break;
      case "schedule:changed":
        setScheduleVersion((v) => v + 1);
        break;
      case "task:changed":
        if (taskMutationInFlight.current === 0) loadTasks();
        break;
      case "status:connected":
        // Don't touch restart state — server sends authoritative state on connect
        break;
    }
  }, []));

  // Auto-dismiss "reconnected" banner after 2 seconds
  useEffect(() => {
    if (restartPhase !== "reconnected") return;
    const timer = setTimeout(() => setRestartPhase(null), 2000);
    return () => clearTimeout(timer);
  }, [restartPhase]);

  // Background poll for reconciliation (slow: 30s, visibility-aware)
  useEffect(() => {
    const poll = () => {
      if (document.visibilityState === "visible") loadSessions();
    };
    const timer = setInterval(poll, 30_000);
    return () => clearInterval(timer);
  }, []);

  // Mark session as read after 2s dwell, and again on departure to capture
  // any messages that arrived after the initial mark.
  useEffect(() => {
    if (!activeSessionId) return;
    // Track last-viewed session for this task immediately
    if (activeTaskId) setLastViewedSession(activeTaskId, activeSessionId);
    let dwelled = false;
    const timer = setTimeout(() => {
      dwelled = true;
      markRead(activeSessionId);
    }, 2000);
    return () => {
      clearTimeout(timer);
      if (dwelled) markRead(activeSessionId);
    };
  }, [activeSessionId, activeTaskId, markRead]);

  // Optimistic insert
  const addOptimisticSession = useCallback((sessionId: string) => {
    optimisticIdsRef.current.add(sessionId);
    setSessions((prev) => {
      if (prev.some((s) => s.sessionId === sessionId)) return prev;
      return [{
        sessionId,
        summary: "New session",
        modifiedTime: new Date().toISOString(),
        diskSizeBytes: 0,
      }, ...prev];
    });
  }, []);

  // Sessions not linked to any task
  const globalSessions = useMemo(() => {
    const taskSessionIds = new Set(tasks.flatMap((t) => t.sessionIds));
    return sessions.filter((s) => !taskSessionIds.has(s.sessionId));
  }, [sessions, tasks]);

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

  const handleSelectTask = (id: string, opts?: { todoId?: string }) => {
    const todoParam = opts?.todoId ? `?todo=${opts.todoId}` : "";
    if (!isMobile) {
      const task = tasks.find((t) => t.id === id);
      if (task && task.sessionIds.length > 0) {
        const lastViewed = getLastViewedSession(id);
        const targetSessionId =
          lastViewed && task.sessionIds.includes(lastViewed)
            ? lastViewed
            : task.sessionIds[task.sessionIds.length - 1];
        navigate(`/tasks/${id}/sessions/${targetSessionId}${todoParam}`);
        return;
      }
    }
    navigate(`/tasks/${id}${todoParam}`);
  };

  const handleSelectQuickChats = () => {
    if (isMobile) {
      setSelectedTask(null);
      navigate("/chats");
    } else {
      // On desktop, toggle the quick chats section open in the rail
      if (!railExpanded) setRailExpanded(true);
      persistQuickChatsExpanded((v) => !v);
    }
  };

  const handleGoHome = () => {
    setSelectedTask(null);
    navigate("/");
  };

  const handleOpenSettings = () => {
    navigate("/settings");
  };

  const handleOpenDocs = () => {
    const lastDoc = getLastViewedDoc();
    if (lastDoc) {
      // Stored as "path" or "path?db" for DB folders
      const isDb = lastDoc.endsWith("?db");
      const docPath = isDb ? lastDoc.slice(0, -3) : lastDoc;
      navigate(isDb ? `/docs/${docPath}?db` : `/docs/${docPath}`);
    } else {
      navigate("/docs");
    }
  };

  const isDocsActive = location.pathname.startsWith("/docs");
  const isDashboardActive = location.pathname === "/" || location.pathname === "/dashboard";

  // ── Mobile bottom nav state ──────────────────────────────────
  const mobileActiveTab = location.pathname === "/dashboard"
    ? "home" as const
    : isDocsActive
      ? "docs" as const
      : location.pathname === "/settings"
        ? "settings" as const
        : quickChatsMode
          ? "chats" as const
          : "tasks" as const;

  const mobileUnreadCount = useMemo(() => {
    return globalSessions.filter(
      (s) => !s.archived && isUnread(s.sessionId, s.modifiedTime),
    ).length;
  }, [globalSessions, isUnread]);

  const handleMobileTab = useCallback((tab: "home" | "tasks" | "chats" | "docs" | "settings") => {
    switch (tab) {
      case "home": navigate("/dashboard"); break;
      case "tasks": handleGoHome(); break;
      case "chats": handleSelectQuickChats(); break;
      case "docs": handleOpenDocs(); break;
      case "settings": handleOpenSettings(); break;
    }
  }, [navigate, handleGoHome, handleSelectQuickChats, handleOpenDocs, handleOpenSettings]);

  const handleSelectSession = (sessionId: string) => {
    if (activeTaskId) {
      navigate(`/tasks/${activeTaskId}/sessions/${sessionId}`);
    } else {
      navigate(`/sessions/${sessionId}`);
    }
  };

  const handleNewSession = (taskId: string) => {
    navigate(`/tasks/${taskId}/sessions/new`);
  };

  const handleNewQuickChat = () => {
    navigate(`/sessions/new`);
  };

  // Actually create a session on the server (called on first message send)
  const materializeSession = useCallback(async (taskId?: string): Promise<string> => {
    if (taskId) {
      const sessionId = await createTaskSession(taskId);
      addOptimisticSession(sessionId);
      const addSession = (t: Task) =>
        t.id === taskId ? { ...t, sessionIds: [...t.sessionIds, sessionId] } : t;
      setTasks((prev) => prev.map(addSession));
      setSelectedTask((prev) => (prev ? addSession(prev) : prev));
      return sessionId;
    } else {
      const sessionId = await createSession();
      addOptimisticSession(sessionId);
      return sessionId;
    }
  }, [addOptimisticSession]);

  const handleNewTask = async (groupId?: string) => {
    try {
      const task = await createTask("New Task", groupId);
      setTasks((prev) => [task, ...prev]);
      setSelectedTask(task);
      navigate(`/tasks/${task.id}/sessions/new`);
    } catch (err) {
      console.error("Failed to create task:", err);
    }
  };

  const handleUpdateTask = async (taskId: string, updates: Partial<Pick<Task, "title" | "status">>) => {
    try {
      const updated = await patchTask(taskId, updates);
      // When status changes, refetch all tasks since order values shift
      if (updates.status) {
        setTasks(await fetchTasks());
      } else {
        setTasks((prev) => prev.map((t) => (t.id === taskId ? updated : t)));
      }
      setSelectedTask((prev) => (prev?.id === taskId ? updated : prev));
    } catch (err) {
      console.error("Failed to update task:", err);
    }
  };

  const handleReorderTasks = async (taskIds: string[]) => {
    // Optimistic: reorder in local state immediately
    setTasks((prev) => {
      const map = new Map(prev.map((t) => [t.id, t]));
      const reordered = taskIds.map((id, i) => {
        const t = map.get(id);
        return t ? { ...t, order: i } : null;
      }).filter(Boolean) as Task[];
      // Keep tasks not in the reorder set
      const reorderedIds = new Set(taskIds);
      const rest = prev.filter((t) => !reorderedIds.has(t.id));
      return [...reordered, ...rest];
    });
    taskMutationInFlight.current++;
    try {
      await reorderTasks(taskIds);
    } catch (err) {
      console.error("Failed to reorder tasks:", err);
      setTasks(await fetchTasks());
    } finally {
      taskMutationInFlight.current--;
    }
  };

  const handleDeleteTask = async (taskId: string) => {
    try {
      await deleteTask(taskId);
      setSelectedTask(null);
      navigate("/");
      await loadTasks();
    } catch (err) {
      console.error("Failed to delete task:", err);
    }
  };

  // ── Task Group handlers ─────────────────────────────────────────

  const handleCreateGroup = async (name: string, color?: string) => {
    try {
      const group = await createTaskGroup(name, color);
      setTaskGroups((prev) => [...prev, group]);
      return group;
    } catch (err) {
      console.error("Failed to create group:", err);
      return null;
    }
  };

  const handleUpdateGroup = async (groupId: string, updates: Partial<Pick<TaskGroup, "name" | "color" | "collapsed">>) => {
    try {
      const updated = await patchTaskGroup(groupId, updates);
      setTaskGroups((prev) => prev.map((g) => (g.id === groupId ? updated : g)));
    } catch (err) {
      console.error("Failed to update group:", err);
    }
  };

  const handleDeleteGroup = async (groupId: string) => {
    try {
      await deleteTaskGroup(groupId);
      setTaskGroups((prev) => prev.filter((g) => g.id !== groupId));
      // Tasks in this group become ungrouped — refetch
      setTasks(await fetchTasks());
    } catch (err) {
      console.error("Failed to delete group:", err);
    }
  };

  const handleReorderGroups = async (groupIds: string[]) => {
    // Optimistic update
    setTaskGroups((prev) => {
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
      setTaskGroups(await fetchTaskGroups());
    }
  };

  const handleMoveTaskToGroup = async (taskId: string, groupId: string | undefined) => {
    // Optimistic update
    setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, groupId } : t)));
    taskMutationInFlight.current++;
    try {
      await patchTask(taskId, { groupId: groupId ?? ("" as any) });
    } catch (err) {
      console.error("Failed to move task to group:", err);
      setTasks(await fetchTasks());
    } finally {
      taskMutationInFlight.current--;
    }
  };

  const handleMoveAndReorder = async (taskId: string, groupId: string | undefined, taskIds: string[]) => {
    // Single optimistic update: group move + reorder combined
    setTasks((prev) => {
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
    // Serialize server calls to avoid load/save race
    taskMutationInFlight.current++;
    try {
      await patchTask(taskId, { groupId: groupId ?? ("" as any) });
      await reorderTasks(taskIds);
    } catch (err) {
      console.error("Failed to move and reorder:", err);
      setTasks(await fetchTasks());
    } finally {
      taskMutationInFlight.current--;
    }
  };

  // ── Tag handlers ────────────────────────────────────────────────

  const handleSetTaskTags = async (taskId: string, tagIds: string[]) => {
    try {
      const tags = await setTaskTags(taskId, tagIds);
      setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, tags } : t)));
      setSelectedTask((prev) => (prev?.id === taskId ? { ...prev, tags } : prev));
    } catch (err) {
      console.error("Failed to set task tags:", err);
    }
  };

  const handleSetGroupTags = async (groupId: string, tagIds: string[]) => {
    try {
      const tags = await setGroupTags(groupId, tagIds);
      setTaskGroups((prev) => prev.map((g) => (g.id === groupId ? { ...g, tags } : g)));
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
      await loadSessions();
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
    clearLastViewedSession(sessionId);
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
      await Promise.all([loadSessions(), loadTasks()]);
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
        setTasks((prev) =>
          prev.map((t) =>
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
      await Promise.all([loadSessions(), loadTasks()]);
    } catch (err) {
      console.error("Failed to duplicate session:", err);
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
    await loadTasks();
    // Update URL to reflect the new task context
    if (activeSessionId === sessionId && !activeTaskId) {
      navigate(`/tasks/${taskId}/sessions/${sessionId}`, { replace: true });
    }
  };

  // ── Bulk actions for quick chats ──────────────────────────────
  const handleMarkAllRead = useCallback(() => {
    const unreadIds = globalSessions
      .filter((s) => !s.archived && isUnread(s.sessionId, s.modifiedTime))
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
      await new Promise((r) => setTimeout(r, 200));
      setArchivingIds((prev) => {
        const next = new Set(prev);
        for (const id of sessionIds) next.add(id);
        return next;
      });
    }

    if (action === "delete") {
      for (const id of sessionIds) {
        clearDraft(id);
        clearLastViewedSession(id);
      }
      setExitingIds((prev) => {
        const next = new Set(prev);
        for (const id of sessionIds) next.add(id);
        return next;
      });
      await new Promise((r) => setTimeout(r, 200));
    }

    try {
      await batchSessionAction(action, sessionIds);
      await Promise.all([loadSessions(), loadTasks()]);
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
  }, [activeSessionId, activeTaskId, selectedTask, sessions, globalSessions, navigate, markRead, clearDraft, loadSessions, loadTasks]);

  // ── Mobile: detect breakpoint ─────────────────────────────────
  // On mobile (< md / 768px), we show stacked full-screen views.
  // The route determines which level of the hierarchy is visible.

  const isTaskDashboard = !!activeTaskId && !activeSessionId;

  const isMobileRoute = {
    dashboard: location.pathname === "/dashboard",
    taskList: (location.pathname === "/" || location.pathname === "/chats") && !activeTaskId && !activeSessionId,
    taskDashboard: isTaskDashboard,
    taskPanel: !!activeTaskId && !!activeSessionId,
    chat: !!activeSessionId,
    settings: location.pathname === "/settings",
    docs: location.pathname.startsWith("/docs"),
  };

  return (
    <div
      className="flex flex-col h-dvh bg-bg-primary text-text-primary"
      style={{ paddingTop: "env(safe-area-inset-top)" }}
    >
      {/* Row wrapper: TaskRail + sidebar + main content fill space above mobile nav */}
      <div className="flex flex-1 min-h-0">
      {/* ── Task Rail (desktop only) ──────────────────────── */}
      <TaskRail
        tasks={tasks}
        taskGroups={taskGroups}
        activeTaskId={activeTaskId}
        onSelectTask={handleSelectTask}
        onNewTask={handleNewTask}
        onSelectQuickChats={handleSelectQuickChats}
        isQuickChatsActive={quickChatsMode && !activeTaskId}
        onGoHome={handleGoHome}
        onOpenSettings={handleOpenSettings}
        onOpenDocs={handleOpenDocs}
        isDocsActive={isDocsActive}
        isDashboardActive={isDashboardActive}
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
        onMoveTaskToGroup={handleMoveTaskToGroup}
        onMoveAndReorder={handleMoveAndReorder}
        orphanSessions={globalSessions}
        activeSessionId={activeSessionId}
        onSelectSession={(id) => navigate(`/sessions/${id}`)}
        onNewQuickChat={handleNewQuickChat}
        quickChatsExpanded={quickChatsExpanded}
        onToggleQuickChats={() => persistQuickChatsExpanded((v) => !v)}
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
                  markUnread={markUnread}
                  onRefresh={async () => { await Promise.all([loadTasks(), loadSessions(), loadTaskGroups()]); }}
                  hasDraft={hasDraft}
                  onMarkAllRead={handleMarkAllRead}
                  onBulkAction={handleBulkAction}
                  onRequestArchived={requestArchivedSessions}
                  archivedLoaded={archivedLoadedRef.current}
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
                  onTasksChanged={loadTasks}
                  scheduleVersion={scheduleVersion}
                  isUnread={isUnread}
                  onArchiveSession={handleArchiveSession}
                  archivingIds={archivingIds}
                  exitingIds={exitingIds}
                  tasks={tasks}
                  onLinkToTask={handleLinkToTask}
                  onDeleteTask={handleDeleteTask}
                  onDeleteSession={handleDeleteSession}
                  onDuplicateSession={handleDuplicateSession}
                  onMarkUnread={markUnread}
                  hasDraft={hasDraft}
                  onMoveTaskToGroup={handleMoveTaskToGroup}
                  onRefresh={async () => { await Promise.all([loadTasks(), loadSessions(), loadTaskGroups()]); }}
                  onViewDashboard={(taskId) => navigate(`/tasks/${taskId}`)}
                  onMarkAllRead={handleMarkAllRead}
                  onBulkAction={handleBulkAction}
                  onRequestArchived={requestArchivedSessions}
                  archivedLoaded={archivedLoadedRef.current}
                  allTags={allTags}
                  onSetTaskTags={handleSetTaskTags}
                  onTagCreated={loadTags}
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
        {restartPhase && <RestartBanner phase={restartPhase} waitingSessions={restartWaiting} />}

        {/* Mobile back bar (hidden on top-level tab views) */}
        <div className={`shrink-0 flex items-center gap-3 px-4 py-2.5 border-b border-border bg-bg-secondary md:hidden ${isMobileRoute.dashboard ? "hidden" : ""}`}>
          <button
            onClick={goBack}
            className="text-text-muted hover:text-text-primary transition-colors text-sm"
            aria-label="Back"
          >
            ← Back
          </button>
        </div>

        <main className="flex-1 flex flex-col min-h-0">
          <Routes>
            <Route
              index
              element={
                <Dashboard
                  onSelectTask={handleSelectTask}
                  onSelectSession={(id) => navigate(`/sessions/${id}`)}
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
                  onSelectSession={(id) => navigate(`/sessions/${id}`)}
                  onNewSession={handleNewQuickChat}
                  onResumeTask={handleResumeTask}
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
                    onTasksChanged={loadTasks}
                    scheduleVersion={scheduleVersion}
                    isUnread={isUnread}
                    allTags={allTags}
                    onSetTaskTags={handleSetTaskTags}
                    onTagCreated={loadTags}
                    onRefresh={async () => { await Promise.all([loadTasks(), loadSessions(), loadTaskGroups()]); }}
                    onDeleteSession={handleDeleteSession}
                    onDuplicateSession={handleDuplicateSession}
                    onArchiveSession={handleArchiveSession}
                    onMarkUnread={markUnread}
                    hasDraft={hasDraft}
                    onRequestArchived={requestArchivedSessions}
                    archivedLoaded={archivedLoadedRef.current}
                  />
                ) : taskNotFound ? (
                  <div className="flex-1 flex flex-col items-center justify-center gap-3">
                    <div className="text-text-muted text-sm">Task not found</div>
                    <button
                      onClick={() => navigate("/")}
                      className="text-xs text-accent hover:text-accent-hover"
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
                <SessionRoute sessions={sessions} onMessageSent={loadSessions} getDraft={getDraft} setDraft={setDraft} clearDraft={clearDraft} materializeSession={materializeSession} />
              }
            />
            <Route
              path="sessions/:sessionId"
              element={
                <SessionRoute sessions={sessions} onMessageSent={loadSessions} getDraft={getDraft} setDraft={setDraft} clearDraft={clearDraft} materializeSession={materializeSession} />
              }
            />
            <Route path="docs/*" element={<DocsView />} />
            <Route path="settings" element={<SettingsView />} />
          </Routes>
        </main>
      </div>
      </div>{/* ← close row wrapper */}

      {/* ── Mobile bottom navigation ──────────────────────── */}
      {isMobile && (isMobileRoute.dashboard || isMobileRoute.taskList || isMobileRoute.taskDashboard || isMobileRoute.settings || isMobileRoute.docs) && (
        <MobileBottomNav
          activeTab={mobileActiveTab}
          onSelectTab={handleMobileTab}
          unreadCount={mobileUnreadCount}
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
  markUnread,
  onRefresh,
  hasDraft,
  onMarkAllRead,
  onBulkAction,
  onRequestArchived,
  archivedLoaded,
}: {
  tasks: Task[];
  activeTaskId: string | null;
  onSelectTask: (id: string) => void;
  onNewTask: (groupId?: string) => void;
  sessions: Session[];
  isUnread?: (sessionId: string, modifiedTime?: string) => boolean;
  markRead?: (sessionId: string) => void;
  onUpdateTask?: (taskId: string, updates: Partial<Pick<Task, "title" | "status">>) => void;
  onDeleteTask?: (taskId: string) => void;
  onReorderTasks?: (taskIds: string[]) => void;
  quickChatsMode: boolean;
  taskGroups?: TaskGroup[];
  onMoveTaskToGroup?: (taskId: string, groupId: string | undefined) => void;
  onMoveAndReorder?: (taskId: string, groupId: string | undefined, taskIds: string[]) => void;
  onCreateGroup?: (name: string, color?: string) => Promise<TaskGroup | null>;
  onUpdateGroup?: (groupId: string, updates: Partial<Pick<TaskGroup, "name" | "color" | "collapsed">>) => void;
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
  markUnread?: (sessionId: string) => void;
  onRefresh: () => Promise<void>;
  hasDraft?: (sessionId: string) => boolean;
  onMarkAllRead?: () => void;
  onBulkAction?: (action: import("./api").BatchAction, sessionIds: string[]) => void;
  onRequestArchived?: () => void;
  archivedLoaded?: boolean;
}){
  const [selectMode, setSelectMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  const toggleSelect = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleMobileBulkAction = useCallback((action: import("./api").BatchAction, ids: string[]) => {
    onBulkAction?.(action, ids);
    setSelectedIds(new Set());
    setSelectMode(false);
  }, [onBulkAction]);

  const unreadCount = orphanSessions.filter(
    (s) => !s.archived && isUnread?.(s.sessionId, s.modifiedTime),
  ).length;

  const activeCount = orphanSessions.filter((s) => !s.archived).length;

  return (
    <div className="flex flex-col h-full bg-bg-secondary min-w-0 overflow-hidden">
      {/* Header */}
      <div className="p-4 border-b border-border flex items-center justify-between">
        <span className="text-sm font-semibold text-text-primary">
          {quickChatsMode ? "Quick Chats" : "Tasks"}
        </span>
        <div className="flex items-center gap-2">
          {quickChatsMode && !selectMode && unreadCount > 0 && onMarkAllRead && (
            <button
              onClick={onMarkAllRead}
              className="text-text-muted hover:text-accent transition-colors text-xs"
            >
              Read all
            </button>
          )}
          {quickChatsMode && onBulkAction && activeCount > 0 && (
            <button
              onClick={() => {
                setSelectMode(!selectMode);
                if (selectMode) setSelectedIds(new Set());
              }}
              className={`text-xs transition-colors ${selectMode ? "text-accent font-medium" : "text-text-muted hover:text-text-secondary"}`}
            >
              {selectMode ? "Done" : "Select"}
            </button>
          )}
        </div>
      </div>

      {/* Content — pull-to-refresh wraps both tabs */}
      <div className="flex-1 min-h-0 relative">
      <PullToRefresh onRefresh={onRefresh} className="absolute inset-0 overflow-x-hidden min-w-0" scrollKey={quickChatsMode ? "chats" : "tasks"}>
        {quickChatsMode ? (
          <SessionList
            variant="global"
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
            onMarkUnread={markUnread}
            hasDraft={hasDraft}
            selectMode={selectMode}
            selectedIds={selectedIds}
            onToggleSelect={toggleSelect}
            onBulkAction={handleMobileBulkAction}
            onRequestArchived={onRequestArchived}
            archivedLoaded={archivedLoaded}
            className="min-w-0 overflow-x-hidden p-2 space-y-1"
          />
        ) : (
          <TaskList
            tasks={tasks}
            taskGroups={taskGroups}
            activeTaskId={activeTaskId}
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
function SessionRoute({ sessions, onMessageSent, getDraft, setDraft, clearDraft, materializeSession }: {
  sessions: Session[];
  onMessageSent: () => void;
  getDraft: (id: string) => import("./useDrafts").Draft | null;
  setDraft: (id: string, text: string, attachments?: import("./api").BlobAttachment[]) => void;
  clearDraft: (id: string) => void;
  materializeSession: (taskId?: string) => Promise<string>;
}) {
  const { sessionId: rawSessionId, taskId } = useParams<{ sessionId: string; taskId: string }>();
  const navigate = useNavigate();

  const isDraft = rawSessionId === "new";
  const sessionId = isDraft ? null : (rawSessionId ?? null);
  const hasPlan = sessions.find((s) => s.sessionId === sessionId)?.hasPlan;
  const draft = sessionId ? getDraft(sessionId) : null;
  const handleDraftChange = useCallback(
    (text: string, attachments?: import("./api").BlobAttachment[]) => {
      if (sessionId) setDraft(sessionId, text, attachments);
    },
    [sessionId, setDraft],
  );
  const handleDraftClear = useCallback(() => {
    if (sessionId) clearDraft(sessionId);
  }, [sessionId, clearDraft]);

  // Create session on first message, then redirect to real URL
  const onCreateAndSend = useCallback(async (prompt: string, attachments?: import("./api").BlobAttachment[]) => {
    const newSessionId = await materializeSession(taskId);
    // Send the message BEFORE navigating so the session is busy when
    // ChatView's effect reconnects the stream (avoids idle-close race).
    await fetch(`${API_BASE}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: newSessionId, prompt, ...(attachments?.length ? { attachments } : {}) }),
    });
    // Navigate to real session URL (replace draft URL in history)
    const path = taskId
      ? `/tasks/${taskId}/sessions/${newSessionId}`
      : `/sessions/${newSessionId}`;
    navigate(path, { replace: true });
  }, [materializeSession, taskId, navigate]);

  return (
    <ChatView
      // No `key` here — the component must survive draft→real session transitions
      // so the optimistic user message is preserved and the wasDraft recovery path
      // in ChatView fires correctly.  Session-switch resets are handled by the
      // useEffect on sessionId inside ChatView.
      sessionId={sessionId}
      hasPlan={hasPlan}
      onMessageSent={onMessageSent}
      draft={draft}
      onDraftChange={handleDraftChange}
      onDraftClear={handleDraftClear}
      onCreateAndSend={isDraft ? onCreateAndSend : undefined}
    />
  );
}
