import { describe, expect, it } from "vitest";
import {
  buildTaskDashboardSearch,
  isChecklistItemsReadyForFocus,
  resolveTaskDashboardFocus,
  resolveTaskPanelChecklistHighlight,
} from "./task-detail-focus";

describe("buildTaskDashboardSearch", () => {
  it("returns an empty search string when no options are provided", () => {
    expect(buildTaskDashboardSearch()).toBe("");
  });

  it("serializes section and checklist item options", () => {
    expect(buildTaskDashboardSearch({
      section: "checklist",
      checklistItemId: "item-123",
    })).toBe("?section=checklist&checklistItem=item-123");
  });
});

describe("isChecklistItemsReadyForFocus", () => {
  it("treats fresh cached data as ready", () => {
    expect(isChecklistItemsReadyForFocus({
      isFetched: true,
      isFetchedAfterMount: false,
      isStale: false,
      isFetching: false,
      isSuccess: true,
    })).toBe(true);
  });

  it("waits for a post-mount fetch when cached data is stale", () => {
    expect(isChecklistItemsReadyForFocus({
      isFetched: true,
      isFetchedAfterMount: false,
      isStale: true,
      isFetching: true,
      isSuccess: true,
    })).toBe(false);
  });

  it("becomes ready after the current mount fetch completes", () => {
    expect(isChecklistItemsReadyForFocus({
      isFetched: true,
      isFetchedAfterMount: true,
      isStale: true,
      isFetching: false,
      isSuccess: true,
    })).toBe(true);
  });

  it("does not become ready after a failed post-mount fetch", () => {
    expect(isChecklistItemsReadyForFocus({
      isFetched: true,
      isFetchedAfterMount: true,
      isStale: true,
      isFetching: false,
      isSuccess: false,
    })).toBe(false);
  });
});

describe("resolveTaskDashboardFocus", () => {
  it("waits for checklist items before consuming a checklist deep link", () => {
    expect(resolveTaskDashboardFocus({
      focusedSection: null,
      focusedChecklistItemId: "item-123",
      checklistItems: [],
      checklistItemsReady: false,
    })).toEqual({
      request: null,
      consumeParams: false,
    });
  });

  it("preserves checklist item focus once the target item is available", () => {
    expect(resolveTaskDashboardFocus({
      focusedSection: null,
      focusedChecklistItemId: "item-123",
      checklistItems: [{ id: "item-123" }],
      checklistItemsReady: true,
    })).toEqual({
      request: {
        section: "checklist",
        checklistItemId: "item-123",
      },
      consumeParams: true,
    });
  });

  it("falls back to the checklist section after checklist data loads without the item", () => {
    expect(resolveTaskDashboardFocus({
      focusedSection: null,
      focusedChecklistItemId: "item-123",
      checklistItems: [{ id: "item-999" }],
      checklistItemsReady: true,
    })).toEqual({
      request: {
        section: "checklist",
      },
      consumeParams: true,
    });
  });

  it("handles section-only deep links immediately", () => {
    expect(resolveTaskDashboardFocus({
      focusedSection: "sessions",
      focusedChecklistItemId: null,
      checklistItems: [],
      checklistItemsReady: false,
    })).toEqual({
      request: {
        section: "sessions",
      },
      consumeParams: true,
    });
  });
});

describe("resolveTaskPanelChecklistHighlight", () => {
  it("waits for checklist data before consuming panel checklist focus", () => {
    expect(resolveTaskPanelChecklistHighlight({
      focusedChecklistItemId: "item-123",
      checklistItems: [],
      checklistItemsReady: false,
    })).toEqual({
      highlightId: null,
      consumeParam: false,
    });
  });

  it("keeps the highlighted checklist item when it exists", () => {
    expect(resolveTaskPanelChecklistHighlight({
      focusedChecklistItemId: "item-123",
      checklistItems: [{ id: "item-123" }],
      checklistItemsReady: true,
    })).toEqual({
      highlightId: "item-123",
      consumeParam: true,
    });
  });

  it("drops invalid checklist focus once the checklist has loaded", () => {
    expect(resolveTaskPanelChecklistHighlight({
      focusedChecklistItemId: "item-123",
      checklistItems: [{ id: "item-999" }],
      checklistItemsReady: true,
    })).toEqual({
      highlightId: null,
      consumeParam: true,
    });
  });
});
