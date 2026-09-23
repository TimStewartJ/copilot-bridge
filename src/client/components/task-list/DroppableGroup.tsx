import { useDroppable } from "@dnd-kit/core";
import { TASK_GROUP_DROPPABLE } from "../../hooks/useCrossGroupDnd";

export default function DroppableGroup({ id, children }: { id: string; children: React.ReactNode }) {
  const { setNodeRef } = useDroppable({ id, data: { type: TASK_GROUP_DROPPABLE } });
  return <div ref={setNodeRef}>{children}</div>;
}
