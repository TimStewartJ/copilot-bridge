import { createElement } from "react";
import { describe, expect, it } from "vitest";
import type { SessionContextSummary } from "../../shared/session-context";
import { createReactDomHarness, findAllByTag, getReactProps } from "../test-react-harness";
import {
  describeCacheExpiry,
  formatCompactTokens,
  getContextPressure,
  getSummaryMetrics,
} from "./SessionContextHelpers";
import SessionContextPanel from "./SessionContextPanel";

describe("SessionContextPanel", () => {
  it("keeps loading, unknown and failed context distinct without showing an empty graph", async () => {
    const harness = await createReactDomHarness();
    await harness.render(createElement(SessionContextPanel, { loading: true }));
    expect(harness.dom.container.textContent).toContain("Loading usage...");
    await harness.render(createElement(SessionContextPanel));
    expect(harness.dom.container.textContent).toContain("Context usage unavailable");
    expect(harness.dom.container.textContent).not.toContain("No context history");
    expect(findAllByTag(harness.dom.container, "DIV").some(node => getReactProps(node)?.role === "progressbar")).toBe(false);
    await harness.render(createElement(SessionContextPanel, { error: "Context service offline" }));
    expect(harness.dom.container.textContent).toContain("Context unavailable");
    expect(harness.dom.container.textContent).toContain("Context service offline");
    expect(findAllByTag(harness.dom.container, "DIV").some(node => getReactProps(node)?.role === "alert")).toBe(true);
  });

  it("keeps derived sub-one-percent context usage small", () => {
    expect(getSummaryMetrics({ tokensUsed: 5, contextWindow: 1000, tokensRemaining: 995, usageRatio: null }).percent).toBe(0.5);
  });

  it("formats token counts compactly and names the compaction pressure", () => {
    expect([840, 8_400, 84_000, 1_240_000, 12_000_000].map(formatCompactTokens)).toEqual(["840", "8.4k", "84k", "1.24M", "12M"]);
    expect([undefined, 79, 80, 94, 95].map((percent) => getContextPressure(percent))).toEqual(["room", "room", "compacting", "compacting", "blocking"]);
    expect(getContextPressure(70, 65)).toBe("compacting");
  });

  it("describes whether the prompt cache is still warm", () => {
    const now = Date.UTC(2026, 8, 22, 10, 0);
    expect(describeCacheExpiry(new Date(now + 3 * 60_000).toISOString(), now)).toEqual({ warm: true, text: "cache warm for 3 more min" });
    expect(describeCacheExpiry(new Date(now - 12 * 60_000).toISOString(), now)).toEqual({ warm: false, text: "cache expired 12 min ago" });
    expect(describeCacheExpiry(null, now)).toBeUndefined();
  });

  it("splits the window, counts compactions and shows session totals", async () => {
    const harness = await createReactDomHarness();
    try {
      await harness.render(createElement(SessionContextPanel, {
        summary: summary({ tokensUsed: 420_000, contextWindow: 872_000, usageRatio: 420_000 / 872_000, compactionCount: 2 }),
        insights: {
          breakdown: {
            observedAt: "2026-09-22T12:00:00.000Z", tokensUsed: 420_000,
            systemTokens: 21_000, toolDefinitionsTokens: 30_000, conversationTokens: 369_000,
          },
          lastCompaction: {
            occurredAt: "2026-09-22T11:00:00.000Z", preCompactionTokens: 700_000, postCompactionTokens: 76_000, trigger: "threshold",
          },
          cacheExpiresAt: null,
        },
        usage: {
          available: true, totalNanoAiu: null, aiCredits: null, costUsd: 1.84, totalPremiumRequestCost: 0,
          totalUserRequests: 14, modelRequests: 37, apiDurationMs: 125_000,
          tokens: { inputTokens: 1_000_000, outputTokens: 20_000, cacheReadTokens: 910_000, cacheWriteTokens: 50_000, reasoningTokens: 0 },
          codeChanges: { linesAdded: 1204, linesRemoved: 311, filesModified: 14 },
        },
        cost: { label: "$1.84" },
      }));
      const text = harness.dom.container.textContent;
      expect(text).toContain("420k of 872k");
      expect(text).toContain("Instructions21k");
      expect(text).toContain("Tool definitions30k");
      expect(text).toContain("Conversation369k");
      expect(text).toContain("Compacted 2 times.");
      expect(text).not.toContain("700k");
      expect(text).toContain("Model calls37for 14 messages since the session was loaded");
      expect(text).toContain("91% of input reused");
      expect(text).toContain("2m 05s");
      expect(text).toContain("+1,204 −311");
      expect(text).toContain("whole session, all models and agents");
    } finally {
      await harness.cleanup();
    }
  });

  it("warns once the window is past the compaction point and ignores a split from before compaction", async () => {
    const harness = await createReactDomHarness();
    try {
      await harness.render(createElement(SessionContextPanel, {
        summary: summary({ tokensUsed: 850, contextWindow: 1000, usageRatio: 0.85, compactionCount: 1 }),
        insights: {
          breakdown: { observedAt: "2026-09-22T10:00:00.000Z", tokensUsed: 800, systemTokens: 100, toolDefinitionsTokens: 50, conversationTokens: 650 },
          lastCompaction: { occurredAt: "2026-09-22T11:00:00.000Z", preCompactionTokens: null, postCompactionTokens: null, trigger: null },
          cacheExpiresAt: null,
        },
      }));
      const text = harness.dom.container.textContent;
      expect(text).toContain("older turns are being summarised in the background");
      expect(text).not.toContain("Instructions");
    } finally {
      await harness.cleanup();
    }
  });
});

function summary(overrides: Partial<SessionContextSummary>): SessionContextSummary {
  return {
    sessionId: "s", provider: "copilot", providerSessionId: null, updatedAt: "2026-09-22T12:00:00.000Z",
    currentModel: "model", latestBridgeTurnId: null, latestSnapshotAt: null, contextWindow: null, tokensUsed: null,
    tokensRemaining: null, usageRatio: null, modelUsage: null, snapshotCount: 1, compactionCount: 0,
    truncationCount: 0, shutdownCount: 0, ...overrides,
  };
}
