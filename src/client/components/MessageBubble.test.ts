import { createElement } from "react";
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../api";
import { createReactDomHarness, findAllByTag, getReactProps } from "../test-react-harness";

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
    const message = {
      role: "user",
      content: "Hello",
      delivery: { failed: false },
    } satisfies ChatMessage;

    try {
      await harness.render(createElement(MessageBubble, { message }));

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

describe("MessageBubble failed user messages", () => {
  it("renders a clear failed state and invokes retry", async () => {
    const harness = await createReactDomHarness();
    const onRetry = vi.fn();
    const message = {
      role: "user",
      content: "Please retry",
      delivery: { failed: true, error: "network unavailable" },
    } satisfies ChatMessage;

    try {
      await harness.render(createElement(MessageBubble, { message, onRetry }));

      const bubble = findAllByTag(harness.dom.container, "DIV").find((candidate) => (
        candidate.getAttribute?.("data-delivery-state") === "failed"
      ));
      expect(bubble).toBeDefined();
      expect(bubble?.getAttribute("aria-busy")).toBeNull();
      expect(bubble?.getAttribute("aria-invalid")).toBe("true");
      expect(bubble?.getAttribute("title")).toContain("network unavailable");
      expect(harness.dom.container.textContent).toContain("Failed to send");

      const failedSurface = findAllByTag(harness.dom.container, "DIV").find((candidate) => (
        candidate.getAttribute?.("class")?.includes("border-error/40")
      ));
      expect(failedSurface).toBeDefined();

      const retryButton = findAllByTag(harness.dom.container, "BUTTON").find((candidate) => (
        candidate.getAttribute?.("aria-label") === "Retry sending message"
      ));
      expect(retryButton).toBeDefined();
      const stopPropagation = vi.fn();
      await harness.act(async () => {
        getReactProps(retryButton)?.onClick?.({ stopPropagation });
      });

      expect(stopPropagation).toHaveBeenCalledOnce();
      expect(onRetry).toHaveBeenCalledOnce();
    } finally {
      await harness.cleanup();
    }
  });

  it("marks an accepted user message as sent", async () => {
    const harness = await createReactDomHarness();
    const message = { role: "user", content: "Accepted" } satisfies ChatMessage;

    try {
      await harness.render(createElement(MessageBubble, { message }));

      const bubble = findAllByTag(harness.dom.container, "DIV").find((candidate) => (
        candidate.getAttribute?.("data-delivery-state") === "sent"
      ));
      expect(bubble).toBeDefined();
      expect(harness.dom.container.textContent).not.toContain("Failed to send");
    } finally {
      await harness.cleanup();
    }
  });
});
