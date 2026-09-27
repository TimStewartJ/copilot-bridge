import { useState, useEffect, useRef, type ReactNode } from "react";
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
  /** May return a promise; the editor stays open with the draft if it rejects. */
  onSave: (notes: string) => void | Promise<void>;
  onClose: () => void;
  startInEditMode?: boolean;
  /** Heading; defaults to "Notes". The same sheet edits a task's instructions. */
  title?: string;
  icon?: ReactNode;
  /** One line under the heading that says what belongs here. */
  description?: string;
  placeholder?: string;
  emptyMessage?: string;
  emptySub?: string;
  emptyActionLabel?: string;
}

export default function NotesSheet({
  notes,
  onSave,
  onClose,
  startInEditMode = false,
  title = "Notes",
  icon = <FileText size={14} className="text-text-muted" />,
  description,
  placeholder = "Write notes in markdown...",
  emptyMessage = "No notes yet",
  emptySub = "Add notes to capture context and decisions",
  emptyActionLabel = "Add notes",
}: NotesSheetProps) {
  const [editing, setEditing] = useState(startInEditMode);
  const [draft, setDraft] = useState(notes);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const { titleId, dialogProps } = useModalDialog({ onDismiss: onClose });

  useEffect(() => {
    if (editing && textareaRef.current) {
      textareaRef.current.focus();
      textareaRef.current.selectionStart = textareaRef.current.value.length;
    }
  }, [editing]);

  const handleSave = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await onSave(draft);
      setEditing(false);
    } catch (error) {
      setSaveError(error instanceof Error ? error.message : "Could not save.");
    } finally {
      setSaving(false);
    }
  };

  const handleCancel = () => {
    setDraft(notes);
    setSaveError(null);
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
            {icon}
            {editing ? `Editing ${title}` : title}
          </h2>
          <div className="flex items-center gap-2">
            {!editing && (
              <button
                onClick={() => { setDraft(notes); setEditing(true); }}
                className={cx(DS.button.base, DS.button.size.sm, DS.button.variant.ghost)}
                aria-label="Edit"
                title={`Edit ${title.toLowerCase()}`}
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
          {description && <p className={cx(DS.text.meta, "mb-3")}>{description}</p>}
          {editing ? (
            <div className="flex flex-col gap-3 h-full">
              <textarea
                ref={textareaRef}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={16}
                className={cx(DS.field.input, DS.field.textarea, DS.focus, "flex-1 font-mono resize-y min-h-[200px]")}
                placeholder={placeholder}
              />
              <div className="flex items-center gap-2">
                <button
                  onClick={() => { void handleSave(); }}
                  disabled={saving}
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
                {saveError && (
                  <span role="alert" className={cx(DS.text.meta, DS.tone.danger)}>{saveError}</span>
                )}
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
              message={emptyMessage}
              sub={emptySub}
              action={() => setEditing(true)}
              actionLabel={emptyActionLabel}
            />
          )}
        </div>
      </div>
    </div>
  );
}
