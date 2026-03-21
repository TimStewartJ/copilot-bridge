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
  type Session,
  type Task,
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

export default function App() {
  const navigate = useNavigate();
  const location = useLocation();

  const [sessions, setSessions] = useState<Session[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
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

  const { isUnread, markRead, unreadCount } = useReadState(sessions);

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

  useEffect(() => {
    loadSessions();
    loadTasks();
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

  // ── Navigation handlers ───────────────────────────────────────

  const handleSelectTask = (id: string) => {
    setQuickChatsMode(false);
    const task = tasks.find((t) => t.id === id);
    if (task && task.sessionIds.length > 0) {
      const mostRecentSessionId = task.sessionIds[task.sessionIds.length - 1];
      navigate(`/tasks/${id}/sessions/${mostRecentSessionId}`);
    } else {
      navigate(`/tasks/${id}`);
    }
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
      navigate(`/tasks/${task.id}/sessions/${sessionId}`);
    } catch (err) {
      console.error("Failed to create task:", err);
    }
  };

  const handleUpdateTask = async (taskId: string, updates: Partial<Pick<Task, "title" | "status">>) => {
    try {
      const updated = await patchTask(taskId, updates);
      setTasks((prev) => prev.map((t) => (t.id === taskId ? updated : t)));
      setSelectedTask((prev) => (prev?.id === taskId ? updated : prev));
    } catch (err) {
      console.error("Failed to update task:", err);
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

  const [archivingIds, setArchivingIds] = useState<Set<string>>(new Set());

  const handleArchiveSession = async (sessionId: string, archived: boolean) => {
    setArchivingIds((prev) => new Set(prev).add(sessionId));
    try {
      await patchSession(sessionId, { archived });
      if (archived && activeSessionId === sessionId) {
        if (activeTaskId) {
          navigate(`/tasks/${activeTaskId}`);
        } else {
          navigate("/");
        }
      }
      await loadSessions();
    } catch (err) {
      console.error("Failed to archive session:", err);
    } finally {
      setArchivingIds((prev) => {
        const next = new Set(prev);
        next.delete(sessionId);
        return next;
      });
    }
  };

  const handleDeleteSession = async (sessionId: string) => {
    try {
      await deleteSession(sessionId);
      if (activeSessionId === sessionId) {
        if (activeTaskId) {
          navigate(`/tasks/${activeTaskId}`);
        } else {
          navigate("/");
        }
      }
      await Promise.all([loadSessions(), loadTasks()]);
    } catch (err) {
      console.error("Failed to delete session:", err);
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
      />

      {/* ── Task Panel / Mobile Task List ─────────────────── */}
      {/* Desktop: always visible as fixed-width middle column */}
      {/* Mobile: show task list at /, task panel at /tasks/:id */}
      <div className={`
        md:flex md:shrink-0
        ${isMobileRoute.taskList || isMobileRoute.taskPanel ? "flex flex-1 md:flex-none" : ""}
        ${isMobileRoute.chat || isMobileRoute.settings ? "hidden md:flex" : ""}
      `.trim()}>
        {/* Mobile task list — full screen at / */}
        <div className={`md:hidden ${isMobileRoute.taskList ? "flex flex-col flex-1" : "hidden"}`}>
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
            quickChatsMode={quickChatsMode}
            orphanSessions={globalSessions}
            activeSessionId={activeSessionId}
            onSelectSession={(id) => navigate(`/sessions/${id}`)}
            onNewQuickChat={handleNewQuickChat}
            onArchiveSession={handleArchiveSession}
            archivingIds={archivingIds}
            allTasks={tasks}
            onLinkToTask={handleLinkToTask}
          />
        </div>

        {/* Desktop panel + mobile task detail */}
        <div className={`
          md:flex md:shrink-0
          ${isMobileRoute.taskPanel ? "flex flex-1 md:flex-none" : "hidden md:flex"}
        `.trim()}>
          <TaskPanel
            task={selectedTask}
            sessions={sessions}
            activeSessionId={activeSessionId}
            onSelectSession={handleSelectSession}
            onNewSession={handleNewSession}
            onUpdateTask={handleUpdateTask}
            onTasksChanged={loadTasks}
            isUnread={isUnread}
            onArchiveSession={handleArchiveSession}
            archivingIds={archivingIds}
            isQuickChats={quickChatsMode}
            orphanSessions={globalSessions}
            onNewQuickChat={handleNewQuickChat}
            tasks={tasks}
            onLinkToTask={handleLinkToTask}
            onDeleteTask={handleDeleteTask}
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
              if (activeTaskId) {
                navigate(`/tasks/${activeTaskId}`);
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
  quickChatsMode,
  orphanSessions,
  activeSessionId,
  onSelectSession,
  onNewQuickChat,
  onArchiveSession,
  archivingIds,
  allTasks,
  onLinkToTask,
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
  quickChatsMode: boolean;
  orphanSessions: Session[];
  activeSessionId: string | null;
  onSelectSession: (id: string) => void;
  onNewQuickChat: () => void;
  onArchiveSession: (id: string, archived: boolean) => void;
  archivingIds: Set<string>;
  allTasks: Task[];
  onLinkToTask: (sessionId: string, taskId: string) => void;
}) {
  return (
    <div className="flex flex-col h-full bg-bg-secondary">
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

      {/* Content */}
      {quickChatsMode ? (
        <div className="flex-1 overflow-y-auto p-2">
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
            tasks={allTasks}
            onLinkToTask={onLinkToTask}
            onDeleteSession={onDeleteSession}
          />
        </div>
      ) : (
        <TaskList
          tasks={tasks}
          activeTaskId={activeTaskId}
          onSelectTask={onSelectTask}
          onNewTask={onNewTask}
          sessions={sessions}
          isUnread={isUnread}
          markRead={markRead}
          onUpdateTask={onUpdateTask}
          onDeleteTask={onDeleteTask}
        />
      )}
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
