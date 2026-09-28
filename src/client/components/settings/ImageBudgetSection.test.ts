import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "../../api";
import { createReactDomHarness, findAllByTag, getReactProps, type ReactDomHarness } from "../../test-react-harness";
import { ImageBudgetSection } from "./ImageBudgetSection";

describe("ImageBudgetSection", () => {
  let harness: ReactDomHarness | undefined;

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  async function renderSection(draft: AppSettings, setDraft = vi.fn()) {
    harness = await createReactDomHarness();
    await harness.render(createElement(ImageBudgetSection, { draft, setDraft }));
    return { container: harness.dom.container, setDraft, act: harness.act };
  }

  it("is on by default, lists the limits, and stores only the change", async () => {
    const draft: AppSettings = { mcpServers: {} };
    const { container, setDraft, act } = await renderSection(draft);
    expect(container.textContent).toContain("claude-* at 30 MB");
    const [checkbox] = findAllByTag(container, "INPUT");
    expect(getReactProps(checkbox)?.checked).toBe(true);
    await act(async () => { getReactProps(checkbox)?.onChange?.({ target: { checked: false } }); });
    expect(setDraft).toHaveBeenCalledWith({ ...draft, imageBudget: { enabled: false } });
  });

  it("keeps other fields when turned back on and clears the setting when nothing is left", async () => {
    const custom: AppSettings = { mcpServers: {}, imageBudget: { enabled: false, ceilingsMb: { "claude-*": 25 } } };
    const first = await renderSection(custom);
    await first.act(async () => { getReactProps(findAllByTag(first.container, "INPUT")[0])?.onChange?.({ target: { checked: true } }); });
    expect(first.setDraft).toHaveBeenCalledWith({ ...custom, imageBudget: { ceilingsMb: { "claude-*": 25 } } });
    await harness?.cleanup();

    const plain: AppSettings = { mcpServers: {}, imageBudget: { enabled: false } };
    const second = await renderSection(plain);
    await second.act(async () => { getReactProps(findAllByTag(second.container, "INPUT")[0])?.onChange?.({ target: { checked: true } }); });
    expect(second.setDraft).toHaveBeenCalledWith({ ...plain, imageBudget: undefined });
  });
});
