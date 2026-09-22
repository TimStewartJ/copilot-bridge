import { createElement } from "react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { HomeSnapshot } from "../../shared/home";
import { createDialogTestHarness, type DialogTestHarness } from "../test-dialog-harness";
import { advanceTimersByTimeAct, findAllByTag, getReactProps, waitTick } from "../test-react-harness";
const api = vi.hoisted(() => ({ fetchHome: vi.fn(), fetchHomeInput: vi.fn(), patchChecklistItem: vi.fn(), submitElicitationResponse: vi.fn(), submitUserInputResponse: vi.fn() }));
vi.mock("../api", () => api);
vi.mock("./PullToRefresh", () => ({ default: ({ children }: { children: unknown }) => children }));
import NativeHome from "./NativeHome";
const emptyPage = () => ({ items: [], total: 0, offset: 0, hasMore: false });
const empty = (): HomeSnapshot => ({ section: "overview", tasks: emptyPage(), deferredTaskTotal: 0, inputs: emptyPage(), followUps: emptyPage(), actions: emptyPage(), replies: emptyPage(), inputErrors: [], sourceErrors: [], openActionTotal: 0, timezone: "UTC" });
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
    snapshot.tasks = { items: [{ id: "existing", title: "Existing task", kind: "ongoing", deferred: false, nextAction: "Read the reply", sessionId: "existing-chat", runningCount: 0 }], total: 1, offset: 0, hasMore: false };
    api.fetchHome.mockResolvedValue(snapshot);
    await render();
    expect(harness.dom.container.textContent).toContain("Read the reply");
    await click("Open task"); expect(selectTask).toHaveBeenCalledExactlyOnceWith("existing");
    await click("Continue conversation"); expect(selectSession).toHaveBeenCalledExactlyOnceWith("existing-chat", "existing");
    expect(harness.dom.container.textContent).not.toContain("Accept commitment");
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
    api.fetchHome.mockResolvedValue(snapshot); api.patchChecklistItem.mockResolvedValue({});
    await render(); await click("Complete Accepted global item");
    expect(api.patchChecklistItem).toHaveBeenCalledExactlyOnceWith("original-action", { done: true });
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
  it("explains an all-deferred overview without claiming there are no active tasks", async () => {
    const snapshot = empty();
    snapshot.deferredTaskTotal = 2;
    snapshot.followUps = { items: [{ taskId: "deferred", title: "Set aside", deferred: true, at: "2000-01-01T00:00:00Z", waitingOn: "A reply" }], total: 1, offset: 0, hasMore: false };
    api.fetchHome.mockResolvedValue(snapshot);
    await render();
    const text = harness.dom.container.textContent;
    expect(text).toContain("2 deferred tasks in View all tasks");
    expect(text).toContain("View all tasks");
    expect(text).toContain("Ready to revisit");
    expect(text).toContain("Waiting for: A reply");
    expect(text).toContain("Resume task");
    expect(text).not.toContain("No active, unmuted tasks");
    expect(text).not.toContain("overdue");
  });
});
