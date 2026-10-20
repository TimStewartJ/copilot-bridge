import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReactDomHarness, findAllByTag, getReactProps, type ReactDomHarness } from "../test-react-harness";
import type { TaskAttentionHealth } from "../hooks/useTaskAttention";
import TaskAttentionNotice from "./TaskAttentionNotice";

describe("task activity source notice", () => {
  let harness: ReactDomHarness;
  const health: TaskAttentionHealth = {
    state: "partial", messages: ["Production conversations are not copied into this preview."],
    affectedTasks: [{ id: "one", title: "First task", reason: "Missing preview conversation." },
      { id: "two", title: "Second task", reason: "Missing preview conversation." }],
  };
  beforeEach(async () => { harness = await createReactDomHarness(); });
  afterEach(async () => { await harness.cleanup(); });
  it("reports a shared problem once and puts affected tasks behind one disclosure", async () => {
    await harness.render(createElement(TaskAttentionNotice, { health }));
    expect(findAllByTag(harness.dom.container, "DETAILS")).toHaveLength(1);
    expect(findAllByTag(harness.dom.container, "SUMMARY")[0].textContent).toBe("Activity data incomplete2 tasks");
    expect(findAllByTag(harness.dom.container, "LI").map(node => node.textContent)).toEqual([
      "First task: Missing preview conversation.", "Second task: Missing preview conversation.",
    ]);
    expect(findAllByTag(harness.dom.container, "SPAN").some(node => getReactProps(node)?.["data-status"])).toBe(false);
  });
  it("uses a loading message before the first reading and explicitly labels stale readings", async () => {
    await harness.render(createElement(TaskAttentionNotice, { health: { ...health, state: "loading" } }));
    expect(harness.dom.container.textContent).toBe("Loading task activity...");
    expect(findAllByTag(harness.dom.container, "DETAILS")).toHaveLength(0);
    await harness.render(createElement(TaskAttentionNotice, { health: { ...health, state: "stale" } }));
    expect(harness.dom.container.textContent).toContain("Showing the last reading");
    expect(findAllByTag(harness.dom.container, "SUMMARY")[0].textContent).toContain("Activity refresh failed");
  });
  it("uses the singular for a selected task's source notice", async () => {
    await harness.render(createElement(TaskAttentionNotice, { health: { ...health, affectedTasks: health.affectedTasks.slice(0, 1) } }));
    expect(findAllByTag(harness.dom.container, "SUMMARY")[0].textContent).toBe("Activity data incomplete1 task");
  });
  it("keeps the narrow rail count short and does not repeat one common reason for every task", async () => {
    await harness.render(createElement(TaskAttentionNotice, { compact: true, health: {
      ...health, messages: ["Missing preview conversation."],
    } }));
    expect(findAllByTag(harness.dom.container, "SUMMARY")[0].textContent).toBe("Activity data incomplete2");
    expect(findAllByTag(harness.dom.container, "LI").map(node => node.textContent)).toEqual(["First task", "Second task"]);
    expect(findAllByTag(harness.dom.container, "SPAN").some(node => getReactProps(node)?.["aria-label"] === "2 tasks")).toBe(true);
  });
  it("keeps one accessible source indicator on the collapsed rail that opens the full list", async () => {
    const onExpand = vi.fn();
    await harness.render(createElement(TaskAttentionNotice, { health, collapsed: true, onExpand }));
    const button = findAllByTag(harness.dom.container, "BUTTON")[0];
    expect(getReactProps(button)?.["aria-label"]).toContain("Activity data incomplete. Expand the task list for details.");
    await harness.act(async () => { getReactProps(button)?.onClick(); });
    expect(onExpand).toHaveBeenCalledOnce();
  });
});
