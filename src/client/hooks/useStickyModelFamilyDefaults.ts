import { useCallback } from "react";
import {
  patchSettings,
  type AppSettings,
  type ModelFamilyDefaults,
} from "../api";
import { buildFamilyDefaultsPatch } from "../lib/model-family-defaults";
import { queryClient, queryKeys } from "../queryClient";
import type { CopilotContextTier } from "../../shared/copilot-context.js";
import { getModelFamily } from "../../shared/model-families.js";

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
      console.error("[model-family] Failed to remember launch defaults", error);
      if (writeId === latestSettingsWrite) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.settings });
      }
    }
  });
}

export function useStickyModelFamilyDefaults(
  fallbackFamilyDefaults?: ModelFamilyDefaults,
) {
  return useCallback(({
    modelId,
    reasoningEffort,
    contextTier,
  }: {
    modelId: string;
    reasoningEffort?: string;
    contextTier?: CopilotContextTier;
  }) => {
    if (!modelId) return;
    const family = getModelFamily(modelId);
    const cachedSettings = queryClient.getQueryData<AppSettings>(queryKeys.settings);
    const currentFamilyDefaults = cachedSettings?.familyDefaults ?? fallbackFamilyDefaults;
    const nextFamilyDefaults = buildFamilyDefaultsPatch({
      current: currentFamilyDefaults,
      modelId,
      reasoningEffort,
      contextTier,
    });
    if (!nextFamilyDefaults && cachedSettings?.lastModelFamily === family) return;

    const familyDefaults = nextFamilyDefaults ?? currentFamilyDefaults;
    queryClient.setQueryData<AppSettings>(queryKeys.settings, (current) => (
      current
        ? {
          ...current,
          ...(familyDefaults ? { familyDefaults } : {}),
          lastModelFamily: family,
        }
        : current
    ));
    enqueueSettingsPatch({
      ...(familyDefaults ? { familyDefaults } : {}),
      lastModelFamily: family,
    });
  }, [fallbackFamilyDefaults]);
}
