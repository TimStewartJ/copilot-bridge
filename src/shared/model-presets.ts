import type { ModelFamily } from "./model-families.js";

export type ModelPresetSlot = "preset1" | "preset2" | "preset3";

export const MODEL_PRESET_SLOTS = [
  "preset1",
  "preset2",
  "preset3",
] as const satisfies readonly ModelPresetSlot[];

export const DEFAULT_MODEL_PRESET_FAMILIES: Readonly<Record<ModelPresetSlot, ModelFamily>> = {
  preset1: "gpt",
  preset2: "claude",
  preset3: "other",
};

export function isModelPresetSlot(value: unknown): value is ModelPresetSlot {
  return value === "preset1" || value === "preset2" || value === "preset3";
}

export function getModelPresetSlotLabel(slot: ModelPresetSlot): string {
  switch (slot) {
    case "preset1":
      return "Preset 1";
    case "preset2":
      return "Preset 2";
    default:
      return "Preset 3";
  }
}

export function getModelPresetSlotForFamily(family: ModelFamily): ModelPresetSlot {
  switch (family) {
    case "gpt":
      return "preset1";
    case "claude":
      return "preset2";
    default:
      return "preset3";
  }
}
