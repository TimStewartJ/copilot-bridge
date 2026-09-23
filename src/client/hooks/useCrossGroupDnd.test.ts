import { createElement } from "react";
import { closestCenter } from "@dnd-kit/core";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Task, TaskGroup } from "../api";
import { createReactDomHarness, type ReactDomHarness } from "../test-react-harness";
import useCrossGroupDnd, { TASK_GROUP_DROPPABLE, taskListCollisionDetection, type Section } from "./useCrossGroupDnd";

type Box = { top: number; height: number };
function rect({ top, height }: Box) {
  return { top, bottom: top + height, left: 0, right: 200, width: 200, height };
}

function collide(boxes: Record<string, Box & { group?: boolean }>, dragged: string, collisionTop: number, pointerY: number | null) {
  const droppableRects = new Map(Object.entries(boxes).map(([id, box]) => [id, rect(box)]));
  const droppableContainers = Object.entries(boxes).map(([id, box]) => ({
    id, key: id, disabled: false, node: { current: null }, rect: { current: rect(box) },
    data: { current: box.group ? { type: TASK_GROUP_DROPPABLE } : {} },
  }));
  return taskListCollisionDetection({
    active: { id: dragged, data: { current: {} }, rect: { current: { initial: null, translated: null } } },
    collisionRect: rect({ top: collisionTop, height: 40 }),
    droppableRects,
    droppableContainers,
    pointerCoordinates: pointerY === null ? null : { x: 100, y: pointerY },
  } as never).map((collision) => collision.id);
}

function task(id: string, groupId?: string): Task {
  return { id, title: id, kind: "task", muted: false, deferred: false, status: "active", notes: "", priority: 0, order: 0,
    createdAt: "", updatedAt: "", sessionIds: [], workItems: [], pullRequests: [], groupId };
}

const groupA: TaskGroup = { id: "a", name: "A", order: 0 } as TaskGroup;
const groupB: TaskGroup = { id: "b", name: "B", order: 1 } as TaskGroup;

describe("useCrossGroupDnd", () => {
  let harness: ReactDomHarness | null = null;
  afterEach(async () => {
    await harness?.cleanup();
    harness = null;
  });

  it("drops the cross-group preview and the active drag when a drag is cancelled", async () => {
    const tasks = [task("t1", "a"), task("t2", "b")];
    const sections: Section[] = [{ group: groupA, tasks: [tasks[0]] }, { group: groupB, tasks: [tasks[1]] }];
    const onReorderTasks = vi.fn();
    const onMoveAndReorder = vi.fn();
    const ref: { current: ReturnType<typeof useCrossGroupDnd> | null } = { current: null };
    function Probe() {
      ref.current = useCrossGroupDnd({ tasks, groupedSections: sections, hasGroups: true, onReorderTasks, onMoveAndReorder });
      return null;
    }
    harness = await createReactDomHarness();
    await harness.render(createElement(Probe));

    await harness.act(async () => ref.current!.handleDragStart({ active: { id: "t1" } } as never));
    await harness.act(async () => ref.current!.handleDragOver({ active: { id: "t1" }, over: { id: "t2" } } as never));
    expect(ref.current!.activeDragTask?.id).toBe("t1");
    expect(ref.current!.displaySections?.[1].tasks.map((t) => t.id)).toEqual(["t1", "t2"]);

    await harness.act(async () => ref.current!.handleDragCancel());
    expect(ref.current!.activeDragTask).toBeNull();
    expect(ref.current!.displaySections).toBe(sections);

    // A later drop with no movement must not replay the cancelled cross-group preview.
    await harness.act(async () => ref.current!.handleDragEnd({ active: { id: "t1" }, over: { id: "t1" } } as never));
    expect(onMoveAndReorder).not.toHaveBeenCalled();
    expect(onReorderTasks).not.toHaveBeenCalled();
  });
});

function closestCenterIds(boxes: Record<string, Box & { group?: boolean }>, collisionTop: number) {
  const droppableRects = new Map(Object.entries(boxes).map(([id, box]) => [id, rect(box)]));
  const droppableContainers = Object.keys(boxes).map((id) => ({ id, data: { current: {} } }));
  return closestCenter({ collisionRect: rect({ top: collisionTop, height: 40 }), droppableRects, droppableContainers } as never)
    .map((collision) => collision.id);
}

describe("taskListCollisionDetection", () => {
  // Group A (0-170, header on top) holds rows a1, a2, a3; group B (220-260) is collapsed and shows no rows.
  const boxes = {
    A: { top: 0, height: 170, group: true },
    a1: { top: 40, height: 40 }, a2: { top: 80, height: 40 }, a3: { top: 120, height: 40 },
    B: { top: 220, height: 40, group: true },
  };

  it("drops onto the nearest row, not the group box around it", () => {
    // a3 dragged up between a1 and a2: group A's centre (85) is nearer than either row's.
    expect(closestCenterIds(boxes, 62)[0]).toBe("A");
    expect(collide(boxes, "a3", 62, 82)[0]).toBe("a2");
    expect(collide(boxes, "a3", 42, 62)[0]).toBe("a1");
  });

  it("drops into a group that shows no rows when the pointer is over it", () => {
    expect(collide(boxes, "a3", 220, 240)[0]).toBe("B");
  });

  it("falls back to rows for keyboard moves, which carry no pointer", () => {
    expect(collide(boxes, "a3", 82, null)[0]).toBe("a2");
  });
});
