import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../api";
import { createReactDomHarness, findAllByTag, getReactProps, type ReactDomHarness } from "../test-react-harness";
import TaskMomentumFields, { getTaskContextSummary } from "./TaskMomentumFields";

const patchTaskMock = vi.hoisted(() => vi.fn());
vi.mock("../api", () => ({ patchTask: patchTaskMock }));

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1", title: "Design migration", kind: "task", muted: false, deferred: false, status: "active",
    notes: "", priority: 0, order: 0, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    sessionIds: [], workItems: [], pullRequests: [], tags: [], ...overrides,
  };
}

describe("TaskMomentumFields design migration", () => {
  let harness: ReactDomHarness | null = null;
  beforeEach(() => { patchTaskMock.mockReset(); });
  afterEach(async () => {
    await harness?.cleanup();
    harness = null;
  });

  function disclosure(container: ReactDomHarness["dom"]["container"]) {
    return findAllByTag(container, "BUTTON").find(button => typeof getReactProps(button)?.["aria-expanded"] === "boolean");
  }
  async function render(task: Task, onPatched = vi.fn(), expand = true) {
    harness ??= await createReactDomHarness();
    await harness.render(createElement(TaskMomentumFields, { task, onPatched }));
    const toggle = disclosure(harness.dom.container);
    if (expand && !getReactProps(toggle)?.["aria-expanded"]) {
      await harness.act(async () => getReactProps(toggle)!.onClick());
    }
    return harness.dom.container;
  }

  it("starts collapsed with one context summary and keeps Defer reachable", async () => {
    const container = await render(createTask({ nextAction: "Review the quotes", waitingOn: "The dealer" }), vi.fn(), false);
    expect(container.textContent).toContain("Where things stand");
    expect(container.textContent).toContain("Next: Review the quotes");
    expect(container.textContent).not.toContain("The dealer");
    expect(container.textContent).toContain("Defer task");
    expect(getReactProps(disclosure(container))?.["aria-expanded"]).toBe(false);
    expect(findAllByTag(container, "DL")).toHaveLength(0);
    await harness!.act(async () => getReactProps(disclosure(container))!.onClick());
    expect(container.textContent).toContain("The dealer");
    expect(findAllByTag(container, "DL")).toHaveLength(1);
  });

  it.each([
    [{ deferred: true, nextAction: "Hidden next step" }, "Deferred"],
    [{ nextAction: "Read\n the reply", waitingOn: "Approval" }, "Next: Read the reply"],
    [{ waitingOn: "A reply" }, "Waiting for: A reply"],
    [{ doneWhen: "Changes approved" }, "Done when: Changes approved"],
    [{ kind: "ongoing" as const, doneWhen: "Never show this" }, "No next step set"],
    [{ status: "archived" as const }, "Archived"],
    [{ status: "archived" as const, completedAt: "2026-01-01T00:00:00Z" }, "Completed"],
  ])("summarizes recorded context without inventing a task state: %j", (overrides, summary) => {
    expect(getTaskContextSummary(createTask(overrides))).toBe(summary);
  });

  it("includes the recorded revisit date in a deferred summary", () => {
    const nextTouchAt = "2030-05-02T10:30:00.000Z";
    const date = new Date(nextTouchAt).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
    expect(getTaskContextSummary(createTask({ deferred: true, nextTouchAt }))).toBe(`Deferred · Revisit ${date}`);
  });

  it("stays open after saves and same-task updates, but closes when switching tasks", async () => {
    const task = createTask({ nextAction: "Read" });
    const container = await render(task);
    await render({ ...task, nextAction: "Review" }, vi.fn(), false);
    expect(getReactProps(disclosure(container))?.["aria-expanded"]).toBe(true);
    expect(container.textContent).toContain("Next: Review");
    await render({ ...task, id: "other-task", nextAction: "Different task" }, vi.fn(), false);
    expect(getReactProps(disclosure(container))?.["aria-expanded"]).toBe(false);
    expect(findAllByTag(container, "DL")).toHaveLength(0);
    await render(task, vi.fn(), false);
    expect(getReactProps(disclosure(container))?.["aria-expanded"]).toBe(false);
  });

  it("keeps add/edit/autosave working in a field list", async () => {
    const task = createTask();
    const updated = { ...task, nextAction: "Validate the preview" };
    patchTaskMock.mockResolvedValue(updated);
    const onPatched = vi.fn();
    const container = await render(task, onPatched);
    const add = findAllByTag(container, "BUTTON").find((button) => button.textContent === "Add next step");
    await harness!.act(async () => getReactProps(add)?.onClick?.());
    expect(findAllByTag(container, "DL")).toHaveLength(1);
    const input = findAllByTag(container, "INPUT")[0];
    expect(getReactProps(input)?.["aria-label"]).toBe("Edit Next step");
    await harness!.act(async () => getReactProps(input)?.onChange?.({ target: { value: "Validate the preview" } }));
    await harness!.act(async () => getReactProps(input)?.onBlur?.());
    expect(patchTaskMock).toHaveBeenCalledExactlyOnceWith(task.id, { nextAction: "Validate the preview" });
    expect(onPatched).toHaveBeenCalledExactlyOnceWith(updated);
    await render(updated, onPatched, false);
    expect(getReactProps(disclosure(container))?.["aria-expanded"]).toBe(true);
    expect(container.textContent).toContain("Validate the preview");
    expect(findAllByTag(container, "INPUT")).toHaveLength(0);
  });

  it("preserves expansion, clearing, and the return to an add action", async () => {
    const task = createTask({ nextAction: "First line\nSecond line" });
    patchTaskMock.mockResolvedValue({ ...task, nextAction: undefined });
    const container = await render(task);
    const expand = findAllByTag(container, "BUTTON")
      .find((button) => getReactProps(button)?.["aria-label"] === "Expand Next step");
    expect(getReactProps(expand)?.["aria-expanded"]).toBe(false);
    await harness!.act(async () => getReactProps(expand)?.onClick?.());
    expect(getReactProps(expand)?.["aria-expanded"]).toBe(true);
    const clear = findAllByTag(container, "BUTTON")
      .find((button) => getReactProps(button)?.["aria-label"] === "Clear Next step");
    await harness!.act(async () => getReactProps(clear)?.onClick?.());
    expect(patchTaskMock).toHaveBeenCalledExactlyOnceWith(task.id, { nextAction: null });
    expect(container.textContent).not.toContain("First line");
    expect(container.textContent).toContain("Add next step");
  });

  it("cancels an edit without saving and still omits a finish line for ongoing work", async () => {
    const task = createTask({ kind: "ongoing", doneWhen: "Not used", nextAction: "Keep checking" });
    const container = await render(task);
    expect(container.textContent).not.toContain("Done when");
    const edit = findAllByTag(container, "BUTTON")
      .find((button) => getReactProps(button)?.["aria-label"] === "Edit Next step");
    await harness!.act(async () => getReactProps(edit)?.onClick?.());
    const input = findAllByTag(container, "INPUT")[0];
    await harness!.act(async () => getReactProps(input)?.onChange?.({ target: { value: "Discard this edit" } }));
    await harness!.act(async () => getReactProps(input)?.onKeyDown?.({ key: "Escape" }));
    expect(patchTaskMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Keep checking");
    expect(container.textContent).not.toContain("Discard this edit");
  });

  it("surfaces a failed context write and retains its editable draft", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      patchTaskMock.mockRejectedValue(new Error("Save failed"));
      const container = await render(createTask());
      const add = findAllByTag(container, "BUTTON").find(button => button.textContent === "Add a wait");
      await harness!.act(async () => getReactProps(add)!.onClick());
      const input = findAllByTag(container, "INPUT")[0];
      await harness!.act(async () => getReactProps(input)!.onChange({ target: { value: "Delivery confirmation" } }));
      await harness!.act(async () => getReactProps(input)!.onBlur());
      expect(container.textContent).toContain("The change was not saved");
      expect(getReactProps(findAllByTag(container, "INPUT")[0])!.value).toBe("Delivery confirmation");
    } finally { errorLog.mockRestore(); }
  });

  it("keeps a save failure visible when collapsed and restores its draft on reopening", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    let rejectSave: ((error: Error) => void) | undefined;
    patchTaskMock.mockReturnValue(new Promise<Task>((_resolve, reject) => { rejectSave = reject; }));
    try {
      const container = await render(createTask({ nextAction: "Original step" }));
      const edit = findAllByTag(container, "BUTTON").find(button => getReactProps(button)?.["aria-label"] === "Edit Next step");
      await harness!.act(async () => getReactProps(edit)!.onClick());
      const input = findAllByTag(container, "INPUT")[0];
      await harness!.act(async () => getReactProps(input)!.onChange({ target: { value: "Unsaved step" } }));
      await harness!.act(async () => {
        getReactProps(input)!.onBlur();
        getReactProps(disclosure(container))!.onClick();
      });
      expect(getReactProps(disclosure(container))?.["aria-expanded"]).toBe(false);
      await harness!.act(async () => { rejectSave!(new Error("Offline")); });
      expect(container.textContent).toContain("The change was not saved");
      expect(container.textContent).toContain("Offline");
      expect(getReactProps(disclosure(container))?.["aria-expanded"]).toBe(false);
      await harness!.act(async () => getReactProps(disclosure(container))!.onClick());
      expect(getReactProps(findAllByTag(container, "INPUT")[0])!.value).toBe("Unsaved step");
    } finally { errorLog.mockRestore(); }
  });

  it("shows a past revisit neutrally and makes deferral visible", async () => {
    const container = await render(createTask({ deferred: true, nextTouchAt: "2000-01-01T00:00:00Z", waitingOn: "External reply" }));
    expect(container.textContent).toContain("Where things stand");
    expect(container.textContent).toContain("Deferred");
    expect(container.textContent).toContain("Resume task");
    expect(container.textContent).toContain("ready to revisit");
    expect(container.textContent).not.toContain("overdue");
    expect(container.textContent).toContain("Waiting for");
  });
  it("does not offer deferral on a completed and archived task", async () => {
    const container = await render(createTask({ status: "archived", completedAt: "2026-01-01T00:00:00Z", doneWhen: "Delivered" }));
    expect(container.textContent).toContain("Delivered");
    expect(container.textContent).not.toContain("Defer task");
    expect(container.textContent).not.toContain("Resume task");
  });
});
