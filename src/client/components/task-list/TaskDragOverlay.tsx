import { DragOverlay } from "@dnd-kit/core";
import { timeAgo } from "../../time";
import type { Task } from "../../api";
import { DS } from "../../design/tokens";

export default function TaskDragOverlay({ task, lastActivity }: { task: Task | null; lastActivity?: string }) {
  return (
    <DragOverlay dropAnimation={null}>
      {task ? (
        <div className={`${DS.surface.floating} w-48 px-3 py-2 text-sm opacity-90`}>
          <div className="font-medium truncate">{task.title}</div>
          <div className="text-xs text-text-muted mt-0.5">{timeAgo(lastActivity ?? task.updatedAt)}</div>
        </div>
      ) : null}
    </DragOverlay>
  );
}
