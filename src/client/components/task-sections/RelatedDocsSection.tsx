import { useState, useEffect } from "react";
import type { RelatedDoc } from "../../api";
import { BookOpen } from "lucide-react";
import TaskPanelSummaryDisclosure from "../TaskPanelSummaryDisclosure";

// ── Props ────────────────────────────────────────────────────────

export interface RelatedDocsSectionProps {
  docs: RelatedDoc[];
  variant?: "compact" | "card" | "summary";
  onPreview?: (path: string) => void;
  /** Reset expansion state when this key changes (e.g. task ID). */
  resetKey?: string;
}

// ── Component ────────────────────────────────────────────────────

export default function RelatedDocsSection({ docs, variant = "compact", onPreview, resetKey }: RelatedDocsSectionProps) {
  const [expanded, setExpanded] = useState(false);
  const isCompact = variant === "compact";

  // Reset expansion when task changes
  useEffect(() => { setExpanded(false); }, [resetKey]);

  if (docs.length === 0) return null;

  if (variant === "summary") {
    const sortedDocs = [...docs].sort((a, b) => new Date(b.modified).getTime() - new Date(a.modified).getTime());
    const primaryDoc = sortedDocs[0];
    const title = docs.length === 1 ? primaryDoc.title : `${docs.length} related docs`;
    const subtitle = docs.length === 1 ? primaryDoc.path : `Latest: ${primaryDoc.title}`;

    return (
      <TaskPanelSummaryDisclosure
        label="Docs"
        icon={<BookOpen size={14} />}
        title={title}
        subtitle={subtitle}
        subtitleClassName={docs.length === 1 ? "truncate font-mono" : undefined}
        itemCount={docs.length}
        resetKey={resetKey}
        onOpenSingle={onPreview ? () => onPreview(primaryDoc.path) : undefined}
      >
        <RelatedDocsSection docs={docs} variant="compact" onPreview={onPreview} />
      </TaskPanelSummaryDisclosure>
    );
  }

  if (isCompact) {
    const COLLAPSED_MAX = 5;
    const visibleDocs = expanded ? docs : docs.slice(0, COLLAPSED_MAX);
    const hiddenCount = docs.length - COLLAPSED_MAX;

    return (
      <div>
        <div className="space-y-0.5">
          {visibleDocs.map((doc) => (
            <button
              key={doc.path}
              onClick={() => onPreview?.(doc.path)}
              className="block w-full text-left px-3 py-1.5 text-xs text-text-secondary hover:bg-bg-hover rounded-md transition-colors"
            >
              <div className="flex items-center gap-1.5">
                <BookOpen size={12} className="text-text-faint shrink-0" />
                <span className="text-text-primary truncate">{doc.title}</span>
              </div>
              <div className="text-[10px] text-text-faint mt-0.5 ml-5 font-mono truncate">
                {doc.path}
              </div>
            </button>
          ))}
        </div>
        {hiddenCount > 0 && (
          <button
            onClick={() => setExpanded(!expanded)}
            className="px-3 py-1 text-[10px] text-accent hover:text-accent-hover transition-colors"
          >
            {expanded ? "Show less" : `Show ${hiddenCount} more…`}
          </button>
        )}
      </div>
    );
  }

  // Card variant (TaskDashboard)
  return (
    <div className="space-y-1">
      {docs.map((doc) => (
        <a
          key={doc.path}
          href={`/docs/${doc.path}`}
          className="block px-3 py-2 rounded-md bg-bg-surface hover:bg-bg-hover transition-colors"
        >
          <div className="text-sm text-text-primary truncate">{doc.title}</div>
          <div className="text-[10px] text-text-faint mt-0.5 flex items-center gap-2">
            <span className="font-mono">{doc.path}</span>
            {doc.tags.length > 0 && (
              <span>{doc.tags.join(", ")}</span>
            )}
          </div>
        </a>
      ))}
    </div>
  );
}
