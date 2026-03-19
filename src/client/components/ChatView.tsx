import { useState, useEffect, useRef } from "react";
import { fetchMessages, sendChat, type ChatMessage } from "../api";
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
    fetchMessages(sessionId)
      .then((msgs) => setMessages(msgs))
      .catch((err) =>
        setMessages([
          { role: "assistant", content: `Error loading history: ${err.message}` },
        ]),
      )
      .finally(() => setLoading(false));
  }, [sessionId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, thinking]);

  const handleSend = async () => {
    if (!input.trim() || !sessionId || thinking) return;

    const prompt = input.trim();
    setInput("");
    if (textareaRef.current) textareaRef.current.style.height = "auto";

    setMessages((prev) => [...prev, { role: "user", content: prompt }]);
    setThinking(true);

    try {
      const response = await sendChat(sessionId, prompt);
      setMessages((prev) => [...prev, { role: "assistant", content: response }]);
      onMessageSent();
    } catch (err: any) {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", content: `⚠️ Error: ${err.message}` },
      ]);
    } finally {
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
    <div className="flex-1 flex flex-col">
      {/* Messages */}
      <div className="flex-1 overflow-y-auto p-5 space-y-4">
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
        {thinking && (
          <div className="text-indigo-400 italic animate-pulse">
            Thinking...
          </div>
        )}
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <div className="p-4 border-t border-[#2a2a4a] bg-[#16213e]">
        <div className="flex gap-3">
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
            className="px-6 py-3 bg-indigo-500 hover:bg-indigo-600 disabled:bg-gray-600 disabled:cursor-not-allowed text-white rounded-lg text-sm font-semibold self-end transition-colors"
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
