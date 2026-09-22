import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDialogTestHarness, type DialogTestHarness } from "../test-dialog-harness";
import { findAllByTag, getReactProps, waitTick } from "../test-react-harness";
import { toDateTimeInputValue } from "../lib/task-revisit";
import TaskDeferralDialog, { type DeferralTask } from "./TaskDeferralDialog";

const patch = vi.hoisted(() => vi.fn());
vi.mock("../api", () => ({ patchTask: patch }));

describe("native task deferral dialog", () => {
  let harness: DialogTestHarness;
  const close = vi.fn(), saved = vi.fn();
  const task: DeferralTask = { id: "task", title: "Set aside", deferred: false };
  beforeEach(async () => {
    vi.resetAllMocks();
    harness = await createDialogTestHarness();
    patch.mockResolvedValue({ ...task, deferred: true });
  });
  afterEach(async () => { await harness.cleanup(); });
  async function render(value = task) {
    await harness.render(createElement(TaskDeferralDialog, { task: value, onClose: close, onSaved: saved }));
  }
  function input() { return findAllByTag(harness.dom.container, "INPUT")[0]; }
  async function change(value: string) {
    await harness.act(async () => { getReactProps(input())!.onChange({ target: { value } }); });
  }
  async function submit() {
    await harness.act(async () => {
      getReactProps(findAllByTag(harness.dom.container, "FORM")[0])!.onSubmit({ preventDefault() {} });
      await waitTick();
    });
  }
  it("defers without a date, only changes visibility, and invalidates the native task/Home queries", async () => {
    const invalidate = vi.spyOn(harness.queryClient, "invalidateQueries");
    await render();
    await submit();
    expect(patch).toHaveBeenCalledExactlyOnceWith("task", { deferred: true });
    expect(saved).toHaveBeenCalledExactlyOnceWith({ ...task, deferred: true });
    expect(close).toHaveBeenCalledOnce();
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["dashboard"] });
    expect(harness.dom.container.textContent).toContain("Schedules, running sessions and session defer jobs are not paused");
  });
  it("records an optional local revisit time as an absolute instant", async () => {
    await render();
    const instant = new Date(2030, 4, 2, 10, 30);
    await change(toDateTimeInputValue(instant.toISOString()));
    await submit();
    expect(patch).toHaveBeenCalledExactlyOnceWith("task", { deferred: true, nextTouchAt: instant.toISOString() });
  });
  it("preserves an existing timestamp exactly unless the user changes it", async () => {
    await render({ ...task, nextTouchAt: "2030-01-01T10:30:42.123Z" });
    await submit();
    expect(patch).toHaveBeenCalledExactlyOnceWith("task", { deferred: true });
  });
  it("resumes explicitly and lets the user clear the revisit date", async () => {
    await render({ ...task, deferred: true, nextTouchAt: "2030-01-01T10:30:00Z" });
    const clear = findAllByTag(harness.dom.container, "BUTTON").find(node => node.textContent === "Clear revisit date");
    await harness.act(async () => getReactProps(clear)!.onClick());
    await submit();
    expect(patch).toHaveBeenCalledExactlyOnceWith("task", { deferred: false, nextTouchAt: null });
  });
  it("explains an already-arrived revisit rather than silently changing it", async () => {
    await render({ ...task, nextTouchAt: "2000-01-01T00:00:00Z" });
    expect(harness.dom.container.textContent).toContain("will remain in Home's revisit list");
    await submit();
    expect(patch).toHaveBeenCalledExactlyOnceWith("task", { deferred: true });
  });
  it("keeps a failed save's date draft and permits retry", async () => {
    patch.mockRejectedValueOnce(new Error("Storage unavailable"));
    await render();
    const date = toDateTimeInputValue(new Date(2030, 4, 2, 10, 30).toISOString());
    await change(date); await submit();
    expect(harness.dom.container.textContent).toContain("The change was not saved");
    expect(harness.dom.container.textContent).toContain("Storage unavailable");
    expect(getReactProps(input())!.value).toBe(date);
    expect(close).not.toHaveBeenCalled();
    await submit();
    expect(close).toHaveBeenCalledOnce();
    expect(patch).toHaveBeenCalledTimes(2);
  });
  it("retains a draft but stops a known stale deferral/revisit edit", async () => {
    await render();
    await change("2030-05-02T10:30");
    await render({ ...task, deferred: true });
    expect(getReactProps(input())!.value).toBe("2030-05-02T10:30");
    expect(harness.dom.container.textContent).toContain("Task changed");
    await submit();
    expect(patch).not.toHaveBeenCalled();
  });
  it("reports invalid date input without saving", async () => {
    await render();
    await change("not-a-date"); await submit();
    expect(harness.dom.container.textContent).toContain("Enter a valid revisit date");
    expect(patch).not.toHaveBeenCalled();
  });
});
