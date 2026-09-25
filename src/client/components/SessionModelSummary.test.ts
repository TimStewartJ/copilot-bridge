import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReactDomHarness, findAllByTag, getReactProps } from "../test-react-harness";
import SessionModelSummary from "./SessionModelSummary";
import type { ModelInfo, SessionModelState } from "../api";

const STATE: SessionModelState = { model: "gpt-5.6", reasoningEffort: "high", source: "live" };
const MODELS: ModelInfo[] = [{ id: "gpt-5.6", name: "GPT-5.6" }];

afterEach(() => {
  vi.restoreAllMocks();
});

function findEditButton(container: unknown) {
  return findAllByTag(container, "BUTTON")
    .find((button) => String(getReactProps(button)?.["aria-label"] ?? "").startsWith("Change model, effort, and context"));
}

describe("SessionModelSummary editing", () => {
  it("renders plain text when no editor is wired", async () => {
    const harness = await createReactDomHarness();
    try {
      await harness.render(createElement(SessionModelSummary, {
        state: STATE,
        models: MODELS,
        loading: false,
        onRetry: vi.fn(),
      }));
      expect(harness.dom.container.textContent).toContain("GPT-5.6 · High");
      expect(findEditButton(harness.dom.container)).toBeUndefined();
    } finally {
      await harness.cleanup();
    }
  });

  it("opens the editor from the model, effort, and context label", async () => {
    const harness = await createReactDomHarness();
    const onEdit = vi.fn();
    try {
      await harness.render(createElement(SessionModelSummary, {
        state: STATE,
        models: MODELS,
        loading: false,
        onRetry: vi.fn(),
        onEdit,
      }));
      const button = findEditButton(harness.dom.container);
      expect(button?.textContent).toContain("GPT-5.6 · High");
      expect(getReactProps(button)?.disabled).toBe(false);
      await harness.act(async () => getReactProps(button)?.onClick?.());
      expect(onEdit).toHaveBeenCalledOnce();
    } finally {
      await harness.cleanup();
    }
  });

  it("disables the label with a reason while editing is unavailable", async () => {
    const harness = await createReactDomHarness();
    try {
      await harness.render(createElement(SessionModelSummary, {
        state: STATE,
        models: MODELS,
        loading: false,
        onRetry: vi.fn(),
        onEdit: vi.fn(),
        editDisabledReason: "This session is busy",
      }));
      const button = findEditButton(harness.dom.container);
      expect(getReactProps(button)?.disabled).toBe(true);
      expect(getReactProps(button)?.title).toBe("This session is busy");
    } finally {
      await harness.cleanup();
    }
  });

  it("does not offer editing before the session configuration has loaded", async () => {
    const harness = await createReactDomHarness();
    try {
      await harness.render(createElement(SessionModelSummary, {
        loading: true,
        onRetry: vi.fn(),
        onEdit: vi.fn(),
      }));
      expect(findEditButton(harness.dom.container)).toBeUndefined();
    } finally {
      await harness.cleanup();
    }
  });
});
