import type { AppSettings, AppSettingsUpdates } from "../api";

function comparableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(comparableValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => [key, comparableValue(item)]));
  }
  return value;
}

/** Whether two setting values are the same, ignoring key order and undefined members. */
export function sameSettingValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(comparableValue(left)) === JSON.stringify(comparableValue(right));
}

/** Independently saved settings and untouched fields must not be written back from an old draft. */
export function getSettingsDraftUpdates(saved: AppSettings, draft: AppSettings): AppSettingsUpdates {
  const updates: Partial<AppSettings> = {};
  const copyChanged = <K extends keyof AppSettings>(key: K) => {
    if (key === "mcpServers") return;
    if (!sameSettingValue(saved[key], draft[key])) updates[key] = draft[key];
  };
  for (const key of Object.keys({ ...saved, ...draft }) as Array<keyof AppSettings>) copyChanged(key);
  return updates;
}

/**
 * Apply what a section changed, relative to the settings it was rendered with, onto the latest
 * settings. A section that built its update from an older render cannot put back a value that
 * changed since in some other key.
 */
export function applySettingsChanges(base: AppSettings, next: AppSettings, current: AppSettings): AppSettings {
  const result = { ...current } as Record<string, unknown>;
  for (const key of Object.keys({ ...base, ...next }) as Array<keyof AppSettings>) {
    if (key === "mcpServers") continue;
    if (!sameSettingValue(base[key], next[key])) result[key] = next[key];
  }
  return result as unknown as AppSettings;
}
