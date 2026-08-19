import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  fetchSettings,
  patchSettings,
  type AppSettings,
  type ModelFamilyDefaults,
  type ModelInfo,
} from "../api";
import {
  buildFamilyDefaultsPatch,
  resolveModelFamilyState,
  selectFamily,
  selectModelInFamily,
  type ModelFamilyPickerState,
  type ModelFamilySelection,
} from "../lib/model-family-defaults";
import { queryClient, queryKeys } from "../queryClient";
import type { CopilotContextTier } from "../../shared/copilot-context.js";
import { getModelFamily, type ModelFamily } from "../../shared/model-families.js";

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
      console.error("[model-family] Failed to remember model choice", error);
      if (writeId === latestSettingsWrite) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.settings });
      }
    }
  });
}

export interface ModelFamilyPickerContext {
  models: readonly ModelInfo[];
  /** The model currently in effect on this surface, or "" when there is none. */
  selectedModelId: string;
  /** Family to highlight when no concrete model is selected yet. */
  selectedFamily?: ModelFamily;
}

export interface RememberModelSelection {
  modelId: string;
  reasoningEffort?: string;
  contextTier?: CopilotContextTier;
}

export interface ModelFamilyMemory {
  /** Remembered model + effort + context per family. */
  familyDefaults?: ModelFamilyDefaults;
  /** Family the user most recently committed to on any model picker. */
  lastModelFamily?: ModelFamily;
  /** Bridge-wide default model; the fallback tile model and the "default" marker. */
  globalDefaultModelId?: string;
  /** True until settings have loaded once. */
  loading: boolean;
  /** Tile state for a ModelFamilyPicker with memory and the global default applied. */
  resolvePickerState: (context: ModelFamilyPickerContext) => ModelFamilyPickerState;
  /** Selection produced by clicking a family tile: remembered model plus its effort/context. */
  selectFamily: (family: ModelFamily, context: ModelFamilyPickerContext) => ModelFamilySelection | null;
  /** Selection produced by picking a specific model: remembered effort/context when it matches. */
  selectModel: (modelId: string) => ModelFamilySelection;
  /** Starting selection for a surface with no current model, based on the last family used. */
  resolveRememberedSelection: (models: readonly ModelInfo[]) => ModelFamilySelection | null;
  /** Persist a committed selection so every model picker reflects it. */
  remember: (selection: RememberModelSelection) => void;
}

/**
 * Single source of truth for per-family model memory. Every surface that picks
 * a model (new chat, change-model dialog) reads tile state, restores remembered
 * effort/context, and records committed choices through this hook so a choice
 * made in one place shows up in all of them.
 *
 * Settings are observed from the shared query cache; pass `enabled: false` to
 * read whatever is cached without triggering a fetch (e.g. until a dialog opens).
 */
export function useModelFamilyMemory(options?: { enabled?: boolean }): ModelFamilyMemory {
  const settingsQuery = useQuery({
    queryKey: queryKeys.settings,
    queryFn: fetchSettings,
    enabled: options?.enabled ?? true,
  }, queryClient);
  const settings = settingsQuery.data;
  const familyDefaults = settings?.familyDefaults;
  const lastModelFamily = settings?.lastModelFamily;
  const globalDefaultModelId = settings?.model;

  const resolvePickerState = useCallback((context: ModelFamilyPickerContext) => (
    resolveModelFamilyState({
      models: context.models,
      selectedModelId: context.selectedModelId,
      selectedFamily: context.selectedFamily,
      globalDefaultModelId,
      familyDefaults,
    })
  ), [familyDefaults, globalDefaultModelId]);

  const selectFamilyWithMemory = useCallback((family: ModelFamily, context: ModelFamilyPickerContext) => (
    selectFamily({
      family,
      state: resolvePickerState(context),
      familyDefaults,
    })
  ), [familyDefaults, resolvePickerState]);

  const selectModel = useCallback((modelId: string) => (
    selectModelInFamily({ modelId, familyDefaults })
  ), [familyDefaults]);

  const resolveRememberedSelection = useCallback((models: readonly ModelInfo[]) => {
    if (!lastModelFamily) return null;
    return selectFamilyWithMemory(lastModelFamily, {
      models,
      selectedModelId: "",
      selectedFamily: lastModelFamily,
    });
  }, [lastModelFamily, selectFamilyWithMemory]);

  const remember = useCallback(({ modelId, reasoningEffort, contextTier }: RememberModelSelection) => {
    if (!modelId) return;
    const family = getModelFamily(modelId);
    const cachedSettings = queryClient.getQueryData<AppSettings>(queryKeys.settings);
    const currentFamilyDefaults = cachedSettings?.familyDefaults ?? familyDefaults;
    const nextFamilyDefaults = buildFamilyDefaultsPatch({
      current: currentFamilyDefaults,
      modelId,
      reasoningEffort,
      contextTier,
    });
    if (!nextFamilyDefaults && cachedSettings?.lastModelFamily === family) return;

    const mergedFamilyDefaults = nextFamilyDefaults ?? currentFamilyDefaults;
    queryClient.setQueryData<AppSettings>(queryKeys.settings, (current) => (
      current
        ? {
          ...current,
          ...(mergedFamilyDefaults ? { familyDefaults: mergedFamilyDefaults } : {}),
          lastModelFamily: family,
        }
        : current
    ));
    enqueueSettingsPatch({
      ...(mergedFamilyDefaults ? { familyDefaults: mergedFamilyDefaults } : {}),
      lastModelFamily: family,
    });
  }, [familyDefaults]);

  return useMemo<ModelFamilyMemory>(() => ({
    familyDefaults,
    lastModelFamily,
    globalDefaultModelId,
    loading: settingsQuery.isLoading,
    resolvePickerState,
    selectFamily: selectFamilyWithMemory,
    selectModel,
    resolveRememberedSelection,
    remember,
  }), [
    familyDefaults,
    globalDefaultModelId,
    lastModelFamily,
    remember,
    resolvePickerState,
    resolveRememberedSelection,
    selectFamilyWithMemory,
    selectModel,
    settingsQuery.isLoading,
  ]);
}
