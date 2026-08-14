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
    models: [],
    modelsLoading: false,
    selectedModelId: "",
    reasoningEffortOptions: [],
    contextOptions: [],
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

  it("shows a blank-default agent picker for task chats", async () => {
    const onAgentChange = vi.fn();
    await harness!.render(createElement(NewSessionLaunchPanel, {
      ...requiredProps(),
      agentDefinitions: [
        {
          taskId: "task-1",
          name: "api-reviewer",
          displayName: "API Reviewer",
          description: "Reviews APIs",
          tools: null,
          infer: false,
          userInvocable: true,
          fileName: "api-reviewer.agent.md",
          createdAt: "2026-08-13T00:00:00.000Z",
          updatedAt: "2026-08-13T00:00:00.000Z",
        },
        {
          taskId: "task-1",
          name: "hidden-agent",
          description: "Hidden",
          tools: null,
          infer: true,
          userInvocable: false,
          fileName: "hidden-agent.agent.md",
          createdAt: "2026-08-13T00:00:00.000Z",
          updatedAt: "2026-08-13T00:00:00.000Z",
        },
      ],
      selectedAgentName: "",
      onAgentChange,
    }));

    const select = findAllByTag(harness!.dom.container, "SELECT")[0];
    expect(select).toBeTruthy();
    expect(select.textContent).toContain("Default Copilot agent");
    expect(select.textContent).toContain("API Reviewer");
    expect(select.textContent).not.toContain("hidden-agent");

    await harness!.act(async () => {
      getReactProps(select)?.onChange?.({ target: { value: "api-reviewer" } });
    });
    expect(onAgentChange).toHaveBeenCalledWith("api-reviewer");
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
    }));

    expect(getReactProps(findTile(harness!.dom.container, "Claude"))?.["aria-pressed"]).toBe(true);
    expect(getReactProps(findTile(harness!.dom.container, "GPT"))?.["aria-pressed"]).toBe(false);
  });

  it("marks the remembered family live when the model inherits the Bridge default", async () => {
    await harness!.render(createElement(NewSessionLaunchPanel, {
      ...requiredProps(),
      models: [
        { id: "gpt-5.6", name: "GPT-5.6" },
        { id: "claude-opus-5", name: "Claude Opus 5" },
      ],
      defaultModelId: "gpt-5.6",
      selectedModelId: "",
      selectedModelFamily: "claude",
    }));

    expect(getReactProps(findTile(harness!.dom.container, "Claude"))?.["aria-pressed"]).toBe(true);
    expect(getReactProps(findTile(harness!.dom.container, "GPT"))?.["aria-pressed"]).toBe(false);
  });

  it("shows the last remembered model for each family", async () => {
    await harness!.render(createElement(NewSessionLaunchPanel, {
      ...requiredProps(),
      models: [
        { id: "gpt-5.6", name: "GPT-5.6" },
        { id: "gpt-5-mini", name: "GPT-5 mini" },
        { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
        { id: "claude-opus-5", name: "Claude Opus 5" },
      ],
      selectedModelId: "claude-opus-5",
      selectedModelFamily: "claude",
      familyDefaults: {
        gpt: { model: "gpt-5-mini" },
        claude: { model: "claude-opus-5" },
      },
    }));

    expect(findTile(harness!.dom.container, "GPT").textContent).toBe("GPT-5 mini");
    expect(findTile(harness!.dom.container, "Claude").textContent).toBe("Claude Opus 5");
  });

  it("does not mark a fallback model as selected when the SDK default is unresolved", async () => {
    await harness!.render(createElement(NewSessionLaunchPanel, {
      ...requiredProps(),
      models: [
        { id: "gpt-5.6", name: "GPT-5.6" },
        { id: "claude-opus-5", name: "Claude Opus 5" },
      ],
    }));

    expect(getReactProps(findTile(harness!.dom.container, "GPT"))?.["aria-pressed"]).toBe(false);
    expect(getReactProps(findTile(harness!.dom.container, "Claude"))?.["aria-pressed"]).toBe(false);
    expect(harness!.dom.container.textContent).toContain(
      "No concrete default model is available.",
    );
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

  it("shows inherited effort and context as concrete selected choices", async () => {
    await harness!.render(createElement(NewSessionLaunchPanel, {
      ...requiredProps(),
      models: [{ id: "gpt-5.6", name: "GPT-5.6" }],
      selectedModelId: "",
      reasoningEffortOptions: [
        { value: "low", label: "Low" },
        { value: "high", label: "High" },
      ],
      selectedReasoningEffort: "high",
      contextOptions: [
        { value: "default", label: "Standard context" },
        { value: "long_context", label: "Long context" },
      ],
      selectedContextTier: "long_context",
    }));

    const buttons = findAllByTag(harness!.dom.container, "BUTTON");
    expect(buttons.some((button) => button.textContent === "Default")).toBe(false);
    expect(getReactProps(buttons.find((button) => button.textContent === "High"))?.["aria-pressed"]).toBe(true);
    expect(getReactProps(buttons.find((button) => button.textContent === "Long context"))?.["aria-pressed"]).toBe(true);
  });

  it("explains when the SDK does not report a concrete effort default", async () => {
    await harness!.render(createElement(NewSessionLaunchPanel, {
      ...requiredProps(),
      models: [{ id: "gpt-5.6", name: "GPT-5.6" }],
      selectedModelId: "gpt-5.6",
      reasoningEffortOptions: [
        { value: "low", label: "Low" },
        { value: "high", label: "High" },
      ],
    }));

    expect(harness!.dom.container.textContent).toContain(
      "The SDK does not report this model's default effort.",
    );
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

  it("keeps SDK order in family tiles and keyboard-focused refine choices", async () => {
    const props = requiredProps();
    await harness!.render(createElement(NewSessionLaunchPanel, {
      ...props,
      models: [
        { id: "gpt-5.6", name: "GPT-5.6" },
        { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
        { id: "claude-haiku-4.5", name: "Claude Haiku 4.5" },
        {
          id: "claude-disabled",
          name: "Claude Aardvark",
          policy: { state: "disabled" },
        },
      ],
      selectedModelId: "gpt-5.6",
    }));

    expect(findTile(harness!.dom.container, "Claude").textContent).toBe("Claude Sonnet 5");

    const caret = findAllByTag(harness!.dom.container, "BUTTON")
      .find((button) => getReactProps(button)?.["aria-label"] === "Choose Claude model");
    if (!caret) throw new Error("Claude refine caret was not rendered");
    await harness!.act(async () => {
      getReactProps(caret)?.onClick?.();
    });

    const options = findAllByTag(harness!.dom.container, "BUTTON")
      .filter((button) => getReactProps(button)?.role === "option");
    expect(options.map((button) => button.textContent)).toEqual([
      "Claude Sonnet 5",
      "Claude Haiku 4.5",
    ]);
    expect(document.activeElement).toBe(options[0]);

    await harness!.act(async () => {
      getReactProps(options[1])?.onClick?.();
    });
    expect(props.onModelChange).toHaveBeenCalledWith("claude-haiku-4.5");
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
