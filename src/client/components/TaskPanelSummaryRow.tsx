import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";

export interface TaskPanelSummaryChip {
  label: string;
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
  expanded = false,
}: TaskPanelSummaryRowProps) {
  const chevron = (
    <ChevronRight
      size={12}
      className={`mt-1 shrink-0 text-text-faint transition-transform ${expanded ? "rotate-90" : ""}`}
    />
  );
  const content = (
    <>
      <div className="flex min-w-0 flex-1 items-start gap-2">
        <span className="mt-0.5 shrink-0 text-text-faint">{icon}</span>
        <div className="min-w-0 flex-1">
          <div className="text-[10px] font-semibold uppercase tracking-wide text-text-faint">
            {label}
          </div>
          <div className={`min-w-0 text-xs font-medium text-text-primary ${titleClassName ?? "truncate"}`}>
            {title}
          </div>
          {subtitle && (
            <div className={`mt-0.5 min-w-0 text-[11px] text-text-muted ${subtitleClassName ?? "truncate"}`}>
              {subtitle}
            </div>
          )}
          {chips.length > 0 && (
            <div className="mt-1 flex flex-wrap gap-1">
              {chips.map((chip) => (
                <span
                  key={`${label}-${chip.label}`}
                  className={`rounded-full px-1.5 py-0.5 text-[10px] ${chip.className ?? "bg-text-muted/15 text-text-muted"}`}
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
    <div className={`group flex items-stretch rounded-md bg-bg-surface transition-colors ${onClick || trailing ? "hover:bg-bg-hover" : ""}`}>
      {onClick ? (
        <button
          onClick={onClick}
          className="flex min-w-0 flex-1 items-start gap-2 px-2.5 py-2 text-left"
        >
          {content}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-start gap-2 px-2.5 py-2">
          {content}
        </div>
      )}
      {trailing && (
        <div className="flex shrink-0 items-start gap-0.5 pr-2 pt-2">
          {trailing}
          {onClick && (
            chevron
          )}
        </div>
      )}
    </div>
  );
}
