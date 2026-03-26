import { Plus } from "lucide-react";

interface EmptyStateProps {
  message: string;
  sub: string;
  action?: () => void;
  actionLabel?: string;
}

export default function EmptyState({ message, sub, action, actionLabel }: EmptyStateProps) {
  return (
    <div className="text-center py-6 px-4 rounded-md bg-bg-surface border border-border">
      <div className="text-sm text-text-muted">{message}</div>
      <div className="text-xs text-text-faint mt-1">{sub}</div>
      {action && actionLabel && (
        <button
          onClick={action}
          className="mt-3 text-xs text-accent hover:text-accent-hover flex items-center gap-1 mx-auto"
        >
          <Plus size={12} />
          {actionLabel}
        </button>
      )}
    </div>
  );
}
