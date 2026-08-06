import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createReactDomHarness,
  findAllByTag,
  getReactProps,
  type ReactDomHarness,
} from "../test-react-harness";
import { installSelectAwareDomShim } from "../test-dom-shim";
import NewSessionLaunchPanel from "./NewSessionLaunchPanel";

function requiredProps() {
  return {
    modelsLoading: false,
    mode: "interactive" as const,
    onModelFamilyChange: vi.fn(),
    onModelChange: vi.fn(),
    onReasoningEffortChange: vi.fn(),
    onContextTierChange: vi.fn(),
    onModeChange: vi.fn(),
  };
}

function tileLabels(container: any): string[] {
  return findAllByTag(container, "BUTTON")
    .map((button) => getReactProps(button)?.["aria-label"])
    .filter((label): label is string => typeof label === "string");
}

function findTile(container: any, family: string): any {
  const tile = findAllByTag(container, "BUTTON")
    .find((button) => String(getReactProps(button)?.["aria-label"] ?? "").startsWith(`${family}:`));
  if (!tile) throw new Error(`Tile not found for family ${family}: ${tileLabels(container).join(" | ")}`);
  return tile;
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

  it("shows one compact tile per family and excludes disabled models", async () => {
    await harness!.render(createElement(NewSessionLaunchPanel, {
      ...requiredProps(),
      models: [
        { id: "gpt-5.6", name: "GPT-5.6", policy: { state: "enabled" } },
        { id: "claude-opus-5", name: "Claude Opus 5", policy: { state: "enabled" } },
        { id: "gemini-3.1-pro", name: "Gemini 3.1 Pro", policy: { state: "enabled" } },
        { id: "gpt-disabled", name: "Disabled Model", policy: { state: "disabled" } },
      ],
      defaultModelId: "gpt-5.6",
      selectedModelId: "",
      reasoningEffortOptions: [{ value: null, label: "Default" }],
      contextOptions: [{ value: null, label: "Default context" }],
    }));

    // Each family tile surfaces a concrete model rather than an empty placeholder.
    expect(findTile(harness!.dom.container, "GPT").textContent).toBe("GPT-5.6");
    expect(findTile(harness!.dom.container, "Claude").textContent).toBe("Claude Opus 5");
    expect(findTile(harness!.dom.container, "Other").textContent).toBe("Gemini 3.1 Pro");

    const text = harness!.dom.container.textContent ?? "";
    expect(text).not.toContain("Disabled Model");
    // The family name is carried by the accessible name, not visible chrome.
    expect(tileLabels(harness!.dom.container)).toContain("GPT: GPT-5.6");
  });

  it("marks the family holding the current selection as live", async () => {
    await harness!.render(createElement(NewSessionLaunchPanel, {
      ...requiredProps(),
      models: [
        { id: "gpt-5.6", name: "GPT-5.6" },
        { id: "claude-opus-5", name: "Claude Opus 5" },
      ],
      defaultModelId: "gpt-5.6",
      selectedModelId: "claude-opus-5",
      reasoningEffortOptions: [{ value: null, label: "Default" }],
      contextOptions: [{ value: null, label: "Default context" }],
    }));

    expect(getReactProps(findTile(harness!.dom.container, "Claude"))?.["aria-pressed"]).toBe(true);
    expect(getReactProps(findTile(harness!.dom.container, "GPT"))?.["aria-pressed"]).toBe(false);
  });

  it("reports family switches and the other launch selections", async () => {
    const props = requiredProps();
    await harness!.render(createElement(NewSessionLaunchPanel, {
      ...props,
      models: [
        { id: "gpt-5.6", name: "GPT-5.6" },
        { id: "claude-opus-5", name: "Claude Opus 5" },
      ],
      selectedModelId: "gpt-5.6",
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
    }));

    const buttons = findAllByTag(harness!.dom.container, "BUTTON");
    const claudeTile = findTile(harness!.dom.container, "Claude");
    const autopilot = buttons.find((button) => button.textContent === "Autopilot");
    const lowEffort = buttons.find((button) => button.textContent === "Low");
    const standardContext = buttons.find(
      (button) => button.textContent === "Standard context (200K)",
    );
    if (!autopilot || !lowEffort || !standardContext) {
      throw new Error("Launch option rows were not rendered");
    }

    await harness!.act(async () => {
      getReactProps(claudeTile)?.onClick?.();
      getReactProps(lowEffort)?.onClick?.();
      getReactProps(standardContext)?.onClick?.();
      getReactProps(autopilot)?.onClick?.();
    });

    expect(props.onModelFamilyChange).toHaveBeenCalledWith("claude");
    expect(props.onReasoningEffortChange).toHaveBeenCalledWith("low");
    expect(props.onContextTierChange).toHaveBeenCalledWith("default");
    expect(props.onModeChange).toHaveBeenCalledWith("autopilot");
  });

  it("opens the refine menu and reports a specific model pick", async () => {
    const props = requiredProps();
    await harness!.render(createElement(NewSessionLaunchPanel, {
      ...props,
      models: [
        { id: "gpt-5.6", name: "GPT-5.6" },
        { id: "gpt-5-mini", name: "GPT-5 mini" },
      ],
      selectedModelId: "gpt-5.6",
      reasoningEffortOptions: [{ value: null, label: "Default" }],
      contextOptions: [{ value: null, label: "Default context" }],
    }));

    const caret = findAllByTag(harness!.dom.container, "BUTTON")
      .find((button) => getReactProps(button)?.["aria-label"] === "Choose GPT model");
    if (!caret) throw new Error("GPT refine caret was not rendered");

    await harness!.act(async () => {
      getReactProps(caret)?.onClick?.();
    });

    const miniOption = findAllByTag(harness!.dom.container, "BUTTON")
      .find((button) => button.textContent === "GPT-5 mini");
    if (!miniOption) throw new Error("Refine menu did not render the family's models");

    await harness!.act(async () => {
      getReactProps(miniOption)?.onClick?.();
    });

    expect(props.onModelChange).toHaveBeenCalledWith("gpt-5-mini");
    expect(props.onModelFamilyChange).not.toHaveBeenCalled();
  });

  it("marks the Bridge default inside the refine menu rather than on the tile", async () => {
    await harness!.render(createElement(NewSessionLaunchPanel, {
      ...requiredProps(),
      models: [
        { id: "gpt-5.6", name: "GPT-5.6" },
        { id: "gpt-5-mini", name: "GPT-5 mini" },
      ],
      defaultModelId: "gpt-5-mini",
      selectedModelId: "",
      reasoningEffortOptions: [{ value: null, label: "Default" }],
      contextOptions: [{ value: null, label: "Default context" }],
    }));

    // The tile stays a single bare model name.
    expect(findTile(harness!.dom.container, "GPT").textContent).toBe("GPT-5 mini");

    const caret = findAllByTag(harness!.dom.container, "BUTTON")
      .find((button) => getReactProps(button)?.["aria-label"] === "Choose GPT model");
    if (!caret) throw new Error("GPT refine caret was not rendered");
    await harness!.act(async () => {
      getReactProps(caret)?.onClick?.();
    });

    const options = findAllByTag(harness!.dom.container, "BUTTON")
      .filter((button) => getReactProps(button)?.role === "option");
    const defaultOption = options
      .find((button) => (button.textContent ?? "").startsWith("GPT-5 mini"));
    expect(defaultOption?.textContent).toContain("default");
    const otherOption = options
      .find((button) => (button.textContent ?? "").startsWith("GPT-5.6"));
    expect(otherOption?.textContent).not.toContain("default");
  });
});
