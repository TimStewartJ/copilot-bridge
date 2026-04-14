import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";

// ── Props ────────────────────────────────────────────────────────

export interface TaskNotesSectionProps {
  notes: string | undefined;
  onView: () => void;
  onEdit: () => void;
  truncate?: boolean;
}

// ── Component ────────────────────────────────────────────────────

export default function TaskNotesSection({ notes, onView, onEdit, truncate = false }: TaskNotesSectionProps) {
  if (notes) {
    return (
      <div
        onClick={onView}
        className={`${
          truncate
            ? "px-3 py-1.5 cursor-pointer hover:bg-bg-hover rounded-md transition-colors relative"
            : "px-3 py-3 cursor-pointer rounded-md bg-bg-surface hover:bg-bg-hover transition-colors"
        }`}
      >
        <div className={truncate ? "max-h-16 overflow-hidden" : undefined}>
          <div
            className={
              truncate
                ? "prose prose-invert prose-xs max-w-none text-text-muted prose-p:my-0.5 prose-headings:mt-1 prose-headings:mb-0.5 prose-headings:text-xs prose-ul:my-0.5 prose-ol:my-0.5 prose-li:my-0 prose-pre:hidden prose-table:hidden prose-code:text-accent prose-code:text-[10px] prose-a:text-accent prose-a:no-underline"
                : "prose prose-invert prose-sm max-w-none text-text-secondary prose-p:my-1 prose-headings:mt-2 prose-headings:mb-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0 prose-code:text-accent prose-code:text-xs prose-a:text-accent prose-a:no-underline"
            }
          >
            <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{notes}</ReactMarkdown>
          </div>
        </div>
        {truncate && (
          <div className="absolute bottom-0 left-0 right-0 h-6 bg-gradient-to-t from-bg-secondary to-transparent pointer-events-none rounded-b-md" />
        )}
      </div>
    );
  }

  if (truncate) {
    return (
      <div className="px-3 py-1">
        <button
          onClick={onEdit}
          className="text-[10px] text-text-faint hover:text-accent transition-colors"
        >
          Add notes…
        </button>
      </div>
    );
  }

  return null;
}
