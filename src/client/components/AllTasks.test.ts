import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskOverview, TaskOverviewRow } from "../../shared/task-overview";
import { createDialogTestHarness, type DialogTestHarness } from "../test-dialog-harness";
import { findAllByTag, getReactProps, waitTick, waitUntilAct } from "../test-react-harness";
const api = vi.hoisted(() => ({ fetchTaskOverview: vi.fn(), patchTask: vi.fn() }));
vi.mock("../api", () => api);
vi.mock("./PullToRefresh", () => ({ default: ({ children }: { children: unknown }) => children }));
import AllTasks from "./AllTasks";
import { createTaskActivity } from "../../test-support/task-attention";
import type { TaskIndicator } from "../hooks/useTaskIndicators";

const row = (overrides: Partial<TaskOverviewRow> = {}): TaskOverviewRow => ({ id: "t", title: "Task", kind: "task", muted: false, deferred: false,
  state: "up_next", reasons: [], staleWait: false, idleDays: 10, busyCount: 0, stalledCount: 0, inputCount: 0, automationCount: 0, activity: createTaskActivity(), order: 0, ...overrides });
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
  async function render(tasks: TaskOverviewRow[], compact = false, taskIndicators?: ReadonlyMap<string, TaskIndicator>) {
    api.fetchTaskOverview.mockResolvedValue(overview(tasks));
    await harness.render(createElement(AllTasks, { onSelectTask: selectTask, compact, taskIndicators }));
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
    expect(needs?.textContent).toContain("Needs you");
    expect(needs?.textContent).toContain("Deferred");
    const upNext = findAllByTag(harness.dom.container, "SECTION").find(node => getReactProps(node)?.["aria-label"] === "Up next");
    expect(upNext?.textContent).not.toContain("Deferred");
  });

  it("keeps manual task/group order while attention changes", async () => {
    stored.set("bridge.allTasks.grouping", "group");
    const tasks = [
      row({ id: "later-group", title: "Later group task", groupId: "b", groupName: "Second", groupOrder: 2, order: 0 }),
      row({ id: "first", title: "First in order", groupId: "a", groupName: "First", groupOrder: 1, order: 0, state: "waiting", waitingOn: "Reviewers", nextTouchAt: "2099-01-01T00:00:00Z" }),
      row({ id: "second", title: "Second in order", groupId: "a", groupName: "First", groupOrder: 1, order: 1, state: "needs_you", inputCount: 1 }),
      row({ id: "third", title: "Third in order", groupId: "a", groupName: "First", groupOrder: 1, order: 2 }),
    ];
    await render(tasks);
    const taskButtons = () => buttons().filter(node => tasks.some(task => node.textContent?.startsWith(task.title)));
    expect(taskButtons().map(node => getReactProps(node)?.["aria-label"])).toEqual([
      "First in order", "Second in order, Needs you", "Third in order, Needs a look", "Later group task, Needs a look",
    ]);
    await harness.render(createElement(AllTasks, { onSelectTask: selectTask, taskIndicators: new Map([
      ["first", { busy: false, busyCount: 0, stalled: false, unread: false, unreadCount: 0, needsUserInputCount: 1, readStateKnown: true, sessionStateKnown: true, lastActivity: "" }],
    ]) }));
    expect(taskButtons().map(node => getReactProps(node)?.["aria-label"])).toEqual([
      "First in order, Needs you", "Second in order, Needs you", "Third in order, Needs a look", "Later group task, Needs a look",
    ]);
    expect(findAllByTag(harness.dom.container, "SECTION").map(node => getReactProps(node)?.["aria-label"])).toEqual(["First", "Second"]);
  });

  it("shows new replies and questions distinctly and keeps automatic work unbadged", async () => {
    const indicators = new Map<string, TaskIndicator>([
      ["new", { busy: true, busyCount: 1, stalled: false, unread: true, unreadCount: 1, readStateKnown: true, sessionStateKnown: true, lastActivity: "" }],
    ]);
    await render([
      row({ id: "asks", title: "Approval", state: "needs_you", inputCount: 1 }),
      row({ id: "new", title: "Finished output" }),
      row({ id: "auto", title: "Monitoring", activity: createTaskActivity({ deferredCount: 1 }) }),
    ], false, indicators);
    const iconKinds = findAllByTag(harness.dom.container, "SPAN").map(node => getReactProps(node)?.["data-status"]).filter(Boolean);
    expect(iconKinds).toEqual(["needs-input", "unread"]);
    expect(text()).toContain("New replies");
    expect(text()).toContain("Automatic check scheduled");
    expect(iconKinds).not.toContain("working");
  });

  it("shows a shared source gap once instead of putting Unknown on every affected row", async () => {
    const tasks = ["First copied task", "Second copied task"].map((title, index) => row({
      id: `copy-${index}`, title, order: index, activity: createTaskActivity({
        known: false, sessionIndexKnown: false,
        unavailable: { scope: "source", reason: "Production conversations are isolated." },
      }),
    }));
    await render(tasks);
    const notices = findAllByTag(harness.dom.container, "DIV").filter(node => getReactProps(node)?.["data-task-attention-notice"]);
    expect(notices).toHaveLength(1);
    expect(findAllByTag(harness.dom.container, "SUMMARY")[0].textContent).toContain("Activity data incomplete");
    expect(findAllByTag(harness.dom.container, "LI").map(node => node.textContent)).toEqual([
      "First copied task", "Second copied task",
    ]);
    expect(buttons().filter(node => tasks.some(task => node.textContent?.startsWith(task.title)))
      .map(node => getReactProps(node)?.["aria-label"])).toEqual(["First copied task", "Second copied task"]);
    expect(findAllByTag(harness.dom.container, "SPAN").map(node => getReactProps(node)?.["data-status"]).filter(Boolean)).toEqual([]);
  });

  it("does not show a disclosure or inferred attention for expected preview isolation", async () => {
    await render([row({ title: "Copied task", activity: createTaskActivity({
      known: false, sessionIndexKnown: false,
      unavailable: { scope: "source", reason: "Production conversations are isolated.", expectedInPreview: true },
    }) })]);
    expect(findAllByTag(harness.dom.container, "DIV").filter(node => getReactProps(node)?.["data-task-attention-notice"])).toHaveLength(0);
    expect(findAllByTag(harness.dom.container, "SPAN").map(node => getReactProps(node)?.["data-status"]).filter(Boolean)).toEqual([]);
    expect(buttons().find(node => getReactProps(node)?.["aria-label"] === "Copied task")).toBeDefined();
  });
});
