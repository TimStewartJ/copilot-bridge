import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { Routes, Route, useNavigate, useParams, useLocation, useSearchParams } from "react-router-dom";
import {
  fetchSessions,
  createSession,
  patchSession,
  fetchTasks,
  createTask,
  fetchTask,
  createTaskSession,
  type Session,
  type Task,
} from "./api";
import { useReadState } from "./useReadState";
import { useStatusStream } from "./useStatusStream";
import Sidebar from "./components/Sidebar";
import ChatView from "./components/ChatView";
import TaskDetailView from "./components/TaskDetailView";
import Dashboard from "./components/Dashboard";
import SettingsView from "./components/SettingsView";
import RestartBanner from "./components/RestartBanner";
import { useSwipeDrawer } from "./useSwipeDrawer";
import { Menu, Sparkles } from "lucide-react";

export default function App() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();

  const [sessions, setSessions] = useState<Session[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [activeTab, setActiveTab] = useState<"tasks" | "sessions">("tasks");
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [taskContext, setTaskContext] = useState<Task | null>(null);
  const [restartPending, setRestartPending] = useState(false);
  const [restartWaiting, setRestartWaiting] = useState(0);

  // Track optimistic sessions that the server doesn't know about yet
  const optimisticIdsRef = useRef(new Set<string>());

  // Derive active IDs from URL
  const activeSessionId = location.pathname.match(/^\/sessions\/(.+)/)?.[1] ?? null;
  const activeTaskId = location.pathname.match(/^\/tasks\/(.+)/)?.[1] ?? null;

  // Restore taskContext from search param on navigation
  const taskContextId = searchParams.get("taskContext");
  useEffect(() => {
    if (taskContextId && (!taskContext || taskContext.id !== taskContextId)) {
      fetchTask(taskContextId).then(setTaskContext).catch(() => setTaskContext(null));
    } else if (!taskContextId && taskContext) {
      setTaskContext(null);
    }
  }, [taskContextId]);

  const { isUnread, markRead, unreadCount } = useReadState(sessions);

  const loadSessions = async () => {
    try {
      const serverSessions = await fetchSessions(true);
      setSessions((prev) => {
        const serverIds = new Set(serverSessions.map((s) => s.sessionId));
        // Promote: optimistic sessions now in server data no longer need protection
        for (const id of serverIds) optimisticIdsRef.current.delete(id);
        // Survivors: optimistic sessions not yet in server data
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

  // Real-time status updates via SSE — replaces 5s busy-polling
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
      case "server:restart-pending":
        setRestartPending(true);
        setRestartWaiting(event.waitingSessions ?? 0);
        break;
      case "status:connected":
        // SSE reconnected after server restart — clear the banner
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

  // Optimistic insert — makes new sessions visible in sidebar immediately
  // (server filters out sessions with no summary, so loadSessions misses brand-new ones)
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

  const handleNewSession = async () => {
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
      // Auto-create a session and jump straight into chat
      const sessionId = await createTaskSession(task.id);
      addOptimisticSession(sessionId);
      navigate(`/sessions/${sessionId}?taskContext=${task.id}`);
    } catch (err) {
      console.error("Failed to create task:", err);
    }
  };

  const openSidebar = useCallback(() => setSidebarOpen(true), []);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  useSwipeDrawer(sidebarOpen, openSidebar, closeSidebar);

  const handleSelectSession = (id: string) => {
    navigate(`/sessions/${id}`);
    closeSidebar();
  };

  const handleSelectTask = (id: string) => {
    navigate(`/tasks/${id}`);
    closeSidebar();
  };

  const handleGoHome = () => {
    navigate("/");
    closeSidebar();
  };

  const handleOpenSettings = () => {
    navigate("/settings");
    closeSidebar();
  };

  // Open a session from within a task detail view — keep task context in sidebar
  const handleOpenSessionFromTask = async (sessionId: string) => {
    const ctxId = activeTaskId;
    if (ctxId) {
      // Pre-fetch task so sidebar context is ready immediately
      try {
        const task = await fetchTask(ctxId);
        setTaskContext(task);
      } catch {
        // taskContext will be loaded from search param anyway
      }
    }
    navigate(`/sessions/${sessionId}${ctxId ? `?taskContext=${ctxId}` : ""}`);
  };

  // Create a new session linked to the task context and open it
  const handleNewTaskSession = async (taskId: string) => {
    try {
      const sessionId = await createTaskSession(taskId);
      addOptimisticSession(sessionId);
      const task = await fetchTask(taskId);
      setTaskContext(task);
      navigate(`/sessions/${sessionId}?taskContext=${taskId}`);
    } catch (err) {
      console.error("Failed to create task session:", err);
    }
  };

  // Navigate back to the task detail from chat context
  const handleBackToTask = (taskId: string) => {
    navigate(`/tasks/${taskId}`);
    setActiveTab("tasks");
  };

  // Navigate back to task list from chat context (clears task context, stays on current page)
  const handleBackToTaskList = () => {
    setSearchParams({});
    setActiveTab("tasks");
  };

  // Resume a task — open last session or create a new one
  const handleResumeTask = async (taskId: string, sessionId?: string) => {
    if (sessionId) {
      // Open existing session with task context
      try {
        const task = await fetchTask(taskId);
        setTaskContext(task);
      } catch { /* fallback */ }
      navigate(`/sessions/${sessionId}?taskContext=${taskId}`);
    } else {
      // Create new session for this task
      await handleNewTaskSession(taskId);
    }
  };

  // Select a session within task context (stay in task context)
  const handleSelectTaskSession = (sessionId: string) => {
    const ctxId = taskContext?.id ?? taskContextId;
    navigate(`/sessions/${sessionId}${ctxId ? `?taskContext=${ctxId}` : ""}`);
    closeSidebar();
  };

  const handleTaskDeleted = () => {
    navigate("/");
    loadTasks();
  };

  const handleArchiveSession = async (sessionId: string, archived: boolean) => {
    try {
      await patchSession(sessionId, { archived });
      // If archiving the active session, go home
      if (archived && activeSessionId === sessionId) {
        navigate("/");
      }
      await loadSessions();
    } catch (err) {
      console.error("Failed to archive session:", err);
    }
  };

  // Sessions not linked to any task — shown in global Sessions tab and Dashboard
  const globalSessions = useMemo(() => {
    const taskSessionIds = new Set(tasks.flatMap((t) => t.sessionIds));
    return sessions.filter((s) => !taskSessionIds.has(s.sessionId));
  }, [sessions, tasks]);

  return (
    <div className="flex h-dvh bg-bg-primary text-text-primary">
      {/* Mobile overlay backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/60 z-30 md:hidden"
          onClick={closeSidebar}
        />
      )}

      {/* Sidebar — overlay on mobile, static on desktop */}
      <div
        className={`fixed inset-y-0 left-0 z-40 w-64 transform transition-transform duration-200 ease-in-out md:relative md:translate-x-0 ${
          sidebarOpen ? "translate-x-0" : "-translate-x-full"
        }`}
      >
        <Sidebar
          activeTab={activeTab}
          onTabChange={setActiveTab}
          onGoHome={handleGoHome}
          onOpenSettings={handleOpenSettings}
          tasks={tasks}
          activeTaskId={activeTaskId}
          onSelectTask={handleSelectTask}
          onNewTask={handleNewTask}
          sessions={globalSessions}
          allSessions={sessions}
          activeSessionId={activeSessionId}
          onSelectSession={handleSelectSession}
          onNewSession={handleNewSession}
          onArchiveSession={handleArchiveSession}
          taskContext={taskContext}
          taskContextSessions={sessions}
          onBackToTask={handleBackToTask}
          onBackToTaskList={handleBackToTaskList}
          onSelectTaskSession={handleSelectTaskSession}
          onNewTaskSession={handleNewTaskSession}
          isUnread={isUnread}
          unreadCount={unreadCount}
        />
      </div>

      <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
        {restartPending && <RestartBanner waitingSessions={restartWaiting} />}

        {/* Mobile top bar — sticky */}
        <div className="shrink-0 flex items-center gap-3 px-4 py-2.5 border-b border-border bg-bg-secondary md:hidden">
          <button
            onClick={() => setSidebarOpen(true)}
            className="text-text-muted hover:text-text-primary transition-colors"
            aria-label="Open menu"
          >
            <Menu size={18} />
          </button>
          <button
            onClick={handleGoHome}
            className="text-sm font-medium text-text-primary hover:text-accent transition-colors flex items-center gap-1.5"
          >
            <Sparkles size={14} className="text-accent" />
            Copilot Bridge
          </button>
        </div>

        <main className="flex-1 flex flex-col min-h-0">
          <Routes>
            <Route
              index
              element={
                <Dashboard
                  onSelectTask={handleSelectTask}
                  onSelectSession={handleSelectSession}
                  onNewTask={handleNewTask}
                  onNewSession={handleNewSession}
                  onResumeTask={handleResumeTask}
                />
              }
            />
            <Route
              path="tasks/:taskId"
              element={
                <TaskDetailView
                  sessions={sessions}
                  onTaskUpdated={loadTasks}
                  onTaskDeleted={handleTaskDeleted}
                  onOpenSession={handleOpenSessionFromTask}
                  onSessionCreated={addOptimisticSession}
                  onArchiveSession={handleArchiveSession}
                  isUnread={isUnread}
                />
              }
            />
            <Route
              path="sessions/:sessionId"
              element={
                <SessionRoute
                  sessions={sessions}
                  onMessageSent={loadSessions}
                />
              }
            />
            <Route path="settings" element={<SettingsView />} />
          </Routes>
        </main>
      </div>
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
