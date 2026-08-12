import type {
  ModelFamilyDefault,
  ModelFamilyDefaults,
  ModelInfo,
} from "../api";
import type { CopilotContextTier } from "../../shared/copilot-context.js";
import {
  MODEL_FAMILIES,
  getModelFamily,
  getModelFamilyLabel,
  type ModelFamily,
} from "../../shared/model-families.js";

export interface ModelFamilyTile {
  family: ModelFamily;
  label: string;
  /** Undefined when the family has no selectable models. */
  model?: ModelInfo;
  /** The family the current selection belongs to. */
  isLive: boolean;
  /** This tile is showing the Bridge-wide default model. */
  isGlobalDefault: boolean;
}

export interface ModelFamilyPickerState {
  tiles: ModelFamilyTile[];
  liveFamily: ModelFamily;
  modelsByFamily: Record<ModelFamily, ModelInfo[]>;
}

export interface ModelFamilySelection {
  modelId: string;
  reasoningEffort?: string;
  contextTier?: CopilotContextTier;
}

interface ResolveModelFamilyStateOptions {
  models: readonly ModelInfo[];
  selectedModelId: string;
  selectedFamily?: ModelFamily;
  globalDefaultModelId?: string;
  familyDefaults?: ModelFamilyDefaults;
}

function emptyModelsByFamily(): Record<ModelFamily, ModelInfo[]> {
  return { gpt: [], claude: [], other: [] };
}

/**
 * Groups selectable models by family, preserving the order the API returned so
 * each family's flagship stays first.
 */
export function groupModelsByFamily(
  models: readonly ModelInfo[],
): Record<ModelFamily, ModelInfo[]> {
  const grouped = emptyModelsByFamily();
  for (const model of models) {
    if (model.policy?.state === "disabled") continue;
    grouped[getModelFamily(model.id)].push(model);
  }
  return grouped;
}

/**
 * The model a family tile shows. The live selection wins so the tile always
 * reflects reality, then sticky memory, then the global default, then the
 * family's first model.
 */
function resolveFamilyModel(
  family: ModelFamily,
  familyModels: readonly ModelInfo[],
  selectedModelId: string,
  globalDefaultModelId: string | undefined,
  familyDefaults: ModelFamilyDefaults | undefined,
): ModelInfo | undefined {
  if (familyModels.length === 0) return undefined;

  if (selectedModelId && getModelFamily(selectedModelId) === family) {
    const selected = familyModels.find((model) => model.id === selectedModelId);
    if (selected) return selected;
  }

  const remembered = familyDefaults?.[family]?.model;
  if (remembered) {
    const rememberedModel = familyModels.find((model) => model.id === remembered);
    if (rememberedModel) return rememberedModel;
  }

  if (globalDefaultModelId && getModelFamily(globalDefaultModelId) === family) {
    const globalModel = familyModels.find((model) => model.id === globalDefaultModelId);
    if (globalModel) return globalModel;
  }

  return familyModels[0];
}

function resolveLiveFamily(
  selectedModelId: string,
  selectedFamily: ModelFamily | undefined,
  globalDefaultModelId: string | undefined,
  modelsByFamily: Record<ModelFamily, ModelInfo[]>,
): ModelFamily {
  // Family is derived from the raw id so an unlisted model still lands somewhere.
  if (selectedModelId) return getModelFamily(selectedModelId);
  if (selectedFamily && modelsByFamily[selectedFamily].length > 0) return selectedFamily;
  if (globalDefaultModelId) return getModelFamily(globalDefaultModelId);
  const firstPopulated = MODEL_FAMILIES.find((family) => modelsByFamily[family].length > 0);
  return firstPopulated ?? "other";
}

export function resolveModelFamilyState({
  models,
  selectedModelId,
  selectedFamily,
  globalDefaultModelId,
  familyDefaults,
}: ResolveModelFamilyStateOptions): ModelFamilyPickerState {
  const modelsByFamily = groupModelsByFamily(models);
  const liveFamily = resolveLiveFamily(
    selectedModelId,
    selectedFamily,
    globalDefaultModelId,
    modelsByFamily,
  );

  const tiles = MODEL_FAMILIES.map<ModelFamilyTile>((family) => {
    const model = resolveFamilyModel(
      family,
      modelsByFamily[family],
      selectedModelId,
      globalDefaultModelId,
      familyDefaults,
    );
    return {
      family,
      label: getModelFamilyLabel(family),
      model,
      isLive: family === liveFamily,
      isGlobalDefault: Boolean(model && globalDefaultModelId && model.id === globalDefaultModelId),
    };
  });

  return { tiles, liveFamily, modelsByFamily };
}

export function selectModelInFamily({
  modelId,
  familyDefaults,
}: {
  modelId: string;
  familyDefaults?: ModelFamilyDefaults;
}): ModelFamilySelection {
  const remembered = familyDefaults?.[getModelFamily(modelId)];
  const matchesRemembered = remembered?.model === modelId;
  return {
    modelId,
    ...(matchesRemembered && remembered.reasoningEffort
      ? { reasoningEffort: remembered.reasoningEffort }
      : {}),
    ...(matchesRemembered && remembered.contextTier
      ? { contextTier: remembered.contextTier }
      : {}),
  };
}

/** Selection produced by clicking a family tile rather than a menu entry. */
export function selectFamily({
  family,
  state,
  familyDefaults,
}: {
  family: ModelFamily;
  state: ModelFamilyPickerState;
  familyDefaults?: ModelFamilyDefaults;
}): ModelFamilySelection | null {
  const tile = state.tiles.find((candidate) => candidate.family === family);
  if (!tile?.model) return null;
  return selectModelInFamily({ modelId: tile.model.id, familyDefaults });
}

function sameFamilyDefault(
  left: ModelFamilyDefault | undefined,
  right: ModelFamilyDefault,
): boolean {
  return left?.model === right.model
    && left?.reasoningEffort === right.reasoningEffort
    && left?.contextTier === right.contextTier;
}

export function buildFamilyDefaultsPatch({
  current,
  modelId,
  reasoningEffort,
  contextTier,
}: {
  current: ModelFamilyDefaults | undefined;
  modelId: string;
  reasoningEffort?: string;
  contextTier?: CopilotContextTier;
}): ModelFamilyDefaults | null {
  if (!modelId) return null;
  const family = getModelFamily(modelId);
  const next: ModelFamilyDefault = {
    model: modelId,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(contextTier ? { contextTier } : {}),
  };
  if (sameFamilyDefault(current?.[family], next)) return null;
  return { ...(current ?? {}), [family]: next };
}
