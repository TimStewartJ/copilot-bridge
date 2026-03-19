import { useState, useRef, useCallback } from "react";

interface ChatInputProps {
  onSend: (text: string) => void;
  disabled: boolean;
}

export default function ChatInput({ onSend, disabled }: ChatInputProps) {
  const [input, setInput] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const lastHeightRef = useRef(0);

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
          disabled={disabled || !input.trim()}
          className="px-4 md:px-6 py-3 bg-indigo-500 hover:bg-indigo-600 disabled:bg-gray-600 disabled:cursor-not-allowed text-white rounded-lg text-sm font-semibold self-end transition-colors"
        >
          Send
        </button>
      </div>
    </div>
  );
}
