import type { Task, TaskGroup } from "../api";

const STATUS_ORDER: Record<Task["status"], number> = {
  active: 0,
  done: 1,
  archived: 2,
};

/** Sort tasks by status priority then by order, with pinned tasks floating to top within each status tier. */
export function sortTasksByStatusAndOrder(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const statusDiff = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (statusDiff !== 0) return statusDiff;
    // Pinned tasks float to top within their status group
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return a.order - b.order;
  });
}

/** Split tasks into non-archived (sorted) and archived (by order). */
export function splitArchivedTasks(tasks: Task[]): { nonArchived: Task[]; archived: Task[] } {
  const sorted = sortTasksByStatusAndOrder(tasks);
  return {
    nonArchived: sorted.filter((t) => t.status !== "archived"),
    archived: sorted.filter((t) => t.status === "archived"),
  };
}

/** Group tasks by status category. */
export function groupTasksByStatus(tasks: Task[]): {
  active: Task[];
  done: Task[];
  archived: Task[];
} {
  const sorted = sortTasksByStatusAndOrder(tasks);
  return {
    active: sorted.filter((t) => t.status === "active"),
    done: sorted.filter((t) => t.status === "done"),
    archived: sorted.filter((t) => t.status === "archived"),
  };
}

export interface GroupSection {
  group: TaskGroup | null;
  tasks: Task[];
}

/** Sort tasks within a group: pinned first (preserving order), then by status and order. */
function sortGroupTasks(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    // Pinned tasks always float to top of their group
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const statusDiff = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (statusDiff !== 0) return statusDiff;
    return a.order - b.order;
  });
}

/** Build sections from task groups, with an ungrouped section at the end. */
export function buildGroupSections(tasks: Task[], taskGroups: TaskGroup[]): GroupSection[] {
  const sections: GroupSection[] = [];
  for (const group of taskGroups) {
    sections.push({
      group,
      tasks: sortGroupTasks(tasks.filter((t) => t.groupId === group.id)),
    });
  }
  const ungrouped = tasks.filter((t) => !t.groupId || !taskGroups.some((g) => g.id === t.groupId));
  if (ungrouped.length > 0) {
    sections.push({ group: null, tasks: sortGroupTasks(ungrouped) });
  }
  return sections;
}
