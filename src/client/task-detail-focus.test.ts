import { describe, expect, it } from "vitest";
import {
  isChecklistItemsReadyForFocus,
  resolveTaskPanelChecklistHighlight,
} from "./task-detail-focus";

describe("isChecklistItemsReadyForFocus", () => {
  it("is ready when data is fresh or post-mount fetch succeeded, not ready while fetching or after failed fetch", () => {
    const cases: [Parameters<typeof isChecklistItemsReadyForFocus>[0], boolean, string][] = [
      // fresh cached data — ready immediately
      [{ isFetched: true, isFetchedAfterMount: false, isStale: false, isFetching: false, isSuccess: true }, true, "fresh cached"],
      // stale cached data with in-progress post-mount fetch — wait
      [{ isFetched: true, isFetchedAfterMount: false, isStale: true, isFetching: true, isSuccess: true }, false, "stale fetching"],
      // post-mount fetch completed successfully — ready
      [{ isFetched: true, isFetchedAfterMount: true, isStale: true, isFetching: false, isSuccess: true }, true, "fetched after mount"],
      // post-mount fetch failed — not ready
      [{ isFetched: true, isFetchedAfterMount: true, isStale: true, isFetching: false, isSuccess: false }, false, "failed after mount"],
    ];
    for (const [state, expected, label] of cases) {
      expect(isChecklistItemsReadyForFocus(state), label).toBe(expected);
    }
  });
});

describe("resolveTaskPanelChecklistHighlight", () => {
  it("waits for data before consuming, highlights existing items, drops invalid focus once loaded", () => {
    const cases: [Parameters<typeof resolveTaskPanelChecklistHighlight>[0], ReturnType<typeof resolveTaskPanelChecklistHighlight>, string][] = [
      // not ready — hold off consuming
      [
        { focusedChecklistItemId: "item-123", checklistItems: [], checklistItemsReady: false },
        { highlightId: null, consumeParam: false },
        "not ready",
      ],
      // ready + item exists — highlight and consume
      [
        { focusedChecklistItemId: "item-123", checklistItems: [{ id: "item-123" }], checklistItemsReady: true },
        { highlightId: "item-123", consumeParam: true },
        "item found",
      ],
      // ready + item missing — drop and consume
      [
        { focusedChecklistItemId: "item-123", checklistItems: [{ id: "item-999" }], checklistItemsReady: true },
        { highlightId: null, consumeParam: true },
        "item missing",
      ],
    ];
    for (const [input, expected, label] of cases) {
      expect(resolveTaskPanelChecklistHighlight(input), label).toEqual(expected);
    }
  });
});
