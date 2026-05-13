import type { DashboardChecklistItem } from "../api";
import type { HomeChecklistIndicatorState } from "../checklist-helpers";

export type ChecklistSort = "deadline" | "task";

export interface ChecklistGroup {
  key: string;
  taskId: string | null;
  taskTitle: string | null;
  taskGroupColor: string | null;
  checklistItems: DashboardChecklistItem[];
}

export const SORT_LABELS: Record<ChecklistSort, string> = {
  deadline: "Deadline",
  task: "By task",
};

const TASK_STATUS_ORDER: Record<string, number> = { active: 0, done: 1, archived: 2 };

export function dashboardChecklistCountClass(state: HomeChecklistIndicatorState): string {
  switch (state) {
    case "overdue":
      return "border-error/30 bg-error/10 text-error";
    case "due-today":
      return "border-warning/30 bg-warning/10 text-warning";
    default:
      return "border-border bg-bg-hover text-text-faint";
  }
}

function deadlineSortKey(deadline: string | undefined): number {
  if (!deadline) return Infinity;
  return new Date(deadline + "T00:00:00").getTime();
}

export function sortChecklistItems(
  checklistItems: DashboardChecklistItem[],
  sort: ChecklistSort,
): DashboardChecklistItem[] {
  const copy = [...checklistItems];
  switch (sort) {
    case "deadline":
      return copy.sort((a, b) => deadlineSortKey(a.deadline) - deadlineSortKey(b.deadline) || b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
    case "task":
      return copy.sort((a, b) => {
        if (!a.taskId && b.taskId) return -1;
        if (a.taskId && !b.taskId) return 1;
        const titleCmp = (a.taskTitle ?? "").localeCompare(b.taskTitle ?? "");
        if (titleCmp !== 0) return titleCmp;
        return a.order - b.order;
      });
    default:
      return copy;
  }
}

export function groupChecklistItemsByTask(checklistItems: DashboardChecklistItem[]): ChecklistGroup[] {
  const globalChecklistItems: DashboardChecklistItem[] = [];
  const taskMap = new Map<string, {
    checklistItems: DashboardChecklistItem[];
    taskTitle: string | null;
    taskGroupColor: string | null;
    taskGroupOrder: number | null;
    taskStatusOrder: number;
    taskOrder: number;
  }>();

  for (const checklistItem of checklistItems) {
    if (!checklistItem.taskId) {
      globalChecklistItems.push(checklistItem);
      continue;
    }

    let entry = taskMap.get(checklistItem.taskId);
    if (!entry) {
      entry = {
        checklistItems: [],
        taskTitle: checklistItem.taskTitle,
        taskGroupColor: checklistItem.taskGroupColor,
        taskGroupOrder: checklistItem.taskGroupOrder,
        taskStatusOrder: TASK_STATUS_ORDER[checklistItem.taskStatus ?? "active"] ?? 0,
        taskOrder: checklistItem.taskOrder,
      };
      taskMap.set(checklistItem.taskId, entry);
    }
    entry.checklistItems.push(checklistItem);
  }

  for (const entry of taskMap.values()) {
    entry.checklistItems.sort((a, b) => a.order - b.order);
  }
  globalChecklistItems.sort((a, b) => a.order - b.order);

  const taskEntries = [...taskMap.entries()].sort(([, a], [, b]) => {
    const aGrouped = a.taskGroupOrder != null ? 0 : 1;
    const bGrouped = b.taskGroupOrder != null ? 0 : 1;
    if (aGrouped !== bGrouped) return aGrouped - bGrouped;
    if (a.taskGroupOrder != null && b.taskGroupOrder != null && a.taskGroupOrder !== b.taskGroupOrder) {
      return a.taskGroupOrder - b.taskGroupOrder;
    }
    if (a.taskStatusOrder !== b.taskStatusOrder) return a.taskStatusOrder - b.taskStatusOrder;
    return a.taskOrder - b.taskOrder;
  });

  const groups: ChecklistGroup[] = [];
  if (globalChecklistItems.length > 0) {
    groups.push({
      key: "__global__",
      taskId: null,
      taskTitle: null,
      taskGroupColor: null,
      checklistItems: globalChecklistItems,
    });
  }
  for (const [taskId, entry] of taskEntries) {
    groups.push({
      key: taskId,
      taskId,
      taskTitle: entry.taskTitle,
      taskGroupColor: entry.taskGroupColor,
      checklistItems: entry.checklistItems,
    });
  }
  return groups;
}
