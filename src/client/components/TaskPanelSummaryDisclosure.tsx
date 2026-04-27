import { useEffect, useState, type ReactNode } from "react";
import TaskPanelSummaryRow, { type TaskPanelSummaryChip } from "./TaskPanelSummaryRow";

export interface TaskPanelSummaryDisclosureProps {
  // Row display props
  label: string;
  icon: ReactNode;
  title: string;
  subtitle?: string;
  chips?: TaskPanelSummaryChip[];
  trailing?: ReactNode;
  titleClassName?: string;
  subtitleClassName?: string;

  // Disclosure control
  /** Total number of items represented by this row. */
  itemCount: number;
  /** Resets expanded state when this value changes (e.g. active task ID). */
  resetKey?: string;
  /**
   * Called when itemCount === 1 and the row is clicked.
   * Omit to make the row non-clickable for single items (e.g. missing provider URLs).
   */
  onOpenSingle?: () => void;
  /**
   * When true, a single item with no `onOpenSingle` toggles inline expansion
   * instead of being a dead non-interactive row.
   */
  expandWhenSingle?: boolean;
  /** Content rendered inside the expanded disclosure panel. */
  children: ReactNode;
}

/**
 * Shared disclosure row for task-panel summary sections.
 *
 * - Multiple items: clicking the row toggles inline expansion.
 * - Single item with `onOpenSingle`: clicking the row fires the action.
 * - Single item without `onOpenSingle` and `expandWhenSingle`: row is non-interactive.
 * - Single item without `onOpenSingle` but with `expandWhenSingle`: row toggles expansion.
 * - `resetKey` change collapses any open disclosure.
 */
export default function TaskPanelSummaryDisclosure({
  label,
  icon,
  title,
  subtitle,
  chips,
  trailing,
  titleClassName,
  subtitleClassName,
  itemCount,
  resetKey,
  onOpenSingle,
  expandWhenSingle,
  children,
}: TaskPanelSummaryDisclosureProps) {
  const [expanded, setExpanded] = useState(false);
  const hasMultiple = itemCount > 1;
  const canExpand = hasMultiple || (expandWhenSingle === true && !onOpenSingle);

  useEffect(() => {
    setExpanded(false);
  }, [resetKey]);

  const handleClick = canExpand
    ? () => setExpanded((prev) => !prev)
    : onOpenSingle;

  return (
    <div className="space-y-1">
      <TaskPanelSummaryRow
        label={label}
        icon={icon}
        title={title}
        subtitle={subtitle}
        chips={chips}
        trailing={trailing}
        titleClassName={titleClassName}
        subtitleClassName={subtitleClassName}
        expanded={canExpand && expanded}
        onClick={handleClick}
      />
      {canExpand && expanded && (
        <div className="space-y-0.5 rounded-md bg-bg-surface px-1.5 py-1">
          {children}
        </div>
      )}
    </div>
  );
}
