import { DragOverlay } from "@dnd-kit/core";
import { timeAgo } from "../../time";
import type { Task } from "../../api";

export default function TaskDragOverlay({ task }: { task: Task | null }) {
  return (
    <DragOverlay dropAnimation={null}>
      {task ? (
        <div className="bg-bg-secondary rounded-md shadow-lg border border-border px-3 py-2 text-sm w-48 opacity-90">
          <div className="font-medium truncate">{task.title}</div>
          <div className="text-xs text-text-muted mt-0.5">{timeAgo(task.updatedAt)}</div>
        </div>
      ) : null}
    </DragOverlay>
  );
}
