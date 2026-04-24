import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import { Pencil, StickyNote } from "lucide-react";
import TaskPanelSummaryRow from "../TaskPanelSummaryRow";

// ── Props ────────────────────────────────────────────────────────

export interface TaskNotesSectionProps {
  notes: string | undefined;
  onView: () => void;
  onEdit: () => void;
  truncate?: boolean;
  variant?: "default" | "summary";
}

function getNotesPreview(notes: string): string {
  return notes
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+\.\s+/gm, "")
    .replace(/^>\s+/gm, "")
    .replace(/[*_~]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// ── Component ────────────────────────────────────────────────────

export default function TaskNotesSection({ notes, onView, onEdit, truncate = false, variant = "default" }: TaskNotesSectionProps) {
  const trimmedNotes = notes?.trim();

  if (variant === "summary") {
    if (!trimmedNotes) return null;

    const preview = getNotesPreview(trimmedNotes);

    return (
      <TaskPanelSummaryRow
        label="Notes"
        icon={<StickyNote size={14} />}
        title={preview || "View notes"}
        titleClassName="line-clamp-2"
        onClick={onView}
        trailing={(
          <button
            onClick={(e) => {
              e.stopPropagation();
              onEdit();
            }}
            className="p-1 text-text-faint hover:text-text-primary transition-colors"
            title="Edit notes"
          >
            <Pencil size={12} />
          </button>
        )}
      />
    );
  }

  if (trimmedNotes) {
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
            <ReactMarkdown remarkPlugins={[remarkGfm, remarkBreaks]}>{trimmedNotes}</ReactMarkdown>
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
