import { useState } from "react";
import { ChevronRight, Sparkles } from "lucide-react";
import type { ChatSkillEntry } from "../api";

interface SkillLoadedCardProps {
  entry: ChatSkillEntry;
}

export default function SkillLoadedCard({ entry }: SkillLoadedCardProps) {
  const [expanded, setExpanded] = useState(false);
  const label = entry.skill.label || "skill";
  const content = entry.content?.trim() ?? "";
  const hasContent = content.length > 0;

  return (
    <div className="rounded-2xl border border-border bg-bg-secondary/60 text-text-secondary shadow-sm">
      <button
        type="button"
        onClick={() => hasContent && setExpanded((v) => !v)}
        aria-expanded={hasContent ? expanded : undefined}
        disabled={!hasContent}
        className={`flex w-full items-center gap-2 px-4 py-2.5 text-left text-xs font-medium ${
          hasContent ? "cursor-pointer hover:text-text-primary" : "cursor-default"
        }`}
      >
        {hasContent && (
          <ChevronRight
            size={14}
            className={`shrink-0 text-text-faint transition-transform ${expanded ? "rotate-90" : ""}`}
          />
        )}
        <Sparkles size={14} className="shrink-0 text-accent" />
        <span className="text-text-muted">
          Skill loaded: <span className="font-semibold text-text-secondary">{label}</span>
        </span>
      </button>
      {expanded && hasContent && (
        <pre className="max-h-[420px] overflow-auto border-t border-border px-4 py-3 text-xs leading-relaxed text-text-secondary whitespace-pre-wrap break-words">
          {content}
        </pre>
      )}
    </div>
  );
}
