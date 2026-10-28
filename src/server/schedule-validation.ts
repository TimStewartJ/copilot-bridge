import { isPromptProfileId, type PromptProfileId } from "../shared/prompt-profiles.js";
import { isModelPresetSlot, type ModelPresetSlot } from "../shared/model-presets.js";

export const MAX_SCHEDULE_AUTO_ARCHIVE_KEEP = 1000;

export type NormalizedScheduleAutoArchiveKeep =
  | { ok: true; value: number | null | undefined }
  | { ok: false; error: string };

export interface ScheduleLaunchOptionUpdates {
  /** A tier from Settings › Models; null follows New chats. */
  modelTier?: ModelPresetSlot | null;
  promptProfile?: PromptProfileId | null;
}

export type ScheduleLaunchOptionValidationResult =
  | { ok: true; updates: ScheduleLaunchOptionUpdates }
  | { ok: false; error: string };

export function findUnknownFields(input: unknown, allowedFields: readonly string[]): string[] {
  if (!input || typeof input !== "object" || Array.isArray(input)) return [];
  const allowed = new Set(allowedFields);
  return Object.keys(input as Record<string, unknown>)
    .filter((key) => !allowed.has(key))
    .sort();
}

export function formatUnknownFieldsError(fields: readonly string[]): string {
  return fields.length === 1
    ? `Unknown field: "${fields[0]}"`
    : `Unknown fields: ${fields.map((field) => `"${field}"`).join(", ")}`;
}

export function normalizeScheduleAutoArchiveKeep(value: unknown): NormalizedScheduleAutoArchiveKeep {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null || value === "") return { ok: true, value: null };

  const parsed = typeof value === "number"
    ? value
    : typeof value === "string" && /^\d+$/.test(value.trim())
      ? Number(value)
      : NaN;

  if (!Number.isInteger(parsed) || parsed < 1 || parsed > MAX_SCHEDULE_AUTO_ARCHIVE_KEEP) {
    return {
      ok: false,
      error: `autoArchiveKeep must be a positive integer no greater than ${MAX_SCHEDULE_AUTO_ARCHIVE_KEEP}`,
    };
  }

  return { ok: true, value: parsed };
}

/** Reads the provided model tier and prompt profile; absent fields stay out of the updates. */
export function validateScheduleLaunchOptions(input: Record<string, unknown>): ScheduleLaunchOptionValidationResult {
  const updates: ScheduleLaunchOptionUpdates = {};
  if (Object.prototype.hasOwnProperty.call(input, "modelTier")) {
    const value = input.modelTier;
    if (value === null || value === "") updates.modelTier = null;
    else if (isModelPresetSlot(value)) updates.modelTier = value;
    else return { ok: false, error: "modelTier must be preset1, preset2, preset3, or null" };
  }
  if (Object.prototype.hasOwnProperty.call(input, "promptProfile")) {
    const value = input.promptProfile;
    if (value === null || value === "") updates.promptProfile = null;
    else if (isPromptProfileId(value)) updates.promptProfile = value;
    else return { ok: false, error: "promptProfile must be engineer, assistant, monitor, or null" };
  }
  return { ok: true, updates };
}
