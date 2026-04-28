import { describe, expect, it } from "vitest";
import {
  isChecklistItemsReadyForFocus,
  resolveTaskPanelChecklistHighlight,
} from "./task-detail-focus";

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
