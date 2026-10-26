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
    let serverSettings: AppSettings = {
      mcpServers: {},
      model: "gpt-5.6",
      modelPresets: {
        preset1: { model: "gpt-5.6" },
        preset2: { model: "claude-opus-5", reasoningEffort: "high", contextTier: "long_context" },
      },
      lastModelPreset: "preset1",
    };
    queryClient.setQueryData<AppSettings>(queryKeys.settings, structuredClone(serverSettings));
    // The server answers a PATCH with the full settings after applying it.
    vi.stubGlobal("fetch", vi.fn(async (_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body ?? "{}"));
      serverSettings = { ...serverSettings, ...body };
      return {
        ok: true,
        statusText: "OK",
        json: async () => structuredClone(serverSettings),
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

  it("starts a new chat on the New chats tier, whatever was picked last", async () => {
    await harness!.render(createElement(TestComponent));
    // No New chats tier: the chat starts on the default model.
    expect(memory!.resolveNewChatSelection(MODELS)).toBeNull();

    await harness!.act(async () => {
      queryClient.setQueryData<AppSettings>(queryKeys.settings, (current) => ({ ...current!, modelRoles: { chat: { tier: "preset2" } } }));
      memory!.remember({ slot: "preset1", modelId: "gpt-5.6" });
    });
    await waitUntilAct(harness!.act, () => memory?.resolveNewChatSelection(MODELS) !== null, { label: "New chats tier" });
    expect(memory!.resolveNewChatSelection(MODELS)).toEqual({
      slot: "preset2",
      modelId: "claude-opus-5",
      reasoningEffort: "high",
      contextTier: "long_context",
    });
  });

  it("remembers only the last tier picked, never rewriting a tier from a chat's choice", async () => {
    await harness!.render(createElement(TestComponent));
    const before = queryClient.getQueryData<AppSettings>(queryKeys.settings)?.modelPresets;

    await harness!.act(async () => {
      memory?.remember({ slot: "preset1", modelId: "gpt-5-mini", reasoningEffort: "high" });
      memory?.remember({ slot: "preset2", modelId: "gpt-5.6", contextTier: "long_context" });
    });

    expect(queryClient.getQueryData<AppSettings>(queryKeys.settings)).toMatchObject({ lastModelPreset: "preset2" });
    expect(queryClient.getQueryData<AppSettings>(queryKeys.settings)?.modelPresets).toEqual(before);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    for (const call of vi.mocked(fetch).mock.calls) {
      expect(JSON.parse(String(call[1]?.body))).not.toHaveProperty("modelPresets");
    }
  });

  it("skips the write when the preset already matches memory", async () => {
    await harness!.render(createElement(TestComponent));

    await harness!.act(async () => {
      memory?.remember({ slot: "preset1", modelId: "gpt-5.6" });
    });

    expect(fetch).not.toHaveBeenCalled();
  });

  it("saves a chat's choice into a tier only when asked", async () => {
    await harness!.render(createElement(TestComponent));

    await harness!.act(async () => {
      memory?.saveToTier({ slot: "preset1", modelId: "gpt-5-mini", reasoningEffort: "high" });
    });

    expect(queryClient.getQueryData<AppSettings>(queryKeys.settings)?.modelPresets).toEqual({
      preset1: { model: "gpt-5-mini", reasoningEffort: "high" },
      preset2: { model: "claude-opus-5", reasoningEffort: "high", contextTier: "long_context" },
    });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
  });
});
