import type { Task } from "../api";
import { getTaskKindLabel } from "../task-kind";
import { Pin } from "lucide-react";

interface TaskKindBadgeProps {
  kind: Task["kind"];
  showTask?: boolean;
  iconOnly?: boolean;
  className?: string;
}

export default function TaskKindBadge({
  kind,
  showTask = false,
  iconOnly = false,
  className = "",
}: TaskKindBadgeProps) {
  if (kind === "task" && !showTask) return null;
  const label = getTaskKindLabel(kind);

  const tone = kind === "ongoing"
    ? "bg-info-surface text-info"
    : "bg-bg-hover text-text-muted";

  return (
    <span
      className={`inline-flex items-center justify-center gap-1 rounded-full ${iconOnly ? "p-0.5" : "px-1.5 py-0.5"} text-[10px] font-medium ${tone} ${className}`.trim()}
      title={label}
    >
      {kind === "ongoing" && <Pin size={10} className="rotate-45" aria-hidden="true" />}
      {iconOnly ? <span className="sr-only">{label}</span> : label.toLowerCase()}
    </span>
  );
}
