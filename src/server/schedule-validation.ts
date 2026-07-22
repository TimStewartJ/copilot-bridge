export const MAX_SCHEDULE_AUTO_ARCHIVE_KEEP = 1000;

export type NormalizedScheduleAutoArchiveKeep =
  | { ok: true; value: number | null | undefined }
  | { ok: false; error: string };

export type NormalizedScheduleModel =
  | { ok: true; value: string | null | undefined }
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

export function normalizeScheduleModel(value: unknown): NormalizedScheduleModel {
  if (value === undefined) return { ok: true, value: undefined };
  if (value === null) return { ok: true, value: null };
  if (typeof value !== "string") {
    return { ok: false, error: "model must be a string or null" };
  }

  const normalized = value.trim();
  return { ok: true, value: normalized || null };
}
