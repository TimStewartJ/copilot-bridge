import { useState, useRef, useCallback, useEffect } from "react";
import { Square } from "lucide-react";

interface ChatInputProps {
  onSend: (text: string) => void;
  disabled: boolean;
  onAbort?: () => void;
  sessionId?: string | null;
}

export default function ChatInput({ onSend, disabled, onAbort, sessionId }: ChatInputProps) {
  const [input, setInput] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lastHeightRef = useRef(0);

  // Auto-focus on session change (desktop only — avoids keyboard popup on mobile)
  useEffect(() => {
    if (sessionId && window.matchMedia("(pointer: fine)").matches) {
      textareaRef.current?.focus();
    }
  }, [sessionId]);

  const handleInput = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      setInput(e.target.value);
      const el = e.target;
      el.style.height = "auto";
      const next = Math.min(el.scrollHeight, 200);
      if (next !== lastHeightRef.current) {
        lastHeightRef.current = next;
        el.style.height = `${next}px`;
      } else {
        el.style.height = `${next}px`;
      }
    },
    [],
  );

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text) return;
    onSend(text);
    setInput("");
    lastHeightRef.current = 0;
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  }, [input, onSend]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  return (
    <div className="p-3 md:p-4 border-t border-border bg-bg-secondary">
      <div className="flex gap-2 md:gap-3">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={handleInput}
          onKeyDown={handleKeyDown}
          placeholder="Type a message..."
          rows={1}
          className="flex-1 px-4 py-3 bg-bg-primary text-text-primary border border-border rounded-md text-base md:text-sm resize-none focus:outline-none focus:border-accent min-h-[48px] max-h-[200px] placeholder:text-text-faint"
        />
        <button
          onClick={handleSend}
          disabled={disabled || !input.trim()}
          className="px-4 md:px-6 py-3 bg-accent hover:bg-accent-hover disabled:bg-bg-elevated disabled:text-text-faint disabled:cursor-not-allowed text-white rounded-md text-sm font-medium self-end transition-colors"
        >
          Send
        </button>
        {onAbort && (
          <button
            onClick={onAbort}
            className="px-3 py-3 bg-red-600 hover:bg-red-700 text-white rounded-md text-sm font-medium self-end transition-colors"
            title="Stop generating"
          >
            <Square size={14} fill="currentColor" />
          </button>
        )}
      </div>
    </div>
  );
}
