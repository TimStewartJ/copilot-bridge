import { useState, useEffect } from "react";
import {
  fetchSessions,
  createSession,
  fetchTasks,
  createTask,
  type Session,
  type Task,
} from "./api";
import Sidebar from "./components/Sidebar";
import ChatView from "./components/ChatView";
import TaskDetailView from "./components/TaskDetailView";
import Dashboard from "./components/Dashboard";

type ViewMode = "none" | "chat" | "task";

export default function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [activeTab, setActiveTab] = useState<"tasks" | "sessions">("tasks");
  const [viewMode, setViewMode] = useState<ViewMode>("none");
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(false);

  const loadSessions = async () => {
    try {
      setSessions(await fetchSessions());
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

  const closeSidebar = () => setSidebarOpen(false);

  const handleSelectSession = (id: string) => {
    setActiveSessionId(id);
    setActiveTaskId(null);
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
    setViewMode("none");
    closeSidebar();
  };

  // Open a session from within a task detail view
  const handleOpenSessionFromTask = (sessionId: string) => {
    setActiveSessionId(sessionId);
    setViewMode("chat");
    setActiveTab("sessions");
  };

  const handleTaskDeleted = () => {
    setActiveTaskId(null);
    setViewMode("none");
    loadTasks();
  };

  return (
    <div className="flex h-screen bg-[#1a1a2e] text-gray-200">
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
          tasks={tasks}
          activeTaskId={activeTaskId}
          onSelectTask={handleSelectTask}
          onNewTask={handleNewTask}
          sessions={sessions}
          activeSessionId={activeSessionId}
          onSelectSession={handleSelectSession}
          onNewSession={handleNewSession}
        />
      </div>

      <div className="flex-1 flex flex-col min-w-0">
        {/* Mobile top bar — sticky */}
        <div className="sticky top-0 z-20 flex items-center gap-3 px-4 py-3 border-b border-[#2a2a4a] bg-[#16213e] md:hidden">
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
            />
          )}
          {viewMode === "none" && (
            <Dashboard
              tasks={tasks}
              sessions={sessions}
              onSelectTask={handleSelectTask}
              onSelectSession={handleSelectSession}
              onNewTask={handleNewTask}
              onNewSession={handleNewSession}
            />
          )}
        </main>
      </div>
    </div>
  );
}
