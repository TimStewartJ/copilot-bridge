import {
  DEFAULT_CATEGORY,
  normalizeCategory,
  type CategoryId,
} from "../components/settings/settings-layout";

export const LAST_SETTINGS_CATEGORY_KEY = "bridge-last-settings-category";

export function getLastSettingsCategory(): CategoryId {
  try {
    return normalizeCategory(localStorage.getItem(LAST_SETTINGS_CATEGORY_KEY));
  } catch {
    return DEFAULT_CATEGORY;
  }
}

export function setLastSettingsCategory(category: CategoryId): void {
  try {
    localStorage.setItem(LAST_SETTINGS_CATEGORY_KEY, category);
  } catch {}
}
