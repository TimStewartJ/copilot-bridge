import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskOverview, TaskOverviewRow } from "../../shared/task-overview";
import { createDialogTestHarness, type DialogTestHarness } from "../test-dialog-harness";
import { findAllByTag, getReactProps, waitTick, waitUntilAct } from "../test-react-harness";
const api = vi.hoisted(() => ({ fetchTaskOverview: vi.fn(), patchTask: vi.fn() }));
vi.mock("../api", () => api);
vi.mock("./PullToRefresh", () => ({ default: ({ children }: { children: unknown }) => children }));
import AllTasks from "./AllTasks";

const row = (overrides: Partial<TaskOverviewRow> = {}): TaskOverviewRow => ({ id: "t", title: "Task", kind: "task", muted: false, deferred: false,
  state: "up_next", reasons: [], staleWait: false, idleDays: 10, busyCount: 0, stalledCount: 0, inputCount: 0, automationCount: 0, order: 0, ...overrides });
function overview(tasks: TaskOverviewRow[]): TaskOverview {
  const counts = { needs_you: 0, in_motion: 0, up_next: 0, waiting: 0, no_next_step: 0, gone_quiet: 0, set_aside: 0 };
  for (const task of tasks) counts[task.state] += 1;
  return { tasks, sessionsComplete: true, counts, sourceErrors: [], generatedAt: "2026-09-22T12:00:00Z" };
}

describe("All tasks", () => {
  let harness: DialogTestHarness;
  const selectTask = vi.fn();
  const text = () => harness.dom.container.textContent ?? "";
  const buttons = () => findAllByTag(harness.dom.container, "BUTTON");
  async function press(node: unknown) { await harness.act(async () => { await getReactProps(node)!.onClick({ preventDefault() {}, stopPropagation() {} }); await waitTick(); }); }
  let stored: Map<string, string>;
  beforeEach(async () => {
    vi.resetAllMocks();
    stored = new Map();
    vi.stubGlobal("localStorage", { getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => { stored.set(key, value); } });
    harness = await createDialogTestHarness();
  });
  afterEach(async () => { await harness.cleanup(); vi.unstubAllGlobals(); });
  async function render(tasks: TaskOverviewRow[], compact = false) {
    api.fetchTaskOverview.mockResolvedValue(overview(tasks));
    await harness.render(createElement(AllTasks, { onSelectTask: selectTask, compact }));
    await waitUntilAct(harness.act, () => text().includes("active"), { label: "overview loaded" });
  }

  it("groups every active task by state, keeps set-aside collapsed and never mentions checklist items", async () => {
    await render([
      row({ id: "a", title: "Needs answer", state: "needs_you", inputCount: 1 }),
      row({ id: "b", title: "Old plan", state: "gone_quiet", idleDays: 50, lastEngagedAt: "2026-08-01T00:00:00Z" }),
      row({ id: "c", title: "Parked", state: "set_aside", deferred: true }),
    ]);
    expect(text()).toContain("3 active");
    const sections = findAllByTag(harness.dom.container, "SECTION").map(node => getReactProps(node)?.["aria-label"]);
    expect(sections).toEqual(["Needs you", "Gone quiet", "Set aside"]);
    expect(text()).toContain("Needs answer");
    expect(text()).not.toContain("Parked");
    expect(text()).not.toMatch(/checklist/i);
    await press(buttons().find(node => node.textContent?.trim() === "Set aside" && getReactProps(node)?.["aria-expanded"] === false));
    expect(text()).toContain("Parked");
    await press(buttons().find(node => node.textContent?.includes("Needs answer")));
    expect(selectTask).toHaveBeenCalledWith("a");
  });

  it("switches to groups and remembers the choice", async () => {
    await render([row({ id: "a", title: "One", groupId: "g", groupName: "Home projects", groupColor: "blue" }), row({ id: "b", title: "Two" })]);
    await press(buttons().find(node => node.textContent?.trim() === "By group"));
    const sections = findAllByTag(harness.dom.container, "SECTION").map(node => getReactProps(node)?.["aria-label"]);
    expect(sections).toEqual(["Home projects", "Ungrouped"]);
    expect(stored.get("bridge.allTasks.grouping")).toBe("group");
  });

  it("finishes selected tasks in bulk with undo, and refuses a selection that includes ongoing work", async () => {
    await render([row({ id: "a", title: "Done thing", nextAction: "Ship" }), row({ id: "b", title: "Feed", kind: "ongoing" })]);
    api.patchTask.mockResolvedValue({});
    const finished = () => buttons().find(node => node.textContent?.trim() === "Finished");
    await press(buttons().find(node => getReactProps(node)?.["aria-label"] === "Select Done thing"));
    await press(buttons().find(node => getReactProps(node)?.["aria-label"] === "Select Feed"));
    expect(text()).toContain("2 selected");
    expect(getReactProps(finished())?.disabled).toBe(true);
    await press(buttons().find(node => getReactProps(node)?.["aria-label"] === "Select Feed"));
    await press(finished());
    expect(api.patchTask).toHaveBeenCalledExactlyOnceWith("a", { completionAction: "complete-and-archive" });
    expect(text()).not.toContain("1 selected");
    await press(buttons().find(node => node.textContent?.trim() === "Undo"));
    expect(api.patchTask).toHaveBeenLastCalledWith("a", { status: "active", deferred: false, nextAction: "Ship", waitingOn: null, nextTouchAt: null });
  });

  it("filters by state with chips on a phone and has no bulk selection there", async () => {
    await render([row({ id: "a", title: "Moving", state: "in_motion" }), row({ id: "b", title: "Quiet one", state: "gone_quiet" })], true);
    expect(buttons().some(node => getReactProps(node)?.role === "checkbox")).toBe(false);
    await press(buttons().find(node => node.textContent?.trim() === "Gone quiet 1"));
    expect(text()).toContain("Quiet one");
    expect(text()).not.toContain("Moving");
  });

  it("says task states are unavailable rather than showing an empty list", async () => {
    api.fetchTaskOverview.mockRejectedValue(new Error("Offline"));
    await harness.render(createElement(AllTasks, { onSelectTask: selectTask }));
    await waitUntilAct(harness.act, () => !text().includes("Loading task states"), { label: "overview failed" });
    expect(text()).toContain("Task states are unavailable, not empty.");
    expect(text()).not.toContain("No active tasks");
  });
  it("says a surfaced task is still deferred", async () => {
    await render([row({ id: "d", title: "Parked but asking", state: "needs_you", reasons: ["question"], inputCount: 1, deferred: true }), row({ id: "e", title: "Plain" })]);
    const needs = findAllByTag(harness.dom.container, "SECTION").find(node => getReactProps(node)?.["aria-label"] === "Needs you");
    expect(needs?.textContent).toContain("Answer needed");
    expect(needs?.textContent).toContain("Deferred");
    const upNext = findAllByTag(harness.dom.container, "SECTION").find(node => getReactProps(node)?.["aria-label"] === "Up next");
    expect(upNext?.textContent).not.toContain("Deferred");
  });
});
