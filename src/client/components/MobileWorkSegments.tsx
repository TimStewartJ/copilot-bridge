import { ListTodo, MessageSquare, type LucideIcon } from "lucide-react";
import { describeTabAttention, type TabAttentionSummary } from "../hooks/useTaskIndicators";
import type { MobileWorkSegment } from "../lib/mobile-route-meta";
import { DS, cx } from "../design/tokens";
import { CountBadge } from "../design/primitives";

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
    <div role="tablist" aria-label="Work lists" className={cx(DS.segmented.groupFull, "min-w-0 flex-1")}>
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
            className={cx(
              DS.segmented.option,
              DS.segmented.optionSize.md,
              DS.segmented.optionFull,
              selected ? DS.segmented.selected : DS.segmented.unselected,
            )}
          >
            <Icon size={14} aria-hidden="true" />
            <span>{label}</span>
            {attention.count > 0 && (
              <CountBadge count={attention.count} tone={attention.needsUserInputCount > 0 ? "accent" : "unread"} />
            )}
          </button>
        );
      })}
    </div>
  );
}
