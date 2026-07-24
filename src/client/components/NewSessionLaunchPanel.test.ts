import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createReactDomHarness,
  findAllByTag,
  getReactProps,
  type ReactDomHarness,
} from "../test-react-harness";
import { installDomShim } from "../test-dom-shim";
import NewSessionLaunchPanel from "./NewSessionLaunchPanel";

function installSelectAwareDomShim() {
  const dom = installDomShim();
  const documentRef = globalThis.document as typeof globalThis.document & {
    createElement: (tag: string) => any;
  };
  const originalCreateElement = documentRef.createElement.bind(documentRef);
  documentRef.createElement = (tag: string) => {
    const element = originalCreateElement(tag);
    const normalizedTag = tag.toUpperCase();
    if (normalizedTag === "SELECT") {
      Object.defineProperty(element, "options", {
        configurable: true,
        get: () =>
          Array.from(element.childNodes ?? []).filter((child: any) => child.tagName === "OPTION"),
      });
    }
    if (normalizedTag === "OPTION") {
      Object.defineProperty(element, "value", {
        configurable: true,
        get: () => element.getAttribute("value") ?? element.textContent ?? "",
        set: (value) => element.setAttribute("value", String(value)),
      });
      Object.defineProperty(element, "selected", { configurable: true, writable: true, value: false });
    }
    return element;
  };

  return {
    container: dom.container,
    cleanup() {
      documentRef.createElement = originalCreateElement;
      dom.cleanup();
    },
  };
}

describe("NewSessionLaunchPanel", () => {
  let harness: ReactDomHarness | null = null;

  beforeEach(async () => {
    harness = await createReactDomHarness({ installDom: installSelectAwareDomShim });
  });

  afterEach(async () => {
    await harness?.cleanup();
    harness = null;
  });

  it("shows the configured default and excludes disabled models", async () => {
    await harness!.render(createElement(NewSessionLaunchPanel, {
      models: [
        { id: "gpt-5.6", name: "GPT-5.6", policy: { state: "enabled" } },
        { id: "disabled-model", name: "Disabled Model", policy: { state: "disabled" } },
      ],
      modelsLoading: false,
      defaultModelId: "gpt-5.6",
      selectedModelId: "",
      reasoningEffortOptions: [{ value: null, label: "Default" }],
      contextOptions: [{ value: null, label: "Default context" }],
      mode: "interactive",
      onModelChange: vi.fn(),
      onReasoningEffortChange: vi.fn(),
      onContextTierChange: vi.fn(),
      onModeChange: vi.fn(),
    }));

    const optionText = findAllByTag(harness!.dom.container, "OPTION")
      .map((option) => option.textContent);
    expect(optionText).toContain("Default - GPT-5.6");
    expect(optionText).toContain("GPT-5.6");
    expect(optionText).not.toContain("Disabled Model");
  });

  it("updates the one-session model and run mode selections", async () => {
    const onModelChange = vi.fn();
    const onReasoningEffortChange = vi.fn();
    const onContextTierChange = vi.fn();
    const onModeChange = vi.fn();
    await harness!.render(createElement(NewSessionLaunchPanel, {
      models: [{ id: "claude-opus", name: "Claude Opus" }],
      modelsLoading: false,
      selectedModelId: "",
      reasoningEffortOptions: [
        { value: "low", label: "Low" },
        { value: "high", label: "High" },
      ],
      selectedReasoningEffort: "high",
      contextOptions: [
        { value: "default", label: "Standard context (200K)" },
        { value: "long_context", label: "Long context (1M)" },
      ],
      selectedContextTier: "long_context",
      mode: "interactive",
      onModelChange,
      onReasoningEffortChange,
      onContextTierChange,
      onModeChange,
    }));

    const select = findAllByTag(harness!.dom.container, "SELECT")[0];
    const autopilot = findAllByTag(harness!.dom.container, "BUTTON")
      .find((button) => button.textContent === "Autopilot");
    const lowEffort = findAllByTag(harness!.dom.container, "BUTTON")
      .find((button) => button.textContent === "Low");
    const standardContext = findAllByTag(harness!.dom.container, "BUTTON")
      .find((button) => button.textContent === "Standard context (200K)");
    if (!select || !autopilot || !lowEffort || !standardContext) {
      throw new Error("Launch controls were not rendered");
    }

    await harness!.act(async () => {
      getReactProps(select)?.onChange?.({ target: { value: "claude-opus" } });
      getReactProps(lowEffort)?.onClick?.();
      getReactProps(standardContext)?.onClick?.();
      getReactProps(autopilot)?.onClick?.();
    });

    expect(onModelChange).toHaveBeenCalledWith("claude-opus");
    expect(onReasoningEffortChange).toHaveBeenCalledWith("low");
    expect(onContextTierChange).toHaveBeenCalledWith("default");
    expect(onModeChange).toHaveBeenCalledWith("autopilot");
  });
});
