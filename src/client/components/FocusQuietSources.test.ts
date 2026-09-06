import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FocusQuietConcern } from "../api";
import { focusAlert, focusDecision, focusDetails, focusDigest, focusSnapshot, focusTask, FOCUS_TEST_NOW_MS } from "../test-focus-fixtures";
import { changeFocusField, clickFocusButton, createFocusTestHarness, submitFocusForm, type FocusTestHarness } from "../test-focus-harness";
import { advanceTimersByTimeAct, findAllByTag, getReactProps, waitUntilAct } from "../test-react-harness";

const api = vi.hoisted(() => ({
  fetchFocusQuietConcernPage: vi.fn(), fetchFocusEventDigestPage: vi.fn(), markFocusDigestViewed: vi.fn(),
}));
vi.mock("../api", async () => ({ ...await vi.importActual<typeof import("../api")>("../api"), ...api }));
import FocusQuietSources from "./FocusQuietSources";

describe("Quiet concern retrieval", () => {
  let harness: FocusTestHarness;
  beforeEach(async () => {
    harness = await createFocusTestHarness();
    vi.useFakeTimers();
    vi.setSystemTime(FOCUS_TEST_NOW_MS);
    vi.resetAllMocks();
  });
  afterEach(async () => { await harness.cleanup(); });
  const callbacks = () => ({
    tasks: [focusTask()], taskGroups: [], onSelectTask: vi.fn(), onSelectSession: vi.fn(),
    onChanged: vi.fn(async () => undefined), onInspectHistory: vi.fn(), onInspectHistoryFilter: vi.fn(),
  });
  const quietDecision = (): FocusQuietConcern => ({
    ...focusDecision({ taskState: "muted", title: "Muted choice without Events" }), attentionVisible: false, suppressionReason: "muted",
  });

  it("keeps inventory collapsed and unconsumed until deliberately opened", async () => {
    await harness.render(createElement(FocusQuietSources, { snapshot: focusSnapshot(), ...callbacks() }));
    expect(api.fetchFocusQuietConcernPage).not.toHaveBeenCalled();
    expect(api.fetchFocusEventDigestPage).not.toHaveBeenCalled();
    expect(api.markFocusDigestViewed).not.toHaveBeenCalled();
    expect(harness.dom.container.textContent).toContain("no unread state");
  });

  it("exposes suppressed Decisions and handed-off Alerts even with no recent Events", async () => {
    const navigation = callbacks();
    const decision = quietDecision();
    const alert: FocusQuietConcern = { ...focusAlert({ lifecycle: "handed_off", taskState: "archived", title: "Archived handoff without Events" }), attentionVisible: false, suppressionReason: "archived" };
    api.fetchFocusQuietConcernPage.mockResolvedValue({ objects: [decision, alert], total: 2, nextOffset: null });
    await harness.render(createElement(FocusQuietSources, { snapshot: focusSnapshot({ quietConcernTotal: 2, quietDigests: [] }), ...navigation }));
    await clickFocusButton(harness, "Quiet sources");
    await waitUntilAct(harness.act, () => Boolean(harness.dom.container.textContent?.includes(decision.title)));
    expect(api.fetchFocusQuietConcernPage).toHaveBeenCalledWith(0, 20, {});
    expect(harness.dom.container.textContent).toContain(alert.title);
    expect(harness.dom.container.textContent).toContain("Loaded 2 of 2 quiet concerns");
    expect(harness.dom.container.textContent).toContain("No quiet Events in the recent digest horizon");
    expect(api.fetchFocusEventDigestPage).not.toHaveBeenCalled();
    expect(api.markFocusDigestViewed).not.toHaveBeenCalled();
    const first = findAllByTag(harness.dom.container, "ARTICLE")[0];
    const history = findAllByTag(first, "BUTTON").find((button) => button.textContent === "Inspect concern History");
    await harness.act(async () => { getReactProps(history)?.onClick?.(); });
    expect(navigation.onInspectHistory).toHaveBeenCalledWith(decision.id);
    expect(findAllByTag(first, "BUTTON").map((button) => button.textContent)).not.toContain("Acknowledge");
  });

  it("links an orphaned source into original-task and exact source-family History filters", async () => {
    const navigation = callbacks();
    const orphaned: FocusQuietConcern = {
      ...focusDecision({ taskId: null, taskTitle: "Deleted responsibility", taskState: "orphaned",
        details: focusDetails({ originalTaskId: "removed-task", originalTaskTitle: "Deleted responsibility", orphanedAt: "2026-09-04T18:00:00Z", sourceFamily: "release:west" }) }),
      attentionVisible: false, suppressionReason: "orphaned",
    };
    api.fetchFocusQuietConcernPage.mockResolvedValue({ objects: [orphaned], total: 1, nextOffset: null });
    await harness.render(createElement(FocusQuietSources, { snapshot: focusSnapshot(), ...navigation }));
    await clickFocusButton(harness, "Quiet sources");
    await waitUntilAct(harness.act, () => Boolean(harness.dom.container.textContent?.includes("Deleted responsibility")));
    await clickFocusButton(harness, "Inspect source History");
    expect(navigation.onInspectHistoryFilter).toHaveBeenCalledWith({ originalTaskId: "removed-task", sourceFamily: "release:west" });
    await clickFocusButton(harness, "Inspect all handed-off work in History");
    expect(navigation.onInspectHistoryFilter).toHaveBeenLastCalledWith({ lifecycle: "handed_off" });
    expect(harness.dom.container.textContent).not.toContain("Global Focus");
  });

  it("paginates the uncapped inventory and retains earlier records through a failed later page", async () => {
    api.fetchFocusQuietConcernPage.mockResolvedValueOnce({ objects: [quietDecision()], total: 21, nextOffset: 20 })
      .mockRejectedValueOnce(new Error("Older records unavailable"))
      .mockResolvedValueOnce({ objects: [{ ...quietDecision(), id: "quiet-last", title: "Last retained choice" }], total: 21, nextOffset: null });
    await harness.render(createElement(FocusQuietSources, { snapshot: focusSnapshot(), ...callbacks() }));
    await clickFocusButton(harness, "Quiet sources");
    await waitUntilAct(harness.act, () => Boolean(harness.dom.container.textContent?.includes("Load more quiet concerns")));
    await clickFocusButton(harness, "Load more quiet concerns");
    await waitUntilAct(harness.act, () => Boolean(harness.dom.container.textContent?.includes("Older records unavailable")));
    expect(harness.dom.container.textContent).toContain("Muted choice without Events");
    await clickFocusButton(harness, "Load more quiet concerns");
    await waitUntilAct(harness.act, () => Boolean(harness.dom.container.textContent?.includes("Last retained choice")));
    expect(api.fetchFocusQuietConcernPage).toHaveBeenLastCalledWith(20, 20, {});
  });

  it("does not mark a quiet digest viewed just by opening the quiet inventory", async () => {
    api.fetchFocusQuietConcernPage.mockResolvedValue({ objects: [], total: 0, nextOffset: null });
    await harness.render(createElement(FocusQuietSources, { snapshot: focusSnapshot({ quietDigests: [focusDigest({ quiet: true })] }), ...callbacks() }));
    await clickFocusButton(harness, "Quiet sources");
    expect(harness.dom.container.textContent).toContain("Release Watch");
    expect(api.markFocusDigestViewed).not.toHaveBeenCalled();
    expect(api.fetchFocusEventDigestPage).not.toHaveBeenCalled();
  });

  it("offers named quiet-task filters and applies search, state, type and source family together", async () => {
    const navigation = callbacks();
    navigation.tasks = [focusTask({ id: "quiet-task-id", title: "Named quiet work", muted: true })];
    api.fetchFocusQuietConcernPage.mockResolvedValue({ objects: [], total: 0, nextOffset: null });
    await harness.render(createElement(FocusQuietSources, { snapshot: focusSnapshot(), ...navigation }));
    await clickFocusButton(harness, "Quiet sources");
    await clickFocusButton(harness, "Quiet filters");
    expect(findAllByTag(harness.dom.container, "OPTION").some((option) => option.textContent === "Named quiet work (muted)")).toBe(true);
    const calls = api.fetchFocusQuietConcernPage.mock.calls.length;
    await changeFocusField(harness, "Task", "quiet-task-id");
    await changeFocusField(harness, "Search quiet concerns", "  delayed release  ");
    await changeFocusField(harness, "Source family", "  release-watch  ");
    await changeFocusField(harness, "Lifecycle", "handed_off");
    await changeFocusField(harness, "Record type", "alert");
    expect(api.fetchFocusQuietConcernPage).toHaveBeenCalledTimes(calls);
    await submitFocusForm(harness);
    expect(api.fetchFocusQuietConcernPage).toHaveBeenLastCalledWith(0, 20, {
      query: "delayed release", taskId: "quiet-task-id", sourceFamily: "release-watch", lifecycle: "handed_off", objectType: "alert",
    });
    expect(harness.dom.container.textContent).toContain("Task: Named quiet work (muted)");
    expect(harness.dom.container.textContent).toContain("Record type: Alerts");
    expect(harness.dom.container.textContent).toContain("This is not an all-clear for other scopes");
    expect(navigation.onChanged).not.toHaveBeenCalled();
    expect(api.markFocusDigestViewed).not.toHaveBeenCalled();
  });

  it("keeps removed task labels from snapshot provenance and preserves exact original-task filtering", async () => {
    const navigation = callbacks();
    api.fetchFocusQuietConcernPage.mockResolvedValue({ objects: [], total: 0, nextOffset: null });
    await harness.render(createElement(FocusQuietSources, { ...navigation, snapshot: focusSnapshot({
      quietConcernTotal: 1,
      quietConcerns: [{
        objectId: "removed-concern", objectType: "decision", activationId: "episode", title: "Retained choice", lifecycle: "active", interventionBy: null,
        taskId: null, taskTitle: "Former task", taskState: "orphaned", originalTaskId: "former-id", originalTaskTitle: "Former task",
        orphanedAt: "2026-09-01T00:00:00Z", sourceFamily: "retained", producer: "observer", sessionId: null,
        updatedAt: "2026-09-05T18:00:00Z", attentionVisible: false, suppressionReason: "orphaned",
      }],
    }) }));
    await clickFocusButton(harness, "Quiet sources");
    await clickFocusButton(harness, "Quiet filters");
    expect(findAllByTag(harness.dom.container, "OPTION").some((option) => option.textContent === "Former task (removed)")).toBe(true);
    await changeFocusField(harness, "Original task", "former-id");
    await submitFocusForm(harness);
    expect(api.fetchFocusQuietConcernPage).toHaveBeenLastCalledWith(0, 20, { originalTaskId: "former-id" });
    expect(harness.dom.container.textContent).toContain("Original task: Former task (removed)");
  });

  it("does not present the unfiltered snapshot total while a filtered request is pending", async () => {
    let finish!: (value: { objects: FocusQuietConcern[]; total: number; nextOffset: null }) => void;
    api.fetchFocusQuietConcernPage.mockImplementation(async (_offset, _limit, filter) => filter.query
      ? new Promise((resolve) => { finish = resolve; })
      : { objects: [quietDecision()], total: 99, nextOffset: null });
    await harness.render(createElement(FocusQuietSources, { snapshot: focusSnapshot({ quietConcernTotal: 999 }), ...callbacks() }));
    await clickFocusButton(harness, "Quiet sources");
    await changeFocusField(harness, "Search quiet concerns", "specific result");
    await submitFocusForm(harness);
    expect(harness.dom.container.textContent).toContain("Loading quiet concern inventory");
    expect(harness.dom.container.textContent).not.toContain("of 99 quiet concerns");
    expect(harness.dom.container.textContent).not.toContain("of 999 quiet concerns");
    await harness.act(async () => { finish({ objects: [], total: 0, nextOffset: null }); });
    await advanceTimersByTimeAct(harness.act, 1);
    expect(harness.dom.container.textContent).toContain("Loaded 0 of 0 quiet concerns");
  });

  it("rejects an oversized search locally and clears all applied quiet filters without altering Events", async () => {
    api.fetchFocusQuietConcernPage.mockImplementation(async (_offset, _limit, filter) => ({
      objects: [{ ...quietDecision(), title: filter.query ? "Filtered choice" : "All quiet choices" }], total: 1, nextOffset: null,
    }));
    await harness.render(createElement(FocusQuietSources, { snapshot: focusSnapshot(), ...callbacks() }));
    await clickFocusButton(harness, "Quiet sources");
    const calls = api.fetchFocusQuietConcernPage.mock.calls.length;
    await changeFocusField(harness, "Search quiet concerns", "x".repeat(501));
    await submitFocusForm(harness);
    expect(api.fetchFocusQuietConcernPage).toHaveBeenCalledTimes(calls);
    expect(harness.dom.container.textContent).toContain("500 characters or fewer");
    await changeFocusField(harness, "Search quiet concerns", "find");
    await submitFocusForm(harness);
    expect(harness.dom.container.textContent).toContain("Filtered choice");
    await clickFocusButton(harness, "Clear quiet filters");
    expect(harness.dom.container.textContent).toContain("All quiet choices");
    expect(harness.dom.container.textContent).not.toContain("Applied quiet filters");
    expect(api.markFocusDigestViewed).not.toHaveBeenCalled();
  });

  it("resets filtered paging and never replaces a newer filter with an older pending response", async () => {
    let finishOld!: (value: { objects: FocusQuietConcern[]; total: number; nextOffset: null }) => void;
    api.fetchFocusQuietConcernPage.mockImplementation(async (offset, _limit, filter) => {
      if (filter.query === "old") return new Promise((resolve) => { finishOld = resolve; });
      if (filter.query === "new") return { objects: [{ ...quietDecision(), title: "New filter result" }], total: 1, nextOffset: null };
      return { objects: [{ ...quietDecision(), id: `unfiltered-${offset}`, title: `Unfiltered page ${offset}` }], total: 21, nextOffset: offset === 0 ? 20 : null };
    });
    await harness.render(createElement(FocusQuietSources, { snapshot: focusSnapshot(), ...callbacks() }));
    await clickFocusButton(harness, "Quiet sources");
    await clickFocusButton(harness, "Load more quiet concerns");
    expect(harness.dom.container.textContent).toContain("Unfiltered page 20");
    await changeFocusField(harness, "Search quiet concerns", "old");
    await submitFocusForm(harness);
    expect(api.fetchFocusQuietConcernPage).toHaveBeenLastCalledWith(0, 20, { query: "old" });
    await changeFocusField(harness, "Search quiet concerns", "new");
    await submitFocusForm(harness);
    expect(api.fetchFocusQuietConcernPage).toHaveBeenLastCalledWith(0, 20, { query: "new" });
    expect(harness.dom.container.textContent).toContain("New filter result");
    await harness.act(async () => { finishOld({ objects: [{ ...quietDecision(), title: "Stale old result" }], total: 1, nextOffset: null }); });
    await advanceTimersByTimeAct(harness.act, 1);
    expect(harness.dom.container.textContent).not.toContain("Stale old result");
    expect(harness.dom.container.textContent).toContain("New filter result");
    expect(harness.dom.container.textContent).not.toContain("Unfiltered page 20");
    await clickFocusButton(harness, "Clear quiet filters");
    expect(harness.dom.container.textContent).not.toContain("New filter result");
    expect(harness.dom.container.textContent).toContain("Unfiltered page 0");
  });
});
