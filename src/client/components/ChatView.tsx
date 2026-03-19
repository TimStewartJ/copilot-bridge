import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { fetchMessages, sendChatStreaming, type ChatMessage, type StreamEvent } from "../api";
import MessageBubble from "./MessageBubble";
import ChatInput from "./ChatInput";

interface ChatViewProps {
  sessionId: string | null;
  onMessageSent: () => void;
}

export default function ChatView({ sessionId, onMessageSent }: ChatViewProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const [activeTools, setActiveTools] = useState<string[]>([]);
  const [intentText, setIntentText] = useState("");
  const [toolProgress, setToolProgress] = useState("");
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const prevSessionRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    if (!sessionId) {
      setMessages([]);
      return;
    }
    // Only load history if session changed
    if (prevSessionRef.current === sessionId) return;
    prevSessionRef.current = sessionId;

    // Abort any in-flight SSE stream from the previous session
    abortRef.current?.abort();
    abortRef.current = null;

    setMessages([]);
    setLoading(true);
    setThinking(false);
    setStreamingContent("");
    setActiveTools([]);
    setIntentText("");
    setToolProgress("");
    fetchMessages(sessionId)
      .then(({ messages: msgs, busy }) => {
        setMessages(msgs);
        if (busy) {
          setThinking(true);
          // Poll until no longer busy
          const poll = setInterval(async () => {
            try {
              const updated = await fetchMessages(sessionId);
              if (sessionId !== prevSessionRef.current) {
                clearInterval(poll);
                return;
              }
              setMessages(updated.messages);
              if (!updated.busy) {
                clearInterval(poll);
                setThinking(false);
                onMessageSent();
              }
            } catch {
              clearInterval(poll);
              setThinking(false);
            }
          }, 3_000);
        }
      })
      .catch((err) =>
        setMessages([
          { role: "assistant", content: `Error loading history: ${err.message}` },
        ]),
      )
      .finally(() => setLoading(false));
  }, [sessionId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, thinking, streamingContent, activeTools, toolProgress]);

  const handleSend = useCallback(async (prompt: string) => {
    if (!sessionId || thinking) return;

    const targetSessionId = sessionId;

    // Abort any previous SSE stream before starting a new one
    abortRef.current?.abort();
    const abort = new AbortController();
    abortRef.current = abort;

    setMessages((prev) => [...prev, { role: "user", content: prompt }]);
    setThinking(true);
    setStreamingContent("");
    setActiveTools([]);
    setIntentText("");
    setToolProgress("");

    try {
      await sendChatStreaming(targetSessionId, prompt, (event: StreamEvent) => {
        if (targetSessionId !== prevSessionRef.current) return;

        switch (event.type) {
          case "thinking":
            break; // already showing thinking state
          case "intent":
            setIntentText(event.intent ?? "");
            break;
          case "delta":
            setStreamingContent((prev) => prev + (event.content ?? ""));
            break;
          case "assistant_partial":
            // Intermediate message — agent commentary between tool calls
            if (event.content) {
              setMessages((prev) => [
                ...prev,
                { role: "assistant", content: event.content! },
              ]);
            }
            break;
          case "tool_start":
            setActiveTools((prev) => [...prev, event.name ?? "unknown"]);
            setToolProgress("");
            break;
          case "tool_progress":
            setToolProgress(event.message ?? "");
            break;
          case "tool_output":
            setToolProgress(event.content ?? "");
            break;
          case "tool_done":
            setActiveTools((prev) => prev.filter((t) => t !== (event.name ?? "unknown")));
            setToolProgress("");
            break;
          case "title_changed":
            onMessageSent(); // refresh sidebar to pick up new title
            break;
          case "done":
            setMessages((prev) => [
              ...prev,
              { role: "assistant", content: event.content ?? "" },
            ]);
            setStreamingContent("");
            setThinking(false);
            setIntentText("");
            setToolProgress("");
            onMessageSent();
            break;
          case "error":
            setMessages((prev) => [
              ...prev,
              { role: "assistant", content: `⚠️ Error: ${event.message}` },
            ]);
            setStreamingContent("");
            setThinking(false);
            setIntentText("");
            setToolProgress("");
            break;
        }
      }, abort.signal);
    } catch (err: any) {
      if (targetSessionId !== prevSessionRef.current) return;
      if (err.name === "AbortError") return; // silently ignore aborted streams
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `⚠️ Error: ${err.message}` },
      ]);
    } finally {
      if (targetSessionId === prevSessionRef.current) {
        setStreamingContent("");
        setActiveTools([]);
        setThinking(false);
        setIntentText("");
        setToolProgress("");
      }
    }
  }, [sessionId, thinking, onMessageSent]);

  if (!sessionId) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500 text-lg">
        Create or select a session to start
      </div>
    );
  }

  const renderedMessages = useMemo(
    () =>
      messages.map((msg, i) => (
        <MessageBubble key={`${msg.role}-${i}`} message={msg} />
      )),
    [messages],
  );

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden p-3 md:p-5 space-y-4">
        {loading && (
          <div className="text-indigo-400 italic">Loading history...</div>
        )}
        {!loading && messages.length === 0 && !thinking && (
          <div className="flex items-center justify-center h-full text-gray-500 text-lg">
            Send a message to get started
          </div>
        )}
        {renderedMessages}
        {streamingContent && (
          <MessageBubble
            message={{ role: "assistant", content: streamingContent }}
          />
        )}
        {activeTools.length > 0 && (
          <div className="text-xs text-indigo-400/70 px-4 py-1 space-y-1">
            <div className="flex items-center gap-2">
              <span className="animate-spin">⚙️</span>
              {activeTools.map((t) => (
                <span key={t} className="bg-indigo-500/10 px-2 py-0.5 rounded">
                  {t}
                </span>
              ))}
            </div>
            {toolProgress && (
              <div className="text-indigo-400/50 pl-6 truncate">{toolProgress}</div>
            )}
          </div>
        )}
        {thinking && !streamingContent && activeTools.length === 0 && (
          <div className="text-indigo-400 italic animate-pulse">
            {intentText ? `${intentText}...` : "Thinking..."}
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <ChatInput onSend={handleSend} disabled={thinking} />
    </div>
  );
}
