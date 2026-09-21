import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../api";
import { createReactDomHarness, findAllByTag, getReactProps, type ReactDomHarness } from "../test-react-harness";
import TaskMomentumFields from "./TaskMomentumFields";

const patchTaskMock = vi.hoisted(() => vi.fn());
vi.mock("../api", () => ({ patchTask: patchTaskMock }));

function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task-1", title: "Design migration", kind: "task", muted: false, status: "active",
    notes: "", priority: 0, order: 0, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    sessionIds: [], workItems: [], pullRequests: [], tags: [], ...overrides,
  };
}

describe("TaskMomentumFields design migration", () => {
  let harness: ReactDomHarness | null = null;
  beforeEach(() => patchTaskMock.mockReset());
  afterEach(async () => {
    await harness?.cleanup();
    harness = null;
  });

  async function render(task: Task, onPatched = vi.fn()) {
    harness ??= await createReactDomHarness();
    await harness.render(createElement(TaskMomentumFields, { task, onPatched }));
    return harness.dom.container;
  }

  it("keeps add/edit/autosave working in a field list", async () => {
    const task = createTask();
    const updated = { ...task, nextAction: "Validate the preview" };
    patchTaskMock.mockResolvedValue(updated);
    const onPatched = vi.fn();
    const container = await render(task, onPatched);
    const add = findAllByTag(container, "BUTTON").find((button) => button.textContent === "Add next action");
    await harness!.act(async () => getReactProps(add)?.onClick?.());
    expect(findAllByTag(container, "DL")).toHaveLength(1);
    const input = findAllByTag(container, "INPUT")[0];
    expect(getReactProps(input)?.["aria-label"]).toBe("Edit Next action");
    await harness!.act(async () => getReactProps(input)?.onChange?.({ target: { value: "Validate the preview" } }));
    await harness!.act(async () => getReactProps(input)?.onBlur?.());
    expect(patchTaskMock).toHaveBeenCalledExactlyOnceWith(task.id, { nextAction: "Validate the preview" });
    expect(onPatched).toHaveBeenCalledExactlyOnceWith(updated);
    expect(container.textContent).toContain("Validate the preview");
    expect(findAllByTag(container, "INPUT")).toHaveLength(0);
  });

  it("preserves expansion, clearing, and the return to an add action", async () => {
    const task = createTask({ nextAction: "First line\nSecond line" });
    patchTaskMock.mockResolvedValue({ ...task, nextAction: undefined });
    const container = await render(task);
    const expand = findAllByTag(container, "BUTTON")
      .find((button) => getReactProps(button)?.["aria-label"] === "Expand Next action");
    expect(getReactProps(expand)?.["aria-expanded"]).toBe(false);
    await harness!.act(async () => getReactProps(expand)?.onClick?.());
    expect(getReactProps(expand)?.["aria-expanded"]).toBe(true);
    const clear = findAllByTag(container, "BUTTON")
      .find((button) => getReactProps(button)?.["aria-label"] === "Clear Next action");
    await harness!.act(async () => getReactProps(clear)?.onClick?.());
    expect(patchTaskMock).toHaveBeenCalledExactlyOnceWith(task.id, { nextAction: null });
    expect(container.textContent).not.toContain("First line");
    expect(container.textContent).toContain("Add next action");
  });

  it("cancels an edit without saving and still omits a finish line for ongoing work", async () => {
    const task = createTask({ kind: "ongoing", doneWhen: "Not used", nextAction: "Keep checking" });
    const container = await render(task);
    expect(container.textContent).not.toContain("Done when");
    const edit = findAllByTag(container, "BUTTON")
      .find((button) => getReactProps(button)?.["aria-label"] === "Edit Next action");
    await harness!.act(async () => getReactProps(edit)?.onClick?.());
    const input = findAllByTag(container, "INPUT")[0];
    await harness!.act(async () => getReactProps(input)?.onChange?.({ target: { value: "Discard this edit" } }));
    await harness!.act(async () => getReactProps(input)?.onKeyDown?.({ key: "Escape" }));
    expect(patchTaskMock).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Keep checking");
    expect(container.textContent).not.toContain("Discard this edit");
  });
});
