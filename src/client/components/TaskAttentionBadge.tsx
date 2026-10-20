import { Badge, StatusIcon } from "../design/primitives";
import type { TaskRowSignal } from "../task-row-signals";

export default function TaskAttentionBadge({ signal, compact = false, icon = false }: {
  signal: TaskRowSignal;
  compact?: boolean;
  icon?: boolean;
}) {
  return <Badge tone={signal.tone === "faint" ? "neutral" : signal.tone} title={signal.detail ?? signal.label}
    aria-label={compact ? signal.label : undefined}>
    {icon && <StatusIcon kind={signal.status} decorative />}
    {compact ? signal.shortLabel : signal.label}
  </Badge>;
}
