import { createElement } from "react";
import { beforeAll, describe, expect, it } from "vitest";
import type { ChatMessage } from "../api";
import { createReactDomHarness, findAllByTag } from "../test-react-harness";

let MessageBubble: typeof import("./MessageBubble").default;

beforeAll(async () => {
  const harness = await createReactDomHarness();
  try {
    ({ default: MessageBubble } = await import("./MessageBubble"));
  } finally {
    await harness.cleanup();
  }
});

describe("MessageBubble pending user messages", () => {
  it("visually mutes a user message while it is being sent", async () => {
    const harness = await createReactDomHarness();
    const message = { role: "user", content: "Hello" } satisfies ChatMessage;

    try {
      await harness.render(createElement(MessageBubble, { message, isPending: true }));

      const bubble = findAllByTag(harness.dom.container, "DIV").find((candidate) => (
        candidate.getAttribute?.("data-delivery-state") === "sending"
      ));
      expect(bubble).toBeDefined();
      expect(bubble?.getAttribute("aria-busy")).toBe("true");
      expect(bubble?.getAttribute("class")).toContain("opacity-60");
      expect(bubble?.getAttribute("class")).toContain("grayscale");
    } finally {
      await harness.cleanup();
    }
  });
});
