import type { Task } from "./api";

export function isOngoingTask(task: Pick<Task, "kind">): boolean {
  return task.kind === "ongoing";
}

export function getTaskKindLabel(kind: Task["kind"]): string {
  return kind === "ongoing" ? "Ongoing" : "Task";
}

export function getTaskKindUpdate(
  task: Pick<Task, "kind" | "status" | "doneWhen">,
  nextKind: Task["kind"],
): Partial<Pick<Task, "kind" | "status" | "doneWhen">> | null {
  if (task.kind === nextKind) return null;

  if (nextKind === "ongoing") {
    return {
      kind: nextKind,
      doneWhen: null,
      ...(task.status === "done" ? { status: "active" as const } : {}),
    };
  }

  return { kind: nextKind };
}
