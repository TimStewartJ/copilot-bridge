import { describe, expect, it, vi } from "vitest";
import { createTaskCompletionToast } from "./task-completion-feedback";
import type { TaskCompletionFeedback } from "./task-completion-feedback";

function feedback(overrides: Partial<TaskCompletionFeedback> = {}): TaskCompletionFeedback {
  return {
    taskId: "task-1",
    taskTitle: "Ship the feature",
    previousStatus: "active",
    summary: "2 of 2 checklist items complete • 3 linked sessions • 1 linked PR",
    doneWhenCopy: "Done when: Merged and deployed",
    ...overrides,
  };
}

describe("createTaskCompletionToast", () => {
  it("shows the task title followed by 'completed'", () => {
    const toast = createTaskCompletionToast(feedback(), vi.fn());

    expect(toast.title).toBe("Ship the feature completed");
  });

  it("renders the summary and done-when copy", () => {
    const toast = createTaskCompletionToast(feedback(), vi.fn());

    expect(toast.description).toContain("2 of 2 checklist items complete");
    expect(toast.footnote).toBe("Done when: Merged and deployed");
  });

  it("omits done-when line when doneWhenCopy is absent", () => {
    const toast = createTaskCompletionToast(
      feedback({ taskTitle: "Quick fix", summary: "0 linked sessions", doneWhenCopy: undefined }),
      vi.fn(),
    );

    expect(toast.title).toBe("Quick fix completed");
    expect(toast.footnote).toBeUndefined();
  });

  it("offers a Reopen task undo action wired to the callback", async () => {
    const onUndo = vi.fn();
    const toast = createTaskCompletionToast(feedback(), onUndo);

    expect(toast.action?.label).toBe("Reopen task");
    expect(toast.action?.pendingLabel).toBe("Reopening…");

    await toast.action?.onAction();
    expect(onUndo).toHaveBeenCalledOnce();
  });

  it("uses a stable per-task id so repeat completions replace the toast", () => {
    expect(createTaskCompletionToast(feedback(), vi.fn()).id).toBe("task-completion-task-1");
  });
});
