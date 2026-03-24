import { useState, useRef, useCallback } from "react";
import {
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
  type DragOverEvent,
} from "@dnd-kit/core";
import type { Task, TaskGroup } from "../api";

export type Section = { group: TaskGroup | null; tasks: Task[] };

interface UseCrossGroupDndOptions {
  tasks: Task[];
  groupedSections: Section[] | null;
  hasGroups: boolean;
  onReorderTasks?: (taskIds: string[]) => void;
  onMoveTaskToGroup?: (taskId: string, groupId: string | undefined) => void;
  onMoveAndReorder?: (taskId: string, groupId: string | undefined, taskIds: string[]) => void;
}

export default function useCrossGroupDnd({
  tasks,
  groupedSections,
  hasGroups,
  onReorderTasks,
  onMoveTaskToGroup,
  onMoveAndReorder,
}: UseCrossGroupDndOptions) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor),
  );

  const [activeId, setActiveId] = useState<string | null>(null);
  const [localSections, setLocalSections] = useState<Section[] | null>(null);
  const localSectionsRef = useRef<Section[] | null>(null);
  const activeDragTask = activeId ? tasks.find((t) => t.id === activeId) : null;
  const displaySections = localSections ?? groupedSections;

  const handleDragStart = useCallback((event: DragStartEvent) => {
    setActiveId(event.active.id as string);
    if (groupedSections) {
      const sections = groupedSections.map((s) => ({ ...s, tasks: [...s.tasks] }));
      setLocalSections(sections);
      localSectionsRef.current = sections;
    }
  }, [groupedSections]);

  const handleDragOver = useCallback((event: DragOverEvent) => {
    const { active, over } = event;
    if (!over) return;

    const dragId = active.id as string;

    setLocalSections((prev) => {
      if (!prev) return prev;

      const fromSection = prev.find((s) => s.tasks.some((t) => t.id === dragId));
      if (!fromSection) return prev;

      let toSection: Section | undefined;
      let overIndex: number;

      const overIsTask = prev.some((s) => s.tasks.some((t) => t.id === over.id));
      if (overIsTask) {
        toSection = prev.find((s) => s.tasks.some((t) => t.id === over.id));
        overIndex = toSection ? toSection.tasks.findIndex((t) => t.id === over.id) : 0;
      } else {
        toSection = prev.find((s) => (s.group?.id ?? "__ungrouped__") === over.id);
        overIndex = toSection ? toSection.tasks.length : 0;
      }

      if (!toSection || fromSection === toSection) return prev;

      const draggedTask = fromSection.tasks.find((t) => t.id === dragId);
      if (!draggedTask) return prev;

      const result = prev.map((s) => {
        if (s.group?.id === fromSection.group?.id && s.group?.id !== toSection!.group?.id) {
          return { ...s, tasks: s.tasks.filter((t) => t.id !== dragId) };
        }
        if (s.group?.id === toSection!.group?.id && s.group?.id !== fromSection.group?.id) {
          const newTasks = [...s.tasks.filter((t) => t.id !== dragId)];
          newTasks.splice(overIndex, 0, draggedTask);
          return { ...s, tasks: newTasks };
        }
        if (!s.group && !fromSection.group && toSection!.group) {
          return { ...s, tasks: s.tasks.filter((t) => t.id !== dragId) };
        }
        if (!s.group && !toSection!.group && fromSection.group) {
          const newTasks = [...s.tasks.filter((t) => t.id !== dragId)];
          newTasks.splice(overIndex, 0, draggedTask);
          return { ...s, tasks: newTasks };
        }
        return s;
      });
      localSectionsRef.current = result;
      return result;
    });
  }, []);

  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event;
    const finalSections = localSectionsRef.current;
    setActiveId(null);
    setLocalSections(null);
    localSectionsRef.current = null;

    if (!over || !onReorderTasks) return;

    const activeTask = tasks.find((t) => t.id === active.id);
    if (!activeTask) return;

    // Determine target group from preview state (most reliable)
    let targetGroupId: string | undefined = activeTask.groupId;
    let previewOrder: string[] | null = null;

    if (hasGroups && finalSections) {
      const targetSection = finalSections.find((s) => s.tasks.some((t) => t.id === active.id));
      if (targetSection) {
        targetGroupId = targetSection.group?.id;
        previewOrder = targetSection.tasks.map((t) => t.id);
      }
    }

    // Cross-group move detected from preview state
    if (hasGroups && targetGroupId !== activeTask.groupId && previewOrder) {
      if (onMoveAndReorder) {
        onMoveAndReorder(activeTask.id, targetGroupId, previewOrder);
      } else if (onMoveTaskToGroup) {
        onMoveTaskToGroup(activeTask.id, targetGroupId);
        onReorderTasks(previewOrder);
      }
      return;
    }

    // Same-id drop with no group change — nothing to do
    if (active.id === over.id) return;

    // Check if dropped on a group container (not a task)
    const overTask = tasks.find((t) => t.id === over.id);
    if (!overTask && hasGroups && onMoveTaskToGroup) {
      const containerGroupId = over.id === "__ungrouped__" ? undefined : over.id as string;
      if (containerGroupId !== activeTask.groupId) {
        onMoveTaskToGroup(activeTask.id, containerGroupId);
      }
      return;
    }

    if (!overTask) return;

    // Cross-group via over element (fallback when preview didn't detect it)
    if (hasGroups && activeTask.groupId !== overTask.groupId) {
      const targetGroupTasks = tasks.filter(
        (t) => t.groupId === overTask.groupId && t.id !== activeTask.id,
      );
      const overIndex = targetGroupTasks.findIndex((t) => t.id === over.id);
      targetGroupTasks.splice(overIndex >= 0 ? overIndex : targetGroupTasks.length, 0, activeTask);
      const newOrder = targetGroupTasks.map((t) => t.id);
      if (onMoveAndReorder) {
        onMoveAndReorder(activeTask.id, overTask.groupId, newOrder);
      } else if (onMoveTaskToGroup) {
        onMoveTaskToGroup(activeTask.id, overTask.groupId);
        onReorderTasks(newOrder);
      }
      return;
    }

    // Same-group reorder
    if (activeTask.status !== overTask.status) return;
    const group = tasks.filter(
      (t) => t.status === activeTask.status && t.groupId === activeTask.groupId,
    );
    const oldIndex = group.findIndex((t) => t.id === active.id);
    const newIndex = group.findIndex((t) => t.id === over.id);
    if (oldIndex === -1 || newIndex === -1) return;
    const reordered = [...group];
    const [moved] = reordered.splice(oldIndex, 1);
    reordered.splice(newIndex, 0, moved);
    onReorderTasks(reordered.map((t) => t.id));
  }, [tasks, onReorderTasks, hasGroups, onMoveTaskToGroup, onMoveAndReorder]);

  return {
    sensors,
    activeId,
    activeDragTask,
    displaySections,
    handleDragStart,
    handleDragOver,
    handleDragEnd,
  };
}
