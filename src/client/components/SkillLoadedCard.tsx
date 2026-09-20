import { useState } from "react";
import { ChevronRight } from "lucide-react";
import type { ChatSkillEntry } from "../api";

interface SkillLoadedCardProps {
  entry: ChatSkillEntry;
}

/** Skill context the agent pulled in: one quiet line, like any other step, that opens onto its text. */
export default function SkillLoadedCard({ entry }: SkillLoadedCardProps) {
  const [expanded, setExpanded] = useState(false);
  const label = entry.skill.label || "skill";
  const content = entry.content?.trim() ?? "";
  const hasContent = content.length > 0;

  return (
    <div className="min-w-0 text-[13px]">
      <button
        type="button"
        onClick={() => hasContent && setExpanded((v) => !v)}
        aria-expanded={hasContent ? expanded : undefined}
        disabled={!hasContent}
        className={`-mx-1.5 inline-flex max-w-[calc(100%+0.75rem)] min-w-0 items-center gap-1.5 rounded-md px-1.5 py-1 text-left align-top transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent/50 ${
          hasContent ? "cursor-pointer hover:bg-bg-hover/60" : "cursor-default"
        }`}
      >
        <ChevronRight
          size={13}
          aria-hidden="true"
          className={`shrink-0 text-text-faint transition-transform duration-150 ${expanded ? "rotate-90" : ""} ${hasContent ? "" : "opacity-0"}`}
        />
        <span className="min-w-0 truncate text-text-muted">
          Skill loaded: <span className="font-medium text-text-secondary">{label}</span>
        </span>
      </button>
      {expanded && hasContent && (
        <pre className="chat-reveal ml-[5px] mt-1 max-h-[420px] overflow-auto whitespace-pre-wrap break-words border-l border-border py-1 pl-4 font-mono text-xs leading-relaxed text-text-muted">
          {content}
        </pre>
      )}
    </div>
  );
}
