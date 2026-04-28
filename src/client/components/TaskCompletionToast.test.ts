import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import TaskCompletionToast from "./TaskCompletionToast";

function renderToast(overrides: Partial<Parameters<typeof TaskCompletionToast>[0]> = {}): string {
  return renderToStaticMarkup(
    createElement(TaskCompletionToast, {
      feedback: {
        taskId: "task-1",
        taskTitle: "Ship the feature",
        summary: "2 of 2 checklist items complete • 3 linked sessions • 1 linked PR",
        doneWhenCopy: "Done when: Merged and deployed",
      },
      onUndo: vi.fn(),
      onDismiss: vi.fn(),
      ...overrides,
    }),
  );
}

describe("TaskCompletionToast", () => {
  it("shows the task title followed by 'completed'", () => {
    const html = renderToast();

    expect(html).toContain("Ship the feature completed");
  });

  it("does not say 'archived' in the toast body", () => {
    const html = renderToast();

    expect(html).not.toContain("archived");
    expect(html).not.toContain("Archived");
  });

  it("renders the summary and done-when copy", () => {
    const html = renderToast();

    expect(html).toContain("2 of 2 checklist items complete");
    expect(html).toContain("Done when: Merged and deployed");
  });

  it("omits done-when line when doneWhenCopy is absent", () => {
    const html = renderToast({
      feedback: {
        taskId: "task-1",
        taskTitle: "Quick fix",
        summary: "0 linked sessions",
      },
    });

    expect(html).toContain("Quick fix completed");
    expect(html).not.toContain("Done when");
  });

  it("shows the Reopen task button and not an Archive button", () => {
    const html = renderToast();

    expect(html).toContain("Reopen task");
    expect(html).not.toContain("Archive");
  });
});
