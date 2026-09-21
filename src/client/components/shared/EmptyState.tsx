import { Plus } from "lucide-react";
import { Button, EmptyHint } from "../../design/primitives";
import { DS, cx } from "../../design/tokens";

interface EmptyStateProps {
  message: string;
  sub: string;
  action?: () => void;
  actionLabel?: string;
}

export default function EmptyState({ message, sub, action, actionLabel }: EmptyStateProps) {
  return (
    <div className="px-4 py-6 text-center">
      <EmptyHint>{message}</EmptyHint>
      <p className={cx(DS.field.help, "mt-1")}>{sub}</p>
      {action && actionLabel && (
        <Button onClick={action} variant="ghost" size="sm" icon={<Plus size={12} />} className="mx-auto mt-3">
          {actionLabel}
        </Button>
      )}
    </div>
  );
}
