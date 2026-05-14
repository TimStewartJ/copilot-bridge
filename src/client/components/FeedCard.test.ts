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
    action: null,
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
    onAction: vi.fn(),
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
    expect(html).toContain("agent");
    expect(html).toContain("Posted");
    expect(html).toContain('dateTime="2026-05-13T10:00:00.000Z"');
    expect(html).toContain("High priority");
    expect(html).toContain("Open task");
    expect(html).toContain("Open session");
    expect(html).toContain("https://example.test/preview");
    expect(html).toContain("Notes");
    expect(html).toContain("Mark done");
    expect(html).toContain("Dismiss");
    expect(html).toContain("More");
    expect(html).toContain("min-h-11");
    expect(html).toContain('aria-label="More actions"');
    expect(html).not.toContain("Delete card");
  });

  it("uses kind as the header label when no metadata source exists and truncates real source labels", () => {
    const fallbackHtml = renderCard(makeCard({ metadata: { source: "   " }, kind: "decision" }));
    const truncatedHtml = renderCard(makeCard({
      metadata: { source: "A very long source name that should not dominate the card header" },
    }));

    expect(fallbackHtml).toContain("Decision");
    expect(fallbackHtml).not.toContain("Decision update");
    expect(truncatedHtml).toContain("A very long source name that...");
    expect(truncatedHtml).not.toContain("should not dominate");
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

  it("makes resolved cards visually distinct from active high-priority cards", () => {
    const doneHtml = renderCard(makeCard({
      status: "done",
      priority: "high",
    }));
    const dismissedHtml = renderCard(makeCard({
      status: "dismissed",
      priority: "high",
    }));

    expect(doneHtml).toContain("border-success/25");
    expect(doneHtml).toContain("bg-success/70");
    expect(doneHtml).toContain("text-text-secondary");
    expect(doneHtml).not.toContain("border-warning/50");
    expect(dismissedHtml).toContain("bg-bg-secondary/55");
    expect(dismissedHtml).toContain("bg-text-faint/50");
    expect(dismissedHtml).toContain("text-text-muted");
    expect(dismissedHtml).not.toContain("border-warning/50");
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

  it("renders prompt actions for active cards", () => {
    const html = renderCard(makeCard({
      action: {
        label: "Review this",
        prompt: "Open a session and review this card.",
      },
    }));

    expect(html).toContain("Review this");
    expect(html).toContain("button");
  });

  it("marks pending cards busy and disables card actions", () => {
    const html = renderToStaticMarkup(createElement(FeedCard, {
      card: makeCard(),
      pending: true,
      onSelectTask: vi.fn(),
      onSelectSession: vi.fn(),
      onAction: vi.fn(),
      onStatusChange: vi.fn(),
      onDelete: vi.fn(),
    }));

    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Saving...");
    expect(html.match(/Saving\.\.\./g)).toHaveLength(1);
    expect(html).toContain("disabled=\"\"");
  });
});
