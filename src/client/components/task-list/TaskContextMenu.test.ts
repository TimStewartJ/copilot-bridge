import { createElement, type ComponentProps } from "react";
import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Session, Task } from "../../api";
import { queryKeys } from "../../queryClient";
import {
  advanceTimersByTimeAct,
  createReactDomHarness,
  findAllByTag,
  getReactProps,
  waitUntilAct,
} from "../../test-react-harness";
import TaskContextMenu from "./TaskContextMenu";
import { installDialogDom } from "../../test-dialog-harness";

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Clipboard task",
    kind: "task",
    muted: false,
    deferred: false,
    status: "active",
    cwd: "/repo",
    notes: "",
    priority: 0,
    order: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    sessionIds: [],
    workItems: [],
    pullRequests: [],
    tags: [],
    ...overrides,
  };
}

function findButtonByText(root: any, text: string): any {
  const button = findAllByTag(root, "BUTTON").find((candidate) => (candidate.textContent ?? "").includes(text));
  if (!button) throw new Error(`Button not found with text: ${text}`);
  return button;
}

function hasButtonWithText(root: any, text: string): boolean {
  return findAllByTag(root, "BUTTON").some((candidate) => (candidate.textContent ?? "").includes(text));
}

function clickButton(button: any) {
  getReactProps(button)?.onClick?.({
    currentTarget: button,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
  });
}

function setClipboard(clipboard: unknown) {
  (globalThis.navigator as unknown as { clipboard?: unknown }).clipboard = clipboard;
}

function stubWindowConfirm(confirm: (message?: string) => boolean) {
  const descriptor = Object.getOwnPropertyDescriptor(window, "confirm");
  Object.defineProperty(window, "confirm", { configurable: true, writable: true, value: confirm });
  return () => {
    if (descriptor) Object.defineProperty(window, "confirm", descriptor);
    else Reflect.deleteProperty(window, "confirm");
  };
}

async function renderTaskContextMenu(
  onClose: () => void,
  actions: ComponentProps<typeof TaskContextMenu>["actions"] = {},
  task: Task = createTask(),
) {
  const harness = await createReactDomHarness({ installDom: installDialogDom });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnMount: false } },
  });
  queryClient.setQueryData(queryKeys.taskChecklistItems("task-1"), []);

  await harness.render(createElement(
    QueryClientProvider,
    { client: queryClient },
    createElement(TaskContextMenu, {
      task,
      position: { x: 10, y: 10 },
      taskGroups: [],
      sessionMap: new Map<string, Session>(),
      actions,
      onClose,
    }),
  ));

  return harness;
}

describe("TaskContextMenu copy task id", () => {
  it("opens the shared deferral dialog without changing task state merely by opening it", async () => {
    const update = vi.fn(), onClose = vi.fn();
    const harness = await renderTaskContextMenu(onClose, { onUpdateTask: update });
    try {
      await harness.act(async () => { clickButton(findButtonByText(harness.dom.container, "Defer task")); });
      expect(harness.dom.container.textContent).toContain("Revisit on (optional)");
      expect(harness.dom.container.textContent).toContain("Nothing is archived or muted");
      expect(harness.dom.container.textContent).toContain("Sessions, schedules and deferred jobs keep running");
      expect(update).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
      await harness.act(async () => { clickButton(findButtonByText(harness.dom.container, "Cancel")); });
      expect(onClose).toHaveBeenCalledOnce();
    } finally { await harness.cleanup(); }
  });

  it("shows an inline failure and keeps the menu open when the clipboard write rejects", async () => {
    vi.useFakeTimers();
    const onClose = vi.fn();
    const harness = await renderTaskContextMenu(onClose);
    try {
      setClipboard({ writeText: vi.fn().mockRejectedValue(new Error("Clipboard permission denied")) });

      await harness.act(async () => { clickButton(findButtonByText(harness.dom.container, "Copy Task ID")); });
      await waitUntilAct(harness.act, () => hasButtonWithText(harness.dom.container, "Copy failed"), {
        label: "task id copy failure",
      });

      expect(hasButtonWithText(harness.dom.container, "Copied!")).toBe(false);

      await advanceTimersByTimeAct(harness.act, 2_000);
      expect(onClose).not.toHaveBeenCalled();
      expect(hasButtonWithText(harness.dom.container, "Copy failed")).toBe(true);
    } finally {
      await harness.cleanup();
    }
  });
});

describe("TaskContextMenu reorder entry", () => {
  it("offers Reorder tasks only when the list can be reordered, and closes before entering the mode", async () => {
    const onClose = vi.fn();
    const calls: string[] = [];
    onClose.mockImplementation(() => calls.push("close"));
    const onStartReorder = vi.fn(() => calls.push("reorder"));
    const harness = await renderTaskContextMenu(onClose, { onStartReorder });
    try {
      await harness.act(async () => { clickButton(findButtonByText(harness.dom.container, "Reorder tasks")); });
      expect(calls).toEqual(["close", "reorder"]);
    } finally { await harness.cleanup(); }

    const withoutReorder = await renderTaskContextMenu(vi.fn());
    try {
      expect(hasButtonWithText(withoutReorder.dom.container, "Reorder tasks")).toBe(false);
    } finally { await withoutReorder.cleanup(); }
  });
});

describe("TaskContextMenu kind change", () => {
  it("changes the task kind through the context menu", async () => {
    const update = vi.fn();
    const onClose = vi.fn();
    const harness = await renderTaskContextMenu(onClose, { onUpdateTask: update });
    try {
      await harness.act(async () => { clickButton(findButtonByText(harness.dom.container, "Change kind to ongoing")); });

      expect(update).toHaveBeenCalledExactlyOnceWith("task-1", { kind: "ongoing", doneWhen: null });
      expect(onClose).toHaveBeenCalledOnce();
    } finally {
      await harness.cleanup();
    }
  });

  it("asks before clearing a task's Done when definition", async () => {
    const update = vi.fn();
    const onClose = vi.fn();
    const harness = await renderTaskContextMenu(
      onClose,
      { onUpdateTask: update },
      createTask({ doneWhen: "Ship the release" }),
    );
    const confirm = vi.fn(() => false);
    const restoreConfirm = stubWindowConfirm(confirm);
    try {
      await harness.act(async () => { clickButton(findButtonByText(harness.dom.container, "Change kind to ongoing…")); });

      expect(confirm).toHaveBeenCalledExactlyOnceWith(
        "Changing this to an ongoing task will clear its Done when definition. Continue?",
      );
      expect(update).not.toHaveBeenCalled();
      expect(onClose).not.toHaveBeenCalled();
    } finally {
      restoreConfirm();
      await harness.cleanup();
    }
  });

  it("changes back to a task without removing its Done when definition", async () => {
    const update = vi.fn();
    const onClose = vi.fn();
    const harness = await renderTaskContextMenu(
      onClose,
      { onUpdateTask: update },
      createTask({ kind: "ongoing", doneWhen: "Ship the release" }),
    );
    const confirm = vi.fn(() => false);
    const restoreConfirm = stubWindowConfirm(confirm);
    try {
      await harness.act(async () => { clickButton(findButtonByText(harness.dom.container, "Change kind to task")); });

      expect(confirm).not.toHaveBeenCalled();
      expect(update).toHaveBeenCalledExactlyOnceWith("task-1", { kind: "task" });
      expect(onClose).toHaveBeenCalledOnce();
    } finally {
      restoreConfirm();
      await harness.cleanup();
    }
  });
});
