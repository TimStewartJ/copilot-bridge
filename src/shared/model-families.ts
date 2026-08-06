// Model families — shared by the client picker and the server settings store.

export type ModelFamily = "gpt" | "claude" | "other";

export const MODEL_FAMILIES = ["gpt", "claude", "other"] as const satisfies readonly ModelFamily[];

export function isModelFamily(value: unknown): value is ModelFamily {
  return value === "gpt" || value === "claude" || value === "other";
}

/**
 * Families are derived from the model id prefix rather than a curated list so
 * newly entitled models land in a sensible group without a code change.
 */
export function getModelFamily(modelId: string): ModelFamily {
  const id = modelId.trim().toLowerCase();
  if (id.startsWith("gpt-") || id === "gpt") return "gpt";
  if (id.startsWith("claude-") || id === "claude") return "claude";
  return "other";
}

export function getModelFamilyLabel(family: ModelFamily): string {
  switch (family) {
    case "gpt":
      return "GPT";
    case "claude":
      return "Claude";
    default:
      return "Other";
  }
}
