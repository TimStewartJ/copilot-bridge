import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createReactDomHarness, findAllByTag, getReactProps, type ReactDomHarness } from "../test-react-harness";
import { initialVoiceViewState } from "./voice-view-model";
import { installSelectAwareDomShim } from "../test-dom-shim";

const mocks = vi.hoisted(() => ({
  updateSettings: vi.fn(),
  setTransportPreference: vi.fn(),
}));

vi.mock("react-router-dom", () => ({ useNavigate: () => vi.fn() }));
vi.mock("../hooks/queries/useModels", () => ({
  useModelsQuery: () => ({ data: [{ id: "test-model", name: "A very long assistant model name" }] }),
}));
vi.mock("./VoiceOrb", () => ({ VoiceOrb: () => null }));
vi.mock("./useVoiceMode", () => ({
  useVoiceMode: () => ({
    phase: "ready",
    view: initialVoiceViewState,
    status: { voices: [{ id: "af_heart", name: "Heart", gender: "female", accent: "American" }] },
    settings: { voice: "af_heart", speed: 1, patience: 0.5, bargeIn: true, announce: "watched" },
    transportPreference: "auto",
    ...mocks,
  }),
}));

const { default: VoiceModeView } = await import("./VoiceModeView");

describe("Voice settings", () => {
  let harness: ReactDomHarness;

  beforeEach(async () => {
    vi.clearAllMocks();
    harness = await createReactDomHarness({ installDom: () => {
      const dom = installSelectAwareDomShim();
      const createElement = document.createElement.bind(document);
      document.createElement = (tag: string) => {
        const element = createElement(tag);
        Object.defineProperty(element, "scrollTo", { value: vi.fn(), configurable: true });
        return element;
      };
      return dom;
    } });
    await harness.render(createElement(VoiceModeView));
    const open = findAllByTag(harness.dom.container, "button")
      .find((button) => getReactProps(button)?.["aria-label"] === "Voice settings");
    await harness.act(() => getReactProps(open)!.onClick());
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
    const [voice, announce, model, connection] = selects.map((select) => getReactProps(select)!);
    expect(findAllByTag(selects[1], "option").map((option) => getReactProps(option)!.value))
      .toEqual(["watched", "all", "off"]);
    expect(announce["aria-describedby"]).toBe("voice-announce-help");
    await harness.act(() => {
      voice.onChange({ target: { value: "af_heart" } });
      announce.onChange({ target: { value: "all" } });
      model.onChange({ target: { value: "test-model" } });
      model.onChange({ target: { value: "" } });
      connection.onChange({ target: { value: "http" } });
    });
    expect(mocks.updateSettings.mock.calls).toEqual([
      [{ voice: "af_heart" }], [{ announce: "all" }], [{ model: "test-model" }], [{ model: undefined }],
    ]);
    expect(mocks.setTransportPreference).toHaveBeenCalledWith("http");
  });

  it("keeps the header outside the safe-area-aware scrolling body and closes", async () => {
    const divs = findAllByTag(harness.dom.container, "div");
    const panel = divs.find((div) => getReactProps(div)?.className?.includes("sm:max-w-sm"));
    const body = divs.find((div) => getReactProps(div)?.className?.includes("overscroll-contain"));
    expect(getReactProps(panel)!.className).not.toMatch(/(?:^| )max-w-sm(?: |$)/);
    expect(getReactProps(body)!.style.paddingBottom).toContain("safe-area-inset-bottom");
    const stopPropagation = vi.fn();
    await harness.act(() => getReactProps(panel)!.onClick({ stopPropagation }));
    expect(stopPropagation).toHaveBeenCalledOnce();
    const close = findAllByTag(panel, "button")
      .find((button) => getReactProps(button)?.["aria-label"] === "Close settings");
    expect(findAllByTag(body, "button")).not.toContain(close);
    await harness.act(() => getReactProps(close)!.onClick());
    expect(findAllByTag(harness.dom.container, "select")).toHaveLength(0);
  });
});
