export type CategoryId =
  | "chat"
  | "responses"
  | "appearance"
  | "device"
  | "integrations"
  | "tags"
  | "voice"
  | "system"
  | "usage";

export interface CategoryMeta {
  id: CategoryId;
  label: string;
  /** Categories in one nav group are listed together; a hairline separates the groups. */
  group: "preferences" | "connections" | "host";
}

export const SETTINGS_CATEGORIES: CategoryMeta[] = [
  { id: "chat", label: "Chat", group: "preferences" },
  { id: "responses", label: "Responses", group: "preferences" },
  { id: "appearance", label: "Appearance", group: "preferences" },
  { id: "device", label: "Notifications & device", group: "preferences" },
  { id: "integrations", label: "Integrations", group: "connections" },
  { id: "tags", label: "Tags", group: "connections" },
  { id: "voice", label: "Voice", group: "connections" },
  { id: "system", label: "System", group: "host" },
  { id: "usage", label: "Copilot usage", group: "host" },
];

export const DEFAULT_CATEGORY: CategoryId = "chat";

/** Parts of the System page a link can open directly with `?section=`. */
export type SystemSectionId = "updates" | "jobs" | "browser" | "version";

/** Retired category ids kept so existing `?group=` deep links and remembered categories still resolve. */
const CATEGORY_ALIASES: Record<string, CategoryId> = {
  general: "chat",
  management: "system",
  updates: "system",
  diagnostics: "system",
};

/** Where on the System page a retired category's content now lives. */
const LEGACY_SECTIONS: Record<string, SystemSectionId> = {
  management: "jobs",
  updates: "updates",
  diagnostics: "browser",
};

/** The System section a retired `?group=` link pointed at, if any. */
export function legacySectionFor(value: string | null | undefined): SystemSectionId | undefined {
  return value ? LEGACY_SECTIONS[value] : undefined;
}

export function normalizeSystemSection(value: string | null | undefined): SystemSectionId | undefined {
  return value === "updates" || value === "jobs" || value === "browser" || value === "version" ? value : undefined;
}

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
