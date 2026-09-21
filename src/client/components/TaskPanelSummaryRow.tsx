import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { DS, cx } from "../design/tokens";

export interface TaskPanelSummaryChip {
  label: string;
  /** The state the chip names. Prefer this to `className`. */
  tone?: keyof typeof DS.badge.tone;
  className?: string;
}

interface TaskPanelSummaryRowProps {
  icon: ReactNode;
  label: string;
  title: string;
  subtitle?: string;
  chips?: TaskPanelSummaryChip[];
  onClick?: () => void;
  trailing?: ReactNode;
  titleClassName?: string;
  subtitleClassName?: string;
  expanded?: boolean;
}

/** One linked thing in the task panel: what kind it is, what it is called, and how it is doing. */
export default function TaskPanelSummaryRow({
  icon,
  label,
  title,
  subtitle,
  chips = [],
  onClick,
  trailing,
  titleClassName,
  subtitleClassName,
  expanded,
}: TaskPanelSummaryRowProps) {
  const chevron = (
    <ChevronRight
      size={12}
      aria-hidden="true"
      className={cx("mt-1", DS.row.chevron, expanded && DS.row.chevronOpen)}
    />
  );
  const content = (
    <>
      <div className="flex min-w-0 flex-1 items-start gap-2">
        <span className="mt-0.5 shrink-0 text-text-faint">{icon}</span>
        <div className="min-w-0 flex-1">
          <div className="text-xs text-text-muted">
            {label}
          </div>
          <div className={cx("mt-0.5 min-w-0 text-[13px] font-medium text-text-primary", titleClassName ?? "truncate")}>
            {title}
          </div>
          {subtitle && (
            <div className={cx("mt-0.5 min-w-0 text-xs text-text-muted", subtitleClassName ?? "truncate")}>
              {subtitle}
            </div>
          )}
          {chips.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {chips.map((chip) => (
                <span
                  key={`${label}-${chip.label}`}
                  className={cx(DS.badge.base, chip.className ?? DS.badge.tone[chip.tone ?? "neutral"])}
                >
                  {chip.label}
                </span>
              ))}
            </div>
          )}
        </div>
      </div>
      {onClick && !trailing && (
        chevron
      )}
    </>
  );

  return (
    <div className={cx(
      "hover-action-scope group -mx-1.5 flex items-stretch rounded-md transition-colors",
      Boolean(onClick || trailing) && "hover:bg-bg-hover/60",
    )}>
      {onClick ? (
        <button
          type="button"
          onClick={onClick}
          aria-expanded={expanded}
          className={cx("flex min-w-0 flex-1 items-start gap-2 rounded-md px-1.5 py-1.5 text-left", DS.focus)}
        >
          {content}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-start gap-2 px-1.5 py-1.5">
          {content}
        </div>
      )}
      {trailing && (
        <div className="flex shrink-0 items-start gap-0.5 pr-1.5 pt-1.5">
          {trailing}
          {onClick && (
            chevron
          )}
        </div>
      )}
    </div>
  );
}