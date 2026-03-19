import { useState, useEffect, useRef } from "react";
import { fetchMessages, sendChatStreaming, type ChatMessage, type StreamEvent } from "../api";
import MessageBubble from "./MessageBubble";

interface ChatViewProps {
  sessionId: string | null;
  onMessageSent: () => void;
}

export default function ChatView({ sessionId, onMessageSent }: ChatViewProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [streamingContent, setStreamingContent] = useState("");
  const [activeTools, setActiveTools] = useState<string[]>([]);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const prevSessionRef = useRef<string | null>(null);

  useEffect(() => {
    if (!sessionId) {
      setMessages([]);
      return;
    }
    // Only load history if session changed
    if (prevSessionRef.current === sessionId) return;
    prevSessionRef.current = sessionId;

    setMessages([]);
    setLoading(true);
    setThinking(false);
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
  }, [messages, thinking, streamingContent]);

  const handleSend = async () => {
    if (!input.trim() || !sessionId || thinking) return;

    const prompt = input.trim();
    const targetSessionId = sessionId;
    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";

    setMessages((prev) => [...prev, { role: "user", content: prompt }]);
    setThinking(true);
    setStreamingContent("");
    setActiveTools([]);

    try {
      await sendChatStreaming(targetSessionId, prompt, (event: StreamEvent) => {
        if (targetSessionId !== prevSessionRef.current) return;

        switch (event.type) {
          case "thinking":
            break; // already showing thinking state
          case "delta":
            setStreamingContent((prev) => prev + (event.content ?? ""));
            break;
          case "tool_start":
            setActiveTools((prev) => [...prev, event.name ?? "unknown"]);
            break;
          case "tool_done":
            setActiveTools((prev) => prev.filter((t) => t !== (event.name ?? "unknown")));
            break;
          case "done":
            setMessages((prev) => [
              ...prev,
              { role: "assistant", content: event.content ?? "" },
            ]);
            setStreamingContent("");
            setThinking(false);
            onMessageSent();
            break;
          case "error":
            setMessages((prev) => [
              ...prev,
              { role: "assistant", content: `⚠️ Error: ${event.message}` },
            ]);
            setStreamingContent("");
            setThinking(false);
            break;
        }
      });
    } catch (err: any) {
      if (targetSessionId !== prevSessionRef.current) return;
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `⚠️ Error: ${err.message}` },
      ]);
      setStreamingContent("");
      setActiveTools([]);
      setThinking(false);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleInput = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    e.target.style.height = "auto";
    e.target.style.height = `${Math.min(e.target.scrollHeight, 200)}px`;
  };

  if (!sessionId) {
    return (
      <div className="flex-1 flex items-center justify-center text-gray-500 text-lg">
        Create or select a session to start
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-3 md:p-5 space-y-4">
        {loading && (
          <div className="text-indigo-400 italic">Loading history...</div>
        )}
        {!loading && messages.length === 0 && !thinking && (
          <div className="flex items-center justify-center h-full text-gray-500 text-lg">
            Send a message to get started
          </div>
        )}
        {messages.map((msg, i) => (
          <MessageBubble key={i} message={msg} />
        ))}
        {streamingContent && (
          <MessageBubble
            message={{ role: "assistant", content: streamingContent }}
          />
        )}
        {activeTools.length > 0 && (
          <div className="text-xs text-indigo-400/70 px-4 py-1 flex items-center gap-2">
            <span className="animate-spin">⚙️</span>
            {activeTools.map((t) => (
              <span key={t} className="bg-indigo-500/10 px-2 py-0.5 rounded">
                {t}
              </span>
            ))}
          </div>
        )}
        {thinking && !streamingContent && activeTools.length === 0 && (
          <div className="text-indigo-400 italic animate-pulse">
            Thinking...
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="p-3 md:p-4 border-t border-[#2a2a4a] bg-[#16213e]">
        <div className="flex gap-2 md:gap-3">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            placeholder="Type a message..."
            rows={1}
            className="flex-1 px-4 py-3 bg-[#1a1a2e] text-gray-200 border border-[#2a2a4a] rounded-lg text-sm font-sans resize-none focus:outline-none focus:border-indigo-500 min-h-[48px] max-h-[200px]"
          />
          <button
            onClick={handleSend}
            disabled={thinking || !input.trim()}
            className="px-4 md:px-6 py-3 bg-indigo-500 hover:bg-indigo-600 disabled:bg-gray-600 disabled:cursor-not-allowed text-white rounded-lg text-sm font-semibold self-end transition-colors"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
