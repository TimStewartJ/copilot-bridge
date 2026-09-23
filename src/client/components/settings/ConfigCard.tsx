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

/** A configured object in a settings list: its name and state on one line, a short detail beneath. */
export function ConfigCard({
  title,
  badge,
  onEdit,
  onRemove,
  removeTitle = "Remove",
  children,
}: ConfigCardProps) {
  return (
    <div className="min-w-0 py-3 first:pt-0 last:pb-0">
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className={cx(DS.setting.label, "break-words")}>{title}</span>
            {badge}
          </div>
          {children}
        </div>
        <div className="flex shrink-0 items-center gap-1">
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
