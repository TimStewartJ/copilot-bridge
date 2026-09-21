import { Pencil, Trash2 } from "lucide-react";
import { IconButton } from "../../design/primitives";
import { DS, cx } from "../../design/tokens";

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
    <div className={DS.layout.objectRow}>
      <div className="flex items-start justify-between">
        <div className="flex-1 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cx(DS.text.sectionTitle, "break-words")}>{title}</span>
            {badge}
          </div>
          {children}
        </div>
        <div className="ml-2 flex shrink-0 items-center gap-1">
          <IconButton onClick={onEdit} label={`Edit ${title}`} title="Edit">
            <Pencil size={14} />
          </IconButton>
          {onRemove && (
            <IconButton onClick={onRemove} label={removeTitle} variant="danger">
              <Trash2 size={14} />
            </IconButton>
          )}
        </div>
      </div>
    </div>
  );
}
