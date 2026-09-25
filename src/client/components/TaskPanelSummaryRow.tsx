import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { DS, cx } from "../design/tokens";

export interface TaskPanelSummaryChip {
  label: string;
  /** The state the figure names. Only warning and danger colour it; ordinary states stay quiet. */
  tone?: keyof typeof DS.tone;
}

interface TaskPanelSummaryRowProps {
  icon: ReactNode;
  label: string;
  title: string;
  /** Detail that does not fit the line; it is kept in the tooltip. */
  subtitle?: string;
  chips?: TaskPanelSummaryChip[];
  onClick?: () => void;
  /** A control beside the row, such as an add button. */
  trailing?: ReactNode;
  titleClassName?: string;
  expanded?: boolean;
}

/**
 * One linked thing in the task panel on one line: what kind it is, what it is called, and a figure
 * for how it is doing. It opens for the rest.
 */
export default function TaskPanelSummaryRow({
  icon,
  label,
  title,
  subtitle,
  chips = [],
  onClick,
  trailing,
  titleClassName,
  expanded,
}: TaskPanelSummaryRowProps) {
  const meta = chips.length > 0 ? (
    <span className="flex min-w-0 items-center gap-1 truncate">
      {chips.map((chip, index) => (
        <span
          key={`${label}-${chip.label}`}
          className={cx("truncate", chip.tone === "warning" || chip.tone === "danger" ? DS.tone[chip.tone] : undefined)}
        >
          {index > 0 && "· "}
          {chip.label}
        </span>
      ))}
    </span>
  ) : null;
  const tooltip = [label, title, subtitle, ...chips.map((chip) => chip.label)].filter(Boolean).join(" · ");
  const content = (
    <>
      <span className={cx(DS.row.iconSlot, "text-text-faint")}>{icon}</span>
      {/* A narrow desktop panel drops the label column for the title; the icon and tooltip still say it. A phone is wide enough to keep it. */}
      <span className="sr-only shrink-0 @[18rem]/task-details:not-sr-only">
        <span className="block w-[5.25rem] truncate text-xs text-text-muted">{label}</span>
      </span>
      <span className={cx("min-w-0 flex-1 truncate text-[13px] text-text-primary", titleClassName)}>
        {title}
      </span>
      {(meta || onClick) && (
        <span className="ml-auto flex min-w-0 max-w-[45%] items-center gap-2 pl-2 text-[11px] tabular-nums text-text-faint">
          {meta}
          {onClick && (
            <ChevronRight
              size={12}
              aria-hidden="true"
              className={cx(DS.row.chevron, expanded && DS.row.chevronOpen)}
            />
          )}
        </span>
      )}
    </>
  );

  const rowClass = cx(
    "flex min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 py-1 text-left text-[13px] transition-colors",
    trailing ? "-ml-1.5" : "-mx-1.5",
    DS.row.touch,
  );

  return (
    <div className="flex min-w-0 items-center gap-1">
      {onClick ? (
        <button
          type="button"
          onClick={onClick}
          aria-expanded={expanded}
          title={tooltip}
          className={cx(rowClass, DS.row.interactive, DS.focus)}
        >
          {content}
        </button>
      ) : (
        <div className={rowClass} title={tooltip}>
          {content}
        </div>
      )}
      {trailing}
    </div>
  );
}
