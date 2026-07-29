import { createElement } from "react";
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

function createTask(): Task {
  return {
    id: "task-1",
    title: "Clipboard task",
    kind: "task",
    muted: false,
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

async function renderTaskContextMenu(onClose: () => void) {
  const harness = await createReactDomHarness();
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, refetchOnMount: false } },
  });
  queryClient.setQueryData(queryKeys.taskChecklistItems("task-1"), []);

  await harness.render(createElement(
    QueryClientProvider,
    { client: queryClient },
    createElement(TaskContextMenu, {
      task: createTask(),
      position: { x: 10, y: 10 },
      taskGroups: [],
      sessionMap: new Map<string, Session>(),
      actions: {},
      onClose,
    }),
  ));

  return harness;
}

describe("TaskContextMenu copy task id", () => {
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
