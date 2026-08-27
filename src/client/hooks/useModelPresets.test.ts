import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReactDomHarness, waitUntilAct, type ReactDomHarness } from "../test-react-harness";
import { queryClient, queryKeys } from "../queryClient";
import type { AppSettings, ModelInfo } from "../api";
import { useModelPresets, type ModelPresetMemory } from "./useModelPresets";

const MODELS: ModelInfo[] = [
  { id: "gpt-5.6", name: "GPT-5.6" },
  { id: "gpt-5-mini", name: "GPT-5 mini" },
  { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
  { id: "claude-opus-5", name: "Claude Opus 5" },
];

describe("useModelPresets", () => {
  let harness: ReactDomHarness | null = null;
  let memory: ModelPresetMemory | null = null;

  beforeEach(async () => {
    harness = await createReactDomHarness();
    queryClient.setQueryData<AppSettings>(queryKeys.settings, {
      mcpServers: {},
      model: "gpt-5.6",
      modelPresets: {
        preset1: { model: "gpt-5.6" },
        preset2: { model: "claude-opus-5", reasoningEffort: "high", contextTier: "long_context" },
      },
      lastModelPreset: "preset1",
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
    memory = useModelPresets(enabled === undefined ? undefined : { enabled });
    return null;
  }

  it("reads remembered presets, last slot, and the global default", async () => {
    await harness!.render(createElement(TestComponent));

    expect(memory?.presets).toEqual({
      preset1: { model: "gpt-5.6" },
      preset2: { model: "claude-opus-5", reasoningEffort: "high", contextTier: "long_context" },
    });
    expect(memory?.lastPresetSlot).toBe("preset1");
    expect(memory?.globalDefaultModelId).toBe("gpt-5.6");
    expect(memory?.loading).toBe(false);
  });

  it("resolves preset tiles and restores the selected slot settings", async () => {
    await harness!.render(createElement(TestComponent));

    const state = memory!.resolvePickerState({
      models: MODELS,
      selectedModelId: "claude-opus-5",
      selectedPresetSlot: "preset2",
    });
    expect(state.tiles.find((tile) => tile.slot === "preset1")?.model?.id).toBe("gpt-5.6");
    expect(state.tiles.find((tile) => tile.slot === "preset2")?.model?.id).toBe("claude-opus-5");
    expect(memory!.selectPreset("preset2", {
      models: MODELS,
      selectedModelId: "gpt-5.6",
      selectedPresetSlot: "preset1",
    })).toEqual({
      slot: "preset2",
      modelId: "claude-opus-5",
      reasoningEffort: "high",
      contextTier: "long_context",
    });
  });

  it("starts a surface from the last preset used", async () => {
    await harness!.render(createElement(TestComponent));

    expect(memory!.resolveRememberedSelection(MODELS)).toEqual({
      slot: "preset1",
      modelId: "gpt-5.6",
    });

    await harness!.act(async () => {
      memory!.remember({
        slot: "preset2",
        modelId: "claude-opus-5",
        reasoningEffort: "high",
        contextTier: "long_context",
      });
    });
    await waitUntilAct(
      harness!.act,
      () => memory?.lastPresetSlot === "preset2",
      { label: "remembered preset" },
    );
    expect(memory!.resolveRememberedSelection(MODELS)).toEqual({
      slot: "preset2",
      modelId: "claude-opus-5",
      reasoningEffort: "high",
      contextTier: "long_context",
    });
  });

  it("merges rapid slot choices before persisting them", async () => {
    await harness!.render(createElement(TestComponent));

    await harness!.act(async () => {
      memory?.remember({ slot: "preset1", modelId: "gpt-5-mini", reasoningEffort: "high" });
      memory?.remember({ slot: "preset2", modelId: "gpt-5.6", contextTier: "long_context" });
    });

    expect(queryClient.getQueryData<AppSettings>(queryKeys.settings)).toMatchObject({
      modelPresets: {
        preset1: { model: "gpt-5-mini", reasoningEffort: "high" },
        preset2: { model: "gpt-5.6", contextTier: "long_context" },
      },
      lastModelPreset: "preset2",
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(JSON.parse(String(vi.mocked(fetch).mock.calls[1]?.[1]?.body))).toMatchObject({
      modelPresets: {
        preset1: { model: "gpt-5-mini", reasoningEffort: "high" },
        preset2: { model: "gpt-5.6", contextTier: "long_context" },
      },
      lastModelPreset: "preset2",
    });
  });

  it("skips the write when the preset already matches memory", async () => {
    await harness!.render(createElement(TestComponent));

    await harness!.act(async () => {
      memory?.remember({ slot: "preset1", modelId: "gpt-5.6" });
    });

    expect(fetch).not.toHaveBeenCalled();
  });

  it("reads legacy family memory as preset slots", async () => {
    queryClient.setQueryData<AppSettings>(queryKeys.settings, {
      mcpServers: {},
      familyDefaults: {
        claude: { model: "claude-opus-5", contextTier: "long_context" },
      },
      lastModelFamily: "claude",
    });
    await harness!.render(createElement(TestComponent, { enabled: false }));

    expect(memory?.presets?.preset2).toEqual({
      model: "claude-opus-5",
      contextTier: "long_context",
    });
    expect(memory?.lastPresetSlot).toBe("preset2");
    expect(fetch).not.toHaveBeenCalled();
  });
});
