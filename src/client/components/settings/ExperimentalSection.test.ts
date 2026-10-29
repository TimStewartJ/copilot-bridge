import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "../../api";
import { createReactDomHarness, findAllByTag, getReactProps, type ReactDomHarness } from "../../test-react-harness";
import { installSelectAwareDomShim } from "../../test-dom-shim";
import { ExperimentalSection } from "./ExperimentalSection";

describe("ExperimentalSection", () => {
  let harness: ReactDomHarness | undefined;

  afterEach(async () => {
    await harness?.cleanup();
    harness = undefined;
  });

  async function choose(draft: AppSettings, value: string) {
    const setDraft = vi.fn();
    harness = await createReactDomHarness({ installDom: installSelectAwareDomShim });
    await harness.render(createElement(ExperimentalSection, { draft, setDraft }));
    const [select] = findAllByTag(harness.dom.container, "SELECT");
    await harness.act(async () => { getReactProps(select)?.onChange?.({ target: { value } }); });
    return { setDraft, select: getReactProps(select) };
  }

  it("stores a chosen Fusion context limit and clears the setting at the runtime default", async () => {
    const plain: AppSettings = { mcpServers: {} };
    const set = await choose(plain, "600000");
    expect(set.select?.value).toBe("");
    expect(set.setDraft).toHaveBeenCalledWith({ ...plain, experimental: { fusionContextTokens: 600_000 } });
    await harness?.cleanup();

    const raised: AppSettings = { mcpServers: {}, experimental: { fusionContextTokens: 600_000 } };
    const cleared = await choose(raised, "");
    expect(cleared.select?.value).toBe("600000");
    expect(cleared.setDraft).toHaveBeenCalledWith({ ...raised, experimental: undefined });
  });
});
