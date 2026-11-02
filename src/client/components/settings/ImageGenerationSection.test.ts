import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "../../api";
import { createReactDomHarness, findAllByTag, getReactProps, type ReactDomHarness } from "../../test-react-harness";
import { ImageGenerationSection } from "./ImageGenerationSection";

describe("ImageGenerationSection", () => {
  let harness: ReactDomHarness | undefined;

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  it.each([
    { label: "is on until turned off, and saves turning it off", draft: { mcpServers: {} }, checked: true, next: { enabled: false } },
    { label: "clears the setting when turned back on", draft: { mcpServers: {}, imageGeneration: { enabled: false } }, checked: false, next: undefined },
  ])("$label", async ({ draft, checked, next }) => {
    const setDraft = vi.fn();
    harness = await createReactDomHarness();
    await harness.render(createElement(ImageGenerationSection, { draft: draft as AppSettings, setDraft }));

    const [checkbox] = findAllByTag(harness.dom.container, "INPUT");
    expect(getReactProps(checkbox)?.checked).toBe(checked);
    await harness.act(async () => {
      getReactProps(checkbox)?.onChange?.({ target: { checked: !checked } });
    });
    expect(setDraft).toHaveBeenCalledWith({ ...draft, imageGeneration: next });
  });
});
