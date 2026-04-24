import { describe, expect, it, vi } from "vitest";
import { queryKeys } from "../queryClient";
import {
  createDeferredTaskChangeInvalidator,
  invalidateTaskChangeQueries,
} from "./task-change-invalidation";

describe("invalidateTaskChangeQueries", () => {
  it("invalidates shared task data and the affected task checklist", () => {
    const invalidateQueries = vi.fn();

    invalidateTaskChangeQueries({ invalidateQueries } as any, "task-123");

    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.tasks });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.dashboard });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.openChecklistItems });
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.taskChecklistItems("task-123") });

    const predicate = invalidateQueries.mock.calls
      .map(([filters]) => filters?.predicate)
      .find((candidate) => typeof candidate === "function");

    expect(predicate).toBeTypeOf("function");
    expect(predicate?.({ queryKey: queryKeys.taskEnriched("task-123") })).toBe(true);
    expect(predicate?.({ queryKey: queryKeys.taskEnriched("task-999") })).toBe(false);
    expect(predicate?.({ queryKey: queryKeys.taskChecklistItems("task-123") })).toBe(false);
  });

  it("skips task-scoped invalidation when the change is not tied to a task", () => {
    const invalidateQueries = vi.fn();

    invalidateTaskChangeQueries({ invalidateQueries } as any);

    expect(invalidateQueries).toHaveBeenCalledTimes(3);
    expect(invalidateQueries).toHaveBeenNthCalledWith(1, { queryKey: queryKeys.tasks });
    expect(invalidateQueries).toHaveBeenNthCalledWith(2, { queryKey: queryKeys.dashboard });
    expect(invalidateQueries).toHaveBeenNthCalledWith(3, { queryKey: queryKeys.openChecklistItems });
  });
});

describe("createDeferredTaskChangeInvalidator", () => {
  it("flushes queued task changes once local task mutations finish", () => {
    const invalidateQueries = vi.fn();
    const invalidator = createDeferredTaskChangeInvalidator({ invalidateQueries } as any);

    invalidator.beginTaskMutation();
    invalidator.handleTaskChange("task-123");
    invalidator.handleTaskChange("task-123");
    invalidator.handleTaskChange();

    expect(invalidateQueries).not.toHaveBeenCalled();

    invalidator.endTaskMutation();

    expect(invalidateQueries).toHaveBeenCalledTimes(5);
    expect(invalidateQueries).toHaveBeenNthCalledWith(1, { queryKey: queryKeys.tasks });
    expect(invalidateQueries).toHaveBeenNthCalledWith(2, { queryKey: queryKeys.dashboard });
    expect(invalidateQueries).toHaveBeenNthCalledWith(3, { queryKey: queryKeys.openChecklistItems });
    expect(invalidateQueries).toHaveBeenNthCalledWith(4, { queryKey: queryKeys.taskChecklistItems("task-123") });

    const predicate = invalidateQueries.mock.calls[4]?.[0]?.predicate;
    expect(predicate).toBeTypeOf("function");
    expect(predicate?.({ queryKey: queryKeys.taskEnriched("task-123") })).toBe(true);
  });

  it("waits for nested task mutations before flushing queued changes", () => {
    const invalidateQueries = vi.fn();
    const invalidator = createDeferredTaskChangeInvalidator({ invalidateQueries } as any);

    invalidator.beginTaskMutation();
    invalidator.beginTaskMutation();
    invalidator.handleTaskChange("task-123");

    invalidator.endTaskMutation();
    expect(invalidateQueries).not.toHaveBeenCalled();

    invalidator.endTaskMutation();
    expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: queryKeys.taskChecklistItems("task-123") });
  });
});
