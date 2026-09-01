import { createElement } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChatMessage } from "../api";
import {
  createReactDomHarness,
  findAllByTag,
  getReactProps,
  waitUntilAct,
} from "../test-react-harness";

const apiMocks = vi.hoisted(() => ({ fetchWorkReferencePreview: vi.fn() }));

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return { ...actual, fetchWorkReferencePreview: apiMocks.fetchWorkReferencePreview };
});

let MessageBubble: typeof import("./MessageBubble").default;

beforeAll(async () => {
  const harness = await createReactDomHarness();
  try {
    ({ default: MessageBubble } = await import("./MessageBubble"));
  } finally {
    await harness.cleanup();
  }
});

beforeEach(() => {
  apiMocks.fetchWorkReferencePreview.mockReset();
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

describe("MessageBubble text selection mode", () => {
  it("renders clear instructions and a Done control beside selectable text", async () => {
    const harness = await createReactDomHarness();
    const onFinishSelectingText = vi.fn();
    const message = {
      id: "assistant-1",
      role: "assistant",
      content: "Select part of this response.",
    } satisfies ChatMessage;

    try {
      await harness.render(createElement(MessageBubble, {
        message,
        selectingText: true,
        onFinishSelectingText,
      }));

      expect(harness.dom.container.textContent).toContain("Press and hold or drag to select");
      const doneButton = findAllByTag(harness.dom.container, "BUTTON").find((candidate) => (
        candidate.getAttribute?.("aria-label") === "Finish selecting message text"
      ));
      expect(doneButton).toBeDefined();
      const controls = findAllByTag(harness.dom.container, "DIV").find((candidate) => (
        candidate.getAttribute?.("data-message-selection-controls") === "true"
      ));
      expect(controls).toBeDefined();

      await harness.act(async () => {
        getReactProps(doneButton)?.onClick?.();
      });
      expect(onFinishSelectingText).toHaveBeenCalledOnce();
    } finally {
      await harness.cleanup();
    }
  });
});

describe("MessageBubble Azure DevOps references", () => {
  it("renders a standalone work-item markdown link as the shared rich preview card", async () => {
    const url = "https://msazure.visualstudio.com/One/_workitems/edit/37655015";
    apiMocks.fetchWorkReferencePreview.mockResolvedValue({
      kind: "workItem",
      workItem: {
        id: "37655015",
        provider: "ado",
        title: "Review SDL bug",
        state: "Active",
        type: "Bug",
        assignedTo: "Tim Stewart",
        areaPath: "One\\Bridge",
        url,
      },
    });
    const harness = await createReactDomHarness();
    const message = {
      role: "assistant",
      content: `[Review SDL bug](${url})`,
    } satisfies ChatMessage;

    try {
      await harness.render(createElement(MessageBubble, { message }));
      await waitUntilAct(
        harness.act,
        () => findAllByTag(harness.dom.container, "DIV").some((candidate) => (
          candidate.getAttribute?.("data-work-reference-preview") === "loaded"
        )),
        { label: "work-reference preview load" },
      );

      expect(apiMocks.fetchWorkReferencePreview).toHaveBeenCalledWith(url);
      const preview = findAllByTag(harness.dom.container, "DIV").find((candidate) => (
        candidate.getAttribute?.("data-work-reference-preview") === "loaded"
      ));
      expect(preview).toBeDefined();
      const card = findAllByTag(harness.dom.container, "A").find((candidate) => (
        candidate.getAttribute?.("data-work-reference-kind") === "workItem"
      ));
      expect(card?.getAttribute("href")).toBe(url);
      expect(card?.getAttribute("target")).toBe("_blank");
      expect(harness.dom.container.textContent).toContain("Active");
      expect(harness.dom.container.textContent).toContain("Tim Stewart");
    } finally {
      await harness.cleanup();
    }
  });

  it("keeps an inline ADO link as a normal markdown link", async () => {
    const url = "https://msazure.visualstudio.com/One/_workitems/edit/37655015";
    const harness = await createReactDomHarness();
    const message = {
      role: "assistant",
      content: `See [work item 37655015](${url}) before continuing.`,
    } satisfies ChatMessage;

    try {
      await harness.render(createElement(MessageBubble, { message }));

      expect(apiMocks.fetchWorkReferencePreview).not.toHaveBeenCalled();
      expect(findAllByTag(harness.dom.container, "P")).toHaveLength(1);
      const [link] = findAllByTag(harness.dom.container, "A");
      expect(link?.getAttribute("href")).toBe(url);
      expect(link?.getAttribute("data-work-reference-kind")).toBeNull();
    } finally {
      await harness.cleanup();
    }
  });
});
