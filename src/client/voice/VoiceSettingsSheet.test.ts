import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createReactDomHarness, findAllByTag, getReactProps, type ReactDomHarness } from "../test-react-harness";
import { installSelectAwareDomShim } from "../test-dom-shim";
import type { VoiceModeController } from "./useVoiceMode";

const mocks = vi.hoisted(() => ({
  onEffortChange: vi.fn(),
  updateSettings: vi.fn(),
  setTransportPreference: vi.fn(),
  setEchoSafe: vi.fn(),
  onModelChange: vi.fn(),
  onClose: vi.fn(),
}));

vi.mock("../hooks/queries/useModels", () => ({
  useModelsQuery: () => ({
    data: [
      { id: "test-model", name: "A very long assistant model name" },
      { id: "luna", name: "Luna", supportedReasoningEfforts: ["max", "none", "xhigh", "low", "medium", "high"] },
      { id: "haiku", name: "Haiku", supportedReasoningEfforts: ["low", "medium", "high"] },
    ],
  }),
}));

const { VoiceSettingsSheet } = await import("./VoiceSettingsSheet");

const controller = {
  status: { voices: [{ id: "af_heart", name: "Heart", gender: "female", accent: "American" }] },
  settings: { voice: "af_heart", speed: 1, patience: 0.5, bargeIn: true, announce: "watched" },
  transportPreference: "auto",
  echoSafe: true,
  updateSettings: mocks.updateSettings,
  setTransportPreference: mocks.setTransportPreference,
  setEchoSafe: mocks.setEchoSafe,
} as unknown as VoiceModeController;

describe("Helm settings sheet", () => {
  let harness: ReactDomHarness;

  beforeEach(async () => {
    vi.clearAllMocks();
    harness = await createReactDomHarness({ installDom: installSelectAwareDomShim });
    await harness.render(createElement(VoiceSettingsSheet, {
      controller,
      helmModel: { value: "", onChange: mocks.onModelChange },
      onClose: mocks.onClose,
    }));
  });

  it("names every select and preserves setting values and handlers", async () => {
    const selects = findAllByTag(harness.dom.container, "select");
    const labels = findAllByTag(harness.dom.container, "label");
    expect(selects).toHaveLength(4);
    for (const select of selects) {
      const props = getReactProps(select)!;
      expect(labels.some((label) => getReactProps(label)?.htmlFor === props.id)).toBe(true);
      expect(props.className).toContain("pr-9");
      expect(props.className).toContain("text-base");
      expect(props.className).toContain("sm:text-sm");
    }
    const [model, voice, announce, connection] = selects.map((select) => getReactProps(select)!);
    expect(findAllByTag(selects[2], "option").map((option) => getReactProps(option)!.value))
      .toEqual(["watched", "all", "off"]);
    expect(announce["aria-describedby"]).toBe("voice-announce-help");
    expect(model["aria-describedby"]).toBe("helm-model-help");
    await harness.act(() => {
      model.onChange({ target: { value: "test-model" } });
      model.onChange({ target: { value: "" } });
      voice.onChange({ target: { value: "af_heart" } });
      announce.onChange({ target: { value: "all" } });
      connection.onChange({ target: { value: "http" } });
    });
    // Helm's model belongs to the conversation, not to the voice: it never rides along with voice settings.
    expect(mocks.onModelChange.mock.calls).toEqual([["test-model"], [""]]);
    expect(mocks.updateSettings.mock.calls).toEqual([[{ voice: "af_heart" }], [{ announce: "all" }]]);
    expect(mocks.setTransportPreference).toHaveBeenCalledWith("http");
  });

  it("keeps the header outside the safe-area-aware scrolling body and closes", async () => {
    const divs = findAllByTag(harness.dom.container, "div");
    const panel = divs.find((div) => getReactProps(div)?.className?.includes("sm:max-w-sm"));
    const body = divs.find((div) => getReactProps(div)?.className?.includes("overscroll-contain"));
    expect(getReactProps(panel)!.className).not.toMatch(/(?:^| )max-w-sm(?: |$)/);
    expect(getReactProps(panel)!.role).toBe("dialog");
    expect(getReactProps(body)!.style.paddingBottom).toContain("safe-area-inset-bottom");
    const stopPropagation = vi.fn();
    await harness.act(() => getReactProps(panel)!.onClick({ stopPropagation }));
    expect(stopPropagation).toHaveBeenCalledOnce();
    expect(mocks.onClose).not.toHaveBeenCalled();
    const close = findAllByTag(panel, "button")
      .find((button) => getReactProps(button)?.["aria-label"] === "Close settings");
    expect(findAllByTag(body, "button")).not.toContain(close);
    await harness.act(() => getReactProps(close)!.onClick());
    expect(mocks.onClose).toHaveBeenCalledOnce();
  });

  it("still offers the Helm model before the speech engine status is known", async () => {
    await harness.render(createElement(VoiceSettingsSheet, {
      controller: { ...controller, status: null, settings: null } as unknown as VoiceModeController,
      helmModel: { value: "test-model", onChange: mocks.onModelChange },
      onClose: mocks.onClose,
    }));
    const selects = findAllByTag(harness.dom.container, "select");
    expect(selects).toHaveLength(1);
    expect(getReactProps(selects[0])!.value).toBe("test-model");
  });

  describe("thinking effort", () => {
    async function renderEfforts(helmEfforts: Record<string, unknown>) {
      await harness.render(createElement(VoiceSettingsSheet, {
        controller,
        helmEfforts: { typed: "max", spoken: "xhigh", onChange: mocks.onEffortChange, ...helmEfforts },
        onClose: mocks.onClose,
      }));
      const find = (id: string) => findAllByTag(harness.dom.container, "select").find((select) => getReactProps(select)?.id === id)!;
      const help = (id: string) => findAllByTag(harness.dom.container, "div").find((div) => getReactProps(div)?.id === id)?.textContent ?? "";
      return { typed: find("helm-setting-typed-effort"), spoken: find("helm-setting-spoken-effort"), help };
    }
    const values = (select: unknown) => findAllByTag(select, "option").map((option) => getReactProps(option)!.value);

    it("offers the model's own levels in order and reports each mode separately", async () => {
      const { typed, spoken, help } = await renderEfforts({ modelId: "luna" });
      expect(values(typed)).toEqual(["none", "low", "medium", "high", "xhigh", "max"]);
      expect(getReactProps(typed)!.value).toBe("max");
      expect(getReactProps(spoken)!.value).toBe("xhigh");
      expect(help("helm-typed-effort-help")).not.toContain("doesn't have");
      const labels = findAllByTag(harness.dom.container, "label");
      for (const select of [typed, spoken]) {
        expect(labels.some((label) => getReactProps(label)?.htmlFor === getReactProps(select)!.id)).toBe(true);
      }

      await harness.act(() => {
        getReactProps(typed)!.onChange({ target: { value: "high" } });
        getReactProps(spoken)!.onChange({ target: { value: "low" } });
      });
      expect(mocks.onEffortChange.mock.calls).toEqual([["typed", "high"], ["spoken", "low"]]);
    });

    it("keeps showing a saved level the model lacks, and says what it will use instead", async () => {
      const { typed, spoken, help } = await renderEfforts({ modelId: "haiku" });
      expect(values(typed)).toEqual(["low", "medium", "high", "max"]);
      expect(values(spoken)).toEqual(["low", "medium", "high", "xhigh"]);
      expect(help("helm-typed-effort-help")).toContain("Haiku doesn't have max, so it uses high.");
      expect(help("helm-spoken-effort-help")).toContain("Haiku doesn't have xhigh, so it uses high.");
    });

    it("lists every level when the model isn't known yet, and shows a save error", async () => {
      const { typed } = await renderEfforts({ error: "Could not save" });
      expect(values(typed)).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
      const alert = findAllByTag(harness.dom.container, "div").find((div) => getReactProps(div)?.role === "alert");
      expect(alert?.textContent).toBe("Could not save");
    });
  });
});
