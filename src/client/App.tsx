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
  createTaskSession,
  linkResource,
  reorderTasks,
  fetchTaskGroups,
  createTaskGroup,
  patchTaskGroup,
  deleteTaskGroup,
  type Session,
  type Task,
  type TaskGroup,
} from "./api";
import { useReadState } from "./useReadState";
import { useStatusStream } from "./useStatusStream";
import TaskRail from "./components/TaskRail";
import TaskPanel from "./components/TaskPanel";
import TaskList from "./components/TaskList";
import ChatView from "./components/ChatView";
import Dashboard from "./components/Dashboard";
import SettingsView from "./components/SettingsView";
import SessionList from "./components/SessionList";
import RestartBanner from "./components/RestartBanner";
import PullToRefresh from "./components/PullToRefresh";
import { useIsMobile } from "./useIsMobile";

export default function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const isMobile = useIsMobile();

  const [sessions, setSessions] = useState<Session[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [taskGroups, setTaskGroups] = useState<TaskGroup[]>([]);
  const [selectedTask, setSelectedTask] = useState<Task | null>(null);
  const [quickChatsMode, setQuickChatsMode] = useState(false);
  const [railExpanded, setRailExpanded] = useState(true);
  const [restartPending, setRestartPending] = useState(false);
  const [restartWaiting, setRestartWaiting] = useState(0);

  // Track optimistic sessions that the server doesn't know about yet
  const optimisticIdsRef = useRef(new Set<string>());

  // Derive active IDs from URL
  const activeSessionId =
    location.pathname.match(/^\/tasks\/[^/]+\/sessions\/(.+)/)?.[1] ??
    location.pathname.match(/^\/sessions\/(.+)/)?.[1] ??
    null;
  const activeTaskId = location.pathname.match(/^\/tasks\/([^/]+)/)?.[1] ?? null;

  // Sync selectedTask when activeTaskId changes
  useEffect(() => {
    if (activeTaskId) {
      // Try local cache first
      const cached = tasks.find((t) => t.id === activeTaskId);
      if (cached) {
        setSelectedTask(cached);
      } else {
        fetchTask(activeTaskId).then(setSelectedTask).catch(() => setSelectedTask(null));
      }
      setQuickChatsMode(false);
    }
  }, [activeTaskId]);

  // Keep selectedTask in sync with tasks list updates
  useEffect(() => {
    if (selectedTask) {
      const updated = tasks.find((t) => t.id === selectedTask.id);
      if (updated) setSelectedTask(updated);
    }
  }, [tasks]);

  const { isUnread, markRead, markUnread, unreadCount } = useReadState(sessions);

  const loadSessions = async () => {
    try {
      const serverSessions = await fetchSessions(true);
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

  useEffect(() => {
    loadSessions();
    loadTasks();
    loadTaskGroups();
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
          prev.map((s) => s.sessionId === event.sessionId ? { ...s, busy: false, modifiedTime: new Date().toISOString() } : s),
        );
        break;
      case "session:title":
        if (event.title) {
          setSessions((prev) =>
            prev.map((s) => s.sessionId === event.sessionId ? { ...s, summary: event.title, modifiedTime: new Date().toISOString() } : s),
          );
        }
        break;
      case "server:restart-pending":
        setRestartPending(true);
        setRestartWaiting(event.waitingSessions ?? 0);
        break;
      case "server:restart-cleared":
      case "status:connected":
        setRestartPending(false);
        setRestartWaiting(0);
        break;
    }
  }, []));

  // Background poll for reconciliation (slow: 30s, visibility-aware)
  useEffect(() => {
    const poll = () => {
      if (document.visibilityState === "visible") loadSessions();
    };
    const timer = setInterval(poll, 30_000);
    return () => clearInterval(timer);
  }, []);

  // Mark session as read when opened
  useEffect(() => {
    if (activeSessionId) markRead(activeSessionId);
  }, [activeSessionId, markRead]);

  // Mark the departing session as read when navigating away
  const prevSessionRef = useRef<string | null>(null);
  useEffect(() => {
    if (prevSessionRef.current && prevSessionRef.current !== activeSessionId) {
      markRead(prevSessionRef.current);
    }
    prevSessionRef.current = activeSessionId;
  }, [activeSessionId, markRead]);

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

  const handleSelectTask = (id: string) => {
    setQuickChatsMode(false);
    if (!isMobile) {
      const task = tasks.find((t) => t.id === id);
      if (task && task.sessionIds.length > 0) {
        const mostRecentSessionId = task.sessionIds[task.sessionIds.length - 1];
        navigate(`/tasks/${id}/sessions/${mostRecentSessionId}`);
        return;
      }
    }
    navigate(`/tasks/${id}`);
  };

  const handleSelectQuickChats = () => {
    setSelectedTask(null);
    setQuickChatsMode(true);
    navigate("/");
  };

  const handleGoHome = () => {
    setSelectedTask(null);
    setQuickChatsMode(false);
    navigate("/");
  };

  const handleOpenSettings = () => {
    navigate("/settings");
  };

  const handleSelectSession = (sessionId: string) => {
    if (activeTaskId) {
      navigate(`/tasks/${activeTaskId}/sessions/${sessionId}`);
    } else {
      navigate(`/sessions/${sessionId}`);
    }
  };

  const handleNewSession = async (taskId: string) => {
    try {
      const sessionId = await createTaskSession(taskId);
      addOptimisticSession(sessionId);
      const addSession = (t: Task) =>
        t.id === taskId ? { ...t, sessionIds: [...t.sessionIds, sessionId] } : t;
      setTasks((prev) => prev.map(addSession));
      setSelectedTask((prev) => (prev ? addSession(prev) : prev));
      navigate(`/tasks/${taskId}/sessions/${sessionId}`);
    } catch (err) {
      console.error("Failed to create task session:", err);
    }
  };

  const handleNewQuickChat = async () => {
    try {
      const sessionId = await createSession();
      addOptimisticSession(sessionId);
      navigate(`/sessions/${sessionId}`);
    } catch (err) {
      console.error("Failed to create session:", err);
    }
  };

  const handleNewTask = async () => {
    try {
      const task = await createTask("New Task");
      setTasks((prev) => [task, ...prev]);
      const sessionId = await createTaskSession(task.id);
      addOptimisticSession(sessionId);
      const updatedTask = { ...task, sessionIds: [...task.sessionIds, sessionId] };
      setTasks((prev) => prev.map((t) => (t.id === task.id ? updatedTask : t)));
      setSelectedTask(updatedTask);
      navigate(`/tasks/${task.id}/sessions/${sessionId}`);
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
    try {
      const updated = await reorderTasks(taskIds);
      setTasks(updated);
    } catch (err) {
      console.error("Failed to reorder tasks:", err);
      setTasks(await fetchTasks());
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

  const handleMoveTaskToGroup = async (taskId: string, groupId: string | undefined) => {
    // Optimistic update
    setTasks((prev) => prev.map((t) => (t.id === taskId ? { ...t, groupId } : t)));
    try {
      await patchTask(taskId, { groupId: groupId ?? ("" as any) });
    } catch (err) {
      console.error("Failed to move task to group:", err);
      setTasks(await fetchTasks());
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
  };

  // ── Mobile: detect breakpoint ─────────────────────────────────
  // On mobile (< md / 768px), we show stacked full-screen views.
  // The route determines which level of the hierarchy is visible.

  const isMobileRoute = {
    taskList: location.pathname === "/" && !activeTaskId && !activeSessionId,
    taskPanel: !!activeTaskId && !activeSessionId,
    chat: !!activeSessionId,
    settings: location.pathname === "/settings",
  };

  return (
    <div className="flex h-dvh bg-bg-primary text-text-primary">
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
        onMoveTaskToGroup={handleMoveTaskToGroup}
      />

      {/* ── Task Panel / Mobile Task List ─────────────────── */}
      {/* Desktop: always visible as fixed-width middle column */}
      {/* Mobile: show task list at /, task panel at /tasks/:id */}
      <div className={`
        md:flex md:shrink-0 min-w-0
        ${isMobileRoute.taskList || isMobileRoute.taskPanel ? "flex flex-1 md:flex-none" : ""}
        ${isMobileRoute.chat || isMobileRoute.settings ? "hidden md:flex" : ""}
      `.trim()}>
        {/* Mobile task list — full screen at / */}
        <div className={`md:hidden min-w-0 ${isMobileRoute.taskList ? "flex flex-col flex-1" : "hidden"}`}>
          <MobileTaskListView
            tasks={tasks}
            activeTaskId={activeTaskId}
            onSelectTask={handleSelectTask}
            onNewTask={handleNewTask}
            onSelectQuickChats={handleSelectQuickChats}
            onGoHome={handleGoHome}
            onOpenSettings={handleOpenSettings}
            sessions={sessions}
            isUnread={isUnread}
            markRead={markRead}
            onUpdateTask={handleUpdateTask}
            onDeleteTask={handleDeleteTask}
            onReorderTasks={handleReorderTasks}
            quickChatsMode={quickChatsMode}
            taskGroups={taskGroups}
            onMoveTaskToGroup={handleMoveTaskToGroup}
            onCreateGroup={handleCreateGroup}
            onUpdateGroup={handleUpdateGroup}
            onDeleteGroup={handleDeleteGroup}
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
            markUnread={markUnread}
            onRefresh={async () => { await Promise.all([loadTasks(), loadSessions(), loadTaskGroups()]); }}
          />
        </div>

        {/* Desktop panel + mobile task detail */}
        <div className={`
          md:flex md:shrink-0 min-w-0
          ${isMobileRoute.taskPanel ? "flex flex-1 md:flex-none" : "hidden md:flex"}
        `.trim()}>
          <TaskPanel
            task={selectedTask}
            taskGroups={taskGroups}
            sessions={sessions}
            activeSessionId={activeSessionId}
            onSelectSession={handleSelectSession}
            onNewSession={handleNewSession}
            onUpdateTask={handleUpdateTask}
            onTasksChanged={loadTasks}
            isUnread={isUnread}
            onArchiveSession={handleArchiveSession}
            archivingIds={archivingIds}
            exitingIds={exitingIds}
            isQuickChats={quickChatsMode}
            orphanSessions={globalSessions}
            onNewQuickChat={handleNewQuickChat}
            tasks={tasks}
            onLinkToTask={handleLinkToTask}
            onDeleteTask={handleDeleteTask}
            onDeleteSession={handleDeleteSession}
            onMarkUnread={markUnread}
            onMoveTaskToGroup={handleMoveTaskToGroup}
            onRefresh={async () => { await Promise.all([loadTasks(), loadSessions(), loadTaskGroups()]); }}
          />
        </div>
      </div>

      {/* ── Main content area ─────────────────────────────── */}
      <div className={`
        flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden
        ${/* Desktop: always visible */""}
        ${/* Mobile: only when viewing chat or settings */""}
        ${isMobileRoute.chat || isMobileRoute.settings ? "flex" : "hidden md:flex"}
      `.trim()}>
        {restartPending && <RestartBanner waitingSessions={restartWaiting} />}

        {/* Mobile back bar */}
        <div className="shrink-0 flex items-center gap-3 px-4 py-2.5 border-b border-border bg-bg-secondary md:hidden">
          <button
            onClick={() => {
              if (window.history.length > 1) {
                navigate(-1);
              } else {
                navigate("/");
              }
            }}
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
                  onNewTask={handleNewTask}
                  onNewSession={handleNewQuickChat}
                  onResumeTask={handleResumeTask}
                />
              }
            />
            <Route
              path="tasks/:taskId"
              element={
                <Dashboard
                  onSelectTask={handleSelectTask}
                  onSelectSession={(id) => {
                    if (activeTaskId) navigate(`/tasks/${activeTaskId}/sessions/${id}`);
                    else navigate(`/sessions/${id}`);
                  }}
                  onNewTask={handleNewTask}
                  onNewSession={handleNewQuickChat}
                  onResumeTask={handleResumeTask}
                />
              }
            />
            <Route
              path="tasks/:taskId/sessions/:sessionId"
              element={
                <SessionRoute sessions={sessions} onMessageSent={loadSessions} />
              }
            />
            <Route
              path="sessions/:sessionId"
              element={
                <SessionRoute sessions={sessions} onMessageSent={loadSessions} />
              }
            />
            <Route path="settings" element={<SettingsView />} />
          </Routes>
        </main>
      </div>
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
  onSelectQuickChats,
  onGoHome,
  onOpenSettings,
  sessions,
  isUnread,
  markRead,
  onUpdateTask,
  onDeleteTask,
  onReorderTasks,
  quickChatsMode,
  taskGroups,
  onMoveTaskToGroup,
  onCreateGroup,
  onUpdateGroup,
  onDeleteGroup,
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
  markUnread,
  onRefresh,
}: {
  tasks: Task[];
  activeTaskId: string | null;
  onSelectTask: (id: string) => void;
  onNewTask: () => void;
  onSelectQuickChats: () => void;
  onGoHome: () => void;
  onOpenSettings: () => void;
  sessions: Session[];
  isUnread?: (sessionId: string, modifiedTime?: string) => boolean;
  markRead?: (sessionId: string) => void;
  onUpdateTask?: (taskId: string, updates: Partial<Pick<Task, "title" | "status">>) => void;
  onDeleteTask?: (taskId: string) => void;
  onReorderTasks?: (taskIds: string[]) => void;
  quickChatsMode: boolean;
  taskGroups?: TaskGroup[];
  onMoveTaskToGroup?: (taskId: string, groupId: string | undefined) => void;
  onCreateGroup?: (name: string, color?: string) => Promise<TaskGroup | null>;
  onUpdateGroup?: (groupId: string, updates: Partial<Pick<TaskGroup, "name" | "color" | "collapsed">>) => void;
  onDeleteGroup?: (groupId: string) => void;
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
  markUnread?: (sessionId: string) => void;
  onRefresh: () => Promise<void>;
}){
  return (
    <div className="flex flex-col h-full bg-bg-secondary min-w-0 overflow-hidden">
      {/* Header */}
      <div className="p-4 border-b border-border flex items-center justify-between">
        <span className="text-sm font-semibold text-text-primary">
          {quickChatsMode ? "Quick Chats" : "Tasks"}
        </span>
        <button
          onClick={onOpenSettings}
          className="text-text-muted hover:text-text-secondary transition-colors text-xs"
        >
          Settings
        </button>
      </div>

      {/* Tab toggle: Tasks | Quick Chats */}
      <div className="flex border-b border-border">
        <button
          onClick={() => { if (quickChatsMode) onGoHome(); }}
          className={`flex-1 py-2.5 text-xs font-medium transition-colors ${!quickChatsMode ? "text-accent border-b-2 border-accent" : "text-text-muted"}`}
        >
          Tasks
        </button>
        <button
          onClick={onSelectQuickChats}
          className={`flex-1 py-2.5 text-xs font-medium transition-colors ${quickChatsMode ? "text-accent border-b-2 border-accent" : "text-text-muted"}`}
        >
          Quick Chats
        </button>
      </div>

      {/* Content — pull-to-refresh wraps both tabs */}
      <PullToRefresh onRefresh={onRefresh} className="flex-1 overflow-x-hidden min-w-0" scrollKey={quickChatsMode ? "chats" : "tasks"}>
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
            onMarkUnread={markUnread}
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
            onCreateGroup={onCreateGroup}
            onUpdateGroup={onUpdateGroup}
            onDeleteGroup={onDeleteGroup}
            className="p-2 space-y-2"
          />
        )}
      </PullToRefresh>
    </div>
  );
}

// Thin wrapper to extract sessionId from URL and pass hasPlan
function SessionRoute({ sessions, onMessageSent }: { sessions: Session[]; onMessageSent: () => void }) {
  const { sessionId } = useParams<{ sessionId: string }>();
  const hasPlan = sessions.find((s) => s.sessionId === sessionId)?.hasPlan;
  return (
    <ChatView
      sessionId={sessionId ?? null}
      hasPlan={hasPlan}
      onMessageSent={onMessageSent}
    />
  );
}
