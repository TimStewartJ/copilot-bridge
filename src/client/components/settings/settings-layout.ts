export type CategoryId = "general" | "integrations" | "updates" | "usage" | "diagnostics";

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
    sections: ["system-prompt", "model", "reasoning-effort", "appearance", "notifications", "device-management"],
  },
  {
    id: "integrations",
    label: "Integrations",
    sections: ["providers", "tags", "mcp-servers", "skills"],
  },
  {
    id: "updates",
    label: "Updates & Deployment",
    sections: ["updates", "management-jobs", "bridge-status"],
  },
  {
    id: "diagnostics",
    label: "Diagnostics",
    sections: ["browser-diagnostics", "voice-input"],
  },
  {
    id: "usage",
    label: "Copilot Usage",
    sections: ["local-copilot-usage"],
  },
];

export const DEFAULT_CATEGORY: CategoryId = "general";

/** Retired category ids kept so existing `?group=` deep links still resolve. */
const CATEGORY_ALIASES: Record<string, CategoryId> = {
  management: "updates",
};

const VALID_CATEGORY_IDS = new Set<string>(SETTINGS_CATEGORIES.map((c) => c.id));

/** Normalizes an unknown/invalid group search param value to the default category. */
export function normalizeCategory(value: string | null | undefined): CategoryId {
  if (value && VALID_CATEGORY_IDS.has(value)) {
    return value as CategoryId;
  }
  if (value && CATEGORY_ALIASES[value]) {
    return CATEGORY_ALIASES[value];
  }
  return DEFAULT_CATEGORY;
}

/** Returns the CategoryMeta for a given id, or undefined if not found. */
export function getCategoryMeta(id: CategoryId): CategoryMeta | undefined {
  return SETTINGS_CATEGORIES.find((c) => c.id === id);
}
