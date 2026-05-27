import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Session } from "../api";
import { createReactDomHarness } from "../test-react-harness";
import {
  canKeepCurrentReasoningEffortForModel,
  formatReasoningEffortLabel,
  formatSessionModelLabel,
} from "./SessionList";

async function renderSessionList(sessions: Session[]) {
  const harness = await createReactDomHarness();
  const { default: SessionList } = await import("./SessionList");

  await harness.render(createElement(SessionList, {
    variant: "global",
    sessions,
    activeSessionId: null,
    onSelectSession: vi.fn(),
    onNewSession: vi.fn(),
    showNewButton: false,
  }));

  return { dom: harness.dom, cleanup: harness.cleanup };
}

function createSession(overrides: Partial<Session> & { sessionId: string }): Session {
  return {
    summary: "Test session",
    deferSummary: { count: 0, nextRunAt: null },
    ...overrides,
  };
}

function minutesFromNow(minutes: number): string {
  return new Date(Date.now() + minutes * 60_000).toISOString();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-04-27T12:00:00.000Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("SessionList input-required indicator", () => {
  it("renders a needs-answer marker for sessions waiting on user input", async () => {
    const { dom, cleanup } = await renderSessionList([
      createSession({
        sessionId: "session-1",
        summary: "Waiting session",
        runState: "busy",
        busy: true,
        pendingUserInputCount: 1,
        needsUserInput: true,
      }),
    ]);

    try {
      expect(dom.container.textContent).toContain("Waiting session");
      expect(dom.container.textContent).toContain("Needs answer");
    } finally {
      await cleanup();
    }
  });
});

describe("SessionList defer summary indicator", () => {
  it("renders a single defer with the next run time", async () => {
    const { dom, cleanup } = await renderSessionList([
      createSession({
        sessionId: "session-1",
        summary: "Deferred session",
        deferSummary: { count: 1, nextRunAt: minutesFromNow(5) },
      }),
    ]);

    try {
      expect(dom.container.textContent).toContain("Deferred session");
      expect(dom.container.textContent).toContain("Deferred in 5m");
    } finally {
      await cleanup();
    }
  });

  it("renders multiple defers with the count and next run time", async () => {
    const { dom, cleanup } = await renderSessionList([
      createSession({
        sessionId: "session-1",
        summary: "Queued session",
        deferSummary: { count: 2, nextRunAt: minutesFromNow(5) },
      }),
    ]);

    try {
      expect(dom.container.textContent).toContain("2 defers · next in 5m");
    } finally {
      await cleanup();
    }
  });

  it("does not render a defer label when the summary is cleared", async () => {
    const { dom, cleanup } = await renderSessionList([
      createSession({
        sessionId: "session-1",
        summary: "Cleared session",
        deferSummary: { count: 0, nextRunAt: minutesFromNow(5) },
      }),
    ]);

    try {
      expect(dom.container.textContent).toContain("Cleared session");
      expect(dom.container.textContent).not.toContain("Deferred");
      expect(dom.container.textContent).not.toContain("defers");
    } finally {
      await cleanup();
    }
  });

  it("coexists with the needs-answer indicator", async () => {
    const { dom, cleanup } = await renderSessionList([
      createSession({
        sessionId: "session-1",
        summary: "Waiting deferred session",
        needsUserInput: true,
        pendingUserInputCount: 1,
        deferSummary: { count: 1, nextRunAt: minutesFromNow(5) },
      }),
    ]);

    try {
      expect(dom.container.textContent).toContain("Needs answer");
      expect(dom.container.textContent).toContain("Deferred in 5m");
    } finally {
      await cleanup();
    }
  });
});

describe("session model menu labels", () => {
  it("formats model names with reasoning effort labels", () => {
    expect(formatSessionModelLabel(
      { model: "gpt-5.5", reasoningEffort: "high", source: "events" },
      [{ id: "gpt-5.5", name: "GPT-5.5" }],
    )).toBe("GPT-5.5 · High");
  });

  it("falls back to the model id when model metadata is unavailable", () => {
    expect(formatSessionModelLabel({ model: "custom-model", source: "events" }, null))
      .toBe("custom-model");
  });

  it("shows long context from session state before model metadata loads", () => {
    expect(formatSessionModelLabel(
      { model: "gpt-5.5", reasoningEffort: "xhigh", contextTier: "long_context", source: "events" },
      null,
    )).toBe("gpt-5.5 · Extra High · Long context");
  });

  it("uses detailed context labels when model metadata is available", () => {
    expect(formatSessionModelLabel(
      { model: "gpt-5.5", reasoningEffort: "xhigh", contextTier: "long_context", source: "events" },
      [{
        id: "gpt-5.5",
        name: "GPT-5.5",
        billing: {
          tokenPrices: {
            contextMax: 272_000,
            longContext: { contextMax: 1_050_000 },
          },
        },
      }],
    )).toBe("GPT-5.5 · Extra High · Long context (1.1M)");
  });

  it("keeps unknown reasoning effort values visible", () => {
    expect(formatReasoningEffortLabel("experimental")).toBe("experimental");
  });

  it("does not keep current reasoning effort before lookup completes for constrained models", () => {
    expect(canKeepCurrentReasoningEffortForModel({
      supportedReasoningEfforts: ["xhigh"],
      currentEffortLookupReady: false,
    })).toBe(false);
  });

  it("does not trust cached supported reasoning effort before lookup completes", () => {
    expect(canKeepCurrentReasoningEffortForModel({
      supportedReasoningEfforts: ["xhigh"],
      currentReasoningEffort: "xhigh",
      currentEffortLookupReady: false,
    })).toBe(false);
  });

  it("allows keeping current when lookup confirms no reasoning effort is set", () => {
    expect(canKeepCurrentReasoningEffortForModel({
      supportedReasoningEfforts: ["xhigh"],
      currentEffortLookupReady: true,
    })).toBe(true);
  });

  it("does not keep current while lookup is pending for models with no reasoning efforts", () => {
    expect(canKeepCurrentReasoningEffortForModel({
      supportedReasoningEfforts: [],
      currentEffortLookupReady: false,
    })).toBe(false);
  });

  it("allows keeping current for models with no reasoning efforts only after lookup confirms none is set", () => {
    expect(canKeepCurrentReasoningEffortForModel({
      supportedReasoningEfforts: [],
      currentEffortLookupReady: true,
    })).toBe(true);
  });

  it("does not keep a current effort for models with no reasoning efforts", () => {
    expect(canKeepCurrentReasoningEffortForModel({
      supportedReasoningEfforts: [],
      currentReasoningEffort: "high",
      currentEffortLookupReady: true,
    })).toBe(false);
  });

  it("does not keep unsupported current reasoning effort for constrained models", () => {
    expect(canKeepCurrentReasoningEffortForModel({
      supportedReasoningEfforts: ["high"],
      currentReasoningEffort: "xhigh",
      currentEffortLookupReady: true,
    })).toBe(false);
  });

  it("keeps supported current reasoning effort for constrained models", () => {
    expect(canKeepCurrentReasoningEffortForModel({
      supportedReasoningEfforts: ["xhigh"],
      currentReasoningEffort: "xhigh",
      currentEffortLookupReady: true,
    })).toBe(true);
  });
});
