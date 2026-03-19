import { useState, useEffect } from "react";
import { fetchSessions, createSession, type Session } from "./api";
import Sidebar from "./components/Sidebar";
import ChatView from "./components/ChatView";

export default function App() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);

  const loadSessions = async () => {
    try {
      const list = await fetchSessions();
      setSessions(list);
    } catch (err) {
      console.error("Failed to load sessions:", err);
    }
  };

  useEffect(() => {
    loadSessions();
  }, []);

  const handleNewSession = async () => {
    try {
      const sessionId = await createSession();
      setSessions((prev) => [
        { sessionId, summary: "New session", modifiedTime: new Date().toISOString(), diskSizeBytes: 0 },
        ...prev,
      ]);
      setActiveSessionId(sessionId);
    } catch (err) {
      console.error("Failed to create session:", err);
    }
  };

  return (
    <div className="flex h-screen bg-[#1a1a2e] text-gray-200">
      <Sidebar
        sessions={sessions}
        activeSessionId={activeSessionId}
        onSelectSession={setActiveSessionId}
        onNewSession={handleNewSession}
      />
      <ChatView
        sessionId={activeSessionId}
        onMessageSent={loadSessions}
      />
    </div>
  );
}
