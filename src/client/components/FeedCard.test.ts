import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { FeedCard as FeedCardData } from "../api";
import FeedCard from "./FeedCard";

function makeCard(overrides: Partial<FeedCardData> = {}): FeedCardData {
  return {
    id: "card-1",
    dedupeKey: "preview:one",
    title: "Preview ready",
    body: "Open the staging preview.",
    kind: "status",
    priority: "high",
    status: "active",
    taskId: "task-1",
    sessionId: "session-1",
    url: "https://example.test/preview",
    links: [{ label: "Notes", url: "https://example.test/notes" }],
    metadata: { source: "agent" },
    visual: null,
    pinned: true,
    statusChangedAt: "2026-05-13T10:00:00.000Z",
    createdAt: "2026-05-13T10:00:00.000Z",
    updatedAt: "2026-05-13T10:00:00.000Z",
    ...overrides,
  };
}

function renderCard(card: FeedCardData): string {
  return renderToStaticMarkup(createElement(FeedCard, {
    card,
    onSelectTask: vi.fn(),
    onSelectSession: vi.fn(),
    onStatusChange: vi.fn(),
    onDelete: vi.fn(),
  }));
}

describe("FeedCard", () => {
  it("renders card content, links, and built-in actions", () => {
    const html = renderCard(makeCard());

    expect(html).toContain("Preview ready");
    expect(html).toContain("Open the staging preview.");
    expect(html).toContain("Pinned");
    expect(html).toContain("Status");
    expect(html).toContain("high");
    expect(html).toContain("Open task");
    expect(html).toContain("Open session");
    expect(html).toContain("https://example.test/preview");
    expect(html).toContain("Notes");
    expect(html).toContain("Mark done");
    expect(html).toContain("Dismiss");
  });

  it("falls back for unknown kinds and can reactivate resolved cards", () => {
    const html = renderCard(makeCard({
      kind: "approval-needed",
      status: "dismissed",
      priority: "low",
      pinned: false,
    }));

    expect(html).toContain("Approval Needed");
    expect(html).toContain("Dismissed");
    expect(html).toContain("low");
    expect(html).toContain("Reactivate");
    expect(html).not.toContain("Pinned");
  });

  it("renders visual artifacts with the shared visual card renderer", () => {
    const html = renderCard(makeCard({
      visual: {
        artifactId: "11111111-1111-4111-8111-111111111111",
        kind: "image",
        title: "Chart",
        displayName: "chart.png",
        mimeType: "image/png",
        size: 42,
        url: "/api/feed/card-1/visuals/11111111-1111-4111-8111-111111111111",
        downloadUrl: "/api/feed/card-1/visuals/11111111-1111-4111-8111-111111111111/download",
        altText: "Chart preview",
      },
    }));

    expect(html).toContain("Chart");
    expect(html).toContain("Chart preview");
    expect(html).toContain("/api/feed/card-1/visuals/11111111-1111-4111-8111-111111111111");
    expect(html).toContain("Download chart.png");
  });
});
