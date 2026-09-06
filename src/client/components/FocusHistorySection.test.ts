import { createElement, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FocusHistoryEntry, FocusHistoryFilter, FocusHistoryPage, FocusObject, FocusTransition } from "../api";
import {
  FOCUS_TEST_NOW, FOCUS_TEST_NOW_MS, focusAction, focusDecision, focusDetails, focusEpisode, focusEvent, focusTask,
} from "../test-focus-fixtures";
import {
  changeFocusField, clickFocusButton as clickButton, createFocusTestHarness, focusButton, submitFocusForm,
  type FocusTestHarness,
} from "../test-focus-harness";
import { advanceTimersByTimeAct, findAllByTag, getReactProps, waitTick, waitUntilAct } from "../test-react-harness";

const apiMocks = vi.hoisted(() => ({
  fetchFocusHistoryPage: vi.fn<typeof import("../api")["fetchFocusHistoryPage"]>(),
  fetchFocusTransitionPage: vi.fn<typeof import("../api")["fetchFocusTransitionPage"]>(),
  fetchFocusObject: vi.fn<typeof import("../api")["fetchFocusObject"]>(),
  patchChecklistItem: vi.fn<typeof import("../api")["patchChecklistItem"]>(),
  transitionFocusObject: vi.fn<typeof import("../api")["transitionFocusObject"]>(),
  reactivateFocusObject: vi.fn<typeof import("../api")["reactivateFocusObject"]>(),
  deleteFocusObject: vi.fn<typeof import("../api")["deleteFocusObject"]>(),
}));
const cardMocks = vi.hoisted(() => ({ render: vi.fn() }));

vi.mock("../api", async () => ({
  ...await vi.importActual<typeof import("../api")>("../api"),
  ...apiMocks,
}));
vi.mock("./FocusItemCard", () => ({
  default: (props: { object: FocusObject; readOnly?: boolean }) => {
    cardMocks.render(props);
    return createElement("div", { "data-current-record": props.object.id }, `Current record details: ${props.object.title}`);
  },
}));

import FocusHistorySection from "./FocusHistorySection";

function entryFor(
  object: NonNullable<FocusHistoryEntry["object"]>,
  overrides: Partial<FocusHistoryEntry> = {},
): FocusHistoryEntry {
  return {
    id: object.id,
    objectType: "objectType" in object ? object.objectType : "action",
    title: "title" in object ? object.title : object.text,
    updatedAt: FOCUS_TEST_NOW,
    object,
    deleted: false,
    quarantined: false,
    transitions: [],
    transitionTotal: 0,
    matchSource: "current",
    matchedEpisode: null,
    matchedTransition: null,
    ...overrides,
  };
}

function page(objects: FocusHistoryEntry[], overrides: Partial<FocusHistoryPage> = {}): FocusHistoryPage {
  return { objects, total: objects.length, nextOffset: null, ...overrides };
}

function transition(overrides: Partial<FocusTransition> = {}): FocusTransition {
  return {
    id: "transition-1", objectId: "decision-1", objectType: "decision", title: "Release concern",
    activationId: "activation-1", fromLifecycle: "active", toLifecycle: "handed_off",
    reason: "Executable work accepted", actor: "user", relatedActionId: null, sessionId: null,
    details: {}, createdAt: FOCUS_TEST_NOW, ...overrides,
  };
}

async function clickFocusButton(harness: FocusTestHarness, label: string) {
  await clickButton(harness, label);
  await harness.act(waitTick);
}

describe("FocusHistorySection", () => {
  let harness: FocusTestHarness;
  let props: ComponentProps<typeof FocusHistorySection>;
  let scrollIntoView: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetAllMocks();
    apiMocks.fetchFocusHistoryPage.mockResolvedValue(page([]));
    apiMocks.fetchFocusTransitionPage.mockResolvedValue([]);
    harness = await createFocusTestHarness();
    vi.useFakeTimers();
    vi.setSystemTime(FOCUS_TEST_NOW_MS);
    scrollIntoView = vi.fn();
    document.getElementById = vi.fn((id: string) => {
      const section = findAllByTag(harness.dom.container, "SECTION").find((node) => node.getAttribute("id") === id);
      if (section) section.scrollIntoView = scrollIntoView;
      return section ?? null;
    });
    props = {
      nowMs: FOCUS_TEST_NOW_MS, tasks: [focusTask()], taskGroups: [],
      onSelectTask: vi.fn(), onSelectSession: vi.fn(), onInspectHistory: vi.fn(),
      onStartPromptSession: vi.fn(async () => "session-1"), onChanged: vi.fn(async () => undefined),
    };
  });

  afterEach(async () => {
    await harness?.cleanup();
    vi.useRealTimers();
  });

  async function render(overrides: Partial<ComponentProps<typeof FocusHistorySection>> = {}) {
    props = { ...props, ...overrides };
    await harness.render(createElement(FocusHistorySection, props));
  }

  function record(title: string) {
    const article = findAllByTag(harness.dom.container, "ARTICLE")
      .find((node) => findAllByTag(node, "H4")[0]?.textContent === title);
    if (!article) throw new Error(`History record missing: ${title}`);
    return article;
  }

  async function clickRecord(title: string, label: string) {
    await harness.act(async () => {
      getReactProps(focusButton(record(title), label))!.onClick();
      await waitTick();
    });
  }

  function fieldValue(name: string) {
    const field = [...findAllByTag(harness.dom.container, "INPUT"), ...findAllByTag(harness.dom.container, "SELECT")]
      .find((node) => getReactProps(node)?.name === name);
    if (!field) throw new Error(`History field missing: ${name}`);
    return getReactProps(field)!.value;
  }

  it("uses named task choices and readable applied lifecycle/type filters while sending stable IDs", async () => {
    await render({ tasks: [focusTask({ id: "human-task-id", title: "Readable responsibility", status: "archived" })] });
    await clickFocusButton(harness, "History");
    await clickFocusButton(harness, "History filters");
    const options = findAllByTag(harness.dom.container, "OPTION").map((option) => option.textContent);
    expect(options).toContain("Readable responsibility (archived)");
    const calls = apiMocks.fetchFocusHistoryPage.mock.calls.length;
    await changeFocusField(harness, "Task", "human-task-id");
    await changeFocusField(harness, "Lifecycle", "handed_off");
    await changeFocusField(harness, "Record type", "decision");
    expect(apiMocks.fetchFocusHistoryPage).toHaveBeenCalledTimes(calls);
    await submitFocusForm(harness);
    expect(apiMocks.fetchFocusHistoryPage).toHaveBeenLastCalledWith(0, 20, { taskId: "human-task-id", lifecycle: "handed_off", objectType: "decision" });
    const summary = findAllByTag(harness.dom.container, "P").find((node) => node.textContent.startsWith("Applied filters:"));
    expect(summary.textContent).toContain("Task: Readable responsibility (archived)");
    expect(summary.textContent).toContain("Lifecycle: Handed off");
    expect(summary.textContent).toContain("Record type: Decisions");
    expect(summary.textContent).not.toContain("human-task-id");
  });

  it("retains a learned original-task label when the chosen filters return no records", async () => {
    const retained = focusEpisode({ originalTaskId: "removed-label-id", originalTaskTitle: "Former responsibility", taskId: null, orphanedAt: FOCUS_TEST_NOW });
    apiMocks.fetchFocusHistoryPage.mockImplementation(async (_offset, _limit, filter) => filter?.query
      ? page([])
      : page([entryFor(focusDecision(), { matchSource: "previous_episode", matchedEpisode: retained })]));
    await render({ tasks: [] });
    await clickFocusButton(harness, "History");
    await clickFocusButton(harness, "History filters");
    expect(findAllByTag(harness.dom.container, "OPTION").some((option) => option.textContent === "Former responsibility (removed)")).toBe(true);
    await changeFocusField(harness, "Original task", "removed-label-id");
    await changeFocusField(harness, "Search history", "no such outcome");
    await submitFocusForm(harness);
    expect(apiMocks.fetchFocusHistoryPage).toHaveBeenLastCalledWith(0, 20, { query: "no such outcome", originalTaskId: "removed-label-id" });
    expect(harness.dom.container.textContent).toContain("No records match this history view");
    const summary = findAllByTag(harness.dom.container, "P").find((node) => node.textContent.startsWith("Applied filters:"));
    expect(summary.textContent).toContain("Former responsibility (retained label)");
    expect(summary.textContent).not.toContain("Unlisted task");
    expect(fieldValue("originalTaskId")).toBe("removed-label-id");
  });

  it("does not request collapsed History, and distinguishes loading and failed reads from empty history", async () => {
    let rejectPage!: (error: Error) => void;
    apiMocks.fetchFocusHistoryPage.mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectPage = reject; }));
    await render();

    expect(apiMocks.fetchFocusHistoryPage).not.toHaveBeenCalled();
    expect(apiMocks.fetchFocusTransitionPage).not.toHaveBeenCalled();
    expect(getReactProps(focusButton(harness.dom.container, "History"))!["aria-expanded"]).toBe(false);
    expect(findAllByTag(harness.dom.container, "FORM")).toHaveLength(0);
    expect(harness.dom.container.textContent).toContain("No unread state.");

    await clickFocusButton(harness, "History");
    expect(apiMocks.fetchFocusHistoryPage).toHaveBeenCalledWith(0, 20, {});
    expect(harness.dom.container.textContent).toContain("Loading history...");
    await harness.act(async () => { rejectPage(new Error("History store offline")); await waitTick(); });
    await waitUntilAct(harness.act, () => harness.dom.container.textContent!.includes("History store offline"));
    expect(harness.dom.container.textContent).toContain("History unavailable or incomplete");
    expect(harness.dom.container.textContent).not.toContain("No records match");

    await clickFocusButton(harness, "Retry History");
    await waitUntilAct(harness.act, () => harness.dom.container.textContent!.includes("No records match"));
    expect(harness.dom.container.textContent).not.toContain("History store offline");
    await clickFocusButton(harness, "History");
    await harness.act(async () => { await harness.queryClient.invalidateQueries(); });
    await advanceTimersByTimeAct(harness.act, 60_000);
    expect(apiMocks.fetchFocusHistoryPage).toHaveBeenCalledTimes(2);
    expect(apiMocks.fetchFocusTransitionPage).not.toHaveBeenCalled();
  });

  it("retains the first API page after a later-page failure and retries without duplicating records", async () => {
    const first = Array.from({ length: 20 }, (_, index) => entryFor(focusEvent({
      id: `event-${index}`, title: `Retained observation ${index}`,
    })));
    const last = entryFor(focusEvent({ id: "event-last", title: "Oldest observation" }));
    let failLaterPage = true;
    apiMocks.fetchFocusHistoryPage.mockImplementation(async (offset) => {
      if (offset === 0) return page(first, { total: 21, nextOffset: 20 });
      if (failLaterPage) { failLaterPage = false; throw new Error("Older records unavailable"); }
      return page([last], { total: 21 });
    });
    await render();
    await clickFocusButton(harness, "History");
    expect(harness.dom.container.textContent).toContain("Loaded 20 of 21 records.");

    await clickFocusButton(harness, "Load more history");
    await waitUntilAct(harness.act, () => harness.dom.container.textContent!.includes("Older records unavailable"));
    expect(apiMocks.fetchFocusHistoryPage).toHaveBeenLastCalledWith(20, 20, {});
    expect(record("Retained observation 0").textContent).toContain("Active");
    expect(findAllByTag(harness.dom.container, "ARTICLE")).toHaveLength(20);
    expect(harness.dom.container.textContent).not.toContain("No records match");

    await clickFocusButton(harness, "Retry History");
    await waitUntilAct(harness.act, () => !harness.dom.container.textContent!.includes("Older records unavailable"));
    await clickFocusButton(harness, "Load more history");
    await waitUntilAct(harness.act, () => harness.dom.container.textContent!.includes("Oldest observation"));
    expect(apiMocks.fetchFocusHistoryPage.mock.calls).toEqual([[0, 20, {}], [20, 20, {}], [0, 20, {}], [20, 20, {}]]);
    expect(harness.dom.container.textContent).toContain("Loaded 21 of 21 records.");
    expect(findAllByTag(harness.dom.container, "ARTICLE")).toHaveLength(21);
    expect(findAllByTag(harness.dom.container, "BUTTON").some((button) => button.textContent === "Load more history")).toBe(false);
  });

  it("keeps aged active Events open, using meaningful-change time rather than incidental updates", async () => {
    const old = new Date(FOCUS_TEST_NOW_MS - 8 * 86_400_000).toISOString();
    const aged = focusEvent({ id: "aged", title: "Aged active observation", details: focusDetails({ lastMeaningfulChangeAt: old }) });
    const pinned = focusEvent({ ...aged, id: "pinned", title: "Pinned observation", pinned: true });
    const boundary = focusEvent({ id: "boundary", title: "At the digest boundary", details: focusDetails({
      lastMeaningfulChangeAt: new Date(FOCUS_TEST_NOW_MS - 7 * 86_400_000).toISOString(),
    }) });
    const recent = focusEvent({ id: "recent", title: "Meaningfully refreshed", updatedAt: old });
    apiMocks.fetchFocusHistoryPage.mockResolvedValue(page([aged, pinned, boundary, recent].map((object) => entryFor(object))));
    await render();
    await clickFocusButton(harness, "History");

    expect(record(aged.title).textContent).toContain("Active aged Event - outside the digest horizon, not resolved.");
    expect(record(aged.title).textContent).toContain("An Event carries no inherent obligation.");
    for (const object of [pinned, boundary, recent]) expect(record(object.title).textContent).not.toContain("Active aged Event");
    await clickRecord(aged.title, "Inspect record");
    expect(cardMocks.render).toHaveBeenLastCalledWith(expect.objectContaining({ object: aged, readOnly: false }));
    expect(apiMocks.transitionFocusObject).not.toHaveBeenCalled();
  });

  it.each([
    ["resolved", "Resolved", "Health restored and verified"],
    ["accepted_risk", "Risk accepted", "Known exposure accepted through the maintenance window"],
    ["dismissed", "Dismissed", "Duplicate concern, no work authorized"],
  ] as const)("preserves the current %s lifecycle and outcome and delegates its actionable card", async (lifecycle, label, outcome) => {
    const object = focusDecision({
      lifecycle, status: lifecycle === "resolved" ? "done" : "dismissed",
      details: focusDetails({ lifecycle, outcome, resolutionReason: "Explicit user disposition" }),
    });
    apiMocks.fetchFocusHistoryPage.mockResolvedValue(page([entryFor(object)]));
    await render();
    await clickFocusButton(harness, "History");
    expect(record(object.title).textContent).toContain(label);
    expect(record(object.title).textContent).toContain(`Outcome: ${outcome}`);

    await clickFocusButton(harness, "Inspect record");
    expect(cardMocks.render).toHaveBeenLastCalledWith(expect.objectContaining({ object, readOnly: false }));
    expect(apiMocks.reactivateFocusObject).not.toHaveBeenCalled();
  });

  it("delegates current handed-off concerns without changing their linked Action or session state", async () => {
    const completed = focusAction({ id: "completed-work", text: "Verified rollback", done: true });
    const global = focusAction({ id: "global-work", taskId: null, text: "Check remaining exposure" });
    const object = focusDecision({
      lifecycle: "handed_off", sessionId: "execution-session",
      details: focusDetails({ lifecycle: "handed_off", handedOffAt: FOCUS_TEST_NOW }),
      linkedActions: [
        { actionId: completed.id, activationId: "earlier-episode", createdAt: FOCUS_TEST_NOW, action: completed },
        { actionId: global.id, activationId: "activation-1", createdAt: FOCUS_TEST_NOW, action: global },
      ],
    });
    apiMocks.fetchFocusHistoryPage.mockResolvedValue(page([entryFor(object)]));
    await render();
    await clickFocusButton(harness, "History");
    expect(record(object.title).textContent).toContain("Handed-off concern remains open; execution is not its resolution.");
    await clickFocusButton(harness, "Inspect record");

    expect(cardMocks.render).toHaveBeenLastCalledWith(expect.objectContaining({ object, readOnly: false }));
    expect(apiMocks.transitionFocusObject).not.toHaveBeenCalled();
    expect(apiMocks.patchChecklistItem).not.toHaveBeenCalled();
  });

  it("completes an Action from History without resolving its source, and retains source/task navigation", async () => {
    let action = focusAction({ deadline: "2026-09-06", sourceUrl: "https://example.test/action-evidence" });
    apiMocks.fetchFocusHistoryPage.mockImplementation(async () => page([entryFor(action)]));
    apiMocks.patchChecklistItem.mockImplementation(async () => {
      action = { ...action, done: true, completedAt: FOCUS_TEST_NOW };
      return action;
    });
    await render();
    await clickFocusButton(harness, "History");
    await clickFocusButton(harness, "Inspect record");
    expect(harness.dom.container.textContent).toContain("Action open.");
    expect(harness.dom.container.textContent).toContain("Deadline: 2026-09-06");
    const evidence = findAllByTag(harness.dom.container, "A").find((link) => link.textContent === "Source evidence");
    expect(evidence?.getAttribute("href")).toBe("https://example.test/action-evidence");
    await clickFocusButton(harness, "Inspect source");
    expect(props.onInspectHistory).toHaveBeenCalledWith("decision-1");
    await clickFocusButton(harness, "Open Action task");
    expect(props.onSelectTask).toHaveBeenCalledWith("task-1", { checklistItemId: action.id });
    await clickFocusButton(harness, "Complete Action");
    await waitUntilAct(harness.act, () => harness.dom.container.textContent!.includes("Reopen Action"));

    expect(apiMocks.patchChecklistItem).toHaveBeenCalledExactlyOnceWith("action-1", { done: true });
    expect(harness.dom.container.textContent).toContain("Action completed at");
    expect(harness.dom.container.textContent).toContain("Handed off (still open)");
    expect(harness.dom.container.textContent).toContain("Action completion is independent of source resolution.");
    expect(apiMocks.transitionFocusObject).not.toHaveBeenCalled();
  });

  it("pages lifecycle transitions on demand, retaining provenance and navigation through a later-page failure", async () => {
    const first = Array.from({ length: 100 }, (_, index) => transition({
      id: `transition-${index}`, reason: `Retained transition ${index}`,
      ...(index === 0 ? {
        actor: "agent", sessionId: "handoff-session", relatedActionId: "accepted-action",
        details: { receipt: "handoff-receipt" },
      } : {}),
    }));
    const oldest = transition({ id: "creation", fromLifecycle: null, toLifecycle: "active", reason: "Initial concern recorded" });
    apiMocks.fetchFocusHistoryPage.mockResolvedValue(page([entryFor(focusDecision(), { transitions: [first[0]], transitionTotal: 101 })]));
    let failLaterPage = true;
    apiMocks.fetchFocusTransitionPage.mockImplementation(async (_id, offset) => {
      if (offset === 0) return first;
      if (failLaterPage) { failLaterPage = false; throw new Error("Older transitions unavailable"); }
      return [oldest];
    });
    await render();
    await clickFocusButton(harness, "History");
    await clickFocusButton(harness, "Inspect record");
    expect(apiMocks.fetchFocusTransitionPage).not.toHaveBeenCalled();
    await clickFocusButton(harness, "Lifecycle transitions (101)");
    expect(apiMocks.fetchFocusTransitionPage).toHaveBeenCalledWith("decision-1", 0, 100);
    expect(harness.dom.container.textContent).toContain("Active → Handed off");
    expect(harness.dom.container.textContent).toContain("Reason: Retained transition 0 · Actor: agent");
    expect(harness.dom.container.textContent).toContain("Transition episode: activation-1");
    expect(findAllByTag(harness.dom.container, "PRE")[0].textContent).toContain('"receipt": "handoff-receipt"');
    await clickFocusButton(harness, "Open transition session");
    expect(props.onSelectSession).toHaveBeenCalledWith("handoff-session");
    await clickFocusButton(harness, "Open related Action");
    expect(props.onInspectHistory).toHaveBeenCalledWith("accepted-action");

    await clickFocusButton(harness, "Load older transitions");
    await waitUntilAct(harness.act, () => harness.dom.container.textContent!.includes("Older transitions unavailable"));
    expect(apiMocks.fetchFocusTransitionPage).toHaveBeenLastCalledWith("decision-1", 100, 100);
    expect(harness.dom.container.textContent).toContain("Retained transition 99");
    await clickFocusButton(harness, "Retry transitions");
    await waitUntilAct(harness.act, () => !harness.dom.container.textContent!.includes("Older transitions unavailable"));
    await clickFocusButton(harness, "Load older transitions");
    await waitUntilAct(harness.act, () => harness.dom.container.textContent!.includes("Initial concern recorded"));
    expect(harness.dom.container.textContent).toContain("Created → Active");
    expect(findAllByTag(harness.dom.container, "OL").flatMap((list) => findAllByTag(list, "LI"))).toHaveLength(101);
    expect(findAllByTag(harness.dom.container, "BUTTON").map((button) => button.textContent)).not.toContain("Load older transitions");
  });

  it.each(["deleted", "quarantined"] as const)("keeps %s records recoverable read-only even when transition refresh fails", async (kind) => {
    const retained = transition({
      id: "retained", toLifecycle: kind === "deleted" ? null : "acknowledged",
      reason: "Retained historical disposition",
    });
    const entry = entryFor(focusDecision(), {
      object: null, deleted: kind === "deleted", quarantined: kind === "quarantined",
      transitions: [retained], transitionTotal: 1,
    });
    apiMocks.fetchFocusHistoryPage.mockResolvedValue(page([entry]));
    apiMocks.fetchFocusTransitionPage.mockRejectedValueOnce(new Error("Transition store offline")).mockResolvedValue([retained]);
    await render();
    await clickFocusButton(harness, "History");
    await clickFocusButton(harness, "Inspect record");

    expect(harness.dom.container.textContent).toContain(kind === "deleted"
      ? "Deleted record. History is read-only; this is not a resolved outcome."
      : "Quarantined record. Canonical content is unavailable until repaired; history remains readable.");
    expect(harness.dom.container.textContent).toContain("Current content and outcome unavailable. Inspect retained transitions below.");
    const labels = findAllByTag(harness.dom.container, "BUTTON").map((button) => button.textContent);
    for (const label of ["Acknowledge", "Resolve", "Hand off / Create Action", "Reactivate as a new episode", "Complete Action", "Delete item"]) {
      expect(labels).not.toContain(label);
    }
    await clickFocusButton(harness, "Lifecycle transitions (1)");
    await waitUntilAct(harness.act, () => harness.dom.container.textContent!.includes("Transition store offline"));
    expect(harness.dom.container.textContent).toContain("Retained historical disposition");
    if (kind === "deleted") expect(harness.dom.container.textContent).toContain("Active → Deleted");
    await clickFocusButton(harness, "Retry transitions");
    await waitUntilAct(harness.act, () => !harness.dom.container.textContent!.includes("Transition store offline"));
    expect(harness.dom.container.textContent).toContain("Retained historical disposition");
    expect(apiMocks.fetchFocusObject).not.toHaveBeenCalled();
    expect(apiMocks.deleteFocusObject).not.toHaveBeenCalled();
    expect(apiMocks.patchChecklistItem).not.toHaveBeenCalled();
    expect(apiMocks.transitionFocusObject).not.toHaveBeenCalled();
  });

  it("submits all server filters together, supports removed context, and omits empty values", async () => {
    apiMocks.fetchFocusHistoryPage.mockResolvedValue(page([entryFor(focusEvent({ title: "Server-selected record" }))]));
    await render({ tasks: [] });
    await clickFocusButton(harness, "History");
    expect(findAllByTag(harness.dom.container, "INPUT")).toHaveLength(1);
    expect(getReactProps(focusButton(harness.dom.container, "History filters"))!["aria-expanded"]).toBe(false);
    await clickFocusButton(harness, "History filters");
    const callsBeforeTyping = apiMocks.fetchFocusHistoryPage.mock.calls.length;
    await changeFocusField(harness, "Search history", "  original task title  ");
    await changeFocusField(harness, "Object or Action ID", "  record /7  ");
    await changeFocusField(harness, "Task ID", "  removed-task  ");
    await changeFocusField(harness, "Original task ID", "  original-removed-task  ");
    await changeFocusField(harness, "Source family", "  retired/source  ");
    await changeFocusField(harness, "Episode ID", "  earlier-episode  ");
    await changeFocusField(harness, "Record type", "decision");
    await changeFocusField(harness, "Lifecycle", "accepted_risk");
    expect(apiMocks.fetchFocusHistoryPage).toHaveBeenCalledTimes(callsBeforeTyping);
    await submitFocusForm(harness);
    expect(apiMocks.fetchFocusHistoryPage).toHaveBeenLastCalledWith(0, 20, {
      query: "original task title", objectId: "record /7", taskId: "removed-task", originalTaskId: "original-removed-task",
      sourceFamily: "retired/source", activationId: "earlier-episode", objectType: "decision", lifecycle: "accepted_risk",
    });
    expect(harness.dom.container.textContent).toContain("Server-selected record");
    expect(harness.dom.container.textContent).toContain("Applied filters:");
    expect(harness.dom.container.textContent).toContain("retired/source");
    expect(apiMocks.fetchFocusObject).not.toHaveBeenCalled();

    for (const label of ["Object or Action ID", "Task ID", "Original task ID", "Source family", "Episode ID"]) {
      await changeFocusField(harness, label, "  ");
    }
    await changeFocusField(harness, "Record type", "");
    await changeFocusField(harness, "Lifecycle", "");
    await changeFocusField(harness, "Search history", "  previous disposition  ");
    await submitFocusForm(harness);
    expect(apiMocks.fetchFocusHistoryPage).toHaveBeenLastCalledWith(0, 20, { query: "previous disposition" });
    await clickFocusButton(harness, "History filters");
    expect(findAllByTag(harness.dom.container, "INPUT")).toHaveLength(1);
    expect(harness.dom.container.textContent).toContain("Search: previous disposition");
  });

  it("limits text search to 500 characters without silently changing an oversized query", async () => {
    await render();
    await clickFocusButton(harness, "History");
    const input = findAllByTag(harness.dom.container, "INPUT")[0];
    expect(getReactProps(input)!.maxLength).toBe(500);
    await changeFocusField(harness, "Search history", "x".repeat(501));
    await submitFocusForm(harness);
    expect(apiMocks.fetchFocusHistoryPage).toHaveBeenCalledExactlyOnceWith(0, 20, {});
    expect(harness.dom.container.textContent).toContain("Search history must be 500 characters or fewer.");
    expect(getReactProps(focusButton(harness.dom.container, "Find records"))!.disabled).toBe(true);
    await changeFocusField(harness, "Search history", "x".repeat(500));
    await submitFocusForm(harness);
    expect(apiMocks.fetchFocusHistoryPage).toHaveBeenLastCalledWith(0, 20, { query: "x".repeat(500) });
    expect(harness.dom.container.textContent).not.toContain("Search history must be 500 characters or fewer.");

    await render({ targetFilter: { query: "y".repeat(501) } });
    expect(apiMocks.fetchFocusHistoryPage).toHaveBeenCalledTimes(2);
    expect(harness.dom.container.textContent).toContain("Search history must be 500 characters or fewer.");
    expect(harness.dom.container.textContent).not.toContain("No records match");
  });

  it("resets filters when a new or repeated individual History target is requested", async () => {
    apiMocks.fetchFocusHistoryPage.mockImplementation(async (_offset, _limit, filter) => page([entryFor(focusEvent({
      id: filter?.objectId ?? "all-records",
      title: `Result: ${filter?.objectId ?? "all"} / ${filter?.objectType ?? "all"}`,
    }))]));
    await render();
    await clickFocusButton(harness, "History");
    await clickFocusButton(harness, "History filters");
    await changeFocusField(harness, "Record type", "action");
    const callsBeforeTyping = apiMocks.fetchFocusHistoryPage.mock.calls.length;
    await changeFocusField(harness, "Object or Action ID", "  action /7  ");
    expect(apiMocks.fetchFocusHistoryPage).toHaveBeenCalledTimes(callsBeforeTyping);
    await submitFocusForm(harness);
    expect(apiMocks.fetchFocusHistoryPage).toHaveBeenLastCalledWith(0, 20, { objectType: "action", objectId: "action /7" });
    await waitUntilAct(harness.act, () => harness.dom.container.textContent!.includes("Result: action /7 / action"));
    expect(harness.dom.container.textContent).toContain("Result: action /7 / action");

    await render({ targetId: "decision-target", targetRevision: 1 });
    await waitUntilAct(harness.act, () => harness.dom.container.textContent!.includes("Result: decision-target / all"));
    expect(apiMocks.fetchFocusHistoryPage).toHaveBeenLastCalledWith(0, 20, { objectId: "decision-target" });
    expect(fieldValue("objectId")).toBe("decision-target");
    expect(fieldValue("objectType")).toBe("");
    expect(harness.dom.container.textContent).not.toContain("Result: action /7 / action");
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });

    await render({ targetId: "alert-target" });
    await waitUntilAct(harness.act, () => harness.dom.container.textContent!.includes("Result: alert-target / all"));
    await changeFocusField(harness, "Record type", "event");
    await submitFocusForm(harness);
    await clickFocusButton(harness, "History");
    await render({ targetRevision: 2 });
    await waitUntilAct(harness.act, () => harness.dom.container.textContent!.includes("Result: alert-target / all"));
    expect(getReactProps(focusButton(harness.dom.container, "History"))!["aria-expanded"]).toBe(true);
    expect(fieldValue("objectType")).toBe("");
    await clickFocusButton(harness, "Clear history filter");
    expect(fieldValue("objectId")).toBe("");
    expect(harness.dom.container.textContent).toContain("Result: all / all");
  });

  it("opens exact structured targets, ignores equivalent prop identities, and restores repeated targets", async () => {
    const targetFilter: FocusHistoryFilter = { originalTaskId: "removed-task", sourceFamily: "retired-watch", lifecycle: "handed_off", objectType: "decision" };
    apiMocks.fetchFocusHistoryPage.mockImplementation(async (_offset, _limit, filter) => page([entryFor(focusDecision({
      title: `Result: ${filter?.query ?? "target"}`,
    }))]));
    await render({ targetId: "old-individual-target", targetFilter, targetRevision: 1, tasks: [] });
    expect(apiMocks.fetchFocusHistoryPage).toHaveBeenCalledExactlyOnceWith(0, 20, targetFilter);
    expect(fieldValue("objectId")).toBe("");
    expect(fieldValue("originalTaskId")).toBe("removed-task");
    expect(fieldValue("sourceFamily")).toBe("retired-watch");
    expect(fieldValue("lifecycle")).toBe("handed_off");
    expect(getReactProps(focusButton(harness.dom.container, "History"))!["aria-expanded"]).toBe(true);
    expect(scrollIntoView).toHaveBeenCalledWith({ block: "start" });
    await changeFocusField(harness, "Search history", "draft addition");
    await render({ targetFilter: { objectType: "decision", lifecycle: "handed_off", sourceFamily: "retired-watch", originalTaskId: "removed-task" } });
    expect(fieldValue("query")).toBe("draft addition");
    expect(apiMocks.fetchFocusHistoryPage).toHaveBeenCalledTimes(1);
    await submitFocusForm(harness);
    expect(apiMocks.fetchFocusHistoryPage).toHaveBeenLastCalledWith(0, 20, { ...targetFilter, query: "draft addition" });
    await clickFocusButton(harness, "History");
    await render({ targetRevision: 2 });
    expect(fieldValue("query")).toBe("");
    expect(harness.dom.container.textContent).toContain("Result: target");
    expect(harness.dom.container.textContent).not.toContain("Result: draft addition");
    expect(getReactProps(focusButton(harness.dom.container, "History"))!["aria-expanded"]).toBe(true);
    expect(targetFilter).toEqual({ originalTaskId: "removed-task", sourceFamily: "retired-watch", lifecycle: "handed_off", objectType: "decision" });

    await render({ targetId: "new-individual-target", targetFilter: undefined });
    expect(apiMocks.fetchFocusHistoryPage).toHaveBeenLastCalledWith(0, 20, { objectId: "new-individual-target" });
    expect(fieldValue("sourceFamily")).toBe("");
    expect(fieldValue("originalTaskId")).toBe("");
    expect(fieldValue("lifecycle")).toBe("");
  });

  it("renders a server-matched snapshot beyond the latest 100 transitions, not today's object", async () => {
    const earlier = focusEpisode({
      activationId: "old-episode", title: "Old rollback assessment", body: "Retained **old evidence** only.",
      lifecycle: "accepted_risk", outcome: "Exposure explicitly accepted through the old window", resolutionReason: "Old owner decision",
      taskId: null, taskTitle: "Removed release task", originalTaskId: "removed-task", originalTaskTitle: "Removed release task",
      orphanedAt: FOCUS_TEST_NOW, sourceFamily: "retired-watch", sessionIds: ["old-session"], linkedActionIds: ["old-action"],
      linkedActions: [{ sourceId: "decision-1", sourceType: "decision", activationId: "old-episode", actionId: "old-action", createdAt: FOCUS_TEST_NOW }],
    });
    const matchedTransition = transition({ id: "transition-older-than-100", activationId: "new-episode", details: { previousEpisode: earlier } });
    const current = focusDecision({ activationId: "new-episode", title: "Today's unrelated question", body: "Today's different body" });
    const recent = Array.from({ length: 100 }, (_, index) => transition({ id: `recent-${index}`, activationId: "new-episode" }));
    apiMocks.fetchFocusHistoryPage.mockResolvedValue(page([entryFor(current, {
      matchSource: "previous_episode", matchedEpisode: earlier, matchedTransition, transitions: recent, transitionTotal: 151,
    })]));
    const filter: FocusHistoryFilter = { query: "Old rollback", originalTaskId: "removed-task", sourceFamily: "retired-watch", lifecycle: "accepted_risk", activationId: "old-episode" };
    await render({ targetFilter: filter, tasks: [] });
    expect(apiMocks.fetchFocusHistoryPage).toHaveBeenCalledExactlyOnceWith(0, 20, filter);
    expect(record(earlier.title).textContent).toContain("Risk accepted");
    expect(record(earlier.title).textContent).toContain(`Outcome: ${earlier.outcome}`);
    expect(harness.dom.container.textContent).not.toContain(current.title);
    await clickRecord(earlier.title, "Inspect record");
    expect(harness.dom.container.textContent).toContain("Retained episode: old-episode");
    expect(harness.dom.container.textContent).toContain("Transition episode: new-episode");
    expect(harness.dom.container.textContent).toContain("Old owner decision");
    expect(harness.dom.container.textContent).toContain("Original task ID: removed-task");
    expect(harness.dom.container.textContent).toContain("Linked episode: old-episode");
    expect(harness.dom.container.textContent).toContain("not current work state, completion, or resolution");
    expect(findAllByTag(harness.dom.container, "STRONG").some((node) => node.textContent === "old evidence")).toBe(true);
    expect(harness.dom.container.textContent).not.toContain(current.body);
    expect(cardMocks.render).not.toHaveBeenCalled();
    expect(apiMocks.fetchFocusTransitionPage).not.toHaveBeenCalled();
    await clickFocusButton(harness, "Open linked Action record");
    expect(props.onInspectHistory).toHaveBeenCalledWith("old-action");
    await clickFocusButton(harness, "Open retained session");
    expect(props.onSelectSession).toHaveBeenCalledExactlyOnceWith("old-session");
    await clickFocusButton(harness, "Open original task");
    expect(props.onSelectTask).toHaveBeenCalledExactlyOnceWith("removed-task");
    await clickFocusButton(harness, "Open current record");
    expect(props.onInspectHistory).toHaveBeenLastCalledWith("decision-1");
    expect(apiMocks.patchChecklistItem).not.toHaveBeenCalled();
    expect(apiMocks.transitionFocusObject).not.toHaveBeenCalled();
    expect(props.onStartPromptSession).not.toHaveBeenCalled();
  });

  it("renders transition-only matches with explicitly unknown prior details and separate current navigation", async () => {
    const matchedTransition = transition({
      id: "old-legacy-transition", title: "Earlier release concern", activationId: "old-episode",
      fromLifecycle: "active", toLifecycle: "dismissed", reason: "Historic duplicate disposition",
      relatedActionId: "old-action", sessionId: "old-session", details: { legacyReceipt: "retained receipt" },
    });
    const current = focusDecision({ activationId: "new-episode", title: "Today's unrelated title", details: focusDetails({ outcome: "Today's outcome" }) });
    apiMocks.fetchFocusHistoryPage.mockResolvedValue(page([entryFor(current, {
      matchSource: "transition", matchedTransition, matchedEpisode: null, transitionTotal: 102,
      transitions: [transition({ id: "latest", reason: "Not the matching reason" })],
    })]));
    await render({ targetFilter: { query: "Historic duplicate" } });
    await clickRecord(matchedTransition.title, "Inspect record");
    expect(harness.dom.container.textContent).toContain("Transition-only match");
    expect(harness.dom.container.textContent).toContain("Prior details and outcome are unknown.");
    expect(harness.dom.container.textContent).toContain("Active → Dismissed");
    expect(harness.dom.container.textContent).toContain("Historic duplicate disposition");
    expect(harness.dom.container.textContent).toContain("Transition episode: old-episode");
    expect(harness.dom.container.textContent).toContain("Current episode: new-episode");
    expect(harness.dom.container.textContent).not.toContain(current.title);
    expect(harness.dom.container.textContent).not.toContain("Today's outcome");
    expect(harness.dom.container.textContent).not.toContain("Not the matching reason");
    expect(findAllByTag(harness.dom.container, "PRE")[0].textContent).toContain("retained receipt");
    expect(cardMocks.render).not.toHaveBeenCalled();
    expect(apiMocks.fetchFocusTransitionPage).not.toHaveBeenCalled();
    await clickFocusButton(harness, "Open related Action");
    expect(props.onInspectHistory).toHaveBeenCalledWith("old-action");
    await clickFocusButton(harness, "Open transition session");
    expect(props.onSelectSession).toHaveBeenCalledExactlyOnceWith("old-session");
    await clickFocusButton(harness, "Open current record");
    expect(props.onInspectHistory).toHaveBeenLastCalledWith("decision-1");
  });

  it.each(["deleted", "quarantined"] as const)("keeps retained %s snapshot matches read-only", async (kind) => {
    const episode = focusEpisode({ lifecycle: "resolved", outcome: "Earlier outcome was verified", resolutionReason: "Retained verification" });
    apiMocks.fetchFocusHistoryPage.mockResolvedValue(page([entryFor(focusDecision(), {
      object: null, deleted: kind === "deleted", quarantined: kind === "quarantined",
      matchSource: "previous_episode", matchedEpisode: episode,
      matchedTransition: transition({ details: { previousEpisode: episode } }),
    })]));
    await render({ targetFilter: { query: "Earlier outcome" } });
    await clickRecord(episode.title, "Inspect record");
    expect(harness.dom.container.textContent).toContain("Earlier outcome was verified");
    expect(harness.dom.container.textContent).toContain("Retained verification");
    expect(harness.dom.container.textContent).toContain("read-only");
    expect(cardMocks.render).not.toHaveBeenCalled();
    const labels = findAllByTag(harness.dom.container, "BUTTON").map((button) => button.textContent);
    for (const label of ["Acknowledge", "Resolve", "Reactivate as a new episode", "Complete Action", "Delete item", "Open current record"]) {
      expect(labels).not.toContain(label);
    }
  });

  it.each(["deleted", "quarantined"] as const)("passes readOnly for %s current payloads and suppresses Action mutation controls", async (kind) => {
    const flags = { deleted: kind === "deleted", quarantined: kind === "quarantined" };
    const focus = focusDecision();
    const action = focusAction();
    apiMocks.fetchFocusHistoryPage.mockResolvedValue(page([entryFor(focus, flags), entryFor(action, flags)]));
    await render();
    await clickFocusButton(harness, "History");
    await clickRecord(focus.title, "Inspect record");
    expect(cardMocks.render).toHaveBeenLastCalledWith(expect.objectContaining({ object: focus, readOnly: true }));
    await clickRecord(action.text, "Inspect record");
    expect(record(action.text).textContent).toContain("This Action record is read-only.");
    expect(record(action.text).textContent).toContain("(recorded open)");
    expect(record(action.text).textContent).not.toContain("(still open)");
    expect(findAllByTag(record(action.text), "BUTTON").map((button) => button.textContent)).not.toContain("Complete Action");
    expect(apiMocks.patchChecklistItem).not.toHaveBeenCalled();
  });

  it("never substitutes current content when a historical match is missing its retained payload", async () => {
    apiMocks.fetchFocusHistoryPage.mockResolvedValue(page([entryFor(focusDecision(), {
      matchSource: "previous_episode", matchedEpisode: null, matchedTransition: null,
    })]));
    await render({ targetFilter: { activationId: "missing-episode" } });
    await clickRecord("Retained match — details unavailable", "Inspect record");
    expect(harness.dom.container.textContent).toContain("Prior details and outcome are unknown.");
    expect(harness.dom.container.textContent).toContain("Current content is not substituted.");
    expect(cardMocks.render).not.toHaveBeenCalled();
  });

  it("changes paginated targets without mixing a late response from the previous source", async () => {
    const firstFilter: FocusHistoryFilter = { sourceFamily: "old-source", originalTaskId: "removed-task" };
    const nextFilter: FocusHistoryFilter = { sourceFamily: "new-source", lifecycle: "resolved" };
    let finishOlderPage!: (value: FocusHistoryPage) => void;
    apiMocks.fetchFocusHistoryPage.mockImplementation(async (offset, _limit, filter) => {
      if (filter?.sourceFamily === "new-source") return page([entryFor(focusEvent({ id: "new", title: "New source match" }))]);
      if (offset === 0) return page([entryFor(focusEvent({ id: "old", title: "Old source match" }))], { total: 2, nextOffset: 1 });
      return new Promise((resolve) => { finishOlderPage = resolve; });
    });
    await render({ targetFilter: firstFilter });
    await clickFocusButton(harness, "Load more history");
    expect(apiMocks.fetchFocusHistoryPage).toHaveBeenLastCalledWith(1, 20, firstFilter);
    await render({ targetFilter: nextFilter });
    expect(apiMocks.fetchFocusHistoryPage).toHaveBeenLastCalledWith(0, 20, nextFilter);
    expect(harness.dom.container.textContent).toContain("New source match");
    expect(harness.dom.container.textContent).not.toContain("Old source match");
    await harness.act(async () => {
      finishOlderPage(page([entryFor(focusEvent({ id: "late-old", title: "Late old source match" }))], { total: 2 }));
      await waitTick();
    });
    expect(harness.dom.container.textContent).toContain("Loaded 1 of 1 records.");
    expect(harness.dom.container.textContent).not.toContain("Late old source match");
    expect(fieldValue("sourceFamily")).toBe("new-source");
    expect(fieldValue("originalTaskId")).toBe("");
  });
});
