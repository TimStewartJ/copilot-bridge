import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { fetchMessages, type ChatMessage } from "../api";
import { useSessionStream } from "../useSessionStream";
import MessageBubble from "./MessageBubble";
import ChatInput from "./ChatInput";
import PlanSheet from "./PlanSheet";
import { ClipboardList, Loader2 } from "lucide-react";

interface ChatViewProps {
  sessionId: string | null;
  hasPlan?: boolean;
  onMessageSent: () => void;
}

function formatToolArgs(args: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [key, val] of Object.entries(args)) {
    if (key === "intent") continue; // skip noise
    const s = typeof val === "string" ? val : JSON.stringify(val);
    parts.push(s.length > 60 ? s.slice(0, 57) + "..." : s);
  }
  return parts.join(" ");
}

export default function ChatView({ sessionId, hasPlan, onMessageSent }: ChatViewProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [showPlan, setShowPlan] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const handleNewMessages = useCallback((newMsgs: ChatMessage[]) => {
    setMessages((prev) => [...prev, ...newMsgs]);
  }, []);

  const {
    streamingContent,
    activeTools,
    intentText,
    toolProgress,
    isStreaming,
    sendMessage,
    reconnect,
  } = useSessionStream(sessionId, handleNewMessages, onMessageSent);

  // Load history when session changes
  useEffect(() => {
    if (!sessionId) {
      setMessages([]);
      return;
    }

    const loadAndReconnect = () => {
      setLoading(true);
      fetchMessages(sessionId)
        .then(({ messages: msgs, busy }) => {
          setMessages(msgs);
          if (busy) reconnect(sessionId);
        })
        .catch((err) =>
          setMessages([
            { role: "assistant", content: `Error loading history: ${err.message}` },
          ]),
        )
        .finally(() => setLoading(false));
    };

    setMessages([]);
    loadAndReconnect();

    setShowPlan(false);

    // Reconnect when the tab wakes from sleep (mobile screen-off, etc.)
    const onVisible = () => {
      if (document.visibilityState === "visible") loadAndReconnect();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [sessionId, reconnect]);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, isStreaming, streamingContent, activeTools]);

  const handleSend = useCallback(async (prompt: string) => {
    if (!sessionId || isStreaming) return;
    setMessages((prev) => [...prev, { role: "user", content: prompt }]);
    try {
      await sendMessage(prompt);
    } catch (err: any) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `⚠️ Error: ${err.message}` },
      ]);
    }
  }, [sessionId, isStreaming, sendMessage]);

  if (!sessionId) {
    return (
      <div className="flex-1 flex items-center justify-center text-text-muted text-lg">
        Create or select a session to start
      </div>
    );
  }

  const renderedMessages = useMemo(
    () => messages.map((msg, i) => <MessageBubble key={`${msg.role}-${i}`} message={msg} />),
    [messages],
  );

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Plan header bar */}
      {hasPlan && (
        <div className="shrink-0 flex items-center justify-between px-4 py-2 border-b border-border bg-bg-secondary">
          <span className="text-xs text-text-muted flex items-center gap-1.5">
            <ClipboardList size={12} />
            Plan available
          </span>
          <button
            onClick={() => setShowPlan(true)}
            className="text-xs text-accent hover:text-accent-hover transition-colors font-medium"
          >
            View
          </button>
        </div>
      )}
      <div className="flex-1 overflow-y-auto overflow-x-hidden p-3 md:p-5 space-y-4">
        {loading && (
          <div className="text-accent italic">Loading history...</div>
        )}
        {!loading && messages.length === 0 && !isStreaming && (
          <div className="flex items-center justify-center h-full text-text-muted text-lg">
            Send a message to get started
          </div>
        )}
        {renderedMessages}
        {streamingContent && (
          <MessageBubble message={{ role: "assistant", content: streamingContent }} />
        )}
        {activeTools.length > 0 && (
          <div className="text-xs text-accent/70 px-4 py-1 space-y-1">
            <div className="flex items-center gap-2 flex-wrap">
              <Loader2 size={12} className="animate-spin" />
              {activeTools.map((t) => (
                <span key={t.toolCallId || t.name} className="bg-accent/10 px-2 py-0.5 rounded">
                  {t.name}
                  {t.args && Object.keys(t.args).length > 0 && (
                    <span className="text-accent/40 ml-1">{formatToolArgs(t.args)}</span>
                  )}
                </span>
              ))}
            </div>
            {toolProgress && (
              <div className="text-accent/50 pl-6 truncate">{toolProgress}</div>
            )}
          </div>
        )}
        {isStreaming && !streamingContent && activeTools.length === 0 && (
          <div className="text-accent italic animate-pulse">
            {intentText ? `${intentText}...` : "Thinking..."}
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>
      <ChatInput onSend={handleSend} disabled={isStreaming} sessionId={sessionId} />
      {/* Plan sheet overlay */}
      {showPlan && sessionId && (
        <PlanSheet sessionId={sessionId} onClose={() => setShowPlan(false)} />
      )}
    </div>
  );
}
