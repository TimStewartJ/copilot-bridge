import type {
  ModelFamilyDefaults,
  ModelInfo,
  ModelPreset,
  ModelPresets,
} from "../api";
import {
  DEFAULT_MODEL_PRESET_FAMILIES,
  MODEL_PRESET_SLOTS,
  getModelPresetSlotForFamily,
  getModelPresetSlotLabel,
  type ModelPresetSlot,
} from "../../shared/model-presets.js";
import { getModelFamily } from "../../shared/model-families.js";
import type { CopilotContextTier } from "../../shared/copilot-context.js";

export interface ModelPresetTile {
  slot: ModelPresetSlot;
  label: string;
  model?: ModelInfo;
  isLive: boolean;
}

export interface ModelPresetPickerState {
  tiles: ModelPresetTile[];
  liveSlot?: ModelPresetSlot;
  availableModels: ModelInfo[];
}

export interface ModelPresetSelection {
  slot: ModelPresetSlot;
  modelId: string;
  reasoningEffort?: string;
  contextTier?: CopilotContextTier;
}

interface ResolveModelPresetStateOptions {
  models: readonly ModelInfo[];
  selectedModelId: string;
  selectedPresetSlot?: ModelPresetSlot;
  globalDefaultModelId?: string;
  presets?: ModelPresets;
}

export function migrateLegacyFamilyDefaults(
  familyDefaults: ModelFamilyDefaults | undefined,
): ModelPresets | undefined {
  if (!familyDefaults) return undefined;
  const presets: ModelPresets = {};
  for (const [family, preset] of Object.entries(familyDefaults)) {
    if (preset) presets[getModelPresetSlotForFamily(family as keyof ModelFamilyDefaults)] = preset;
  }
  return Object.keys(presets).length > 0 ? presets : undefined;
}

export function mergeStoredModelPresets(
  modelPresets: ModelPresets | undefined,
  familyDefaults: ModelFamilyDefaults | undefined,
): ModelPresets | undefined {
  const legacy = migrateLegacyFamilyDefaults(familyDefaults);
  if (!legacy) return modelPresets;
  if (!modelPresets) return legacy;
  return { ...legacy, ...modelPresets };
}

function getAvailableModels(models: readonly ModelInfo[]): ModelInfo[] {
  return models.filter((model) => model.policy?.state !== "disabled");
}

function resolveFallbackModel(
  slot: ModelPresetSlot,
  availableModels: readonly ModelInfo[],
  globalDefaultModelId: string | undefined,
): ModelInfo | undefined {
  const defaultFamily = DEFAULT_MODEL_PRESET_FAMILIES[slot];
  const familyModels = availableModels.filter((model) => getModelFamily(model.id) === defaultFamily);
  if (globalDefaultModelId && getModelFamily(globalDefaultModelId) === defaultFamily) {
    const globalDefault = familyModels.find((model) => model.id === globalDefaultModelId);
    if (globalDefault) return globalDefault;
  }
  return familyModels[0] ?? availableModels[0];
}

export function resolveModelPresetState({
  models,
  selectedModelId,
  selectedPresetSlot,
  globalDefaultModelId,
  presets,
}: ResolveModelPresetStateOptions): ModelPresetPickerState {
  const availableModels = getAvailableModels(models);
  const tiles = MODEL_PRESET_SLOTS.map<ModelPresetTile>((slot) => {
    const selectedOverride = selectedPresetSlot === slot
      ? availableModels.find((model) => model.id === selectedModelId)
      : undefined;
    const remembered = presets?.[slot]?.model
      ? availableModels.find((model) => model.id === presets[slot]?.model)
      : undefined;
    return {
      slot,
      label: getModelPresetSlotLabel(slot),
      model: selectedOverride
        ?? remembered
        ?? resolveFallbackModel(slot, availableModels, globalDefaultModelId),
      isLive: false,
    };
  });
  const liveSlot = selectedPresetSlot
    ?? (selectedModelId
      ? tiles.find((tile) => tile.model?.id === selectedModelId)?.slot
      : globalDefaultModelId
        ? tiles.find((tile) => tile.model?.id === globalDefaultModelId)?.slot
        : undefined);
  for (const tile of tiles) tile.isLive = tile.slot === liveSlot;
  return { tiles, liveSlot, availableModels };
}

function selectionFromPreset(
  slot: ModelPresetSlot,
  modelId: string,
  preset: ModelPreset | undefined,
): ModelPresetSelection {
  const matchesRemembered = preset?.model === modelId;
  return {
    slot,
    modelId,
    ...(matchesRemembered && preset.reasoningEffort
      ? { reasoningEffort: preset.reasoningEffort }
      : {}),
    ...(matchesRemembered && preset.contextTier
      ? { contextTier: preset.contextTier }
      : {}),
  };
}

export function selectPreset({
  slot,
  state,
  presets,
}: {
  slot: ModelPresetSlot;
  state: ModelPresetPickerState;
  presets?: ModelPresets;
}): ModelPresetSelection | null {
  const tile = state.tiles.find((candidate) => candidate.slot === slot);
  if (!tile?.model) return null;
  return selectionFromPreset(slot, tile.model.id, presets?.[slot]);
}

export function selectModelInPreset({
  slot,
  modelId,
  presets,
}: {
  slot: ModelPresetSlot;
  modelId: string;
  presets?: ModelPresets;
}): ModelPresetSelection {
  return selectionFromPreset(slot, modelId, presets?.[slot]);
}

export function findPresetSlotForModel({
  modelId,
  models,
  presets,
  globalDefaultModelId,
  preferredSlot,
}: {
  modelId: string;
  models: readonly ModelInfo[];
  presets?: ModelPresets;
  globalDefaultModelId?: string;
  preferredSlot?: ModelPresetSlot;
}): ModelPresetSlot | undefined {
  if (!modelId) return undefined;
  const state = resolveModelPresetState({
    models,
    selectedModelId: "",
    globalDefaultModelId,
    presets,
  });
  if (preferredSlot && state.tiles.find((tile) => tile.slot === preferredSlot)?.model?.id === modelId) {
    return preferredSlot;
  }
  return state.tiles.find((tile) => tile.model?.id === modelId)?.slot;
}

function samePreset(left: ModelPreset | undefined, right: ModelPreset): boolean {
  return left?.model === right.model
    && left?.reasoningEffort === right.reasoningEffort
    && left?.contextTier === right.contextTier;
}

export function buildModelPresetsPatch({
  current,
  slot,
  modelId,
  reasoningEffort,
  contextTier,
}: {
  current: ModelPresets | undefined;
  slot: ModelPresetSlot;
  modelId: string;
  reasoningEffort?: string;
  contextTier?: CopilotContextTier;
}): ModelPresets | null {
  if (!modelId) return null;
  const next: ModelPreset = {
    model: modelId,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(contextTier ? { contextTier } : {}),
  };
  if (samePreset(current?.[slot], next)) return null;
  return { ...(current ?? {}), [slot]: next };
}
