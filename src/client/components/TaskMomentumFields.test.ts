import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../api";
import { createReactDomHarness, findAllByTag, getReactProps, type ReactDomHarness } from "../test-react-harness";
import TaskMomentumFields from "./TaskMomentumFields";
import { toDateTimeInputValue } from "../lib/task-revisit";

const patchTaskMock = vi.hoisted(() => vi.fn());
vi.mock("../api", () => ({ patchTask: patchTaskMock }));

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1", title: "Design migration", kind: "task", muted: false, deferred: false, status: "active",
    notes: "", priority: 0, order: 0, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    activeSessionIds: [], sessionCount: 0, archivedSessionCount: 0, sessionLinksRevision: "rev-0", workItems: [], pullRequests: [], tags: [], ...overrides,
  };
}

describe("TaskMomentumFields design migration", () => {
  let harness: ReactDomHarness | null = null;
  beforeEach(() => { patchTaskMock.mockReset(); });
  afterEach(async () => {
    await harness?.cleanup();
    harness = null;
  });

  function button(container: ReactDomHarness["dom"]["container"], label: string) {
    return findAllByTag(container, "BUTTON").find((candidate) => getReactProps(candidate)?.["aria-label"] === label);
  }
  async function render(task: Task, onPatched = vi.fn()) {
    harness ??= await createReactDomHarness();
    await harness.render(createElement(TaskMomentumFields, { task, onPatched }));
    return harness.dom.container;
  }

  it("shows every set field at once, expands a long one and clears it from its editor", async () => {
    const task = createTask({ nextAction: "Review\n the quotes", waitingOn: "The dealer" });
    patchTaskMock.mockResolvedValue({ ...task, nextAction: undefined });
    const container = await render(task);
    expect(container.textContent).toContain("Status");
    expect(container.textContent).toContain("The dealer");
    expect(findAllByTag(container, "DL")).toHaveLength(1);
    expect(button(container, "Clear Next step")).toBeUndefined();

    const expand = button(container, "Expand Next step");
    expect(getReactProps(expand)?.["aria-expanded"]).toBe(false);
    await harness!.act(async () => getReactProps(expand)?.onClick?.());
    expect(getReactProps(button(container, "Collapse Next step"))?.["aria-expanded"]).toBe(true);

    await harness!.act(async () => getReactProps(button(container, "Edit Next step"))!.onClick());
    // Tabbing from the field to its Clear neither saves nor closes the edit.
    await harness!.act(async () => getReactProps(findAllByTag(container, "INPUT")[0])!.onBlur({ relatedTarget: { dataset: { clearField: "nextAction" } } }));
    expect(patchTaskMock).not.toHaveBeenCalled();
    await harness!.act(async () => getReactProps(button(container, "Clear Next step"))!.onClick());
    expect(patchTaskMock).toHaveBeenCalledExactlyOnceWith(task.id, { nextAction: null });
    expect(container.textContent).not.toContain("the quotes");
    expect(button(container, "Add next step")).toBeDefined();
    expect(container.textContent).toContain("The dealer");
  });

  it("explains a revisit only while it is being set, then shows the saved date", async () => {
    const task = createTask({ deferred: true, nextAction: "Hidden step" });
    const nextTouchAt = "2030-05-02T10:30:00.000Z";
    patchTaskMock.mockResolvedValue({ ...task, nextTouchAt });
    const container = await render(task);
    expect(container.textContent).not.toContain("Nothing starts by itself");
    await harness!.act(async () => getReactProps(button(container, "Set revisit date"))!.onClick());
    const input = findAllByTag(container, "INPUT")[0];
    expect(getReactProps(input)?.["aria-describedby"]).toBe(`revisit-help-${task.id}`);
    expect(container.textContent).toContain("Nothing starts by itself");
    await harness!.act(async () => getReactProps(input)!.onChange({ target: { value: toDateTimeInputValue(nextTouchAt) } }));
    await harness!.act(async () => getReactProps(input)!.onBlur({ relatedTarget: null }));
    expect(findAllByTag(container, "INPUT")).toHaveLength(0);
    expect(container.textContent).toContain("Revisit on");
    expect(container.textContent).not.toContain("Nothing starts by itself");
  });

  it("reads a typed revisit date", async () => {
    const task = createTask({ deferred: true });
    patchTaskMock.mockResolvedValue({ ...task, nextTouchAt: new Date(2030, 4, 2, 10, 30).toISOString() });
    const container = await render(task);
    await harness!.act(async () => getReactProps(button(container, "Set revisit date"))!.onClick());
    const input = findAllByTag(container, "INPUT")[0];
    await harness!.act(async () => getReactProps(input)!.onChange({ target: { value: "May 2 2030 10:30am" } }));
    await harness!.act(async () => getReactProps(input)!.onBlur({ relatedTarget: null }));
    expect(patchTaskMock).toHaveBeenCalledWith(task.id, { nextTouchAt: new Date(2030, 4, 2, 10, 30).toISOString() });
  });

  it("saves a new field and drops an unfinished edit when switching tasks", async () => {
    const task = createTask();
    const updated = { ...task, nextAction: "Validate the preview" };
    patchTaskMock.mockResolvedValue(updated);
    const onPatched = vi.fn();
    const container = await render(task, onPatched);
    await harness!.act(async () => getReactProps(button(container, "Add next step"))?.onClick?.());
    const input = findAllByTag(container, "INPUT")[0];
    expect(getReactProps(input)?.["aria-label"]).toBe("Edit Next step");
    await harness!.act(async () => getReactProps(input)?.onChange?.({ target: { value: "Validate the preview" } }));
    await harness!.act(async () => getReactProps(input)?.onBlur?.({ relatedTarget: null }));
    expect(patchTaskMock).toHaveBeenCalledExactlyOnceWith(task.id, { nextAction: "Validate the preview" });
    expect(onPatched).toHaveBeenCalledExactlyOnceWith(updated);
    await render(updated, onPatched);
    expect(container.textContent).toContain("Validate the preview");
    expect(findAllByTag(container, "INPUT")).toHaveLength(0);

    await harness!.act(async () => getReactProps(button(container, "Edit Next step"))!.onClick());
    expect(findAllByTag(container, "INPUT")).toHaveLength(1);
    await render({ ...updated, id: "other-task", nextAction: "Different task" }, onPatched);
    expect(findAllByTag(container, "INPUT")).toHaveLength(0);
    expect(container.textContent).toContain("Different task");
  });

  it("cancels an edit without saving and still omits a finish line for ongoing work", async () => {
    const task = createTask({ kind: "ongoing", doneWhen: "Not used", nextAction: "Keep checking" });
    const container = await render(task);
    expect(container.textContent).not.toContain("Done when");
    await harness!.act(async () => getReactProps(button(container, "Edit Next step"))?.onClick?.());
    const input = findAllByTag(container, "INPUT")[0];
    await harness!.act(async () => getReactProps(input)?.onChange?.({ target: { value: "Discard this edit" } }));
    await harness!.act(async () => getReactProps(input)?.onKeyDown?.({ key: "Escape" }));
    expect(patchTaskMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Keep checking");
    expect(container.textContent).not.toContain("Discard this edit");
  });

  it("keeps a save failure visible and reopens the field with its draft", async () => {
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    let rejectSave: ((error: Error) => void) | undefined;
    patchTaskMock.mockReturnValue(new Promise<Task>((_resolve, reject) => { rejectSave = reject; }));
    try {
      const container = await render(createTask({ nextAction: "Original step" }));
      await harness!.act(async () => getReactProps(button(container, "Edit Next step"))!.onClick());
      const input = findAllByTag(container, "INPUT")[0];
      await harness!.act(async () => getReactProps(input)!.onChange({ target: { value: "Unsaved step" } }));
      await harness!.act(async () => getReactProps(input)!.onBlur({ relatedTarget: null }));
      expect(findAllByTag(container, "INPUT")).toHaveLength(0);
      await harness!.act(async () => { rejectSave!(new Error("Offline")); });
      expect(container.textContent).toContain("The change was not saved");
      expect(container.textContent).toContain("Offline");
      expect(getReactProps(findAllByTag(container, "INPUT")[0])!.value).toBe("Unsaved step");
    } finally { errorLog.mockRestore(); }
  });

  it("shows a past revisit neutrally and offers to resume a set-aside task", async () => {
    const container = await render(createTask({ deferred: true, nextTouchAt: "2000-01-01T00:00:00Z", waitingOn: "External reply" }));
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
