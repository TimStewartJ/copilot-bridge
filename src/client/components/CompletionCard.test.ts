import { createElement } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ChatCompletionEntry } from "../api";
import { COMPONENT_IMPORT_WARMUP_TIMEOUT_MS, createReactDomHarness } from "../test-react-harness";

const markdownRenderMock = vi.hoisted(() => vi.fn());

vi.mock("react-markdown", () => ({
  default: ({ children }: { children: string }) => {
    markdownRenderMock(children);
    return children;
  },
}));

let CompletionCard: typeof import("./CompletionCard").default;

beforeAll(async () => {
  const harness = await createReactDomHarness();
  try {
    ({ default: CompletionCard } = await import("./CompletionCard"));
  } finally {
    await harness.cleanup();
  }
}, COMPONENT_IMPORT_WARMUP_TIMEOUT_MS);

describe("CompletionCard", () => {
  it("parses its summary once, however often the transcript around it renders", async () => {
    const harness = await createReactDomHarness();
    const entry: ChatCompletionEntry = {
      id: "entry-1",
      type: "completion",
      content: "All **done**",
      completion: { content: "All **done**", title: "Task complete", status: "success", sourceEventType: "session.task_complete" },
    };

    try {
      // The transcript works the run's figures out again on every render, streamed chunks included.
      await harness.render(createElement(CompletionCard, { entry, autopilot: { turns: 2 } }));
      await harness.render(createElement(CompletionCard, { entry, autopilot: { turns: 2 } }));

      expect(harness.dom.container.textContent).toContain("Task complete");
      expect(harness.dom.container.textContent).toContain("Autopilot · 2 turns");
      expect(markdownRenderMock.mock.calls).toEqual([["All **done**"]]);
    } finally {
      await harness.cleanup();
    }
  });
});