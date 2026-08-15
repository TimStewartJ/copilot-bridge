import {
  isCopilotContextTier,
  modelSupportsLongContext,
  type CopilotContextTier,
  type CopilotModelContextMetadata,
} from "../shared/copilot-context.js";

export const MAX_SCHEDULE_AUTO_ARCHIVE_KEEP = 1000;

export type NormalizedScheduleAutoArchiveKeep =
  | { ok: true; value: number | null | undefined }
  | { ok: false; error: string };

export type NormalizedScheduleModel =
  | { ok: true; value: string | null | undefined }
  | { ok: false; error: string };

export type NormalizedScheduleReasoningEffort =
  | { ok: true; value: string | null | undefined }
  | { ok: false; error: string };

export type NormalizedScheduleContextTier =
  | { ok: true; value: CopilotContextTier | null | undefined }
  | { ok: false; error: string };

export interface ScheduleLaunchOptionState {
  model?: string;
  reasoningEffort?: string;
  contextTier?: CopilotContextTier;
}

export interface ScheduleLaunchOptionUpdates {
  model?: string | null;
  reasoningEffort?: string | null;
  contextTier?: CopilotContextTier | null;
}

interface ScheduleLaunchModelInfo extends CopilotModelContextMetadata {
  policy?: { state?: string };
}

type ScheduleLaunchOptionValidationResult =
  | { ok: true; updates: ScheduleLaunchOptionUpdates }
  | { ok: false; error: string; status: 400 | 503 };

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

export function normalizeScheduleModel(value: unknown): NormalizedScheduleModel {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string") {
    return { ok: false, error: "model must be a string or null" };
  }

  const normalized = value.trim();
  return { ok: true, value: normalized || null };
}

export function normalizeScheduleReasoningEffort(value: unknown): NormalizedScheduleReasoningEffort {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string") {
    return { ok: false, error: "reasoningEffort must be a string or null" };
  }

  const normalized = value.trim();
  return { ok: true, value: normalized || null };
}

export function normalizeScheduleContextTier(value: unknown): NormalizedScheduleContextTier {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null || value === "") return { ok: true, value: null };
  if (!isCopilotContextTier(value)) {
    return { ok: false, error: "contextTier must be default, long_context, or null" };
  }
  return { ok: true, value };
}

export async function validateScheduleLaunchOptionUpdates({
  input,
  existing,
  listModels,
}: {
  input: Record<string, unknown>;
  existing?: ScheduleLaunchOptionState;
  listModels: () => Promise<readonly ScheduleLaunchModelInfo[]>;
}): Promise<ScheduleLaunchOptionValidationResult> {
  const modelProvided = Object.prototype.hasOwnProperty.call(input, "model");
  const reasoningEffortProvided = Object.prototype.hasOwnProperty.call(input, "reasoningEffort");
  const contextTierProvided = Object.prototype.hasOwnProperty.call(input, "contextTier");

  const normalizedModel = normalizeScheduleModel(input.model);
  if (!normalizedModel.ok) return { ...normalizedModel, status: 400 };
  const normalizedReasoningEffort = normalizeScheduleReasoningEffort(input.reasoningEffort);
  if (!normalizedReasoningEffort.ok) return { ...normalizedReasoningEffort, status: 400 };
  const normalizedContextTier = normalizeScheduleContextTier(input.contextTier);
  if (!normalizedContextTier.ok) return { ...normalizedContextTier, status: 400 };

  const updates: ScheduleLaunchOptionUpdates = {
    ...(modelProvided ? { model: normalizedModel.value } : {}),
    ...(reasoningEffortProvided ? { reasoningEffort: normalizedReasoningEffort.value } : {}),
    ...(contextTierProvided ? { contextTier: normalizedContextTier.value } : {}),
  };
  const nextModel = modelProvided ? normalizedModel.value ?? undefined : existing?.model;
  let nextReasoningEffort = reasoningEffortProvided
    ? normalizedReasoningEffort.value ?? undefined
    : existing?.reasoningEffort;
  let nextContextTier = contextTierProvided
    ? normalizedContextTier.value ?? undefined
    : existing?.contextTier;

  const modelChanged = modelProvided && nextModel !== existing?.model;
  if (modelChanged) {
    if (!reasoningEffortProvided) {
      nextReasoningEffort = undefined;
      updates.reasoningEffort = null;
    }
    if (!contextTierProvided) {
      nextContextTier = undefined;
      updates.contextTier = null;
    }
  }

  if (!nextModel && (nextReasoningEffort || nextContextTier)) {
    return {
      ok: false,
      error: "A schedule model is required to set reasoningEffort or contextTier",
      status: 400,
    };
  }

  const validateReasoningEffort = reasoningEffortProvided && Boolean(nextReasoningEffort);
  const validateContextTier = contextTierProvided && Boolean(nextContextTier);
  if (!validateReasoningEffort && !validateContextTier) {
    return { ok: true, updates };
  }

  let models: readonly ScheduleLaunchModelInfo[];
  try {
    models = await listModels();
  } catch {
    return {
      ok: false,
      error: "Unable to validate the requested schedule model options",
      status: 503,
    };
  }

  const selected = models.find((candidate) => candidate.id === nextModel);
  if (!selected) {
    return { ok: false, error: `Model is not available: ${nextModel}`, status: 400 };
  }
  if (selected.policy?.state === "disabled") {
    return { ok: false, error: `Model is disabled by policy: ${nextModel}`, status: 400 };
  }
  if (
    validateReasoningEffort
    && !selected.supportedReasoningEfforts?.includes(nextReasoningEffort!)
  ) {
    const available = selected.supportedReasoningEfforts ?? [];
    return {
      ok: false,
      error: available.length > 0
        ? `reasoningEffort must be one of: ${available.join(", ")}`
        : `Model does not expose configurable reasoning effort: ${nextModel}`,
      status: 400,
    };
  }
  if (nextContextTier === "long_context" && !modelSupportsLongContext(selected)) {
    return {
      ok: false,
      error: `Model does not support long context: ${nextModel}`,
      status: 400,
    };
  }

  return { ok: true, updates };
}
