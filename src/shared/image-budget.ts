/** Early compaction for models whose provider rejects large requests; see src/server/image-budget.ts. */
export interface ImageBudgetSettings {
  /** Unset means on. */
  enabled?: boolean;
  /** Request ceiling in MB (10^6 bytes) by model id pattern; `*` matches any run of characters. */
  ceilingsMb?: Record<string, number>;
}

/** Measured 2026-09-27: Claude models served through Google Vertex reject requests over about 30.0 MB. */
export const DEFAULT_IMAGE_CEILINGS_MB: Readonly<Record<string, number>> = Object.freeze({ "claude-*": 30 });

/** Share of the ceiling at which a turn is paused and compacted; the rest absorbs images added before a tool boundary. */
export const IMAGE_BUDGET_COMPACT_FRACTION = 2 / 3;

export const IMAGE_BUDGET_MAX_CEILING_MB = 1_000;
export const IMAGE_BUDGET_MODEL_PATTERN = /^[A-Za-z0-9._:*-]{1,100}$/;

export function imageCeilingsMb(settings: ImageBudgetSettings | undefined): Record<string, number> {
  if (settings?.enabled === false) return {};
  return settings?.ceilingsMb ?? DEFAULT_IMAGE_CEILINGS_MB;
}

/** The compaction threshold in bytes for a model, or undefined when the model has no ceiling. */
export function imageCompactAtBytes(model: string | undefined, settings: ImageBudgetSettings | undefined): number | undefined {
  if (!model) return undefined;
  for (const [pattern, mb] of Object.entries(imageCeilingsMb(settings))) {
    const source = pattern.split("*").map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*");
    if (new RegExp(`^${source}$`, "i").test(model)) return Math.floor(mb * 1_000_000 * IMAGE_BUDGET_COMPACT_FRACTION);
  }
  return undefined;
}
