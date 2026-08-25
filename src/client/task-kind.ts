import type { Task } from "./api";

export function isOngoingTask(task: Pick<Task, "kind">): boolean {
  return task.kind === "ongoing";
}

export function getTaskKindLabel(kind: Task["kind"]): string {
  return kind === "ongoing" ? "Ongoing" : "Task";
}

/** Field updates to send when a task's kind changes; ongoing tasks cannot keep a definition of done. */
export function getTaskKindUpdate(
  task: Pick<Task, "kind">,
  nextKind: Task["kind"],
): { kind: Task["kind"]; doneWhen?: null } | null {
  if (task.kind === nextKind) return null;

  if (nextKind === "ongoing") {
    return {
      kind: nextKind,
      doneWhen: null,
    };
  }

  return { kind: nextKind };
}
