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

/** Independently saved settings and untouched fields must not be written back from an old draft. */
export function getSettingsDraftUpdates(saved: AppSettings, draft: AppSettings): AppSettingsUpdates {
  const updates: Partial<AppSettings> = {};
  const copyChanged = <K extends keyof AppSettings>(key: K) => {
    if (key === "mcpServers") return;
    if (JSON.stringify(comparableValue(saved[key])) !== JSON.stringify(comparableValue(draft[key]))) updates[key] = draft[key];
  };
  for (const key of Object.keys({ ...saved, ...draft }) as Array<keyof AppSettings>) copyChanged(key);
  return updates;
}
