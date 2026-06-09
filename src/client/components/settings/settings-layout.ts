export type CategoryId = "general" | "integrations" | "management" | "usage" | "diagnostics";

export type SectionId =
  | "system-prompt"
  | "model"
  | "reasoning-effort"
  | "appearance"
  | "notifications"
  | "device-management"
  | "providers"
  | "tags"
  | "mcp-servers"
  | "skills"
  | "voice-input"
  | "management-jobs"
  | "browser-diagnostics"
  | "updates"
  | "bridge-status"
  | "local-copilot-usage";

export interface CategoryMeta {
  id: CategoryId;
  label: string;
  sections: SectionId[];
}

export const SETTINGS_CATEGORIES: CategoryMeta[] = [
  {
    id: "general",
    label: "General",
    sections: ["updates", "system-prompt", "model", "reasoning-effort", "appearance", "notifications", "device-management"],
  },
  {
    id: "integrations",
    label: "Integrations",
    sections: ["providers", "tags", "mcp-servers", "skills"],
  },
  {
    id: "diagnostics",
    label: "Diagnostics",
    sections: ["bridge-status", "browser-diagnostics", "voice-input"],
  },
  {
    id: "management",
    label: "Management",
    sections: ["management-jobs"],
  },
  {
    id: "usage",
    label: "Copilot Usage",
    sections: ["local-copilot-usage"],
  },
];

export const DEFAULT_CATEGORY: CategoryId = "general";

const VALID_CATEGORY_IDS = new Set<string>(SETTINGS_CATEGORIES.map((c) => c.id));

/** Normalizes an unknown/invalid group search param value to the default category. */
export function normalizeCategory(value: string | null | undefined): CategoryId {
  if (value && VALID_CATEGORY_IDS.has(value)) {
    return value as CategoryId;
  }
  return DEFAULT_CATEGORY;
}

/** Returns the CategoryMeta for a given id, or undefined if not found. */
export function getCategoryMeta(id: CategoryId): CategoryMeta | undefined {
  return SETTINGS_CATEGORIES.find((c) => c.id === id);
}
