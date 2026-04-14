import type { Task, TaskGroup } from "../api";

const STATUS_ORDER: Record<Task["status"], number> = {
  active: 0,
  paused: 1,
  done: 2,
  archived: 3,
};

/** Sort tasks by status priority then by order. */
export function sortTasksByStatusAndOrder(tasks: Task[]): Task[] {
  return [...tasks].sort((a, b) => {
    const statusDiff = STATUS_ORDER[a.status] - STATUS_ORDER[b.status];
    if (statusDiff !== 0) return statusDiff;
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
export function groupTasksByStatus(tasks: Task[]): Record<Task["status"], Task[]> {
  const sorted = sortTasksByStatusAndOrder(tasks);
  return {
    active: sorted.filter((t) => t.status === "active"),
    paused: sorted.filter((t) => t.status === "paused"),
    done: sorted.filter((t) => t.status === "done"),
    archived: sorted.filter((t) => t.status === "archived"),
  };
}

export interface GroupSection {
  group: TaskGroup | null;
  tasks: Task[];
}

/** Build sections from task groups, with an ungrouped section at the end. */
export function buildGroupSections(tasks: Task[], taskGroups: TaskGroup[]): GroupSection[] {
  const sections: GroupSection[] = [];
  for (const group of taskGroups) {
    sections.push({
      group,
      tasks: tasks.filter((t) => t.groupId === group.id),
    });
  }
  const ungrouped = tasks.filter((t) => !t.groupId || !taskGroups.some((g) => g.id === t.groupId));
  if (ungrouped.length > 0) {
    sections.push({ group: null, tasks: ungrouped });
  }
  return sections;
}
