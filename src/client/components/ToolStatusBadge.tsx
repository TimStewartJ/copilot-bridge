import { CheckCircle2, Loader2, XCircle } from "lucide-react";
import type { ToolCall } from "../api";
import { getToolCallStatus, getToolCallStatusLabel } from "../lib/tool-call-status";

interface ToolStatusBadgeProps {
  toolCall: Pick<ToolCall, "success" | "completedAt" | "result">;
}

export default function ToolStatusBadge({ toolCall }: ToolStatusBadgeProps) {
  const status = getToolCallStatus(toolCall);
  const label = getToolCallStatusLabel(status);
  const toneClass = status === "failed"
    ? "bg-error/10 text-error"
    : status === "done"
      ? "bg-success/15 text-success"
      : "bg-warning/15 text-warning";

  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${toneClass}`}>
      {status === "failed"
        ? <XCircle size={10} />
        : status === "done"
          ? <CheckCircle2 size={10} />
          : <Loader2 size={10} className="animate-spin" />}
      {label}
    </span>
  );
}
