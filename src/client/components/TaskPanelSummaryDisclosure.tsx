import { useState, type ReactNode } from "react";
import {
  getTaskPanelDisclosureExpanded,
  setTaskPanelDisclosureExpanded,
  type TaskPanelDisclosureId,
} from "../task-panel-disclosure-state";
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
  /** Task and section identity used to persist expansion state. */
  taskId?: string;
  disclosureId?: TaskPanelDisclosureId;
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
 * - Task disclosures restore their last expanded state from browser storage.
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
  taskId,
  disclosureId,
  onOpenSingle,
  expandWhenSingle,
  children,
}: TaskPanelSummaryDisclosureProps) {
  const persistenceKey = taskId && disclosureId ? `${taskId}:${disclosureId}` : null;
  const [expansionState, setExpansionState] = useState(() => ({
    persistenceKey,
    expanded: taskId && disclosureId
      ? getTaskPanelDisclosureExpanded(taskId, disclosureId)
      : false,
  }));
  const expanded = expansionState.persistenceKey === persistenceKey
    ? expansionState.expanded
    : taskId && disclosureId
      ? getTaskPanelDisclosureExpanded(taskId, disclosureId)
      : false;
  const hasMultiple = itemCount > 1;
  const canExpand = hasMultiple || (expandWhenSingle === true && !onOpenSingle);

  const handleClick = canExpand
    ? () => {
        const nextExpanded = !expanded;
        if (taskId && disclosureId) {
          setTaskPanelDisclosureExpanded(taskId, disclosureId, nextExpanded);
        }
        setExpansionState({ persistenceKey, expanded: nextExpanded });
      }
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
