import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReactDomHarness, waitUntilAct, type ReactDomHarness } from "../test-react-harness";
import { queryClient, queryKeys } from "../queryClient";
import type { AppSettings, ModelInfo } from "../api";
import { useModelFamilyMemory, type ModelFamilyMemory } from "./useModelFamilyMemory";

const MODELS: ModelInfo[] = [
  { id: "gpt-5.6", name: "GPT-5.6" },
  { id: "gpt-5-mini", name: "GPT-5 mini" },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
  { id: "claude-opus-5", name: "Claude Opus 5" },
];

describe("useModelFamilyMemory", () => {
  let harness: ReactDomHarness | null = null;
  let memory: ModelFamilyMemory | null = null;

  beforeEach(async () => {
    harness = await createReactDomHarness();
    queryClient.setQueryData<AppSettings>(queryKeys.settings, {
      mcpServers: {},
      model: "gpt-5.6",
      familyDefaults: {
        gpt: { model: "gpt-5.6" },
        claude: { model: "claude-opus-5", reasoningEffort: "high", contextTier: "long_context" },
      },
      lastModelFamily: "gpt",
    });
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      return {
        ok: true,
        statusText: "OK",
        json: async () => ({ mcpServers: {}, ...body }),
      };
    }));
  });

  afterEach(async () => {
    memory = null;
    queryClient.removeQueries({ queryKey: queryKeys.settings });
    vi.unstubAllGlobals();
    await harness?.cleanup();
    harness = null;
  });

  function TestComponent({ enabled }: { enabled?: boolean }) {
    memory = useModelFamilyMemory(enabled === undefined ? undefined : { enabled });
    return null;
  }

  it("reads remembered defaults, last family, and the global default from settings", async () => {
    await harness!.render(createElement(TestComponent));

    expect(memory?.familyDefaults).toEqual({
      gpt: { model: "gpt-5.6" },
      claude: { model: "claude-opus-5", reasoningEffort: "high", contextTier: "long_context" },
    });
    expect(memory?.lastModelFamily).toBe("gpt");
    expect(memory?.globalDefaultModelId).toBe("gpt-5.6");
    expect(memory?.loading).toBe(false);
  });

  it("resolves tiles and family picks through the same memory", async () => {
    await harness!.render(createElement(TestComponent));

    const state = memory!.resolvePickerState({ models: MODELS, selectedModelId: "gpt-5-mini" });
    expect(state.tiles.find((tile) => tile.family === "gpt")?.model?.id).toBe("gpt-5-mini");
    expect(state.tiles.find((tile) => tile.family === "claude")?.model?.id).toBe("claude-opus-5");

    expect(memory!.selectFamily("claude", { models: MODELS, selectedModelId: "gpt-5-mini" })).toEqual({
      modelId: "claude-opus-5",
      reasoningEffort: "high",
      contextTier: "long_context",
    });
    expect(memory!.selectModel("claude-opus-5")).toEqual({
      modelId: "claude-opus-5",
      reasoningEffort: "high",
      contextTier: "long_context",
    });
    // Effort/context only follow the remembered model, not any model in the family.
    expect(memory!.selectModel("claude-sonnet-5")).toEqual({ modelId: "claude-sonnet-5" });
  });

  it("starts a surface without a current model from the last family used", async () => {
    await harness!.render(createElement(TestComponent));

    expect(memory!.resolveRememberedSelection(MODELS)).toEqual({ modelId: "gpt-5.6" });

    await harness!.act(async () => {
      memory!.remember({ modelId: "claude-opus-5", reasoningEffort: "high", contextTier: "long_context" });
    });
    // The cache write reaches the hook through the query observer on the next flush.
    await waitUntilAct(
      harness!.act,
      () => memory?.lastModelFamily === "claude",
      { label: "remembered family" },
    );
    expect(memory!.resolveRememberedSelection(MODELS)).toEqual({
      modelId: "claude-opus-5",
      reasoningEffort: "high",
      contextTier: "long_context",
    });
  });

  it("merges rapid family choices before persisting them", async () => {
    await harness!.render(createElement(TestComponent));

    await harness!.act(async () => {
      memory?.remember({ modelId: "gpt-5-mini", reasoningEffort: "high" });
      memory?.remember({ modelId: "claude-opus-5", contextTier: "long_context" });
    });

    expect(queryClient.getQueryData<AppSettings>(queryKeys.settings)).toMatchObject({
      familyDefaults: {
        gpt: { model: "gpt-5-mini", reasoningEffort: "high" },
        claude: { model: "claude-opus-5", contextTier: "long_context" },
      },
      lastModelFamily: "claude",
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[1]?.[1]?.body))).toMatchObject({
      familyDefaults: {
        gpt: { model: "gpt-5-mini", reasoningEffort: "high" },
        claude: { model: "claude-opus-5", contextTier: "long_context" },
      },
      lastModelFamily: "claude",
    });
  });

  it("skips the write when the choice already matches memory", async () => {
    await harness!.render(createElement(TestComponent));

    await harness!.act(async () => {
      memory?.remember({ modelId: "gpt-5.6" });
    });

    expect(fetch).not.toHaveBeenCalled();
  });

  it("still reads cached settings when fetching is disabled", async () => {
    await harness!.render(createElement(TestComponent, { enabled: false }));

    expect(memory?.familyDefaults?.claude?.model).toBe("claude-opus-5");
    expect(fetch).not.toHaveBeenCalled();
  });
});
