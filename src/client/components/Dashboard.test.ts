import { describe, expect, it } from "vitest";
import type { FeedCard } from "../api";
import { mergeDashboardFeedCards } from "./Dashboard";

function makeCard(overrides: Partial<FeedCard> = {}): FeedCard {
  return {
    id: "card-1",
    dedupeKey: "feed:one",
    title: "Feed card",
    body: null,
    kind: "note",
    priority: "normal",
    status: "active",
    taskId: null,
    sessionId: null,
    url: null,
    links: [],
    metadata: null,
    visual: null,
    action: null,
    pinned: false,
    statusChangedAt: "2026-05-13T10:00:00.000Z",
    createdAt: "2026-05-13T10:00:00.000Z",
    updatedAt: "2026-05-13T10:00:00.000Z",
    ...overrides,
  };
}

describe("mergeDashboardFeedCards", () => {
  it("prefers fresh resolved cards over stale active copies and orders each bucket", () => {
    const staleActiveCopy = makeCard({
      id: "same-card",
      title: "Stale active",
      status: "active",
      pinned: true,
      updatedAt: "2026-05-13T10:00:00.000Z",
    });
    const freshResolvedCopy = makeCard({
      id: "same-card",
      title: "Fresh done",
      status: "done",
      statusChangedAt: "2026-05-13T10:05:00.000Z",
      updatedAt: "2026-05-13T10:05:00.000Z",
    });
    const recentActive = makeCard({
      id: "active-recent",
      title: "Recent active",
      status: "active",
      updatedAt: "2026-05-13T10:04:00.000Z",
    });
    const olderDismissed = makeCard({
      id: "dismissed-old",
      title: "Older dismissed",
      status: "dismissed",
      statusChangedAt: "2026-05-13T10:03:00.000Z",
      updatedAt: "2026-05-13T10:03:00.000Z",
    });

    expect(mergeDashboardFeedCards(
      [staleActiveCopy, recentActive],
      [olderDismissed, freshResolvedCopy],
    ).map((card) => `${card.status}:${card.title}`)).toEqual([
      "active:Recent active",
      "done:Fresh done",
      "dismissed:Older dismissed",
    ]);
  });

  it("orders resolved cards with equal status changes by updated time and id", () => {
    const statusChangedAt = "2026-05-13T10:00:00.000Z";
    const oldestUpdated = makeCard({
      id: "00000000-0000-4000-8000-000000000001",
      status: "done",
      statusChangedAt,
      updatedAt: "2026-05-13T10:01:00.000Z",
    });
    const sameUpdatedHighId = makeCard({
      id: "00000000-0000-4000-8000-000000000004",
      status: "done",
      statusChangedAt,
      updatedAt: "2026-05-13T10:02:00.000Z",
    });
    const sameUpdatedLowId = makeCard({
      id: "00000000-0000-4000-8000-000000000003",
      status: "done",
      statusChangedAt,
      updatedAt: "2026-05-13T10:02:00.000Z",
    });
    const newestUpdated = makeCard({
      id: "00000000-0000-4000-8000-000000000002",
      status: "done",
      statusChangedAt,
      updatedAt: "2026-05-13T10:03:00.000Z",
    });

    expect(mergeDashboardFeedCards(
      [],
      [oldestUpdated, sameUpdatedLowId, newestUpdated, sameUpdatedHighId],
    ).map((card) => card.id)).toEqual([
      newestUpdated.id,
      sameUpdatedHighId.id,
      sameUpdatedLowId.id,
      oldestUpdated.id,
    ]);
  });
});
