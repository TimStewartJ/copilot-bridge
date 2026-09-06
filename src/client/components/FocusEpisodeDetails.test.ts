import { createElement, type ComponentProps } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { FocusTransition } from "../api";
import { FOCUS_TEST_NOW, focusEpisode } from "../test-focus-fixtures";
import { clickFocusButton, createFocusTestHarness, focusButton, type FocusTestHarness } from "../test-focus-harness";
import { findAllByTag, getReactProps } from "../test-react-harness";
import FocusEpisodeDetails, { FocusTransitionList } from "./FocusEpisodeDetails";

function transition(overrides: Partial<FocusTransition> = {}): FocusTransition {
  return {
    id: "transition-1", objectId: "decision-1", objectType: "decision", title: "Retained release concern",
    activationId: "new-episode", fromLifecycle: "resolved", toLifecycle: "active", reason: "New evidence needs review",
    actor: "user", relatedActionId: null, sessionId: null, details: {}, createdAt: FOCUS_TEST_NOW, ...overrides,
  };
}

describe("FocusEpisodeDetails", () => {
  let harness: FocusTestHarness;
  let navigation: Omit<ComponentProps<typeof FocusEpisodeDetails>, "episode">;

  beforeEach(async () => {
    harness = await createFocusTestHarness();
    navigation = { onSelectTask: vi.fn(), onSelectSession: vi.fn(), onInspectHistory: vi.fn() };
  });

  afterEach(async () => {
    await harness?.cleanup();
  });

  function expectReadOnly() {
    const labels = findAllByTag(harness.dom.container, "BUTTON").map((button) => button.textContent);
    for (const label of ["Acknowledge", "Resolve", "Accept risk", "Dismiss", "Hand off / Create Action", "Reactivate as a new episode", "Delete item", "Complete Action", "Reopen Action", "Start session"]) {
      expect(labels).not.toContain(label);
    }
    expect(findAllByTag(harness.dom.container, "FORM")).toHaveLength(0);
    expect(harness.queryClient.getQueryCache().getAll()).toHaveLength(0);
  }

  async function clickRelationship(prefix: string, label: string) {
    const row = findAllByTag(harness.dom.container, "LI").find((node) => node.textContent.startsWith(prefix));
    if (!row) throw new Error(`Retained relationship missing: ${prefix}`);
    await harness.act(() => { getReactProps(focusButton(row, label))!.onClick(); });
  }

  it("renders retained Markdown, evidence, decision context, provenance, and times without inventing live fields", async () => {
    const episode = {
      ...focusEpisode({
        activationId: "old-episode", title: "Original release decision", body: "Preserve **the original assessment**.\n\n[Recorded body link](https://example.test/old-body)",
        impact: "Old release impact", consequenceOfDelay: "Old rollback window", recommendation: "Keep the old release",
        fallback: "No rollout without a new decision", alternatives: ["Keep **old production**", "Reassess next week"],
        evidence: [
          "Retained **health report**",
          { summary: "Old probe returned 503", url: "https://example.test/old-probe", observedAt: "2026-08-01T12:00:00.000Z" },
        ],
        observedAt: "2026-08-01T12:00:00.000Z", validUntil: "2026-08-02T12:00:00.000Z", interventionBy: "2026-08-01T18:00:00.000Z",
        sourceFamily: "retired-release-watch", producer: "old-monitor", episodeReason: "Original failed release",
        notificationMode: "summary", authorizationGrantId: "old-grant", contentFingerprint: "retained-fingerprint",
      }),
      url: "https://example.test/unretained-url",
      visual: { title: "Unretained visual" },
      launchPrompt: { prompt: "Unretained prompt", label: "Launch unretained prompt" },
      priority: "high",
    };
    await harness.render(createElement(FocusEpisodeDetails, { episode, ...navigation }));
    expect(findAllByTag(harness.dom.container, "H5")[0].textContent).toBe(episode.title);
    expect(findAllByTag(harness.dom.container, "STRONG").map((node) => node.textContent)).toEqual(expect.arrayContaining([
      "the original assessment", "old production", "health report",
    ]));
    for (const value of ["Old release impact", "Old rollback window", "Keep the old release", "No rollout without a new decision", "Reassess next week",
      "Old probe returned 503", "retired-release-watch", "old-monitor", "Original failed release", "old-grant", "retained-fingerprint"]) {
      expect(harness.dom.container.textContent).toContain(value);
    }
    const times = findAllByTag(harness.dom.container, "TIME").map((node) => node.getAttribute("dateTime"));
    expect(times).toEqual(expect.arrayContaining([episode.observedAt, episode.validUntil, episode.interventionBy, episode.createdAt, episode.updatedAt, episode.statusChangedAt]));
    expect(harness.dom.container.textContent).toContain("not a current validity assessment");
    expect(harness.dom.container.textContent).toContain("Retained episode: old-episode");
    const links = findAllByTag(harness.dom.container, "A").map((node) => node.getAttribute("href"));
    expect(links).toEqual(expect.arrayContaining(["https://example.test/old-body", "https://example.test/old-probe"]));
    expect(links).not.toContain(episode.url);
    for (const text of ["Unretained visual", "Unretained prompt", "Launch unretained prompt", "Priority", "Within stated observation validity"]) {
      expect(harness.dom.container.textContent).not.toContain(text);
    }
    expectReadOnly();
  });

  it.each([
    ["resolved", "Resolved", "The earlier outcome was verified"],
    ["accepted_risk", "Risk accepted", "Exposure accepted through the earlier window"],
    ["dismissed", "Dismissed", "No work authorized for the duplicate"],
  ] as const)("preserves %s outcome and reason as a read-only recorded disposition", async (lifecycle, label, outcome) => {
    await harness.render(createElement(FocusEpisodeDetails, {
      episode: focusEpisode({ lifecycle, outcome, resolutionReason: "Earlier user disposition" }), ...navigation,
    }));
    expect(findAllByTag(harness.dom.container, "SPAN").some((node) => node.textContent === label)).toBe(true);
    expect(harness.dom.container.textContent).toContain(`Outcome: ${outcome}`);
    expect(harness.dom.container.textContent).toContain("Reason: Earlier user disposition");
    expect(harness.dom.container.textContent).toContain("read-only");
    expectReadOnly();
  });

  it("preserves Action links and all session IDs without inferring completion, resolution, or session task ownership", async () => {
    const episode = focusEpisode({
      activationId: "old-episode", lifecycle: "handed_off", taskId: "capture-task", taskTitle: "Task at capture",
      originalTaskId: "capture-task", originalTaskTitle: "Task at capture",
      sessionId: "primary-session", sessionIds: ["primary-session", "transition-session"],
      linkedActionIds: ["id-only-action", "linked-action", "id-only-action"],
      linkedActions: [
        { sourceId: "decision-1", sourceType: "decision", activationId: "old-episode", actionId: "linked-action", createdAt: FOCUS_TEST_NOW },
        { sourceId: "other-source", sourceType: "alert", activationId: "other-episode", actionId: "other-action", createdAt: FOCUS_TEST_NOW },
      ],
    });
    await harness.render(createElement(FocusEpisodeDetails, { episode, ...navigation }));
    const actions = findAllByTag(harness.dom.container, "LI").filter((node) => node.textContent.startsWith("Action ID:"));
    const sessions = findAllByTag(harness.dom.container, "LI").filter((node) => node.textContent.startsWith("Session ID:"));
    expect(actions).toHaveLength(3);
    expect(sessions).toHaveLength(2);
    expect(harness.dom.container.textContent).toContain("Source alert: other-source");
    expect(harness.dom.container.textContent).toContain("Linked episode: other-episode");
    expect(harness.dom.container.textContent).toContain("Linked episode: old-episode");
    expect(harness.dom.container.textContent).toContain("not current work state, completion, or resolution");
    expect(harness.dom.container.textContent).not.toContain("Action completed");
    expect(harness.dom.container.textContent).not.toContain("Work open");
    expect(harness.dom.container.textContent).toContain("This snapshot records an unresolved concern");
    await clickRelationship("Action ID: id-only-action", "Open linked Action record");
    await clickRelationship("Action ID: linked-action", "Open linked Action record");
    await clickRelationship("Action ID: other-action", "Open linked source record");
    expect(navigation.onInspectHistory).toHaveBeenNthCalledWith(1, "id-only-action");
    expect(navigation.onInspectHistory).toHaveBeenNthCalledWith(2, "linked-action");
    expect(navigation.onInspectHistory).toHaveBeenNthCalledWith(3, "other-source");
    await clickRelationship("Session ID: primary-session", "Open retained session");
    await clickRelationship("Session ID: transition-session", "Open retained session");
    expect(navigation.onSelectSession).toHaveBeenNthCalledWith(1, "primary-session");
    expect(navigation.onSelectSession).toHaveBeenNthCalledWith(2, "transition-session");
    await clickFocusButton(harness, "Open retained task");
    expect(navigation.onSelectTask).toHaveBeenCalledExactlyOnceWith("capture-task");
    expectReadOnly();
  });

  it("retains removed task context and navigable IDs without a live task or source lookup", async () => {
    await harness.render(createElement(FocusEpisodeDetails, {
      episode: focusEpisode({
        taskId: null, taskTitle: "Removed release task", originalTaskId: "removed-task", originalTaskTitle: "Removed release task",
        orphanedAt: FOCUS_TEST_NOW, sourceFamily: "retired-source", producer: "removed-producer", linkedActionIds: ["retained-action"],
      }),
      ...navigation, onInspectHistory: undefined,
    }));
    expect(harness.dom.container.textContent).toContain("Original task: Removed release task");
    expect(harness.dom.container.textContent).toContain("Original task ID: removed-task");
    expect(harness.dom.container.textContent).toContain("No task linked at capture.");
    expect(harness.dom.container.textContent).toContain("This does not reassign the record to Global Focus.");
    expect(harness.dom.container.textContent).toContain("retired-source");
    expect(harness.dom.container.textContent).toContain("removed-producer");
    expect(harness.dom.container.textContent).toContain("Action ID: retained-action");
    expect(findAllByTag(harness.dom.container, "BUTTON").map((button) => button.textContent)).toEqual(["Open original task"]);
    await clickFocusButton(harness, "Open original task");
    expect(navigation.onSelectTask).toHaveBeenCalledExactlyOnceWith("removed-task");
    expectReadOnly();
  });

  it("labels absent retained values instead of inventing evidence, outcomes, authority, or work", async () => {
    await harness.render(createElement(FocusEpisodeDetails, {
      episode: focusEpisode({
        objectType: "event", body: null, category: "note", evidence: [], alternatives: [], impact: null,
        recommendation: null, consequenceOfDelay: null, fallback: null, outcome: null, resolutionReason: null,
        observedAt: null, validUntil: null, interventionBy: null, sourceFamily: null, producer: null,
        taskId: null, taskTitle: null, originalTaskId: null, originalTaskTitle: null,
      }), ...navigation,
    }));
    for (const text of ["No body recorded.", "No outcome recorded", "No disposition reason recorded", "No alternatives recorded.",
      "No supporting evidence provided", "No Action links recorded.", "No session links recorded.", "An Event records an observation, not an obligation."]) {
      expect(harness.dom.container.textContent).toContain(text);
    }
    expect(findAllByTag(harness.dom.container, "BUTTON")).toHaveLength(0);
    expect(harness.dom.container.textContent).not.toContain("Verified");
    expectReadOnly();
  });

  it("progressively renders structured previousEpisode details and distinguishes its activation from the transition", async () => {
    const episode = focusEpisode({
      activationId: "previous-episode", title: "The earlier retained title", body: "Prior **structured content**.",
      lifecycle: "resolved", outcome: "Old verification held", resolutionReason: "Checked before reopening",
    });
    await harness.render(createElement(FocusTransitionList, {
      transitions: [transition({
        activationId: "new-episode", details: { previousEpisode: episode, receipt: "additional retained detail" },
        sessionId: "transition-session", relatedActionId: "transition-action",
      })], ...navigation,
    }));
    expect(harness.dom.container.textContent).toContain("Resolved → Active");
    expect(harness.dom.container.textContent).toContain("Transition episode: new-episode");
    expect(harness.dom.container.textContent).toContain("Retained episode: previous-episode");
    const disclosure = findAllByTag(harness.dom.container, "DETAILS").find((node) => findAllByTag(node, "SUMMARY")[0]?.textContent === "State before this transition — episode previous-episode");
    expect(disclosure).toBeDefined();
    expect(disclosure!.getAttribute("open")).toBeNull();
    expect(findAllByTag(disclosure, "H5")[0].textContent).toBe(episode.title);
    expect(findAllByTag(disclosure, "STRONG").some((node) => node.textContent === "structured content")).toBe(true);
    expect(disclosure!.textContent).toContain("Outcome: Old verification held");
    expect(disclosure!.textContent).toContain("Reason: Checked before reopening");
    const rawDetails = findAllByTag(harness.dom.container, "PRE")[0].textContent;
    expect(rawDetails).toContain('"receipt": "additional retained detail"');
    expect(rawDetails).not.toContain("previousEpisode");
    expect(rawDetails).not.toContain("Old verification held");
    await clickFocusButton(harness, "Open transition session");
    expect(navigation.onSelectSession).toHaveBeenCalledExactlyOnceWith("transition-session");
    await clickFocusButton(harness, "Open related Action");
    expect(navigation.onInspectHistory).toHaveBeenCalledExactlyOnceWith("transition-action");
    await clickFocusButton(harness, "Open retained task");
    expect(navigation.onSelectTask).toHaveBeenCalledExactlyOnceWith("task-1");
    expectReadOnly();
  });

  it("keeps legacy transition details readable and explicitly marks the missing prior snapshot", async () => {
    await harness.render(createElement(FocusTransitionList, {
      transitions: [
        transition({ id: "creation", fromLifecycle: null, toLifecycle: "active", reason: "Initial record" }),
        transition({ id: "deletion", fromLifecycle: "dismissed", toLifecycle: null, reason: "Removed duplicate", actor: "legacy", details: { legacyReceipt: "retained metadata" } }),
      ], ...navigation,
    }));
    expect(harness.dom.container.textContent).toContain("Created → Active");
    expect(harness.dom.container.textContent).toContain("Dismissed → Deleted");
    expect(harness.dom.container.textContent).toContain("Reason: Removed duplicate · Actor: legacy");
    expect(harness.dom.container.textContent).toContain("Prior details and outcome are unknown.");
    expect(findAllByTag(harness.dom.container, "H5")).toHaveLength(0);
    expect(findAllByTag(harness.dom.container, "PRE")[0].textContent).toContain("retained metadata");
    expectReadOnly();
  });
});
