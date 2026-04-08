import { useState, useRef, useCallback, useEffect } from "react";
import { Square, Paperclip, X } from "lucide-react";
import type { BlobAttachment } from "../api";
import type { Draft } from "../useDrafts";

const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10 MB

interface ChatInputProps {
  onSend: (text: string, attachments?: BlobAttachment[]) => void;
  onAbort?: () => void;
  sessionId?: string | null;
  isDraft?: boolean;
  draft?: Draft | null;
  onDraftChange?: (text: string, attachments?: BlobAttachment[]) => void;
  /** When true, input is visible but send is disabled (e.g., session warming up) */
  disabled?: boolean;
  disabledHint?: string;
}

/** Read a File as base64 (no data-URI prefix) */
function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      // Strip "data:<mime>;base64," prefix
      resolve(result.split(",", 2)[1]);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export default function ChatInput({ onSend, onAbort, sessionId, isDraft, draft, onDraftChange, disabled, disabledHint }: ChatInputProps) {
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<BlobAttachment[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const lastHeightRef = useRef(0);
  // Track which session's draft we've already restored to avoid re-applying on every render
  const restoredForRef = useRef<string | null>(null);

  // Restore draft when session changes
  useEffect(() => {
    if (!sessionId) return;
    if (restoredForRef.current === sessionId) return;
    restoredForRef.current = sessionId;
    if (draft) {
      setInput(draft.text);
      setAttachments(draft.attachments ?? []);
      // Adjust textarea height for restored content
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (el) {
          el.style.height = "auto";
          el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
        }
      });
    } else {
      setInput("");
      setAttachments([]);
      lastHeightRef.current = 0;
      if (textareaRef.current) textareaRef.current.style.height = "auto";
    }
  }, [sessionId]); // intentionally only depends on sessionId — draft at switch time

  // Auto-focus on session change (desktop only — avoids keyboard popup on mobile)
  useEffect(() => {
    if ((sessionId || isDraft) && window.matchMedia("(pointer: fine)").matches) {
      textareaRef.current?.focus();
    }
  }, [sessionId, isDraft]);

  const addImageFiles = useCallback(async (files: File[]) => {
    const imageFiles = files.filter((f) => f.type.startsWith("image/"));
    if (imageFiles.length === 0) return;

    const newAttachments: BlobAttachment[] = [];
    for (const file of imageFiles) {
      if (file.size > MAX_IMAGE_SIZE) {
        console.warn(`Skipping ${file.name}: exceeds 10 MB limit`);
        continue;
      }
      const data = await readFileAsBase64(file);
      newAttachments.push({
        type: "blob",
        data,
        mimeType: file.type,
        displayName: file.name,
      });
    }
    if (newAttachments.length > 0) {
      setAttachments((prev) => {
        const next = [...prev, ...newAttachments];
        onDraftChange?.(input, next);
        return next;
      });
    }
  }, [input, onDraftChange]);

  const removeAttachment = useCallback((index: number) => {
    setAttachments((prev) => {
      const next = prev.filter((_, i) => i !== index);
      onDraftChange?.(input, next);
      return next;
    });
  }, [input, onDraftChange]);

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      const imageFiles: File[] = [];
      for (const item of Array.from(e.clipboardData.items)) {
        if (item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) imageFiles.push(file);
        }
      }
      if (imageFiles.length > 0) {
        e.preventDefault();
        addImageFiles(imageFiles);
      }
    },
    [addImageFiles],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith("image/"));
      if (files.length > 0) addImageFiles(files);
    },
    [addImageFiles],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
  }, []);

  const handleInput = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const value = e.target.value;
      setInput(value);
      onDraftChange?.(value, attachments);
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
    [attachments, onDraftChange],
  );

  const handleSend = useCallback(() => {
    const text = input.trim();
    if (!text && attachments.length === 0) return;
    onSend(text || "(image)", attachments.length > 0 ? attachments : undefined);
    setInput("");
    setAttachments([]);
    lastHeightRef.current = 0;
    if (textareaRef.current) {
      textareaRef.current.style.height = "auto";
      // Dismiss keyboard on touch devices; keep focus on desktop for rapid typing
      if (!window.matchMedia("(pointer: fine)").matches) {
        textareaRef.current.blur();
      }
    }
  }, [input, attachments, onSend]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSend();
      }
    },
    [handleSend],
  );

  const hasContent = input.trim().length > 0 || attachments.length > 0;

  return (
    <div className="p-3 md:p-4 border-t border-border bg-bg-secondary">
      {/* Attachment preview strip */}
      {attachments.length > 0 && (
        <div className="flex gap-2 mb-2 flex-wrap">
          {attachments.map((att, i) => (
            <div key={i} className="relative group">
              <img
                src={`data:${att.mimeType};base64,${att.data}`}
                alt={att.displayName ?? "attachment"}
                className="h-16 w-16 object-cover rounded-md border border-border"
              />
              <button
                onClick={() => removeAttachment(i)}
                className="absolute -top-1.5 -right-1.5 bg-bg-primary border border-border rounded-full p-0.5 opacity-0 group-hover:opacity-100 transition-opacity text-text-secondary hover:text-red-400"
              >
                <X size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      <div className="flex gap-2 md:gap-3">
        <div
          className="flex-1 flex items-end gap-1 bg-bg-primary border border-border rounded-md focus-within:border-accent"
          onDrop={handleDrop}
          onDragOver={handleDragOver}
        >
          <button
            onClick={() => fileInputRef.current?.click()}
            className="p-3 text-text-faint hover:text-text-secondary transition-colors flex-shrink-0"
            title="Attach image"
            type="button"
          >
            <Paperclip size={18} />
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) addImageFiles(Array.from(e.target.files));
              e.target.value = "";
            }}
          />
          <textarea
            ref={textareaRef}
            value={input}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder="Type a message or paste an image..."
            rows={1}
            className="flex-1 py-3 pr-3 bg-transparent text-text-primary text-base md:text-sm resize-none focus:outline-none min-h-[48px] max-h-[200px] placeholder:text-text-faint"
          />
        </div>
        {onAbort ? (
          <button
            onClick={onAbort}
            className="p-3 bg-error hover:bg-error-hover text-white rounded-md self-end transition-colors flex items-center justify-center"
            title="Stop generating"
          >
            <Square size={14} fill="currentColor" />
          </button>
        ) : (
          <button
            onClick={handleSend}
            disabled={!hasContent || disabled}
            className="px-4 md:px-6 py-3 bg-accent hover:bg-accent-hover disabled:bg-bg-elevated disabled:text-text-faint disabled:cursor-not-allowed text-white rounded-md text-sm font-medium self-end transition-colors"
            title={disabled ? disabledHint : undefined}
          >
            {disabled ? (disabledHint ?? "Warming up…") : "Send"}
          </button>
        )}
      </div>
    </div>
  );
}
