import { useState, useEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { FileText, Pencil, X } from "lucide-react";

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
      <div className="relative w-full md:max-w-2xl md:mt-16 md:mb-16 max-h-[85vh] md:max-h-[80vh] bg-bg-primary rounded-t-2xl md:rounded-xl border border-border flex flex-col shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border shrink-0">
          <h2 className="text-sm font-medium text-text-primary flex items-center gap-1.5">
            <FileText size={14} className="text-text-muted" />
            {editing ? "Editing Notes" : "Notes"}
          </h2>
          <div className="flex items-center gap-2">
            {!editing && (
              <button
                onClick={() => { setDraft(notes); setEditing(true); }}
                className="text-text-muted hover:text-text-secondary transition-colors"
                aria-label="Edit"
                title="Edit notes"
              >
                <Pencil size={14} />
              </button>
            )}
            <button
              onClick={onClose}
              className="text-text-muted hover:text-text-secondary transition-colors"
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
                className="w-full flex-1 px-3 py-2 bg-bg-secondary text-text-primary border border-border rounded-md text-sm font-mono resize-y focus:outline-none focus:border-accent min-h-[200px]"
                placeholder="Write notes in markdown..."
              />
              <div className="flex gap-2">
                <button
                  onClick={handleSave}
                  className="px-3 py-1.5 bg-accent hover:bg-accent-hover text-white text-xs rounded-md transition-colors"
                >
                  Save
                </button>
                <button
                  onClick={handleCancel}
                  className="px-3 py-1.5 text-text-muted hover:text-text-primary text-xs transition-colors"
                >
                  Cancel
                </button>
              </div>
            </div>
          ) : notes ? (
            <div
              onClick={() => { setDraft(notes); setEditing(true); }}
              className="cursor-pointer prose prose-invert prose-sm max-w-none
                prose-pre:bg-bg-secondary prose-pre:rounded-md prose-pre:p-3 prose-pre:text-xs prose-pre:overflow-x-auto prose-pre:max-w-full
                prose-code:text-accent prose-code:text-xs prose-code:font-mono
                prose-th:border prose-th:border-border prose-th:px-3 prose-th:py-1.5 prose-th:bg-bg-secondary
                prose-td:border prose-td:border-border prose-td:px-3 prose-td:py-1.5
                prose-table:block prose-table:overflow-x-auto prose-table:max-w-full
                prose-a:text-accent prose-a:no-underline hover:prose-a:underline
                prose-headings:mt-3 prose-headings:mb-1
                prose-p:my-1.5 prose-ul:my-1.5 prose-ol:my-1.5
                prose-li:my-0.5"
            >
              <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{notes}</ReactMarkdown>
            </div>
          ) : (
            <div className="text-center py-8">
              <p className="text-text-faint text-sm mb-3">No notes yet</p>
              <button
                onClick={() => setEditing(true)}
                className="px-3 py-1.5 bg-accent hover:bg-accent-hover text-white text-xs rounded-md transition-colors"
              >
                Add notes
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
