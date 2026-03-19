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

      {/* Floating menu button — always visible on mobile */}
      {!sidebarOpen && (
        <button
          onClick={() => setSidebarOpen(true)}
          className="fixed bottom-20 left-3 z-30 md:hidden w-11 h-11 rounded-full bg-indigo-500 hover:bg-indigo-600 text-white shadow-lg shadow-black/30 flex items-center justify-center text-lg active:scale-95 transition-all"
          aria-label="Open menu"
        >
          ☰
        </button>
      )}

      <div className="flex-1 flex flex-col min-w-0">
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
