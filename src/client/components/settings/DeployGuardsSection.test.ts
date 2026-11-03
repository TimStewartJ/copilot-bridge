import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "../../api";
import { createReactDomHarness, findAllByTag, getReactProps, type ReactDomHarness } from "../../test-react-harness";
import { DeployGuardsSection } from "./DeployGuardsSection";

function memoryStorage(): Storage {
  const store = new Map<string, string>();
  return {
    get length() { return store.size; },
    clear: () => store.clear(),
    getItem: (key) => store.get(key) ?? null,
    key: (index) => [...store.keys()][index] ?? null,
    removeItem: (key) => { store.delete(key); },
    setItem: (key, value) => { store.set(key, String(value)); },
  };
}

let harness: ReactDomHarness | undefined;

beforeEach(() => { vi.stubGlobal("sessionStorage", memoryStorage()); });
afterEach(async () => {
  await harness?.cleanup();
  harness = undefined;
  vi.unstubAllGlobals();
});

async function editAndSave(field: Element, text: string) {
  await harness!.act(async () => { getReactProps(field)?.onChange?.({ target: { value: text } }); });
  const save = findAllByTag(harness!.dom.container, "BUTTON").find((button) => button.textContent === "Save");
  await harness!.act(async () => { getReactProps(save)?.onClick?.(); });
}

describe("DeployGuardsSection", () => {
  it("saves patterns one per line and clears the setting when both fields are empty", async () => {
    let draft: AppSettings = { mcpServers: {}, deployGuards: { denylistFile: "/home/user/denylist.txt" } };
    const setDraft = vi.fn((next: AppSettings) => { draft = next; });
    harness = await createReactDomHarness();
    const render = () => harness!.render(createElement(DeployGuardsSection, { draft, setDraft }));
    await render();

    await editAndSave(findAllByTag(harness.dom.container, "TEXTAREA")[0], "dev@example.com\n\n *@corp.example.com \n");
    expect(draft.deployGuards).toEqual({
      denylistFile: "/home/user/denylist.txt",
      blockedEmailPatterns: ["dev@example.com", "*@corp.example.com"],
    });
    await render();

    await editAndSave(findAllByTag(harness.dom.container, "INPUT")[0], " ");
    expect(draft.deployGuards).toEqual({ blockedEmailPatterns: ["dev@example.com", "*@corp.example.com"] });
    await render();

    await editAndSave(findAllByTag(harness.dom.container, "TEXTAREA")[0], "\n");
    expect(draft).toEqual({ mcpServers: {}, deployGuards: undefined });
  });
});
