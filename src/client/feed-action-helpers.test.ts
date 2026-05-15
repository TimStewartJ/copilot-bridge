import { describe, expect, it } from "vitest";
import type { FeedCard } from "./api";
import { buildFeedCardChatContext, buildFeedCardChatPrompt } from "./feed-action-helpers";

function makeCard(overrides: Partial<FeedCard> = {}): FeedCard {
  return {
    id: "card-1",
    dedupeKey: "preview:one",
    title: "Preview ready",
    body: "Open the staging preview.",
    kind: "status",
    priority: "high",
    status: "active",
    taskId: "task-1",
    sessionId: null,
    url: "https://example.test/preview",
    links: [{ label: "Notes", url: "https://example.test/notes" }],
    metadata: { source: "agent", ignored: { large: true } },
    visual: {
      artifactId: "visual-1",
      kind: "image",
      title: "Chart",
      displayName: "chart.png",
      mimeType: "image/png",
      size: 42,
      url: "/api/feed/card-1/visuals/visual-1",
      downloadUrl: "/api/feed/card-1/visuals/visual-1/download",
      caption: "Preview chart",
      altText: "A chart",
      source: "raw visual content should not be included",
    },
    action: null,
    pinned: true,
    statusChangedAt: "2026-05-13T10:00:00.000Z",
    createdAt: "2026-05-13T10:00:00.000Z",
    updatedAt: "2026-05-13T11:00:00.000Z",
    ...overrides,
  };
}

describe("feed action helpers", () => {
  it("builds bounded chat context from safe feed card fields", () => {
    const context = buildFeedCardChatContext(makeCard());

    expect(context).toContain("# Feed card context");
    expect(context).toContain("- Title: Preview ready");
    expect(context).toContain("- Kind: status");
    expect(context).toContain("- Priority: high");
    expect(context).toContain("- Pinned: yes");
    expect(context).toContain("- Source: agent");
    expect(context).toContain("- Related task ID: task-1");
    expect(context).toContain("- URL: https://example.test/preview");
    expect(context).toContain("- Notes: https://example.test/notes");
    expect(context).toContain("## Visual");
    expect(context).toContain("- Type: image");
    expect(context).toContain("- Title: Chart");
    expect(context).toContain("- Caption: Preview chart");
    expect(context).toContain("Open the staging preview.");
    expect(context).not.toContain("raw visual content should not be included");
    expect(context).not.toContain("ignored");
  });

  it("truncates oversized card bodies", () => {
    const context = buildFeedCardChatContext(makeCard({ body: "x".repeat(8_100) }));

    expect(context).toContain("[Truncated 100 additional characters]");
    expect(context.length).toBeLessThan(9_000);
  });

  it("combines card context with a user message and defaults empty messages", () => {
    const context = buildFeedCardChatContext(makeCard());
    const prompt = buildFeedCardChatPrompt(context, "What should I do next?");
    const defaultPrompt = buildFeedCardChatPrompt(context, "   ");

    expect(prompt).toContain("Use the feed card context below when responding.");
    expect(prompt).toContain("# Feed card context");
    expect(prompt).toContain("# My message\nWhat should I do next?");
    expect(defaultPrompt).toContain("# My message\nLet's discuss this feed card.");
  });
});
