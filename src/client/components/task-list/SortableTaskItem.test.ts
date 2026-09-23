import { createElement } from "react";
import { DndContext } from "@dnd-kit/core";
import { SortableContext } from "@dnd-kit/sortable";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../../api";
import type { TaskIndicator } from "../../hooks/useTaskIndicators";
import { createReactDomHarness, findAllByTag, getReactProps, type ReactDomHarness } from "../../test-react-harness";
import SortableTaskItem from "./SortableTaskItem";

const { rowPointerDown } = vi.hoisted(() => ({ rowPointerDown: vi.fn() }));

// Record what reaches dnd-kit's pointer activator instead of starting a drag in the DOM shim.
vi.mock("@dnd-kit/sortable", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@dnd-kit/sortable")>();
  return {
    ...actual,
    useSortable: (args: Parameters<typeof actual.useSortable>[0]) => {
      const sortable = actual.useSortable(args);
      if (!sortable.listeners?.onPointerDown) return sortable;
      return {
        ...sortable,
        listeners: { ...sortable.listeners, onPointerDown: (event: { pointerType: string }) => rowPointerDown(event.pointerType) },
      };
    },
  };
});

const task: Task = {
  id: "task-1", title: "Ship it", kind: "task", muted: false, deferred: false, status: "active",
  notes: "", priority: 0, order: 0, createdAt: "2026-09-01T00:00:00Z", updatedAt: "2026-09-01T00:00:00Z",
  sessionIds: [], workItems: [], pullRequests: [],
};

function indicator(overrides: Partial<TaskIndicator> = {}): TaskIndicator {
  return { busy: false, stalled: false, unread: false, busyCount: 0, unreadCount: 0, needsUserInputCount: 0,
    lastActivity: "2026-09-01T00:00:00Z", ...overrides };
}

function statusIcons(root: any): string[] {
  return findAllByTag(root, "SPAN")
    .map((span) => getReactProps(span)?.["data-status"])
    .filter((value): value is string => typeof value === "string");
}

function leadingIcon(root: any): any {
  const slot = findAllByTag(root, "SPAN").find((span) => getReactProps(span)?.["data-task-row-leading"] !== undefined);
  if (!slot) throw new Error("Leading slot not found");
  return findAllByTag(slot, "SPAN").find((span) => getReactProps(span)?.["data-status"]) ?? null;
}

describe("SortableTaskItem", () => {
  let harness: ReactDomHarness | null = null;

  afterEach(async () => {
    await harness?.cleanup();
    harness = null;
    rowPointerDown.mockReset();
  });

  async function renderRow(
    rowTask: Task,
    rowIndicator: TaskIndicator,
    variant: "rail" | "list" = "rail",
    extra: { rowDrag?: boolean; reordering?: boolean; onSelectTask?: (id: string) => void } = {},
  ) {
    harness ??= await createReactDomHarness();
    const row = createElement(SortableTaskItem, {
      task: rowTask,
      isActive: false,
      indicator: rowIndicator,
      isCtxTarget: false,
      isLongPressTarget: false,
      bindLongPress: (_id: string, onClick: () => void) => ({ onClick }) as never,
      onSelectTask: extra.onSelectTask ?? vi.fn(),
      variant,
      rowDrag: extra.rowDrag,
      reordering: extra.reordering,
    });
    await harness.render(createElement(DndContext, null, createElement(SortableContext, { items: [rowTask.id], children: row })));
    return harness.dom.container;
  }

  describe("leading attention mark", () => {
    it("draws an open question in the leading slot, without an Answer badge", async () => {
      for (const variant of ["rail", "list"] as const) {
        const root = await renderRow(task, indicator({ needsUserInputCount: 1, unreadCount: 1 }), variant);
        const leading = leadingIcon(root);
        expect(getReactProps(leading)?.["data-status"]).toBe("needs-input");
        expect(getReactProps(leading)?.["aria-label"]).toBe("Answer needed");
        expect(statusIcons(root)).not.toContain("unread");
        expect(root.textContent).not.toContain("Answer");
      }
    });

    it("keeps the unread dot when nothing is waiting on an answer", async () => {
      const root = await renderRow(task, indicator({ unreadCount: 1, unread: true }));
      expect(getReactProps(leadingIcon(root))?.["data-status"]).toBe("unread");
      expect(statusIcons(root)).toEqual(["unread"]);
    });

    it("gives the leading slot to an open question over a working agent", async () => {
      const root = await renderRow(task, indicator({ needsUserInputCount: 2, busy: true, busyCount: 1 }));
      expect(statusIcons(root)).toEqual(["needs-input"]);
      expect(root.textContent).not.toContain("answers");
      expect(root.textContent).not.toContain("working");
    });

    it("draws a working agent in the leading slot, without a working badge, in both variants", async () => {
      for (const variant of ["rail", "list"] as const) {
        const root = await renderRow(task, indicator({ busy: true, busyCount: 2, unreadCount: 1, unread: true }), variant);
        const leading = leadingIcon(root);
        expect(getReactProps(leading)?.["data-status"]).toBe("working");
        expect(getReactProps(leading)?.["aria-label"]).toBe("2 sessions working");
        expect(statusIcons(root)).toEqual(["working"]);
        expect(root.textContent).not.toContain("working");
      }
    });

    it("keeps Stalled as a badge and draws no spinner for it", async () => {
      const root = await renderRow(task, indicator({ busy: true, busyCount: 1, stalled: true }));
      expect(statusIcons(root)).toEqual(["warning"]);
      expect(root.textContent).toContain("Stalled");
    });

    it("shows no question mark for a muted task", async () => {
      const root = await renderRow({ ...task, muted: true }, indicator({ needsUserInputCount: 1 }));
      expect(statusIcons(root)).not.toContain("needs-input");
    });
  });

  describe("momentum", () => {
    it("keeps the next step and wait out of the row in both variants", async () => {
      for (const variant of ["rail", "list"] as const) {
        const root = await renderRow({ ...task, nextAction: "Call the landlord", waitingOn: "Lease draft" }, indicator(), variant);
        expect(root.textContent).toContain("Ship it");
        expect(root.textContent).not.toContain("Call the landlord");
        expect(root.textContent).not.toContain("Lease draft");
        expect(root.textContent).not.toContain("Next step");
      }
    });
  });

  describe("reordering", () => {
    it("has no drag handle, and the row is the only control, outside reorder mode", async () => {
      for (const variant of ["rail", "list"] as const) {
        const root = await renderRow(task, indicator(), variant, { rowDrag: variant === "rail" });
        const buttons = findAllByTag(root, "BUTTON");
        expect(buttons).toHaveLength(1);
        expect(getReactProps(buttons[0])?.["data-task-reorder-handle"]).toBeUndefined();
      }
    });

    it("drags the whole rail row with a mouse or pen, never with touch", async () => {
      const root = await renderRow(task, indicator(), "rail", { rowDrag: true });
      const row = findAllByTag(root, "BUTTON")[0];
      getReactProps(row)?.onPointerDown?.({ pointerType: "touch" });
      expect(rowPointerDown).not.toHaveBeenCalled();
      getReactProps(row)?.onPointerDown?.({ pointerType: "mouse" });
      getReactProps(row)?.onPointerDown?.({ pointerType: "pen" });
      expect(rowPointerDown.mock.calls).toEqual([["mouse"], ["pen"]]);
    });

    it("gives the mobile row no drag listener outside reorder mode", async () => {
      const root = await renderRow(task, indicator(), "list");
      expect(getReactProps(findAllByTag(root, "BUTTON")[0])?.onPointerDown).toBeUndefined();
    });

    it("shows a labelled handle beside the row, not inside it, and stops the row opening the task", async () => {
      for (const variant of ["rail", "list"] as const) {
        const onSelectTask = vi.fn();
        const root = await renderRow(task, indicator({ busy: true, busyCount: 1 }), variant, { rowDrag: variant === "rail", reordering: true, onSelectTask });
        const buttons = findAllByTag(root, "BUTTON");
        expect(buttons).toHaveLength(1);
        const handle = buttons[0];
        expect(getReactProps(handle)?.["data-task-reorder-handle"]).toBe("task-1");
        expect(getReactProps(handle)?.["aria-label"]).toBe("Reorder Ship it");
        expect(getReactProps(handle)?.className).toContain("touch-none");
        expect(typeof getReactProps(handle)?.onKeyDown).toBe("function");
        expect(statusIcons(root)).toEqual(["working"]);
        expect(onSelectTask).not.toHaveBeenCalled();
      }
    });
  });
});
