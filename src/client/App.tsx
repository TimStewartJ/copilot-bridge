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

type ViewMode = "none" | "chat" | "task";

export default function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [activeTab, setActiveTab] = useState<"tasks" | "sessions">("tasks");
  const [viewMode, setViewMode] = useState<ViewMode>("none");
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);

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

  const handleSelectSession = (id: string) => {
    setActiveSessionId(id);
    setActiveTaskId(null);
    setViewMode("chat");
  };

  const handleSelectTask = (id: string) => {
    setActiveTaskId(id);
    setActiveSessionId(null);
    setViewMode("task");
  };

  // Open a session from within a task detail view
  const handleOpenSessionFromTask = (sessionId: string) => {
    setActiveSessionId(sessionId);
    setViewMode("chat");
    setActiveTab("sessions");
  };

  return (
    <div className="flex h-screen bg-[#1a1a2e] text-gray-200">
      <Sidebar
        activeTab={activeTab}
        onTabChange={setActiveTab}
        tasks={tasks}
        activeTaskId={activeTaskId}
        onSelectTask={handleSelectTask}
        onNewTask={handleNewTask}
        sessions={sessions}
        activeSessionId={activeSessionId}
        onSelectSession={handleSelectSession}
        onNewSession={handleNewSession}
      />
      <main className="flex-1 flex flex-col">
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
            onOpenSession={handleOpenSessionFromTask}
          />
        )}
        {viewMode === "none" && (
          <div className="flex-1 flex items-center justify-center text-gray-500 text-lg">
            Select a task or session to get started
          </div>
        )}
      </main>
    </div>
  );
}
