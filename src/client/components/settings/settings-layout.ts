export type CategoryId = "general" | "integrations" | "voice" | "updates" | "usage" | "diagnostics";

export type SectionId =
  | "system-prompt"
  | "model"
  | "reasoning-effort"
  | "appearance"
  | "notifications"
  | "device-management"
  | "defer-worker"
  | "computer-use"
  | "providers"
  | "tags"
  | "mcp-servers"
  | "skills"
  | "speech-engine"
  | "management-jobs"
  | "browser-diagnostics"
  | "updates"
  | "bridge-status"
  | "local-copilot-usage";

export interface CategoryMeta {
  id: CategoryId;
  label: string;
  sections: SectionId[];
  description?: string;
}

export const SETTINGS_CATEGORIES: CategoryMeta[] = [
  {
    id: "general",
    label: "General",
    description: "Defaults for new chats, response preferences, and this device.",
    sections: ["model", "reasoning-effort", "system-prompt", "appearance", "notifications", "device-management", "defer-worker"],
  },
  {
    id: "integrations",
    label: "Integrations",
    description: "Connected services, tools, skills, and shared tags.",
    sections: ["providers", "mcp-servers", "computer-use", "skills", "tags"],
  },
  {
    id: "voice",
    label: "Voice",
    description: "Speech recognition and hands-free audio on the Bridge host.",
    sections: ["speech-engine"],
  },
  {
    id: "updates",
    label: "Updates & Deployment",
    description: "Software updates, background jobs, and host operations.",
    sections: ["updates", "management-jobs", "bridge-status"],
  },
  {
    id: "diagnostics",
    label: "Diagnostics",
    description: "Inspect browser health and troubleshoot connections.",
    sections: ["browser-diagnostics"],
  },
  {
    id: "usage",
    label: "Copilot Usage",
    description: "Local usage estimates and SDK-reported metering.",
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
