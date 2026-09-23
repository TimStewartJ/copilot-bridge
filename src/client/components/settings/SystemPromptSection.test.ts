import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppSettings } from "../../api";
import {
  DEFAULT_RESPONSE_STYLE_GUIDANCE,
  MAX_RESPONSE_STYLE_GUIDANCE_LENGTH,
  resolveResponseStyle,
} from "../../../shared/response-style.js";
import { createReactDomHarness, findAllByTag, getReactProps } from "../../test-react-harness";
import { SystemPromptSection } from "./SystemPromptSection";

async function renderSection(draft: AppSettings) {
  const harness = await createReactDomHarness();
  const setDraft = vi.fn<(next: AppSettings) => void>();
  const render = (next: AppSettings) => harness.render(createElement(SystemPromptSection, { draft: next, setDraft }));
  await render(draft);
  return { harness, container: harness.dom.container, setDraft, render };
}

function styleTextarea(container: unknown) {
  return findAllByTag(container, "TEXTAREA")[0];
}

function buttonWithText(container: unknown, text: string) {
  const button = findAllByTag(container, "BUTTON").find((candidate) => candidate.textContent === text);
  if (!button) throw new Error(`No "${text}" button`);
  return button;
}

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

beforeEach(() => { vi.stubGlobal("sessionStorage", memoryStorage()); });
afterEach(() => { vi.unstubAllGlobals(); });

describe("SystemPromptSection", () => {
  it("shows natural-and-direct defaults, adaptive detail, quality safeguards, and truthful apply timing", async () => {
    const { container } = await renderSection({ mcpServers: {} });
    expect(getReactProps(styleTextarea(container))?.value).toBe(DEFAULT_RESPONSE_STYLE_GUIDANCE);
    expect(getReactProps(styleTextarea(container))?.maxLength).toBe(MAX_RESPONSE_STYLE_GUIDANCE_LENGTH);
    const radios = findAllByTag(container, "INPUT");
    expect(radios.map((radio) => getReactProps(radio)?.value)).toEqual(["adaptive", "concise", "detailed"]);
    expect(radios.map((radio) => getReactProps(radio)?.checked)).toEqual([true, false, false]);
    expect(container.textContent).toContain("Response quality (always on)");
    expect(container.textContent).toContain("new chats and fresh session resumes");
    expect(getReactProps(findAllByTag(container, "BUTTON")[0])?.disabled).toBe(true);
  });

  it("uses associated labels and an accessible native radio group", async () => {
    const { container } = await renderSection({ mcpServers: {} });
    const textareas = findAllByTag(container, "TEXTAREA");
    const labels = findAllByTag(container, "LABEL");
    for (const textarea of textareas) {
      const props = getReactProps(textarea);
      expect(labels.some((label) => getReactProps(label)?.htmlFor === props?.id)).toBe(true);
      expect(props?.["aria-describedby"]).toBeTruthy();
    }
    const radios = findAllByTag(container, "INPUT");
    expect(new Set(radios.map((radio) => getReactProps(radio)?.name)).size).toBe(1);
    expect(radios.every((radio) => getReactProps(radio)?.type === "radio")).toBe(true);
    expect(findAllByTag(container, "LEGEND")[0].textContent).toBe("Default detail");
    for (const element of [...labels, ...findAllByTag(container, "LEGEND"), ...findAllByTag(container, "P")]) {
      const className = getReactProps(element)?.className ?? "";
      expect(className).not.toContain("text-text-faint");
    }
  });

  it("keeps advanced text fields closed until requested without hiding the detail choices", async () => {
    const { container } = await renderSection({ mcpServers: {}, customInstructions: "Keep my terminology." });
    const disclosures = findAllByTag(container, "DETAILS");
    expect(disclosures).toHaveLength(4);
    expect(disclosures.every((element) => !getReactProps(element)?.open)).toBe(true);
    expect(findAllByTag(container, "FIELDSET")).toHaveLength(1);
    expect(container.textContent).toContain("Configured");
  });

  it("changes the detail level without overwriting guidance or unrelated settings", async () => {
    const draft: AppSettings = {
      mcpServers: {}, identity: "Bridge", customInstructions: "Prefer TypeScript.", theme: "dark",
      responseStyle: { detail: "adaptive", guidance: "Use plain prose." },
    };
    const { harness, container, setDraft } = await renderSection(draft);
    await harness.act(async () => {
      getReactProps(findAllByTag(container, "INPUT")[2])?.onChange?.();
    });
    expect(setDraft).toHaveBeenCalledWith({ ...draft, responseStyle: { detail: "detailed", guidance: "Use plain prose." } });
    expect(draft.responseStyle?.detail).toBe("adaptive");
  });

  it("saves edited guidance only on Save, keeping the selected detail level", async () => {
    const draft: AppSettings = { mcpServers: {}, responseStyle: { detail: "concise", guidance: "Old guidance." } };
    const { harness, container, setDraft, render } = await renderSection(draft);
    await harness.act(async () => {
      getReactProps(styleTextarea(container))?.onChange?.({ target: { value: "Use precise terms." } });
    });
    expect(setDraft).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Not saved yet");
    await harness.act(async () => { getReactProps(buttonWithText(container, "Save"))?.onClick?.(); });
    expect(setDraft).toHaveBeenLastCalledWith({ ...draft, responseStyle: { detail: "concise", guidance: "Use precise terms." } });

    const saved = setDraft.mock.calls.at(-1)?.[0];
    if (!saved) throw new Error("No updated settings draft");
    await render(saved);
    await harness.act(async () => {
      getReactProps(styleTextarea(container))?.onChange?.({ target: { value: "" } });
    });
    await harness.act(async () => { getReactProps(buttonWithText(container, "Save"))?.onClick?.(); });
    const next = setDraft.mock.calls.at(-1)?.[0];
    expect(next).toEqual({ ...draft, responseStyle: { detail: "concise", guidance: "" } });
    if (!next) throw new Error("No updated settings draft");
    await render(next);
    expect(getReactProps(styleTextarea(container))?.value).toBe("");
    expect(container.textContent).toContain("Leave blank to use the default guidance");
    expect(container.textContent).not.toContain("Not saved yet");
  });

  it("keeps unsaved guidance for this tab and cancels back to the saved text", async () => {
    const draft: AppSettings = { mcpServers: {}, responseStyle: { detail: "adaptive", guidance: "Saved." } };
    const first = await renderSection(draft);
    await first.harness.act(async () => {
      getReactProps(styleTextarea(first.container))?.onChange?.({ target: { value: "Half-written" } });
    });
    await first.harness.cleanup();

    const second = await renderSection(draft);
    expect(getReactProps(styleTextarea(second.container))?.value).toBe("Half-written");
    expect(second.container.textContent).toContain("Unsaved edit restored");
    await second.harness.act(async () => { getReactProps(buttonWithText(second.container, "Cancel"))?.onClick?.(); });
    expect(getReactProps(styleTextarea(second.container))?.value).toBe("Saved.");
    expect(sessionStorage.getItem("bridge-settings-unsaved:responseStyle.guidance")).toBeNull();
    expect(second.setDraft).not.toHaveBeenCalled();
  });

  it("resets only response style in the draft, with an explicit persistable default", async () => {
    const draft: AppSettings = {
      mcpServers: {}, identity: "Bridge", customInstructions: "Keep my terminology.", theme: "light",
      responseStyle: { detail: "detailed", guidance: "Explain thoroughly." },
    };
    const { harness, container, setDraft } = await renderSection(draft);
    const reset = findAllByTag(container, "BUTTON")[0];
    expect(getReactProps(reset)?.disabled).toBe(false);
    await harness.act(async () => { getReactProps(reset)?.onClick?.(); });
    expect(setDraft).toHaveBeenCalledWith({ ...draft, responseStyle: resolveResponseStyle() });
    expect(draft.responseStyle?.guidance).toBe("Explain thoroughly.");
  });

  it.each([
    "<anti_slop_response_quality>Edited guidance.</anti_slop_response_quality>",
    "<anti_slop_response_quality>Incomplete guidance.",
    "<anti_slop_response_quality",
  ])("shows a review notice for preserved legacy guidance", async (customInstructions) => {
    const { container } = await renderSection({ mcpServers: {}, customInstructions });
    expect(container.textContent).toContain("An edited or incomplete legacy response-quality block was preserved");
    expect(getReactProps(findAllByTag(container, "TEXTAREA")[2])?.value).toBe(customInstructions);
  });

  it("keeps ordinary custom instructions free of legacy warnings", async () => {
    const { container } = await renderSection({ mcpServers: {}, customInstructions: "Prefer TypeScript." });
    expect(container.textContent).not.toContain("legacy response-quality block was preserved");
  });
});
