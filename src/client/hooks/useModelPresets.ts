import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  fetchSettings,
  type AppSettings,
  type ModelInfo,
  type ModelPresets,
} from "../api";
import {
  buildModelPresetsPatch,
  findPresetSlotForModel,
  resolveModelPresetState,
  selectModelInPreset,
  selectPreset,
  type ModelPresetPickerState,
  type ModelPresetSelection,
} from "../lib/model-presets";
import { queryClient, queryKeys } from "../queryClient";
import { settingsWriter } from "./queries/useSettings";
import type { CopilotContextTier } from "../../shared/copilot-context.js";
import type { ModelPresetSlot } from "../../shared/model-presets.js";
import { isTierChoice } from "../../shared/model-roles.js";

/** The shared writer applies the change to the cached settings at once and sends it in order. */
function enqueueSettingsPatch(updates: Partial<AppSettings>): void {
  settingsWriter.patch(updates).catch((error: unknown) => {
    console.error("[model-presets] Failed to remember preset", error);
  });
}

export interface ModelPresetPickerContext {
  models: readonly ModelInfo[];
  selectedModelId: string;
  selectedPresetSlot?: ModelPresetSlot;
}

export interface RememberModelPresetSelection {
  slot: ModelPresetSlot;
  modelId: string;
  reasoningEffort?: string;
  contextTier?: CopilotContextTier;
}

export interface ModelPresetMemory {
  presets?: ModelPresets;
  lastPresetSlot?: ModelPresetSlot;
  globalDefaultModelId?: string;
  loading: boolean;
  resolvePickerState: (context: ModelPresetPickerContext) => ModelPresetPickerState;
  selectPreset: (
    slot: ModelPresetSlot,
    context: ModelPresetPickerContext,
  ) => ModelPresetSelection | null;
  selectModel: (slot: ModelPresetSlot, modelId: string) => ModelPresetSelection;
  resolveNewChatSelection: (models: readonly ModelInfo[]) => ModelPresetSelection | null;
  findSlotForModel: (modelId: string, models: readonly ModelInfo[]) => ModelPresetSlot | undefined;
  remember: (selection: RememberModelPresetSelection) => void;
  /** Makes a chat's model, effort and context the tier's own (Settings › Models changes with it). */
  saveToTier: (selection: RememberModelPresetSelection) => void;
}

export function useModelPresets(options?: { enabled?: boolean }): ModelPresetMemory {
  const settingsQuery = useQuery({
    queryKey: queryKeys.settings,
    queryFn: fetchSettings,
    enabled: options?.enabled ?? true,
  }, queryClient);
  const settings = settingsQuery.data;
  const presets = settings?.modelPresets;
  const lastPresetSlot = settings?.lastModelPreset;
  const globalDefaultModelId = settings?.model;

  const resolvePickerState = useCallback((context: ModelPresetPickerContext) => (
    resolveModelPresetState({
      models: context.models,
      selectedModelId: context.selectedModelId,
      selectedPresetSlot: context.selectedPresetSlot,
      globalDefaultModelId,
      presets,
    })
  ), [globalDefaultModelId, presets]);

  const selectPresetWithMemory = useCallback((
    slot: ModelPresetSlot,
    context: ModelPresetPickerContext,
  ) => (
    selectPreset({
      slot,
      state: resolvePickerState(context),
      presets,
    })
  ), [presets, resolvePickerState]);

  const selectModel = useCallback((slot: ModelPresetSlot, modelId: string) => (
    selectModelInPreset({ slot, modelId, presets })
  ), [presets]);

  // A new chat starts on the "New chats" tier from Settings › Models; with its own model, on that model.
  const newChatSlot = isTierChoice(settings?.modelRoles?.chat) ? settings.modelRoles.chat.tier : undefined;
  const resolveNewChatSelection = useCallback((models: readonly ModelInfo[]) => {
    if (!newChatSlot) return null;
    return selectPresetWithMemory(newChatSlot, {
      models,
      selectedModelId: "",
      selectedPresetSlot: newChatSlot,
    });
  }, [newChatSlot, selectPresetWithMemory]);

  const findSlot = useCallback((modelId: string, models: readonly ModelInfo[]) => (
    findPresetSlotForModel({
      modelId,
      models,
      presets,
      globalDefaultModelId,
      preferredSlot: lastPresetSlot,
    })
  ), [globalDefaultModelId, lastPresetSlot, presets]);

  /**
   * Remembers which tier was picked last. The tiers themselves (Fast, Standard, Deep) are shared by
   * Helm, background work and sub-agents, so a choice made in one chat never rewrites them; they are
   * edited only in Settings › Models.
   */
  const remember = useCallback(({ slot, modelId }: RememberModelPresetSelection) => {
    if (!modelId) return;
    const cachedSettings = queryClient.getQueryData<AppSettings>(queryKeys.settings);
    if (cachedSettings?.lastModelPreset === slot) return;
    enqueueSettingsPatch({ lastModelPreset: slot });
  }, []);

  const saveToTier = useCallback(({ slot, modelId, reasoningEffort, contextTier }: RememberModelPresetSelection) => {
    const current = queryClient.getQueryData<AppSettings>(queryKeys.settings)?.modelPresets ?? presets;
    const next = buildModelPresetsPatch({ current, slot, modelId, reasoningEffort, contextTier });
    if (next) enqueueSettingsPatch({ modelPresets: next });
  }, [presets]);

  return useMemo<ModelPresetMemory>(() => ({
    presets,
    lastPresetSlot,
    globalDefaultModelId,
    loading: settingsQuery.isLoading,
    resolvePickerState,
    selectPreset: selectPresetWithMemory,
    selectModel,
    resolveNewChatSelection,
    findSlotForModel: findSlot,
    remember,
    saveToTier,
  }), [
    saveToTier,
    findSlot,
    globalDefaultModelId,
    lastPresetSlot,
    presets,
    remember,
    resolvePickerState,
    resolveNewChatSelection,
    selectModel,
    selectPresetWithMemory,
    settingsQuery.isLoading,
  ]);
}
