import { createElement } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../../api";
import { updateTaskInQueryCaches } from "../../lib/task-query-cache";
import { createReactDomHarness, waitUntilAct } from "../../test-react-harness";
import { useActiveTask } from "./useActiveTask";

const fetchTaskMock = vi.hoisted(() => vi.fn());

vi.mock("../../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../api")>();
  return {
    ...actual,
    fetchTask: (...args: unknown[]) => fetchTaskMock(...args),
  };
});

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    title: "Task 1",
    kind: "task",
    muted: false,
    status: "active",
    notes: "",
    priority: 0,
    order: 0,
    createdAt: "2026-08-11T12:00:00.000Z",
    updatedAt: "2026-08-11T12:00:00.000Z",
    sessionIds: [],
    workItems: [],
    pullRequests: [],
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("useActiveTask", () => {
  it("derives a listed task without a duplicate detail fetch", async () => {
    const harness = await createReactDomHarness();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    let selected: Task | null = null;
    const getSelected = (): Task | null => selected;

    function TestComponent() {
      selected = useActiveTask("task-1", [createTask()], true).task;
      return null;
    }

    try {
      await harness.render(createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(TestComponent),
      ));
      expect(getSelected()?.title).toBe("Task 1");
      expect(fetchTaskMock).not.toHaveBeenCalled();
    } finally {
      queryClient.clear();
      await harness.cleanup();
    }
  });

  it("derives a deep-linked task from detail query state and follows cache updates", async () => {
    const harness = await createReactDomHarness();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    fetchTaskMock.mockResolvedValue(createTask({ id: "deep-task", title: "Deep task" }));
    let selected: Task | null = null;
    const getSelected = (): Task | null => selected;

    function TestComponent() {
      selected = useActiveTask("deep-task", [], true).task;
      return null;
    }

    try {
      await harness.render(createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(TestComponent),
      ));
      await waitUntilAct(harness.act, () => getSelected()?.title === "Deep task");
      expect(fetchTaskMock).toHaveBeenCalledWith("deep-task");

      await harness.act(async () => {
        updateTaskInQueryCaches(queryClient, "deep-task", (task) => ({
          ...task,
          title: "Updated from cache",
          sessionIds: ["session-1"],
        }));
      });
      await waitUntilAct(harness.act, () => getSelected()?.title === "Updated from cache");
      expect(getSelected()?.sessionIds).toEqual(["session-1"]);
    } finally {
      queryClient.clear();
      await harness.cleanup();
    }
  });
});
