import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  fetchSettings,
  patchSettings,
  type AppSettings,
  type ModelInfo,
  type ModelPresets,
} from "../api";
import {
  buildModelPresetsPatch,
  findPresetSlotForModel,
  mergeStoredModelPresets,
  resolveModelPresetState,
  selectModelInPreset,
  selectPreset,
  type ModelPresetPickerState,
  type ModelPresetSelection,
} from "../lib/model-presets";
import { queryClient, queryKeys } from "../queryClient";
import type { CopilotContextTier } from "../../shared/copilot-context.js";
import {
  getModelPresetSlotForFamily,
  type ModelPresetSlot,
} from "../../shared/model-presets.js";

let settingsWriteChain = Promise.resolve();
let latestSettingsWrite = 0;

function enqueueSettingsPatch(updates: Partial<AppSettings>): void {
  const writeId = ++latestSettingsWrite;
  settingsWriteChain = settingsWriteChain.then(async () => {
    try {
      const settings = await patchSettings(updates);
      if (writeId === latestSettingsWrite) {
        queryClient.setQueryData(queryKeys.settings, settings);
      }
    } catch (error) {
      console.error("[model-presets] Failed to remember preset", error);
      if (writeId === latestSettingsWrite) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.settings });
      }
    }
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
  resolveRememberedSelection: (models: readonly ModelInfo[]) => ModelPresetSelection | null;
  findSlotForModel: (modelId: string, models: readonly ModelInfo[]) => ModelPresetSlot | undefined;
  remember: (selection: RememberModelPresetSelection) => void;
}

export function useModelPresets(options?: { enabled?: boolean }): ModelPresetMemory {
  const settingsQuery = useQuery({
    queryKey: queryKeys.settings,
    queryFn: fetchSettings,
    enabled: options?.enabled ?? true,
  }, queryClient);
  const settings = settingsQuery.data;
  const presets = useMemo(
    () => mergeStoredModelPresets(settings?.modelPresets, settings?.familyDefaults),
    [settings?.familyDefaults, settings?.modelPresets],
  );
  const lastPresetSlot = settings?.lastModelPreset
    ?? (settings?.lastModelFamily ? getModelPresetSlotForFamily(settings.lastModelFamily) : undefined);
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

  const resolveRememberedSelection = useCallback((models: readonly ModelInfo[]) => {
    if (!lastPresetSlot) return null;
    return selectPresetWithMemory(lastPresetSlot, {
      models,
      selectedModelId: "",
      selectedPresetSlot: lastPresetSlot,
    });
  }, [lastPresetSlot, selectPresetWithMemory]);

  const findSlot = useCallback((modelId: string, models: readonly ModelInfo[]) => (
    findPresetSlotForModel({
      modelId,
      models,
      presets,
      globalDefaultModelId,
      preferredSlot: lastPresetSlot,
    })
  ), [globalDefaultModelId, lastPresetSlot, presets]);

  const remember = useCallback(({
    slot,
    modelId,
    reasoningEffort,
    contextTier,
  }: RememberModelPresetSelection) => {
    if (!modelId) return;
    const cachedSettings = queryClient.getQueryData<AppSettings>(queryKeys.settings);
    const currentPresets = mergeStoredModelPresets(
      cachedSettings?.modelPresets,
      cachedSettings?.familyDefaults,
    ) ?? presets;
    const nextPresets = buildModelPresetsPatch({
      current: currentPresets,
      slot,
      modelId,
      reasoningEffort,
      contextTier,
    });
    if (!nextPresets && cachedSettings?.lastModelPreset === slot) return;

    const mergedPresets = nextPresets ?? currentPresets;
    queryClient.setQueryData<AppSettings>(queryKeys.settings, (current) => (
      current
        ? {
          ...current,
          ...(mergedPresets ? { modelPresets: mergedPresets } : {}),
          lastModelPreset: slot,
        }
        : current
    ));
    enqueueSettingsPatch({
      ...(mergedPresets ? { modelPresets: mergedPresets } : {}),
      lastModelPreset: slot,
    });
  }, [presets]);

  return useMemo<ModelPresetMemory>(() => ({
    presets,
    lastPresetSlot,
    globalDefaultModelId,
    loading: settingsQuery.isLoading,
    resolvePickerState,
    selectPreset: selectPresetWithMemory,
    selectModel,
    resolveRememberedSelection,
    findSlotForModel: findSlot,
    remember,
  }), [
    findSlot,
    globalDefaultModelId,
    lastPresetSlot,
    presets,
    remember,
    resolvePickerState,
    resolveRememberedSelection,
    selectModel,
    selectPresetWithMemory,
    settingsQuery.isLoading,
  ]);
}
