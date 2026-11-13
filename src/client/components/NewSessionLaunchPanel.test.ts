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
    playbooks: [],
    mode: "interactive" as const,
    onPresetChange: vi.fn(),
    onModelChange: vi.fn(),
    onReasoningEffortChange: vi.fn(),
    onContextTierChange: vi.fn(),
    onPlaybookChange: vi.fn(),
    onModeChange: vi.fn(),
  };
}

function tileLabels(container: any): string[] {
  return findAllByTag(container, "BUTTON")
    .map((button) => getReactProps(button)?.["aria-label"])
    .filter((label): label is string => typeof label === "string");
}

function findTile(container: any, preset: string): any {
  const tile = findAllByTag(container, "BUTTON")
    .find((button) => String(getReactProps(button)?.["aria-label"] ?? "").startsWith(`${preset}:`));
  if (!tile) throw new Error(`Tile not found for ${preset}: ${tileLabels(container).join(" | ")}`);
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

  it("lists playbooks by family with Direct, and reports Automatic as no choice", async () => {
    const onPlaybookChange = vi.fn();
    await harness!.render(createElement(NewSessionLaunchPanel, {
      ...requiredProps(),
      playbooks: [
        { id: "research", label: "Research", description: "Find out", family: "knowledge" as const, evidence: [], source: "bundled" as const },
        { id: "bug-fix", label: "Bug fix", description: "Fix it", family: "code" as const, evidence: [], source: "bundled" as const },
      ],
      selectedPlaybook: "bug-fix",
      onPlaybookChange,
    }));
    const select = findAllByTag(harness!.dom.container, "SELECT")
      .find((element) => getReactProps(element)?.id === "new-session-playbook");
    expect(getReactProps(select)?.value).toBe("bug-fix");
    expect(findAllByTag(select, "OPTGROUP").map((group) => getReactProps(group)?.label)).toEqual(["Code", "Knowledge work"]);
    expect(findAllByTag(select, "OPTION").map((option) => getReactProps(option)?.value)).toEqual(["", "bug-fix", "research", "none"]);

    await harness!.act(() => {
      getReactProps(select)?.onChange?.({ target: { value: "" } });
    });
    expect(onPlaybookChange).toHaveBeenCalledWith(undefined);
  });

  it("offers to reset or save a chat that departs from its tier", async () => {
    const onReset = vi.fn();
    const onSave = vi.fn();
    await harness!.render(createElement(NewSessionLaunchPanel, {
      ...requiredProps(),
      tierChange: { tierLabel: "Deep", onReset, onSave },
    }));
    expect(harness!.dom.container.textContent).toContain("This chat only");
    const buttons = findAllByTag(harness!.dom.container, "button");
    await harness!.act(() => getReactProps(buttons.find((button) => button.textContent === "Reset"))!.onClick());
    await harness!.act(() => getReactProps(buttons.find((button) => button.textContent === "Save as Deep"))!.onClick());
    expect(onReset).toHaveBeenCalledTimes(1);
    expect(onSave).toHaveBeenCalledTimes(1);
  });

  it("names an A/B test's two tiers in place of effort and context when the test picks the model", async () => {
    await harness!.render(createElement(NewSessionLaunchPanel, {
      ...requiredProps(),
      reasoningEffortOptions: [{ value: "high", label: "High" }],
      contextOptions: [{ value: "default", label: "Standard context" }],
      abTestTiers: ["preset2", "preset3"],
    }));
    expect(harness!.dom.container.textContent).toContain("A/B test: starts on Standard or Deep at random");
    const groups = findAllByTag(harness!.dom.container, "div").map((element) => getReactProps(element)?.["aria-label"]);
    expect(groups).not.toContain("Effort for new session");
    expect(groups).not.toContain("Context for new session");
  });

  it("marks an explicitly remembered preset live when the model inherits the Bridge default", async () => {
    await harness!.render(createElement(NewSessionLaunchPanel, {
      ...requiredProps(),
      models: [
        { id: "gpt-5.6", name: "GPT-5.6" },
        { id: "claude-opus-5", name: "Claude Opus 5" },
      ],
      defaultModelId: "gpt-5.6",
      selectedModelId: "",
      selectedPresetSlot: "preset2",
    }));

    expect(getReactProps(findTile(harness!.dom.container, "Standard"))?.["aria-pressed"]).toBe(true);
    expect(getReactProps(findTile(harness!.dom.container, "Fast"))?.["aria-pressed"]).toBe(false);
  });

  it("does not mark a fallback model as selected when the SDK default is unresolved", async () => {
    await harness!.render(createElement(NewSessionLaunchPanel, {
      ...requiredProps(),
      models: [
        { id: "gpt-5.6", name: "GPT-5.6" },
        { id: "claude-opus-5", name: "Claude Opus 5" },
      ],
    }));

    expect(getReactProps(findTile(harness!.dom.container, "Fast"))?.["aria-pressed"]).toBe(false);
    expect(getReactProps(findTile(harness!.dom.container, "Standard"))?.["aria-pressed"]).toBe(false);
  });

  it("labels the launch controls and reports a committed preset selection and the other choices", async () => {
    const props = { ...requiredProps(), onModelSelectionCommitted: vi.fn() };
    await harness!.render(createElement(NewSessionLaunchPanel, {
      ...props,
      models: [
        { id: "gpt-5.6", name: "GPT-5.6" },
        { id: "claude-opus-5", name: "Claude Opus 5" },
      ],
      selectedModelId: "gpt-5.6",
      selectedPresetSlot: "preset1",
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

    const container = harness!.dom.container;
    const hiddenLabels = [...findAllByTag(container, "LABEL"), ...findAllByTag(container, "DIV")]
      .filter((element) => getReactProps(element)?.className === "sr-only")
      .map((element) => element.textContent);
    expect(hiddenLabels).toEqual(["Playbook", "Model", "Effort", "Context", "Mode"]);
    const playbookLabel = findAllByTag(container, "LABEL")[0];
    expect(getReactProps(playbookLabel)?.htmlFor).toBe(getReactProps(findAllByTag(container, "SELECT")[0])?.id);
    expect(container.textContent).not.toContain("Default Copilot agent");
    const groupLabels = findAllByTag(container, "DIV")
      .filter((element) => getReactProps(element)?.role === "group")
      .map((element) => getReactProps(element)?.["aria-label"]);
    expect(groupLabels).toEqual([
      "Model presets",
      "Effort for new session",
      "Context for new session",
      "Run mode for new session",
    ]);
    for (const choice of ["GPT-5.6", "High", "Standard context", "Automatic playbook", "Interactive", "Autopilot"]) {
      expect(container.textContent).toContain(choice);
    }

    const buttons = findAllByTag(container, "BUTTON");
    const preset2 = findTile(harness!.dom.container, "Standard");
    expect(getReactProps(preset2)?.["aria-haspopup"]).toBeUndefined();
    const autopilot = buttons.find((button) => button.textContent === "Autopilot");
    const lowEffort = buttons.find((button) => button.textContent === "Low");
    const standardContext = buttons.find(
      (button) => button.textContent === "Standard context (200K)",
    );
    if (!autopilot || !lowEffort || !standardContext) {
      throw new Error("Launch option rows were not rendered");
    }

    await harness!.act(async () => {
      getReactProps(preset2)?.onClick?.();
      getReactProps(lowEffort)?.onClick?.();
      getReactProps(standardContext)?.onClick?.();
      getReactProps(autopilot)?.onClick?.();
    });

    expect(props.onModelSelectionCommitted).toHaveBeenCalledTimes(1);
    expect(findAllByTag(container, "BUTTON").some((button) => getReactProps(button)?.role === "option")).toBe(false);
    expect(props.onPresetChange).toHaveBeenCalledWith("preset2");
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

  it("keeps SDK order in preset menus and keyboard-focused refine choices", async () => {
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

    expect(findTile(harness!.dom.container, "Standard").textContent).toContain("Claude Sonnet 5");

    const caret = findAllByTag(harness!.dom.container, "BUTTON")
      .find((button) => getReactProps(button)?.["aria-label"] === "Choose Standard model");
    if (!caret) throw new Error("Standard refine caret was not rendered");
    await harness!.act(async () => {
      getReactProps(caret)?.onClick?.();
    });

    const options = findAllByTag(harness!.dom.container, "BUTTON")
      .filter((button) => getReactProps(button)?.role === "option");
    expect(options.map((button) => button.textContent)).toEqual([
      "GPT-5.6",
      "Claude Sonnet 5",
      "Claude Haiku 4.5",
    ]);
    expect(document.activeElement).toBe(options[1]);

    await harness!.act(async () => {
      getReactProps(options[1])?.onClick?.();
    });
    expect(props.onModelChange).toHaveBeenCalledWith("preset2", "claude-sonnet-5");
    expect(props.onPresetChange).not.toHaveBeenCalled();
  });

  it("opens the model menu when the live tile is clicked again", async () => {
    const props = { ...requiredProps(), onModelSelectionCommitted: vi.fn() };
    await harness!.render(createElement(NewSessionLaunchPanel, {
      ...props,
      models: [
        { id: "gpt-5.6", name: "GPT-5.6" },
        { id: "gpt-5-mini", name: "GPT-5 mini" },
      ],
      selectedModelId: "gpt-5-mini",
      selectedPresetSlot: "preset1",
      presets: { preset1: { model: "gpt-5-mini" } },
    }));

    const liveTile = findTile(harness!.dom.container, "Fast");
    expect(getReactProps(liveTile)?.["aria-haspopup"]).toBe("listbox");
    expect(getReactProps(liveTile)?.["aria-expanded"]).toBe(false);
    await harness!.act(async () => {
      getReactProps(liveTile)?.onClick?.();
    });

    const options = findAllByTag(harness!.dom.container, "BUTTON")
      .filter((button) => getReactProps(button)?.role === "option");
    expect(options.map((button) => button.textContent)).toEqual(["GPT-5.6", "GPT-5 mini"]);
    expect(document.activeElement).toBe(options[1]);
    expect(props.onPresetChange).not.toHaveBeenCalled();
    expect(props.onModelSelectionCommitted).not.toHaveBeenCalled();

    await harness!.act(async () => {
      getReactProps(options[0])?.onClick?.();
    });
    expect(props.onModelChange).toHaveBeenCalledWith("preset1", "gpt-5.6");
    expect(props.onModelSelectionCommitted).toHaveBeenCalledTimes(1);
    expect(findAllByTag(harness!.dom.container, "BUTTON")
      .some((button) => getReactProps(button)?.role === "option")).toBe(false);
  });

  it("moves through choices with arrow keys and returns focus to the tile on Escape", async () => {
    const props = { ...requiredProps(), onModelSelectionCommitted: vi.fn() };
    await harness!.render(createElement(NewSessionLaunchPanel, {
      ...props,
      models: [
        { id: "gpt-5.6", name: "GPT-5.6" },
        { id: "claude-opus-5", name: "Claude Opus 5" },
      ],
      selectedModelId: "gpt-5.6",
      selectedPresetSlot: "preset1",
    }));

    const addListener = vi.spyOn(document, "addEventListener");
    const caret = findAllByTag(harness!.dom.container, "BUTTON")
      .find((button) => getReactProps(button)?.["aria-label"] === "Choose Standard model");
    await harness!.act(async () => {
      getReactProps(caret)?.onClick?.();
    });

    const options = findAllByTag(harness!.dom.container, "BUTTON")
      .filter((button) => getReactProps(button)?.role === "option");
    const menu = findAllByTag(harness!.dom.container, "DIV")
      .find((element) => getReactProps(element)?.role === "listbox");
    expect(document.activeElement).toBe(options[1]);
    const preventDefault = vi.fn();
    await harness!.act(async () => {
      getReactProps(menu)?.onKeyDown?.({ key: "ArrowDown", preventDefault });
    });
    expect(preventDefault).toHaveBeenCalled();
    expect(document.activeElement).toBe(options[0]);

    const keydown = addListener.mock.calls
      .filter(([type]) => type === "keydown")
      .map(([, handler]) => handler as unknown as (event: { key: string }) => void)
      .at(-1);
    if (!keydown) throw new Error("Refine menu did not register an Escape handler");
    await harness!.act(async () => {
      keydown({ key: "Escape" });
    });
    addListener.mockRestore();

    expect(findAllByTag(harness!.dom.container, "BUTTON")
      .some((button) => getReactProps(button)?.role === "option")).toBe(false);
    expect(document.activeElement).toBe(findTile(harness!.dom.container, "Standard"));
    expect(props.onModelSelectionCommitted).not.toHaveBeenCalled();
  });
});
