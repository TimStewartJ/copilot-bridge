import { useState, useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { FileText, Pencil, X } from "lucide-react";
import CodeBlock from "./CodeBlock";
import { APP_PROSE } from "./shared/prose-classes";
import EmptyState from "./shared/EmptyState";
import { useModalDialog } from "./shared/useModalDialog";
import { DS, cx } from "../design/tokens";

interface NotesSheetProps {
  notes: string;
  onSave: (notes: string) => void;
  onClose: () => void;
  startInEditMode?: boolean;
}

export default function NotesSheet({ notes, onSave, onClose, startInEditMode = false }: NotesSheetProps) {
  const [editing, setEditing] = useState(startInEditMode);
  const [draft, setDraft] = useState(notes);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { titleId, dialogProps } = useModalDialog({ onDismiss: onClose });

  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.selectionStart = textareaRef.current.value.length;
    }
  }, [editing]);

  const handleSave = () => {
    onSave(draft);
    setEditing(false);
  };

  const handleCancel = () => {
    setDraft(notes);
    setEditing(false);
    if (!notes) onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-start md:justify-center">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/60" onClick={onClose} />

      {/* Sheet */}
      <div
        {...dialogProps}
        className={cx(DS.surface.dialog, "relative w-full md:max-w-2xl md:mt-16 md:mb-16 max-h-[85vh] md:max-h-[80vh] rounded-t-2xl md:rounded-xl flex flex-col")}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
          <h2 id={titleId} className="text-sm font-medium text-text-primary flex items-center gap-1.5">
            <FileText size={14} className="text-text-muted" />
            {editing ? "Editing Notes" : "Notes"}
          </h2>
          <div className="flex items-center gap-2">
            {!editing && (
              <button
                onClick={() => { setDraft(notes); setEditing(true); }}
                className={cx(DS.button.base, DS.button.size.sm, DS.button.variant.ghost)}
                aria-label="Edit"
                title="Edit notes"
              >
                <Pencil size={14} />
              </button>
            )}
            <button
              onClick={onClose}
              className={cx(DS.button.base, DS.button.size.sm, DS.button.variant.ghost)}
              aria-label="Close"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {editing ? (
            <div className="flex flex-col gap-3 h-full">
              <textarea
                ref={textareaRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={16}
                className={cx(DS.field.input, DS.field.textarea, DS.focus, "flex-1 font-mono resize-y min-h-[200px]")}
                placeholder="Write notes in markdown..."
              />
              <div className="flex gap-2">
                <button
                  onClick={handleSave}
                  className={cx(DS.button.base, DS.button.size.sm, DS.button.variant.primary)}
                >
                  Save
                </button>
                <button
                  onClick={handleCancel}
                  className={cx(DS.button.base, DS.button.size.sm, DS.button.variant.ghost)}
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : notes ? (
            <div
              onClick={() => { setDraft(notes); setEditing(true); }}
              className={cx("cursor-pointer max-w-none", APP_PROSE, "prose-pre:bg-bg-secondary prose-th:bg-bg-secondary")}
            >
              <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]} components={{ pre: CodeBlock }}>{notes}</ReactMarkdown>
            </div>
          ) : (
            <EmptyState
              message="No notes yet"
              sub="Add notes to capture context and decisions"
              action={() => setEditing(true)}
              actionLabel="Add notes"
            />
          )}
        </div>
      </div>
    </div>
  );
}
