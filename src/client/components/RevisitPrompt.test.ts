import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDialogTestHarness, type DialogTestHarness } from "../test-dialog-harness";
import { findAllByTag, getReactProps, waitTick } from "../test-react-harness";
import { toDateTimeInputValue } from "../lib/task-revisit";
import RevisitPrompt, { type RevisitTask } from "./RevisitPrompt";

const patch = vi.hoisted(() => vi.fn());
vi.mock("../api", () => ({ patchTask: patch }));

describe("revisit prompt", () => {
  let harness: DialogTestHarness;
  const saved = vi.fn();
  const due: RevisitTask = { id: "task", title: "Renew the lease", deferred: false, muted: false, nextTouchAt: "2000-01-01T00:00:00Z" };
  beforeEach(async () => {
    vi.resetAllMocks();
    harness = await createDialogTestHarness();
    patch.mockImplementation(async (_id: string, updates: object) => ({ ...due, ...updates }));
  });
  afterEach(async () => { await harness.cleanup(); });
  async function render(task: RevisitTask) {
    await harness.render(createElement(RevisitPrompt, { task, onSaved: saved }));
  }
  const text = () => harness.dom.container.textContent ?? "";
  const button = (label: string) => findAllByTag(harness.dom.container, "BUTTON").find(node => node.textContent?.trim().startsWith(label));
  async function click(label: string) {
    const target = button(label);
    expect(target, label).toBeDefined();
    await harness.act(async () => { await getReactProps(target)!.onClick(); await waitTick(); });
  }

  it("stays out of the way until the date arrives", async () => {
    await render({ ...due, nextTouchAt: "9999-01-01T00:00:00Z" });
    expect(text()).toBe("");
    await render({ ...due, nextTouchAt: undefined });
    expect(text()).toBe("");
  });

  it("offers a task in the working list a later date or none, never a resume", async () => {
    await render(due);
    expect(text()).toContain("Time to revisit");
    expect(text()).not.toContain("set aside");
    expect(button("Resume task")).toBeUndefined();
    await click("Clear date");
    expect(patch).toHaveBeenCalledExactlyOnceWith("task", { nextTouchAt: null });
    expect(saved).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: "task", nextTouchAt: null }));
  });

  it("resumes a set-aside task and drops its date in one change", async () => {
    const invalidate = vi.spyOn(harness.queryClient, "invalidateQueries");
    await render({ ...due, deferred: true });
    expect(text()).toContain("It is still set aside.");
    await click("Resume task");
    expect(patch).toHaveBeenCalledExactlyOnceWith("task", { deferred: false, nextTouchAt: null });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["dashboard"] });
  });

  it("says a muted task is still muted and does not offer to resume it", async () => {
    await render({ ...due, muted: true });
    expect(text()).toContain("It is still muted.");
    expect(button("Resume task")).toBeUndefined();
  });

  it("postpones to tomorrow morning, or to a chosen time that is still ahead", async () => {
    await render({ ...due, deferred: true });
    await click("Later");
    expect(text()).toContain("stays set aside");
    await click("Tomorrow");
    const tomorrow = new Date(patch.mock.calls[0][1].nextTouchAt);
    expect(Object.keys(patch.mock.calls[0][1])).toEqual(["nextTouchAt"]);
    expect([tomorrow.getHours(), tomorrow.getMinutes()]).toEqual([9, 0]);
    expect(tomorrow.getTime()).toBeGreaterThan(Date.now());
    expect(text()).not.toContain("Revisit later");

    await click("Later");
    const input = () => findAllByTag(harness.dom.container, "INPUT")[0];
    const type = async (value: string) => { await harness.act(async () => { getReactProps(input())!.onChange({ target: { value } }); }); };
    await type("2001-01-01T10:00");
    expect(text()).toContain("That time has passed");
    expect(getReactProps(button("Set date"))!.disabled).toBe(true);
    const instant = new Date(2999, 4, 2, 10, 30);
    await type(toDateTimeInputValue(instant.toISOString()));
    await harness.act(async () => {
      getReactProps(findAllByTag(harness.dom.container, "FORM")[0])!.onSubmit({ preventDefault() {} });
      await waitTick();
    });
    expect(patch).toHaveBeenLastCalledWith("task", { nextTouchAt: instant.toISOString() });
  });

  it("keeps the choice open and says what went wrong when a save fails", async () => {
    patch.mockRejectedValueOnce(new Error("Storage unavailable"));
    await render(due);
    await click("Clear date");
    expect(text()).toContain("Storage unavailable");
    expect(saved).not.toHaveBeenCalled();
    patch.mockRejectedValueOnce(new Error("Still unavailable"));
    await click("Later");
    await click("Next week");
    expect(text()).toContain("Revisit later");
    expect(text()).toContain("Still unavailable");
  });
});
