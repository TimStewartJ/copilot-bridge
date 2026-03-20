import { useState, useEffect, useMemo, useCallback, useRef } from "react";
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
import Sidebar from "./components/Sidebar";
import ChatView from "./components/ChatView";
import TaskDetailView from "./components/TaskDetailView";
import Dashboard from "./components/Dashboard";
import SettingsView from "./components/SettingsView";
import { useSwipeDrawer } from "./useSwipeDrawer";

type ViewMode = "none" | "chat" | "task" | "settings";

export default function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [activeTab, setActiveTab] = useState<"tasks" | "sessions">("tasks");
  const [viewMode, setViewMode] = useState<ViewMode>("none");
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [taskContext, setTaskContext] = useState<Task | null>(null);

  const { isUnread, markRead, unreadCount } = useReadState(sessions);

  const loadSessions = async () => {
    try {
      setSessions(await fetchSessions(true));
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

  // Auto-refresh sessions while any are busy (fast: 5s)
  useEffect(() => {
    const hasBusy = sessions.some((s) => s.busy);
    if (!hasBusy) return;
    const timer = setInterval(loadSessions, 5_000);
    return () => clearInterval(timer);
  }, [sessions]);

  // Background poll to detect new activity on idle sessions (slow: 30s, visibility-aware)
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

  const handleNewSession = async () => {
    try {
      const sessionId = await createSession();
      setSessions((prev) => [
        {
          sessionId,
          summary: "New session",
          modifiedTime: new Date().toISOString(),
          diskSizeBytes: 0,
        },
        ...prev,
      ]);
      setActiveSessionId(sessionId);
      setActiveTaskId(null);
      setViewMode("chat");
    } catch (err) {
      console.error("Failed to create session:", err);
    }
  };

  const handleNewTask = async () => {
    const title = prompt("Task title:");
    if (!title) return;
    try {
      const task = await createTask(title);
      setTasks((prev) => [task, ...prev]);
      setActiveTaskId(task.id);
      setActiveSessionId(null);
      setViewMode("task");
    } catch (err) {
      console.error("Failed to create task:", err);
    }
  };

  const openSidebar = useCallback(() => setSidebarOpen(true), []);
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);

  useSwipeDrawer(sidebarOpen, openSidebar, closeSidebar);

  const handleSelectSession = (id: string) => {
    setActiveSessionId(id);
    setActiveTaskId(null);
    setTaskContext(null);
    setViewMode("chat");
    closeSidebar();
  };

  const handleSelectTask = (id: string) => {
    setActiveTaskId(id);
    setActiveSessionId(null);
    setViewMode("task");
    closeSidebar();
  };

  const handleGoHome = () => {
    setActiveSessionId(null);
    setActiveTaskId(null);
    setTaskContext(null);
    setViewMode("none");
    closeSidebar();
  };

  const handleOpenSettings = () => {
    setActiveSessionId(null);
    setActiveTaskId(null);
    setTaskContext(null);
    setViewMode("settings");
    closeSidebar();
  };

  // Open a session from within a task detail view — keep task context in sidebar
  const handleOpenSessionFromTask = async (sessionId: string) => {
    // Capture the current task for sidebar context
    if (activeTaskId) {
      try {
        const task = await fetchTask(activeTaskId);
        setTaskContext(task);
      } catch {
        setTaskContext(null);
      }
    }
    setActiveSessionId(sessionId);
    setViewMode("chat");
  };

  // Create a new session linked to the task context and open it
  const handleNewTaskSession = async (taskId: string) => {
    try {
      const sessionId = await createTaskSession(taskId);
      await loadSessions();
      const task = await fetchTask(taskId);
      setTaskContext(task);
      setActiveSessionId(sessionId);
      setViewMode("chat");
    } catch (err) {
      console.error("Failed to create task session:", err);
    }
  };

  // Navigate back to the task detail from chat context
  const handleBackToTask = (taskId: string) => {
    setActiveTaskId(taskId);
    setActiveSessionId(null);
    setTaskContext(null);
    setViewMode("task");
    setActiveTab("tasks");
  };

  // Select a session within task context (stay in task context)
  const handleSelectTaskSession = (sessionId: string) => {
    setActiveSessionId(sessionId);
    setViewMode("chat");
    closeSidebar();
  };

  const handleTaskDeleted = () => {
    setActiveTaskId(null);
    setViewMode("none");
    loadTasks();
  };

  const handleArchiveSession = async (sessionId: string, archived: boolean) => {
    try {
      await patchSession(sessionId, { archived });
      // If archiving the active session, deselect it
      if (archived && activeSessionId === sessionId) {
        setActiveSessionId(null);
        setTaskContext(null);
        setViewMode("none");
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
    <div className="flex h-dvh bg-[#1a1a2e] text-gray-200">
      {/* Mobile overlay backdrop */}
      {sidebarOpen && (
        <div
          className="fixed inset-0 bg-black/50 z-30 md:hidden"
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
          activeSessionId={activeSessionId}
          onSelectSession={handleSelectSession}
          onNewSession={handleNewSession}
          onArchiveSession={handleArchiveSession}
          taskContext={taskContext}
          taskContextSessions={sessions}
          onBackToTask={handleBackToTask}
          onSelectTaskSession={handleSelectTaskSession}
          onNewTaskSession={handleNewTaskSession}
          isUnread={isUnread}
          unreadCount={unreadCount}
        />
      </div>

      <div className="flex-1 flex flex-col min-w-0 min-h-0 overflow-hidden">
        {/* Mobile top bar — sticky */}
        <div className="shrink-0 flex items-center gap-3 px-4 py-3 border-b border-[#2a2a4a] bg-[#16213e] md:hidden">
          <button
            onClick={() => setSidebarOpen(true)}
            className="text-gray-400 hover:text-gray-200 text-xl"
            aria-label="Open menu"
          >
            ☰
          </button>
          <button
            onClick={handleGoHome}
            className="text-sm font-semibold text-indigo-400 hover:text-indigo-300 transition-colors"
          >
            🤖 Copilot Bridge
          </button>
        </div>

        <main className="flex-1 flex flex-col min-h-0">
          {viewMode === "chat" && (
            <ChatView
              sessionId={activeSessionId}
              hasPlan={sessions.find((s) => s.sessionId === activeSessionId)?.hasPlan}
              onMessageSent={loadSessions}
            />
          )}
          {viewMode === "task" && activeTaskId && (
            <TaskDetailView
              taskId={activeTaskId}
              sessions={sessions}
              onTaskUpdated={loadTasks}
              onTaskDeleted={handleTaskDeleted}
              onOpenSession={handleOpenSessionFromTask}
              isUnread={isUnread}
            />
          )}
          {viewMode === "none" && (
            <Dashboard
              tasks={tasks}
              sessions={globalSessions}
              onSelectTask={handleSelectTask}
              onSelectSession={handleSelectSession}
              onNewTask={handleNewTask}
              onNewSession={handleNewSession}
              isUnread={isUnread}
            />
          )}
          {viewMode === "settings" && (
            <SettingsView onGoHome={handleGoHome} />
          )}
        </main>
      </div>
    </div>
  );
}
