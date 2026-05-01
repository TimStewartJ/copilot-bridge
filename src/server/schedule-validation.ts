export const MAX_SCHEDULE_AUTO_ARCHIVE_KEEP = 1000;

export type NormalizedScheduleAutoArchiveKeep =
  | { ok: true; value: number | null | undefined }
  | { ok: false; error: string };

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
