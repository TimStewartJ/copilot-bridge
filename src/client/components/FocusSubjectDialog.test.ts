import { createElement, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FocusEpisodeRead, FocusHistoryEntry, FocusHistoryPage, FocusObject, FocusTransition } from "../api";
import { queryKeys } from "../queryClient";
import {
  FOCUS_TEST_NOW, FOCUS_TEST_NOW_MS, focusAlert, focusDecision, focusDetails, focusEpisode, focusEvent,
  focusLaunchReceipt, focusTask,
} from "../test-focus-fixtures";
import { clickFocusButton, createFocusTestHarness, focusButton, type FocusTestHarness } from "../test-focus-harness";
import { advanceTimersByTimeAct, findAllByTag, getReactProps, waitTick } from "../test-react-harness";

const apiMocks = vi.hoisted(() => ({
  fetchFocusEpisodePage: vi.fn<typeof import("../api")["fetchFocusEpisodePage"]>(),
  fetchFocusHistoryPage: vi.fn<typeof import("../api")["fetchFocusHistoryPage"]>(),
  fetchFocusObject: vi.fn<typeof import("../api")["fetchFocusObject"]>(),
  fetchFocusLaunchReceipts: vi.fn<typeof import("../api")["fetchFocusLaunchReceipts"]>(),
  transitionFocusObject: vi.fn<typeof import("../api")["transitionFocusObject"]>(),
  reactivateFocusObject: vi.fn<typeof import("../api")["reactivateFocusObject"]>(),
  promoteFocusObjectToAction: vi.fn<typeof import("../api")["promoteFocusObjectToAction"]>(),
  deleteFocusObject: vi.fn<typeof import("../api")["deleteFocusObject"]>(),
  linkFocusObjectSession: vi.fn<typeof import("../api")["linkFocusObjectSession"]>(),
  launchFocusSession: vi.fn<typeof import("../api")["launchFocusSession"]>(),
  prepareFocusSessionLaunch: vi.fn<typeof import("../api")["prepareFocusSessionLaunch"]>(),
  startFocusSessionLaunch: vi.fn<typeof import("../api")["startFocusSessionLaunch"]>(),
}));

vi.mock("../api", async () => ({
  ...await vi.importActual<typeof import("../api")>("../api"),
  ...apiMocks,
}));

import FocusSubjectDialog from "./FocusSubjectDialog";

function episodeRead(overrides: Partial<FocusEpisodeRead> = {}): FocusEpisodeRead {
  return {
    objectId: "decision-1", activationId: "activation-1", currentObject: focusDecision(), isCurrentEpisode: true,
    previousEpisode: null, transitions: [], transitionTotal: 0, nextOffset: null,
    deleted: false, quarantined: false, historyIncomplete: false, ...overrides,
  };
}

function historyEntry(object: FocusObject, overrides: Partial<FocusHistoryEntry> = {}): FocusHistoryEntry {
  return {
    id: object.id, objectType: object.objectType, title: object.title, updatedAt: object.updatedAt, object,
    deleted: false, quarantined: false, transitions: [], transitionTotal: 0,
    matchSource: "current", matchedEpisode: null, matchedTransition: null, ...overrides,
  };
}

function historyPage(objects: FocusHistoryEntry[], overrides: Partial<FocusHistoryPage> = {}): FocusHistoryPage {
  return { objects, total: objects.length, nextOffset: null, ...overrides };
}

function transition(overrides: Partial<FocusTransition> = {}): FocusTransition {
  return {
    id: "transition-1", objectId: "decision-1", objectType: "decision", title: "Retained transition",
    activationId: "old-activation", fromLifecycle: "active", toLifecycle: "acknowledged",
    reason: "Observed concern", actor: "user", relatedActionId: null, sessionId: null,
    details: {}, createdAt: FOCUS_TEST_NOW, ...overrides,
  };
}

describe("FocusSubjectDialog exact, non-mutating retrieval", () => {
  let harness: FocusTestHarness;
  let props: ComponentProps<typeof FocusSubjectDialog>;

  beforeEach(async () => {
    vi.resetAllMocks();
    apiMocks.fetchFocusEpisodePage.mockResolvedValue(episodeRead());
    apiMocks.fetchFocusHistoryPage.mockResolvedValue(historyPage([]));
    apiMocks.fetchFocusLaunchReceipts.mockResolvedValue([]);
    harness = await createFocusTestHarness();
    vi.useFakeTimers();
    vi.setSystemTime(FOCUS_TEST_NOW_MS);
    props = {
      target: { objectId: "decision-1", activationId: "activation-1" },
      tasks: [focusTask()], taskGroups: [], onClose: vi.fn(), onInspectCurrent: vi.fn(),
      onSelectTask: vi.fn(), onSelectSession: vi.fn(), onInspectHistory: vi.fn(),
      onStartPromptSession: vi.fn(async () => "must-not-start"), onChanged: vi.fn(async () => undefined),
    };
  });

  afterEach(async () => {
    try {
      for (const name of [
        "transitionFocusObject", "reactivateFocusObject", "promoteFocusObjectToAction", "deleteFocusObject",
        "linkFocusObjectSession", "launchFocusSession", "prepareFocusSessionLaunch", "startFocusSessionLaunch",
      ] as const) expect(apiMocks[name], name).not.toHaveBeenCalled();
      expect(props.onStartPromptSession).not.toHaveBeenCalled();
      expect(props.onChanged).not.toHaveBeenCalled();
    } finally {
      await harness?.cleanup();
      vi.useRealTimers();
    }
  });

  async function render(overrides: Partial<ComponentProps<typeof FocusSubjectDialog>> = {}) {
    props = { ...props, ...overrides };
    await harness.render(createElement(FocusSubjectDialog, props));
  }

  function expectNoMutationControls() {
    const labels = findAllByTag(harness.dom.container, "BUTTON").map((button) => button.textContent);
    for (const label of [
      "Acknowledge", "Hand off / Create Action", "Create Action", "Resolve", "Accept risk", "Dismiss",
      "Reactivate as a new episode", "Start session", "Run linked inspection", "Discuss item", "Delete item",
      "Review launch receipt",
    ]) expect(labels, label).not.toContain(label);
    expect(findAllByTag(harness.dom.container, "FORM")).toHaveLength(0);
    const summaries = findAllByTag(harness.dom.container, "SUMMARY").map((node) => node.textContent);
    expect(summaries).not.toContain("Lifecycle options");
    expect(summaries).not.toContain("Record options");
  }

  it("exposes retained transitions and a full History recovery path for object-only quarantine links", async () => {
    const beforeQuarantine = focusEpisode({ outcome: "Verified before quarantine", lifecycle: "resolved" });
    apiMocks.fetchFocusHistoryPage.mockResolvedValue(historyPage([historyEntry(focusDecision(), {
      object: null, quarantined: true, matchSource: "current", matchedTransition: null, matchedEpisode: null,
      transitions: [transition({ title: "Prior resolved condition", details: { previousEpisode: beforeQuarantine } })], transitionTotal: 101,
    })]));
    await render({ target: { objectId: "decision-1" } });
    expect(harness.dom.container.textContent).toContain("This record is quarantined");
    expect(harness.dom.container.textContent).toContain("Retained object history");
    expect(harness.dom.container.textContent).toContain("Prior resolved condition");
    expect(harness.dom.container.textContent).toContain("Verified before quarantine");
    expectNoMutationControls();
    await clickFocusButton(harness, "Inspect complete object History");
    expect(props.onInspectHistory).toHaveBeenCalledWith("decision-1");
  });

  it.each([focusDecision(), focusAlert(), focusEvent()])(
    "retrieves a current $objectType by its exact object and activation, without opening work",
    async (object) => {
      apiMocks.fetchFocusEpisodePage.mockResolvedValue(episodeRead({
        objectId: object.id, activationId: object.activationId, currentObject: object,
      }));
      await render({ target: { objectId: object.id, activationId: object.activationId } });

      expect(apiMocks.fetchFocusEpisodePage.mock.calls).toEqual([[object.id, object.activationId, 0]]);
      expect(apiMocks.fetchFocusHistoryPage).not.toHaveBeenCalled();
      expect(apiMocks.fetchFocusObject).not.toHaveBeenCalled();
      expect(harness.dom.container.textContent).toContain(object.title);
      expect(harness.dom.container.textContent).toContain("current evidence");
      expect(findAllByTag(harness.dom.container, "ARTICLE").map((node) => node.getAttribute("data-focus-object-id"))).toEqual([object.id]);
      expect(props.onSelectTask).not.toHaveBeenCalled();
      expect(props.onSelectSession).not.toHaveBeenCalled();
      if (object.objectType !== "event") expect(focusButton(harness.dom.container, "Acknowledge")).toBeDefined();
      await clickFocusButton(harness, "Close dialog");
      expect(props.onClose).toHaveBeenCalledOnce();
    },
  );

  it("never substitutes cached current History while an earlier episode loads, then shows its flat retained snapshot", async () => {
    const current = focusDecision({
      activationId: "today-activation", title: "Today's replacement question", body: "TODAY BODY MUST NOT LEAK",
      details: focusDetails({ recommendation: "TODAY RECOMMENDATION MUST NOT LEAK", outcome: "TODAY OUTCOME MUST NOT LEAK" }),
      launchPrompt: { label: "Run linked inspection", prompt: "Do not send this prompt merely by opening" },
    });
    const retained = focusEpisode({
      activationId: "old-activation", title: "Original linked question", body: "Old immutable evidence",
      lifecycle: "dismissed", outcome: "Prior release was withdrawn", resolutionReason: "Obsolete release",
    });
    harness.queryClient.setQueryData(queryKeys.focusHistory({ objectId: current.id }), {
      pageParams: [0], pages: [historyPage([historyEntry(current)])],
    });
    let resolveEpisode!: (value: FocusEpisodeRead) => void;
    apiMocks.fetchFocusEpisodePage.mockImplementationOnce(() => new Promise((resolve) => { resolveEpisode = resolve; }));

    await render({ target: { objectId: current.id, activationId: retained.activationId } });
    expect(harness.dom.container.textContent).toContain("Loading the exact Focus subject");
    expect(harness.dom.container.textContent).not.toContain(current.title);
    expect(harness.dom.container.textContent).not.toContain(current.body);
    expect(apiMocks.fetchFocusHistoryPage).not.toHaveBeenCalled();
    expectNoMutationControls();

    await harness.act(async () => {
      resolveEpisode(episodeRead({
        activationId: retained.activationId, currentObject: current, isCurrentEpisode: false, previousEpisode: retained,
      }));
      await waitTick();
    });
    await advanceTimersByTimeAct(harness.act, 1);
    expect(apiMocks.fetchFocusEpisodePage.mock.calls).toEqual([[current.id, retained.activationId, 0]]);
    expect(harness.dom.container.textContent).toContain(retained.title);
    expect(harness.dom.container.textContent).toContain(retained.body);
    expect(harness.dom.container.textContent).toContain(retained.outcome);
    expect(harness.dom.container.textContent).toContain("Retained episode snapshot — read-only");
    expect(harness.dom.container.textContent).toContain("Snapshot schema: 1");
    expect(harness.dom.container.textContent).toContain(`Current record: ${current.title}`);
    for (const value of [current.body, current.details.outcome, current.details.recommendation]) {
      expect(harness.dom.container.textContent).not.toContain(value);
    }
    expect(findAllByTag(harness.dom.container, "ARTICLE")).toHaveLength(0);
    expectNoMutationControls();
    await clickFocusButton(harness, "Inspect current episode");
    expect(props.onInspectCurrent).toHaveBeenCalledExactlyOnceWith({ objectId: current.id, activationId: current.activationId });
    expect(apiMocks.fetchFocusEpisodePage).toHaveBeenCalledOnce();
    expect(apiMocks.fetchFocusLaunchReceipts).not.toHaveBeenCalled();
  });

  it.each([
    ["resolved", "done", "Resolved"],
    ["accepted_risk", "dismissed", "Risk accepted"],
    ["dismissed", "dismissed", "Dismissed"],
  ] as const)("renders a current %s episode and saved session receipt without mutation controls", async (lifecycle, status, label) => {
    const current = focusDecision({
      lifecycle, status, launchPrompt: { label: "Run linked inspection", prompt: "Do not launch" },
      details: focusDetails({ lifecycle, outcome: "Recorded disposition remains unchanged", resolutionReason: "Reviewed explicitly" }),
    });
    apiMocks.fetchFocusEpisodePage.mockResolvedValue(episodeRead({ currentObject: current }));
    apiMocks.fetchFocusLaunchReceipts.mockResolvedValue([focusLaunchReceipt()]);
    await render();

    expect(harness.dom.container.textContent).toContain(label);
    expect(harness.dom.container.textContent).toContain("This notification is now read-only");
    expect(harness.dom.container.textContent).toContain("Recorded disposition remains unchanged");
    expect(focusButton(harness.dom.container, "Open launch session")).toBeDefined();
    expectNoMutationControls();
    expect(props.onSelectSession).not.toHaveBeenCalled();
  });

  it.each(["deleted", "quarantined"] as const)("retains evidence for a %s object without treating it as resolved or actionable", async (state) => {
    const retained = focusEpisode({ activationId: "old-activation", lifecycle: "active", body: "Evidence retained before removal", outcome: null });
    apiMocks.fetchFocusEpisodePage.mockResolvedValue(episodeRead({
      activationId: retained.activationId, currentObject: null, isCurrentEpisode: false, previousEpisode: retained,
      deleted: state === "deleted", quarantined: state === "quarantined",
    }));
    await render({ target: { objectId: retained.objectId, activationId: retained.activationId } });

    expect(harness.dom.container.textContent).toContain(`This record ${state === "deleted" ? "was deleted" : "is quarantined"}`);
    expect(harness.dom.container.textContent).toContain(retained.body);
    expect(harness.dom.container.textContent).toContain("No outcome recorded");
    expect(harness.dom.container.textContent).not.toContain("This episode is resolved");
    expect(findAllByTag(harness.dom.container, "BUTTON").map((node) => node.textContent)).not.toContain("Inspect current episode");
    expectNoMutationControls();
  });

  it("describes legacy partial history as unknown rather than borrowing today's outcome", async () => {
    const current = focusDecision({
      activationId: "today-activation", body: "Today's unrelated resolution",
      lifecycle: "resolved", status: "done", details: focusDetails({ lifecycle: "resolved", outcome: "Today's verified outcome" }),
    });
    apiMocks.fetchFocusEpisodePage.mockResolvedValue(episodeRead({
      activationId: "old-activation", currentObject: current, isCurrentEpisode: false,
      historyIncomplete: true, transitions: [transition()], transitionTotal: 1,
    }));
    await render({ target: { objectId: current.id, activationId: "old-activation" } });

    expect(harness.dom.container.textContent).toContain("Historical coverage is incomplete");
    expect(harness.dom.container.textContent).toContain("its outcome cannot be inferred");
    expect(harness.dom.container.textContent).toContain("Prior details and outcome are unknown");
    expect(harness.dom.container.textContent).not.toContain(current.body);
    expect(harness.dom.container.textContent).not.toContain(current.details.outcome);
    expect(harness.dom.container.textContent).not.toContain("Retained episode snapshot");
    expectNoMutationControls();
  });

  it("uses exact object-filtered History for an object-only link beyond the cached first page", async () => {
    const current = focusEvent({ id: "aged-event-150", title: "An older observation", body: "Only the exact History lookup finds this body" });
    const firstPage = Array.from({ length: 20 }, (_, index) => historyEntry(focusEvent({ id: `recent-${index}` })));
    harness.queryClient.setQueryData(queryKeys.focusHistory(), {
      pageParams: [0], pages: [historyPage(firstPage, { total: 150, nextOffset: 20 })],
    });
    apiMocks.fetchFocusHistoryPage.mockResolvedValue(historyPage([historyEntry(current)]));
    await render({ target: { objectId: current.id } });

    expect(apiMocks.fetchFocusHistoryPage.mock.calls).toEqual([[0, 20, { objectId: current.id }]]);
    expect(apiMocks.fetchFocusEpisodePage).not.toHaveBeenCalled();
    expect(apiMocks.fetchFocusObject).not.toHaveBeenCalled();
    expect(harness.dom.container.textContent).toContain(current.body);
    expect(harness.dom.container.textContent).toContain("Current record lookup");
  });

  it("renders a retained History match from matchedEpisode rather than requiring a live object", async () => {
    const retained = focusEpisode({ title: "Deleted record's retained question", body: "History retained this exact evidence" });
    const matchedTransition = transition({ details: { previousEpisode: retained } });
    apiMocks.fetchFocusHistoryPage.mockResolvedValue(historyPage([historyEntry(focusDecision(), {
      object: null, deleted: true, matchSource: "previous_episode", matchedEpisode: retained, matchedTransition,
      transitions: [matchedTransition], transitionTotal: 1,
    })]));
    await render({ target: { objectId: retained.objectId } });

    expect(apiMocks.fetchFocusHistoryPage.mock.calls).toEqual([[0, 20, { objectId: retained.objectId }]]);
    expect(harness.dom.container.textContent).toContain(retained.title);
    expect(harness.dom.container.textContent).toContain(retained.body);
    expect(harness.dom.container.textContent).toContain("Retained object history");
    expect(harness.dom.container.textContent).toContain("This record was deleted");
    expectNoMutationControls();
  });

  it("does not silently substitute a cached current record for an unknown activation", async () => {
    const current = focusDecision({ title: "Known current object", body: "Current body is not missing episode evidence" });
    harness.queryClient.setQueryData(queryKeys.focusHistory({ objectId: current.id }), {
      pageParams: [0], pages: [historyPage([historyEntry(current)])],
    });
    apiMocks.fetchFocusEpisodePage.mockRejectedValue(new Error("Focus episode missing-activation for decision-1 not found"));
    await render({ target: { objectId: current.id, activationId: "missing-activation" } });

    expect(apiMocks.fetchFocusEpisodePage.mock.calls).toEqual([[current.id, "missing-activation", 0]]);
    expect(apiMocks.fetchFocusHistoryPage).not.toHaveBeenCalled();
    expect(apiMocks.fetchFocusObject).not.toHaveBeenCalled();
    expect(harness.dom.container.textContent).toContain("Could not retrieve this exact subject");
    expect(harness.dom.container.textContent).toContain("missing-activation");
    expect(harness.dom.container.textContent).not.toContain(current.title);
    expect(harness.dom.container.textContent).not.toContain(current.body);
    expect(harness.dom.container.textContent).not.toContain("This record was not found in History");
    expect(focusButton(harness.dom.container, "Retry subject lookup")).toBeDefined();
    expectNoMutationControls();
  });

  it("retries the same failed activation read without changing the target or performing a History scan", async () => {
    const retained = focusEpisode({ activationId: "old-activation", body: "Recovered retained body" });
    apiMocks.fetchFocusEpisodePage.mockRejectedValueOnce(new Error("Episode store temporarily offline"))
      .mockResolvedValueOnce(episodeRead({ activationId: retained.activationId, isCurrentEpisode: false, previousEpisode: retained }));
    await render({ target: { objectId: retained.objectId, activationId: retained.activationId } });
    expect(harness.dom.container.textContent).toContain("Episode store temporarily offline");

    await clickFocusButton(harness, "Retry subject lookup");
    expect(apiMocks.fetchFocusEpisodePage.mock.calls).toEqual([
      [retained.objectId, retained.activationId, 0], [retained.objectId, retained.activationId, 0],
    ]);
    expect(harness.dom.container.textContent).toContain(retained.body);
    expect(harness.dom.container.textContent).not.toContain("Episode store temporarily offline");
    expect(apiMocks.fetchFocusHistoryPage).not.toHaveBeenCalled();
    expectNoMutationControls();
  });

  it("keeps earlier evidence through a later-page failure and retries the episode's nextOffset without duplication", async () => {
    const retained = focusEpisode({ activationId: "old-activation", body: "Retained evidence stays visible across pages" });
    const first = Array.from({ length: 50 }, (_, index) => transition({ id: `transition-${index}`, title: `Recorded step ${index}` }));
    const last = transition({ id: "last-transition", title: "Final retained transition" });
    const base = episodeRead({
      activationId: retained.activationId, isCurrentEpisode: false, previousEpisode: retained, transitionTotal: 51,
    });
    let rejectNext!: (error: Error) => void;
    apiMocks.fetchFocusEpisodePage.mockResolvedValueOnce({ ...base, transitions: first, nextOffset: 50 })
      .mockImplementationOnce(() => new Promise((_resolve, reject) => { rejectNext = reject; }))
      .mockResolvedValueOnce({ ...base, transitions: [last], nextOffset: null });
    await render({ target: { objectId: retained.objectId, activationId: retained.activationId } });

    await clickFocusButton(harness, "Load more episode history");
    expect(getReactProps(focusButton(harness.dom.container, "Loading..."))?.disabled).toBe(true);
    expect(harness.dom.container.textContent).toContain(retained.body);
    await harness.act(async () => { rejectNext(new Error("Older episode transitions unavailable")); await waitTick(); });
    await advanceTimersByTimeAct(harness.act, 1);
    expect(harness.dom.container.textContent).toContain("Older episode transitions unavailable");
    expect(harness.dom.container.textContent).toContain("Recorded step 0");
    expect(harness.dom.container.textContent).toContain(retained.body);
    expectNoMutationControls();

    await clickFocusButton(harness, "Load more episode history");
    expect(apiMocks.fetchFocusEpisodePage.mock.calls).toEqual([
      [retained.objectId, retained.activationId, 0],
      [retained.objectId, retained.activationId, 50],
      [retained.objectId, retained.activationId, 50],
    ]);
    const history = findAllByTag(harness.dom.container, "SECTION")
      .find((node) => findAllByTag(node, "H3")[0]?.textContent === "Linked episode history");
    expect(findAllByTag(history, "LI")).toHaveLength(51);
    expect(harness.dom.container.textContent).toContain(last.title);
    expect(harness.dom.container.textContent).not.toContain("Older episode transitions unavailable");
    expect(findAllByTag(harness.dom.container, "BUTTON").map((node) => node.textContent)).not.toContain("Load more episode history");
    expect(apiMocks.fetchFocusHistoryPage).not.toHaveBeenCalled();
  });

  it("reports an empty object-filtered History result without falling back to a different record", async () => {
    harness.queryClient.setQueryData(queryKeys.focusHistory(), {
      pageParams: [0], pages: [historyPage([historyEntry(focusDecision({ body: "Unrelated cached record" }))])],
    });
    await render({ target: { objectId: "missing-object" } });

    expect(apiMocks.fetchFocusHistoryPage.mock.calls).toEqual([[0, 20, { objectId: "missing-object" }]]);
    expect(apiMocks.fetchFocusEpisodePage).not.toHaveBeenCalled();
    expect(harness.dom.container.textContent).toContain("This record was not found in History. No state was changed");
    expect(harness.dom.container.textContent).not.toContain("Unrelated cached record");
    expectNoMutationControls();
  });
});
