import type { Task } from "../api";
import { getTaskKindLabel } from "../task-kind";
import { Pin } from "lucide-react";
import { cx } from "../design/tokens";
import { Badge } from "../design/primitives";

interface TaskKindBadgeProps {
  kind: Task["kind"];
  showTask?: boolean;
  iconOnly?: boolean;
  className?: string;
}

/** What kind of item a task is. A kind is not a state, so it carries no colour. */
export default function TaskKindBadge({
  kind,
  showTask = false,
  iconOnly = false,
  className = "",
}: TaskKindBadgeProps) {
  if (kind === "task" && !showTask) return null;
  const label = getTaskKindLabel(kind);
  const pin = kind === "ongoing" ? <Pin size={10} className="rotate-45" aria-hidden="true" /> : null;

  if (iconOnly) {
    return (
      <span className={cx("inline-flex items-center justify-center text-text-faint", className)} title={label}>
        {pin}
        <span className="sr-only">{label}</span>
      </span>
    );
  }

  return (
    <Badge title={label} className={className}>
      {pin}
      {label.toLowerCase()}
    </Badge>
  );
}