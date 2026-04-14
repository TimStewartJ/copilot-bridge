import { Pencil, Trash2 } from "lucide-react";

export interface ConfigCardProps {
  title: string;
  badge?: React.ReactNode;
  onEdit: () => void;
  onRemove?: () => void;
  removeTitle?: string;
  children?: React.ReactNode;
}

export function ConfigCard({
  title,
  badge,
  onEdit,
  onRemove,
  removeTitle = "Remove",
  children,
}: ConfigCardProps) {
  return (
    <div className="bg-bg-elevated border border-border rounded-md p-4 group">
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-accent">{title}</span>
            {badge}
          </div>
          {children}
        </div>
        <div className="flex items-center gap-1 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity">
          <button
            onClick={onEdit}
            className="p-1.5 text-text-muted hover:text-accent transition-colors"
            title="Edit"
          >
            <Pencil size={14} />
          </button>
          {onRemove && (
            <button
              onClick={onRemove}
              className="p-1.5 text-text-muted hover:text-error transition-colors"
              title={removeTitle}
            >
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
