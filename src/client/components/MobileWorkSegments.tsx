import { ListTodo, MessageSquare, type LucideIcon } from "lucide-react";
import { describeTabAttention, type TabAttentionSummary } from "../hooks/useTaskIndicators";
import type { MobileWorkSegment } from "../lib/mobile-route-meta";

interface MobileWorkSegmentsProps {
  activeSegment: MobileWorkSegment;
  onSelectSegment: (segment: MobileWorkSegment) => void;
  taskAttention?: TabAttentionSummary;
  chatAttention?: TabAttentionSummary;
}

const NO_ATTENTION: TabAttentionSummary = { count: 0, needsUserInputCount: 0 };

const SEGMENTS: { id: MobileWorkSegment; label: string; icon: LucideIcon; singular: string; plural: string }[] = [
  { id: "tasks", label: "Tasks", icon: ListTodo, singular: "task", plural: "tasks" },
  { id: "chats", label: "Chats", icon: MessageSquare, singular: "chat", plural: "chats" },
];

/** Switches the mobile Work tab between its two lists; each side keeps its own attention badge. */
export function MobileWorkSegments({
  activeSegment,
  onSelectSegment,
  taskAttention = NO_ATTENTION,
  chatAttention = NO_ATTENTION,
}: MobileWorkSegmentsProps) {
  return (
    <div
      role="tablist"
      aria-label="Work lists"
      className="flex min-w-0 flex-1 rounded-lg border border-border bg-bg-surface p-1"
    >
      {SEGMENTS.map(({ id, label, icon: Icon, singular, plural }) => {
        const selected = id === activeSegment;
        const attention = id === "tasks" ? taskAttention : chatAttention;
        const attentionDescription = describeTabAttention(attention, singular, plural);
        return (
          <button
            key={id}
            type="button"
            role="tab"
            aria-selected={selected}
            aria-label={attentionDescription ? `${label}, ${attentionDescription}` : label}
            onClick={() => onSelectSegment(id)}
            className={`flex min-w-0 flex-1 items-center justify-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
              selected
                ? "bg-bg-primary text-text-primary shadow-sm"
                : "text-text-muted active:text-text-secondary"
            }`}
          >
            <Icon size={14} />
            <span>{label}</span>
            {attention.count > 0 && (
              <span
                aria-hidden="true"
                className={`flex h-4 min-w-[16px] items-center justify-center rounded-full px-1 text-[10px] font-semibold leading-none text-white ${
                  attention.needsUserInputCount > 0 ? "bg-warning" : "bg-success"
                }`}
              >
                {attention.count > 99 ? "99+" : attention.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
