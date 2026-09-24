import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HomeSnapshot } from "../../shared/home";
import type { TaskOverviewRow } from "../../shared/task-overview";
import { createDialogTestHarness, type DialogTestHarness } from "../test-dialog-harness";
import { advanceTimersByTimeAct, findAllByTag, getReactProps, waitTick } from "../test-react-harness";
const api = vi.hoisted(() => ({ fetchHome: vi.fn(), fetchHomeInput: vi.fn(), fetchTaskOverview: vi.fn(), patchChecklistItem: vi.fn(), patchTask: vi.fn(),
  submitElicitationResponse: vi.fn(), submitUserInputResponse: vi.fn() }));
vi.mock("../api", () => api);
vi.mock("./PullToRefresh", () => ({ default: ({ children }: { children: unknown }) => children }));
import NativeHome from "./NativeHome";
import { CHECKLIST_UNDO_MS, describeDeadline } from "./HomeChecklist";
const emptyPage = () => ({ items: [], total: 0, offset: 0, hasMore: false });
const counts = () => ({ needs_you: 0, in_motion: 0, up_next: 0, waiting: 0, no_next_step: 0, gone_quiet: 0, set_aside: 0 });
const empty = (): HomeSnapshot => ({ section: "overview", tasks: emptyPage(), deferredTaskTotal: 0, inputs: emptyPage(), followUps: emptyPage(), actions: emptyPage(), replies: emptyPage(),
  attention: [], resume: [], quiet: emptyPage(), taskCounts: counts(),
  inputErrors: [], sourceErrors: [], actionCounts: { open: 0, overdue: 0, dueToday: 0 }, today: "2026-09-22", timezone: "UTC" });
const row = (overrides: Partial<TaskOverviewRow> = {}): TaskOverviewRow => ({ id: "task", title: "Task", kind: "task", muted: false, deferred: false,
  state: "in_motion", reasons: [], staleWait: false, idleDays: 2, busyCount: 0, stalledCount: 0, inputCount: 0, automationCount: 0, order: 0, ...overrides });
describe("Home within native Bridge", () => {
  let harness: DialogTestHarness;
  const selectTask = vi.fn(), selectSession = vi.fn();
  beforeEach(async () => { vi.resetAllMocks(); vi.useFakeTimers(); harness = await createDialogTestHarness(); api.fetchHome.mockResolvedValue(empty()); });
  afterEach(async () => { await harness.cleanup(); vi.useRealTimers(); });
  async function render() { await harness.render(createElement(MemoryRouter, null, createElement(NativeHome, { onSelectTask: selectTask, onSelectSession: selectSession }))); }
  async function click(label: string) {
    const button = findAllByTag(harness.dom.container, "BUTTON").find(node => node.textContent?.trim() === label || getReactProps(node)?.["aria-label"] === label);
    expect(button, label).toBeDefined();
    await harness.act(async () => { await getReactProps(button)!.onClick({ preventDefault() {}, stopPropagation() {} }); await waitTick(); });
    await advanceTimersByTimeAct(harness.act, 1);
  }
  it("opens the original task and linked conversation without creating replacement work", async () => {
    const snapshot = empty();
    snapshot.attention = [row({ id: "existing", title: "Existing task", kind: "ongoing", state: "needs_you", reasons: ["revisit"], nextTouchAt: "2026-09-20T00:00:00Z",
      nextAction: "Read the reply", sessionId: "existing-chat" })];
    api.fetchHome.mockResolvedValue(snapshot);
    await render();
    const text = harness.dom.container.textContent ?? "";
    expect(text).toContain("1 needs you");
    expect(text).toContain("Next: Read the reply");
    await click("Open task"); expect(selectTask).toHaveBeenCalledExactlyOnceWith("existing");
    await click("Continue conversation"); expect(selectSession).toHaveBeenCalledExactlyOnceWith("existing-chat", "existing");
    expect(text).not.toContain("Accept commitment");
  });
  it("moves a due revisit a week out through the normal task update", async () => {
    const snapshot = empty();
    snapshot.attention = [row({ id: "due", title: "Due task", state: "needs_you", reasons: ["revisit"], nextTouchAt: "2026-09-20T00:00:00Z" })];
    api.fetchHome.mockResolvedValue(snapshot); api.patchTask.mockResolvedValue({});
    const before = Date.now();
    await render(); await click("Revisit next week");
    expect(api.patchTask).toHaveBeenCalledOnce();
    const [id, patch] = api.patchTask.mock.calls[0];
    expect(id).toBe("due");
    expect(Date.parse(patch.nextTouchAt) - before).toBeGreaterThanOrEqual(7 * 86_400_000);
    expect(Object.keys(patch)).toEqual(["nextTouchAt"]);
  });
  it("lists recently touched tasks to resume in their latest conversation", async () => {
    const snapshot = empty();
    snapshot.resume = [row({ id: "recent", title: "Recent task", waitingOn: "A review", sessionId: "recent-chat" }), row({ id: "bare", title: "Bare task", order: 1 })];
    api.fetchHome.mockResolvedValue(snapshot);
    await render();
    const text = harness.dom.container.textContent ?? "";
    expect(text).toContain("Pick up where you left off");
    expect(text).toContain("Waiting for: A review");
    expect(text).toContain("No next step");
    const resumes = findAllByTag(harness.dom.container, "BUTTON").filter(node => node.textContent?.trim() === "Resume");
    expect(resumes).toHaveLength(2);
    await harness.act(async () => { getReactProps(resumes[0])!.onClick(); await waitTick(); });
    expect(selectSession).toHaveBeenCalledExactlyOnceWith("recent-chat", "recent");
    await harness.act(async () => { getReactProps(resumes[1])!.onClick(); await waitTick(); });
    expect(selectTask).toHaveBeenCalledExactlyOnceWith("bare");
  });
  it("settles a quiet task and undoes it by restoring every prior value", async () => {
    const snapshot = empty();
    const quiet = row({ id: "quiet", title: "Old idea", state: "gone_quiet", idleDays: 45, nextAction: "Draft outline", waitingOn: "Sam", nextTouchAt: "2026-01-01T00:00:00Z" });
    snapshot.quiet = { items: [quiet], total: 3, offset: 0, hasMore: true };
    api.fetchHome.mockResolvedValue(snapshot); api.patchTask.mockResolvedValue({});
    await render();
    const text = () => harness.dom.container.textContent ?? "";
    expect(text()).toContain("Worth a look");
    expect(text()).toContain("Quiet for 6 weeks");
    expect(text()).toContain("3 worth a look");
    await click("Finished");
    expect(api.patchTask).toHaveBeenCalledExactlyOnceWith("quiet", { completionAction: "complete-and-archive" });
    expect(text()).toContain("Marked complete: “Old idea”");
    await click("Undo");
    expect(api.patchTask).toHaveBeenLastCalledWith("quiet", { status: "active", deferred: false, nextAction: "Draft outline", waitingOn: "Sam", nextTouchAt: "2026-01-01T00:00:00Z" });
    expect(text()).not.toContain("Marked complete: “Old idea”");
  });
  it("offers ongoing quiet tasks set-aside choices instead of completion", async () => {
    const snapshot = empty();
    snapshot.quiet = { items: [row({ id: "feed", title: "Feed", kind: "ongoing", state: "gone_quiet", idleDays: 60 })], total: 1, offset: 0, hasMore: false };
    api.fetchHome.mockResolvedValue(snapshot); api.patchTask.mockResolvedValue({});
    await render();
    const labels = findAllByTag(harness.dom.container, "BUTTON").map(node => node.textContent?.trim());
    expect(labels).not.toContain("Finished");
    expect(labels).toContain("Set aside…");
    await click("Mute");
    expect(api.patchTask).toHaveBeenCalledExactlyOnceWith("feed", { muted: true });
  });
  it("submits the exact native user-input identity through the existing response API", async () => {
    const snapshot = empty();
    snapshot.inputs = { items: [{ kind: "user_input", title: "Native chat", sessionId: "native-session", requestId: "native-request", question: "Which option?", pendingCount: 1 }], total: 1, offset: 0, hasMore: false };
    api.fetchHomeInput.mockResolvedValue({ kind: "user_input", title: "Native chat", sessionId: "native-session", request: { requestId: "native-request", question: "Which option?", choices: ["A", "B"], allowFreeform: false } });
    api.fetchHome.mockResolvedValue(snapshot); api.submitUserInputResponse.mockResolvedValue({});
    await render(); await click("Answer"); await click("A");
    expect(api.submitUserInputResponse).toHaveBeenCalledExactlyOnceWith("native-session", "native-request", { answer: "A", wasFreeform: false });
    expect(api.submitElicitationResponse).not.toHaveBeenCalled();
  });
  it("retains an unsent answer draft during refresh failure and does not submit to an unverified source", async () => {
    const snapshot = empty();
    snapshot.inputs = { items: [{ kind: "user_input", title: "Native chat", sessionId: "native-session", requestId: "native-request", question: "Tell me", pendingCount: 1 }], total: 1, offset: 0, hasMore: false };
    api.fetchHomeInput.mockResolvedValue({ kind: "user_input", title: "Native chat", sessionId: "native-session", request: { requestId: "native-request", question: "Tell me", allowFreeform: true } });
    api.fetchHome.mockResolvedValue(snapshot);
    await render(); await click("Answer");
    const field = findAllByTag(harness.dom.container, "INPUT").find(node => getReactProps(node)?.["aria-label"] === "Answer question");
    await harness.act(async () => { getReactProps(field)!.onChange({ target: { value: "Unsaved response" } }); await waitTick(); });
    api.fetchHome.mockRejectedValue(new Error("Source offline"));
    await harness.act(async () => { await harness.queryClient.refetchQueries({ queryKey: ["dashboard", "home"] }); });
    await advanceTimersByTimeAct(harness.act, 1);
    expect(getReactProps(field)?.value).toBe("Unsaved response");
    expect(harness.dom.container.textContent).toContain("Your draft is retained");
    const form = findAllByTag(harness.dom.container, "FORM")[0];
    await harness.act(async () => { getReactProps(form)!.onSubmit({ preventDefault() {} }); await waitTick(); });
    expect(api.submitUserInputResponse).not.toHaveBeenCalled();
  });
  it("does not turn a failed initial read into a reassuring empty state", async () => {
    api.fetchHome.mockRejectedValue(new Error("Offline"));
    await render();
    expect(harness.dom.container.textContent).toContain("Home is unavailable. Try refreshing.");
    expect(harness.dom.container.textContent).not.toContain("No questions on this page");
  });
  it("completes the original checklist item through its existing endpoint", async () => {
    const snapshot = empty();
    snapshot.actions = { items: [{ id: "original-action", taskId: null, text: "Accepted global item" }], total: 1, offset: 0, hasMore: false };
    snapshot.actionCounts = { open: 1, overdue: 0, dueToday: 0 };
    api.fetchHome.mockResolvedValue(snapshot); api.patchChecklistItem.mockResolvedValue({});
    await render(); await click("Complete Accepted global item");
    expect(api.patchChecklistItem).toHaveBeenCalledExactlyOnceWith("original-action", { done: true });
  });
  it("keeps a completed item in place with an Undo that reopens it, then lets it go", async () => {
    const snapshot = empty();
    snapshot.actions = { items: [{ id: "first", taskId: "task", taskTitle: "Shared task", text: "First step", deadline: "2026-09-21" },
      { id: "second", taskId: "task", taskTitle: "Shared task", text: "Second step" }], total: 2, offset: 0, hasMore: false };
    snapshot.actionCounts = { open: 2, overdue: 1, dueToday: 0 };
    api.fetchHome.mockResolvedValue(snapshot); api.patchChecklistItem.mockResolvedValue({});
    await render();
    const text = () => harness.dom.container.textContent ?? "";
    expect(text().match(/from Shared task/g)).toHaveLength(2);
    expect(text()).toContain("Overdue");
    expect(text()).toContain("No date");
    expect(text()).toContain("Overdue since yesterday");
    expect(text()).toContain("1 overdue");
    const without = { ...snapshot, actions: { ...snapshot.actions, items: snapshot.actions.items.slice(1), total: 1 } };
    api.fetchHome.mockResolvedValue(without);
    await click("Complete First step");
    expect(text()).toContain("First step");
    expect(text()).toContain("Undo");
    api.fetchHome.mockResolvedValue(snapshot);
    await click("Undo");
    expect(api.patchChecklistItem).toHaveBeenLastCalledWith("first", { done: false });
    api.fetchHome.mockResolvedValue(without);
    await click("Complete First step");
    await advanceTimersByTimeAct(harness.act, CHECKLIST_UNDO_MS + 1);
    expect(text()).not.toContain("First step");
    expect(text()).toContain("Second step");
  });
  it("puts a failed completion back and says the change was not saved", async () => {
    const snapshot = empty();
    snapshot.actions = { items: [{ id: "item", taskId: null, text: "Fragile item" }], total: 1, offset: 0, hasMore: false };
    snapshot.actionCounts = { open: 1, overdue: 0, dueToday: 0 };
    api.fetchHome.mockResolvedValue(snapshot); api.patchChecklistItem.mockRejectedValue(new Error("Offline"));
    await render(); await click("Complete Fragile item");
    expect(harness.dom.container.textContent).toContain("The change was not saved");
    expect(harness.dom.container.textContent).not.toContain("Undo");
  });
  it("says deadlines relative to the server's day", () => {
    expect(describeDeadline("2026-09-20", "2026-09-22")).toMatchObject({ tone: "danger", label: expect.stringMatching(/^Overdue since /) });
    expect(describeDeadline("2026-09-21", "2026-09-22")).toEqual({ tone: "danger", label: "Overdue since yesterday" });
    expect(describeDeadline("2026-09-22", "2026-09-22")).toEqual({ tone: "warning", label: "Due today" });
    expect(describeDeadline("2026-09-23", "2026-09-22")).toEqual({ tone: "neutral", label: "Due tomorrow" });
    expect(describeDeadline("2026-09-25", "2026-09-22").label).toMatch(/^Due \D+$/);
    expect(describeDeadline("2027-01-05", "2026-09-22").label).toContain("2027");
  });
  it("presents readable Markdown excerpts without changing or acknowledging their source", async () => {
    const snapshot = empty();
    snapshot.replies = { items: [{ sessionId: "native-session", title: "Native reply", sourceEventId: "source-event",
      excerpt: "**Useful answer** with `literal_code`" }], total: 1, offset: 0, hasMore: false };
    api.fetchHome.mockResolvedValue(snapshot);
    await render();
    expect(harness.dom.container.textContent).toContain("Useful answer with literal_code");
    expect(harness.dom.container.textContent).not.toContain("**Useful answer**");
    expect(snapshot.replies.items[0].excerpt).toBe("**Useful answer** with `literal_code`");
    expect(selectSession).not.toHaveBeenCalled();
  });
  it("groups the full checklist under its tasks", async () => {
    const snapshot = empty(); snapshot.section = "actions";
    snapshot.actions = { items: [{ id: "a", taskId: "task", taskTitle: "Shared task", text: "First step" }, { id: "b", taskId: "task", taskTitle: "Shared task", text: "Second step" }], total: 2, offset: 0, hasMore: false };
    snapshot.actionCounts = { open: 2, overdue: 0, dueToday: 0 };
    api.fetchHome.mockResolvedValue(snapshot);
    await harness.render(createElement(MemoryRouter, { initialEntries: ["/dashboard?section=actions"] }, createElement(NativeHome, { onSelectTask: selectTask, onSelectSession: selectSession })));
    const text = harness.dom.container.textContent ?? "";
    expect(text.match(/Shared task/g)).toHaveLength(1);
    expect(text).not.toContain("from Shared task");
  });
  it("says plainly when nothing needs attention without inventing work", async () => {
    await render();
    const text = harness.dom.container.textContent ?? "";
    expect(text).toContain("Nothing needs you right now.");
    expect(text).toContain("Nothing in motion this week.");
    expect(text).not.toContain("Worth a look");
  });
});
