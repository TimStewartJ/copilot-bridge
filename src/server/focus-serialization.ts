import type { FocusObject } from "./focus-domain-store.js";
import type { FocusHistoryEntry } from "./focus-dashboard-projection.js";

export function serializeFocusObject(object: FocusObject) {
  const { action, kind: _legacyKind, ...rest } = object;
  return { ...rest, launchPrompt: action };
}

export function serializeFocusHistoryPage(page: { objects: FocusHistoryEntry[]; total: number; nextOffset: number | null }) {
  return {
    ...page,
    objects: page.objects.map((entry) => ({
      ...entry,
      object: entry.object && "objectType" in entry.object ? serializeFocusObject(entry.object) : entry.object,
    })),
  };
}
