import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { fetchMessages, type ChatMessage } from "../api";
import { useSessionStream } from "../useSessionStream";
import MessageBubble from "./MessageBubble";
import ChatInput from "./ChatInput";

interface ChatViewProps {
  sessionId: string | null;
  onMessageSent: () => void;
}

export default function ChatView({ sessionId, onMessageSent }: ChatViewProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const prevSessionRef = useRef<string | null>(null);

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
    if (prevSessionRef.current === sessionId) return;
    prevSessionRef.current = sessionId;

    setMessages([]);
    setLoading(true);
    fetchMessages(sessionId)
      .then(({ messages: msgs, busy }) => {
        setMessages(msgs);
        // If session is busy, reconnect to the stream
        if (busy) {
          reconnect(sessionId);
        }
      })
      .catch((err) =>
        setMessages([
          { role: "assistant", content: `Error loading history: ${err.message}` },
        ]),
      )
      .finally(() => setLoading(false));
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
      <div className="flex-1 flex items-center justify-center text-gray-500 text-lg">
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
      <div className="flex-1 overflow-y-auto overflow-x-hidden p-3 md:p-5 space-y-4">
        {loading && (
          <div className="text-indigo-400 italic">Loading history...</div>
        )}
        {!loading && messages.length === 0 && !isStreaming && (
          <div className="flex items-center justify-center h-full text-gray-500 text-lg">
            Send a message to get started
          </div>
        )}
        {renderedMessages}
        {streamingContent && (
          <MessageBubble message={{ role: "assistant", content: streamingContent }} />
        )}
        {activeTools.length > 0 && (
          <div className="text-xs text-indigo-400/70 px-4 py-1 space-y-1">
            <div className="flex items-center gap-2">
              <span className="animate-spin">⚙️</span>
              {activeTools.map((t) => (
                <span key={t} className="bg-indigo-500/10 px-2 py-0.5 rounded">{t}</span>
              ))}
            </div>
            {toolProgress && (
              <div className="text-indigo-400/50 pl-6 truncate">{toolProgress}</div>
            )}
          </div>
        )}
        {isStreaming && !streamingContent && activeTools.length === 0 && (
          <div className="text-indigo-400 italic animate-pulse">
            {intentText ? `${intentText}...` : "Thinking..."}
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>
      <ChatInput onSend={handleSend} disabled={isStreaming} />
    </div>
  );
}
