import { createElement, type ComponentProps } from "react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createReactDomHarness, findAllByTag, getReactProps, type ReactDomHarness } from "../test-react-harness";
import { installSelectAwareDomShim } from "../test-dom-shim";
import type { VoiceModeController } from "./useVoiceMode";

const mocks = vi.hoisted(() => ({
  updateSettings: vi.fn(),
  setTransportPreference: vi.fn(),
  setEchoSafe: vi.fn(),
  patchHelmSettings: vi.fn(async () => ({})),
  onClose: vi.fn(),
}));

vi.mock("../helm/helm-settings", () => ({
  useHelmPreferences: () => ({ data: { settings: { glossary: "timmiepc = Timmy PC" } }, error: null }),
  patchHelmSettings: mocks.patchHelmSettings,
}));

const { VoiceSettingsSheet: Sheet } = await import("./VoiceSettingsSheet");
// The sheet links to Settings › Models, so it renders inside a router.
const VoiceSettingsSheet = (props: ComponentProps<typeof Sheet>) => createElement(MemoryRouter, null, createElement(Sheet, props));

const controller = {
  status: { voices: [{ id: "af_heart", name: "Heart", gender: "female", accent: "American" }] },
  settings: { voice: "af_heart", speed: 1, patience: 0.5, bargeIn: true, announce: "watched" },
  transportPreference: "auto",
  echoSafe: true,
  updateSettings: mocks.updateSettings,
  setTransportPreference: mocks.setTransportPreference,
  setEchoSafe: mocks.setEchoSafe,
} as unknown as VoiceModeController;

describe("Hands-free settings sheet", () => {
  let harness: ReactDomHarness;

  beforeEach(async () => {
    vi.clearAllMocks();
    harness = await createReactDomHarness({ installDom: installSelectAwareDomShim });
    await harness.render(createElement(VoiceSettingsSheet, { controller, onClose: mocks.onClose }));
  });

  it("names every select and preserves setting values and handlers", async () => {
    const selects = findAllByTag(harness.dom.container, "select");
    const labels = findAllByTag(harness.dom.container, "label");
    expect(selects).toHaveLength(3);
    for (const select of selects) {
      const props = getReactProps(select)!;
      expect(labels.some((label) => getReactProps(label)?.htmlFor === props.id)).toBe(true);
      expect(props.className).toContain("pr-9");
      expect(props.className).toContain("text-base");
      expect(props.className).toContain("sm:text-sm");
    }
    const [voice, announce, connection] = selects.map((select) => getReactProps(select)!);
    expect(findAllByTag(selects[1], "option").map((option) => getReactProps(option)!.value))
      .toEqual(["watched", "all", "off"]);
    expect(announce["aria-describedby"]).toBe("voice-announce-help");
    await harness.act(() => {
      voice.onChange({ target: { value: "af_heart" } });
      announce.onChange({ target: { value: "all" } });
      connection.onChange({ target: { value: "http" } });
    });
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

  it("waits for the speech engine status before showing voice choices, and points to the model setting", async () => {
    await harness.render(createElement(VoiceSettingsSheet, {
      controller: { ...controller, status: null, settings: null } as unknown as VoiceModeController,
      onClose: mocks.onClose,
    }));
    expect(findAllByTag(harness.dom.container, "select")).toHaveLength(0);
    expect(harness.dom.container.textContent).toContain("Settings › Models");
  });

  it("edits the names list and saves it only when it changed and the field loses focus", async () => {
    const [field] = findAllByTag(harness.dom.container, "textarea");
    expect(getReactProps(field)!.value).toBe("timmiepc = Timmy PC");
    expect(findAllByTag(harness.dom.container, "label").some((label) => getReactProps(label)?.htmlFor === "hands-free-setting-glossary")).toBe(true);
    await harness.act(() => getReactProps(field)!.onBlur());
    expect(mocks.patchHelmSettings).not.toHaveBeenCalled();
    await harness.act(() => getReactProps(field)!.onChange({ target: { value: "timmiepc = Timmy PC; Tether = my iPhone app" } }));
    await harness.act(() => getReactProps(findAllByTag(harness.dom.container, "textarea")[0])!.onBlur());
    expect(mocks.patchHelmSettings).toHaveBeenCalledWith({ glossary: "timmiepc = Timmy PC; Tether = my iPhone app" });
  });
});
