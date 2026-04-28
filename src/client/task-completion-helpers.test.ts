import { describe, expect, it } from "vitest";
import {
  describeTaskCompletionSummary,
  getTaskCompletionCounts,
  getTaskCompletionState,
  getTaskCompletionSummaryParts,
  getTaskLifecycleBadgeClass,
  getTaskLifecycleDisplayState,
  getTaskStatusLabel,
  getTaskStatusTextClass,
  shouldShowTaskArchiveToggle,
  shouldSurfaceReadyToCompleteCue,
} from "./task-completion-helpers";

describe("getTaskCompletionCounts", () => {
  it("counts completed checklist items, busy sessions, and unresolved PRs", () => {
    const counts = getTaskCompletionCounts({
      checklistItems: [{ done: true }, { done: false }, { done: true }],
      linkedSessions: [
        { busy: false, runState: "idle" },
        { busy: true, runState: "idle" },
        { busy: false, runState: "stalled" },
      ],
      pullRequests: [
        { status: "completed" },
        { status: "active" },
        { status: null },
      ],
    });

    expect(counts).toEqual({
      totalChecklistItems: 3,
      completedChecklistItems: 2,
      openChecklistItems: 1,
      linkedSessions: 3,
      busySessions: 2,
      linkedPullRequests: 3,
      activePullRequests: 1,
      unknownPullRequests: 1,
    });
  });
});

describe("getTaskCompletionState", () => {
  it("marks active tasks with no blockers as strong close candidates", () => {
    const state = getTaskCompletionState(
      { status: "active", doneWhen: "Merged and deployed" },
      {
        totalChecklistItems: 2,
        completedChecklistItems: 2,
        openChecklistItems: 0,
        linkedSessions: 2,
        busySessions: 0,
        linkedPullRequests: 1,
        activePullRequests: 0,
        unknownPullRequests: 0,
      },
    );

    expect(state.isReadyToComplete).toBe(true);
    expect(state.isStrongCloseCandidate).toBe(true);
    expect(state.ctaState).toBe("ready");
    expect(state.ctaLabel).toBe("Complete task");
    expect(state.ctaCompletionAction).toBe("complete-and-archive");
    expect(state.ctaDescription).toBe("Merged and deployed");
    expect(state.blockers).toEqual([]);
  });

  it("keeps paused tasks ready to complete without calling them close candidates", () => {
    const state = getTaskCompletionState(
      { status: "paused", doneWhen: undefined },
      {
        totalChecklistItems: 0,
        completedChecklistItems: 0,
        openChecklistItems: 0,
        linkedSessions: 0,
        busySessions: 0,
        linkedPullRequests: 0,
        activePullRequests: 0,
        unknownPullRequests: 0,
      },
    );

    expect(state.isReadyToComplete).toBe(true);
    expect(state.isStrongCloseCandidate).toBe(false);
    expect(state.ctaState).toBe("ready");
    expect(state.ctaLabel).toBe("Complete task");
    expect(state.ctaCompletionAction).toBe("complete-and-archive");
    expect(state.ctaDescription).toBe("No open checklist items, busy sessions, or unresolved PRs");
  });

  it("surfaces blockers for incomplete work", () => {
    const state = getTaskCompletionState(
      { status: "active", doneWhen: undefined },
      {
        totalChecklistItems: 4,
        completedChecklistItems: 2,
        openChecklistItems: 2,
        linkedSessions: 3,
        busySessions: 1,
        linkedPullRequests: 2,
        activePullRequests: 1,
        unknownPullRequests: 1,
      },
    );

    expect(state.isReadyToComplete).toBe(false);
    expect(state.isStrongCloseCandidate).toBe(false);
    expect(state.ctaState).toBe("default");
    expect(state.ctaLabel).toBe("Complete task");
    expect(state.ctaNextStatus).toBeNull();
    expect(state.ctaCompletionAction).toBeNull();
    expect(state.blockers).toEqual([
      "2 open checklist items",
      "1 busy session",
      "1 active PR",
      "1 PR with unknown status",
    ]);
    expect(state.ctaDescription).toBe("2 open checklist items • 1 busy session • 1 active PR • 1 PR with unknown status");
  });

  it("keeps completion disabled while checklist readiness is unknown", () => {
    const state = getTaskCompletionState(
      { status: "active", doneWhen: undefined },
      {
        totalChecklistItems: 0,
        completedChecklistItems: 0,
        openChecklistItems: 0,
        linkedSessions: 0,
        busySessions: 0,
        linkedPullRequests: 0,
        activePullRequests: 0,
        unknownPullRequests: 0,
      },
      { checklistLoaded: false },
    );

    expect(state.isReadyToComplete).toBe(false);
    expect(state.isStrongCloseCandidate).toBe(false);
    expect(state.ctaState).toBe("default");
    expect(state.ctaNextStatus).toBeNull();
    expect(state.ctaCompletionAction).toBeNull();
    expect(state.blockers).toEqual(["Checklist items haven't loaded yet"]);
    expect(state.ctaDescription).toBe("Checklist items haven't loaded yet");
  });

  it("returns terminal CTA states for done and archived tasks", () => {
    expect(getTaskCompletionState(
      { status: "done", doneWhen: "Shipped", completedAt: "2026-04-01T00:00:00.000Z" },
      {
        totalChecklistItems: 0,
        completedChecklistItems: 0,
        openChecklistItems: 0,
        linkedSessions: 0,
        busySessions: 0,
        linkedPullRequests: 0,
        activePullRequests: 0,
        unknownPullRequests: 0,
      },
    )).toMatchObject({
      ctaState: "completed",
      ctaLabel: "Reopen task",
      ctaDescription: "Done when: Shipped",
      ctaNextStatus: "active",
      ctaCompletionAction: null,
    });

    expect(getTaskCompletionState(
      { status: "archived", doneWhen: undefined, completedAt: undefined },
      {
        totalChecklistItems: 0,
        completedChecklistItems: 0,
        openChecklistItems: 0,
        linkedSessions: 0,
        busySessions: 0,
        linkedPullRequests: 0,
        activePullRequests: 0,
        unknownPullRequests: 0,
      },
    )).toMatchObject({
      ctaState: "archived",
      ctaLabel: "Archived",
      ctaDescription: "Archived tasks cannot be completed",
      ctaNextStatus: null,
      ctaCompletionAction: null,
    });

    expect(getTaskCompletionState(
      { status: "archived", doneWhen: "Shipped", completedAt: "2026-04-01T00:00:00.000Z" },
      {
        totalChecklistItems: 0,
        completedChecklistItems: 0,
        openChecklistItems: 0,
        linkedSessions: 0,
        busySessions: 0,
        linkedPullRequests: 0,
        activePullRequests: 0,
        unknownPullRequests: 0,
      },
    )).toMatchObject({
      ctaState: "completed",
      ctaLabel: "Reopen task",
      ctaDescription: "Done when: Shipped",
      ctaNextStatus: "active",
      ctaCompletionAction: null,
    });
  });
});

describe("task completion summary copy", () => {
  it("builds summary parts for completion feedback", () => {
    const counts = {
      totalChecklistItems: 3,
      completedChecklistItems: 2,
      openChecklistItems: 1,
      linkedSessions: 4,
      busySessions: 0,
      linkedPullRequests: 2,
      activePullRequests: 0,
      unknownPullRequests: 0,
    };

    expect(getTaskCompletionSummaryParts({ doneWhen: "QA signs off" }, counts)).toEqual([
      "2 of 3 checklist items complete",
      "4 linked sessions",
      "2 linked PRs",
      "Done when: QA signs off",
    ]);
    expect(describeTaskCompletionSummary({ doneWhen: "QA signs off" }, counts)).toBe(
      "2 of 3 checklist items complete • 4 linked sessions • 2 linked PRs • Done when: QA signs off",
    );
  });

  it("uses friendly zero-state copy when nothing is linked", () => {
    const counts = {
      totalChecklistItems: 0,
      completedChecklistItems: 0,
      openChecklistItems: 0,
      linkedSessions: 0,
      busySessions: 0,
      linkedPullRequests: 0,
      activePullRequests: 0,
      unknownPullRequests: 0,
    };

    expect(getTaskCompletionSummaryParts({ doneWhen: undefined }, counts)).toEqual([
      "No checklist items",
      "0 linked sessions",
      "0 linked PRs",
    ]);
  });
});

describe("shouldSurfaceReadyToCompleteCue", () => {
  it("fires only when the last open checklist item is finished and the task is ready", () => {
    expect(shouldSurfaceReadyToCompleteCue({
      previousOpenChecklistItems: 1,
      nextOpenChecklistItems: 0,
      isReadyToComplete: true,
    })).toBe(true);

    expect(shouldSurfaceReadyToCompleteCue({
      previousOpenChecklistItems: null,
      nextOpenChecklistItems: 0,
      isReadyToComplete: true,
    })).toBe(false);

    expect(shouldSurfaceReadyToCompleteCue({
      previousOpenChecklistItems: 2,
      nextOpenChecklistItems: 0,
      isReadyToComplete: true,
    })).toBe(false);

    expect(shouldSurfaceReadyToCompleteCue({
      previousOpenChecklistItems: 1,
      nextOpenChecklistItems: 0,
      isReadyToComplete: false,
    })).toBe(false);
  });
});

describe("shouldShowTaskArchiveToggle", () => {
  it("hides the archive toggle when reopening is already the only truthful action", () => {
    expect(shouldShowTaskArchiveToggle(
      { status: "archived", completedAt: "2026-04-01T00:00:00.000Z" },
      { ctaState: "completed" },
    )).toBe(false);
  });

  it("keeps the archive toggle for non-completed archived tasks", () => {
    expect(shouldShowTaskArchiveToggle(
      { status: "archived", completedAt: undefined },
      { ctaState: "archived" },
    )).toBe(true);
  });
});

describe("getTaskLifecycleDisplayState", () => {
  it("returns 'completed' for done status", () => {
    expect(getTaskLifecycleDisplayState({ status: "done", completedAt: undefined })).toBe("completed");
  });

  it("returns 'completed' for archived task with completedAt", () => {
    expect(getTaskLifecycleDisplayState({ status: "archived", completedAt: "2026-04-01T00:00:00.000Z" })).toBe("completed");
  });

  it("returns 'archived' for archived task without completedAt", () => {
    expect(getTaskLifecycleDisplayState({ status: "archived", completedAt: undefined })).toBe("archived");
  });

  it("returns 'active' for active task", () => {
    expect(getTaskLifecycleDisplayState({ status: "active", completedAt: undefined })).toBe("active");
  });
});

describe("getTaskStatusLabel", () => {
  it("labels done tasks as Completed", () => {
    expect(getTaskStatusLabel({ status: "done", completedAt: undefined })).toBe("Completed");
  });

  it("labels archived+completedAt tasks as Completed", () => {
    expect(getTaskStatusLabel({ status: "archived", completedAt: "2026-04-01T00:00:00.000Z" })).toBe("Completed");
  });

  it("labels manually archived tasks as Archived", () => {
    expect(getTaskStatusLabel({ status: "archived", completedAt: undefined })).toBe("Archived");
  });

  it("labels active tasks as Active", () => {
    expect(getTaskStatusLabel({ status: "active", completedAt: undefined })).toBe("Active");
  });
});

describe("getTaskLifecycleBadgeClass", () => {
  it("uses accent colour for completed tasks", () => {
    expect(getTaskLifecycleBadgeClass({ status: "archived", completedAt: "2026-04-01T00:00:00.000Z" })).toContain("text-accent");
  });

  it("uses muted colour for archived tasks", () => {
    expect(getTaskLifecycleBadgeClass({ status: "archived", completedAt: undefined })).toContain("text-text-muted");
  });

  it("uses success colour for active tasks", () => {
    expect(getTaskLifecycleBadgeClass({ status: "active", completedAt: undefined })).toContain("text-success");
  });
});

describe("getTaskStatusTextClass", () => {
  it("returns faint class for archived tasks", () => {
    expect(getTaskStatusTextClass({ status: "archived", completedAt: undefined })).toBe("text-text-faint");
  });

  it("returns muted class for completed tasks", () => {
    expect(getTaskStatusTextClass({ status: "done", completedAt: undefined })).toBe("text-text-muted");
  });

  it("returns success class for active tasks", () => {
    expect(getTaskStatusTextClass({ status: "active", completedAt: undefined })).toBe("text-success");
  });
});
