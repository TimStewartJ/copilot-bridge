import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { describeClientAge, ModelSection, shouldClearUnsupportedContextTier } from "./ModelSection";
import type { AppSettings } from "../../api";
import { createReactDomHarness, findAllByTag, getReactProps, type ReactDomHarness } from "../../test-react-harness";
import { installFocusDialogDom } from "../../test-focus-harness";

const modelQuery = vi.hoisted(() => ({ loaded: false }));
vi.mock("../../hooks/queries/useModels", () => ({
  useModelsQuery: () => ({
    data: modelQuery.loaded ? [
      { id: "economy", name: "Economy", supportedReasoningEfforts: [] },
      { id: "other", name: "Other", supportedReasoningEfforts: [] },
    ] : undefined,
    isLoading: !modelQuery.loaded,
  }),
}));
vi.mock("../../hooks/queries/useModelClientInfo", () => ({ useModelClientInfoQuery: () => ({ data: null }) }));
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...await importOriginal<typeof import("@tanstack/react-query")>(),
  useQueryClient: () => ({ setQueryData: vi.fn(), invalidateQueries: vi.fn() }),
}));

describe("model settings draft", () => {
  let harness: ReactDomHarness | undefined;
  afterEach(async () => { await harness?.cleanup(); harness = undefined; modelQuery.loaded = false; });

  it("does not dirty or normalize a saved draft when model metadata arrives", async () => {
    harness = await createReactDomHarness({ installDom: installFocusDialogDom });
    const draft: AppSettings = { model: "economy", contextTier: "default", mcpServers: {} };
    const setDraft = vi.fn();
    await harness.render(createElement(ModelSection, { draft, setDraft }));
    modelQuery.loaded = true;
    await harness.render(createElement(ModelSection, { draft, setDraft }));
    expect(setDraft).not.toHaveBeenCalled();
    expect(draft.contextTier).toBe("default");
  });

  it("normalizes context only after an explicit model choice", async () => {
    harness = await createReactDomHarness({ installDom: installFocusDialogDom });
    modelQuery.loaded = true;
    const draft: AppSettings = { model: "economy", contextTier: "long_context", mcpServers: {} };
    const setDraft = vi.fn();
    await harness.render(createElement(ModelSection, { draft, setDraft }));
    expect(harness.dom.container.textContent).toContain("It has been preserved");
    expect(setDraft).not.toHaveBeenCalled();
    const select = findAllByTag(harness.dom.container, "SELECT")[0];
    await harness.act(async () => { getReactProps(select)?.onChange?.({ target: { value: "other" } }); });
    expect(setDraft).toHaveBeenCalledWith({ ...draft, model: "other", contextTier: undefined, reasoningEffort: undefined });
  });
});

describe("shouldClearUnsupportedContextTier", () => {
  it("keeps the saved context tier while model metadata is still loading", () => {
    expect(shouldClearUnsupportedContextTier({
      contextTier: "long_context",
      modelsLoaded: false,
      currentModel: "gpt-5.5",
      selectedModelSupportsLongContext: false,
      selectedModelKnown: false,
    })).toBe(false);
  });

  it("clears unsupported context for an explicit model choice", () => {
    expect(shouldClearUnsupportedContextTier({
      contextTier: "long_context",
      modelsLoaded: true,
      currentModel: "gpt-5-mini",
      selectedModelSupportsLongContext: false,
      selectedModelKnown: true,
    })).toBe(true);
  });

  it("keeps the saved context tier when metadata confirms the selected model supports it", () => {
    expect(shouldClearUnsupportedContextTier({
      contextTier: "long_context",
      modelsLoaded: true,
      currentModel: "gpt-5.5",
      selectedModelSupportsLongContext: true,
      selectedModelKnown: true,
    })).toBe(false);
  });
});

describe("describeClientAge", () => {
  it("returns null when the timestamp is missing or unparseable", () => {
    // Missing
    expect(describeClientAge(null)).toBeNull();
    expect(describeClientAge(undefined)).toBeNull();
    expect(describeClientAge("")).toBeNull();
    // Unparseable
    expect(describeClientAge("not-a-date")).toBeNull();
  });

  it("returns the iso string when the timestamp is valid", () => {
    expect(describeClientAge("2026-01-01T00:00:00.000Z")).toEqual({
      iso: "2026-01-01T00:00:00.000Z",
    });
  });
});
