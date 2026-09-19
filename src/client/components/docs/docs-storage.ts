/**
 * Small, failure-tolerant localStorage layer for the Docs view: layout preferences, per-collection
 * sort, and unsaved editor drafts. Storage can be unavailable or full; nothing here may throw.
 */
import { DEFAULT_DB_SORT, type DbSortState, type PageDraftFields } from "./docs-model";

const EXPANDED_KEY = "bridge-docs-expanded";
const DB_SORT_KEY = "bridge-docs-db-sort";
const SIDEBAR_COLLAPSED_KEY = "bridge-docs-sidebar-collapsed";
const WIDE_LAYOUT_KEY = "bridge-docs-wide";
const EDITOR_MODE_KEY = "bridge-docs-editor-mode";
const DRAFTS_KEY = "bridge-docs-drafts";
const MAX_DRAFTS = 20;

export type EditorMode = "write" | "split" | "preview";

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage is a convenience; a full or blocked store must not break the view.
  }
}

/** Returns null when nothing was stored yet, so first use can pick a sensible default. */
export function loadExpandedFolders(): Set<string> | null {
  const stored = readJson<unknown>(EXPANDED_KEY, null);
  return Array.isArray(stored) ? new Set(stored.filter((item): item is string => typeof item === "string")) : null;
}

export function saveExpandedFolders(expanded: ReadonlySet<string>): void {
  writeJson(EXPANDED_KEY, [...expanded]);
}

export function loadDbSort(folder: string): DbSortState {
  const stored = readJson<Record<string, DbSortState>>(DB_SORT_KEY, {})[folder];
  if (!stored || typeof stored.field !== "string") return DEFAULT_DB_SORT;
  return { field: stored.field, order: stored.order === "asc" ? "asc" : "desc" };
}

export function saveDbSort(folder: string, sort: DbSortState): void {
  writeJson(DB_SORT_KEY, { ...readJson<Record<string, DbSortState>>(DB_SORT_KEY, {}), [folder]: sort });
}

export function loadSidebarCollapsed(): boolean {
  return readJson<boolean>(SIDEBAR_COLLAPSED_KEY, false) === true;
}

export function saveSidebarCollapsed(collapsed: boolean): void {
  writeJson(SIDEBAR_COLLAPSED_KEY, collapsed);
}

export function loadWideLayout(): boolean {
  return readJson<boolean>(WIDE_LAYOUT_KEY, false) === true;
}

export function saveWideLayout(wide: boolean): void {
  writeJson(WIDE_LAYOUT_KEY, wide);
}

export function loadEditorMode(): EditorMode | null {
  const stored = readJson<unknown>(EDITOR_MODE_KEY, null);
  return stored === "write" || stored === "split" || stored === "preview" ? stored : null;
}

export function saveEditorMode(mode: EditorMode): void {
  writeJson(EDITOR_MODE_KEY, mode);
}

// ── Drafts ────────────────────────────────────────────────────────

export interface StoredDraft extends PageDraftFields {
  /** Collection entry field values, when the draft is for an entry. */
  fields?: Record<string, string | boolean>;
  /** The page revision the draft was started from. */
  baseModified: string;
  savedAt: string;
}

function readDrafts(): Record<string, StoredDraft> {
  const stored = readJson<unknown>(DRAFTS_KEY, {});
  return stored && typeof stored === "object" && !Array.isArray(stored) ? stored as Record<string, StoredDraft> : {};
}

export function loadDraft(path: string): StoredDraft | null {
  const draft = readDrafts()[path];
  if (!draft || typeof draft.body !== "string" || typeof draft.title !== "string") return null;
  return {
    ...draft,
    description: typeof draft.description === "string" ? draft.description : "",
    tags: Array.isArray(draft.tags) ? draft.tags.filter((tag): tag is string => typeof tag === "string") : [],
  };
}

export function saveDraft(path: string, draft: StoredDraft): void {
  const drafts = { ...readDrafts(), [path]: draft };
  const kept = Object.entries(drafts)
    .sort(([, a], [, b]) => String(b.savedAt).localeCompare(String(a.savedAt)))
    .slice(0, MAX_DRAFTS);
  writeJson(DRAFTS_KEY, Object.fromEntries(kept));
}

export function clearDraft(path: string): void {
  const drafts = readDrafts();
  if (!(path in drafts)) return;
  delete drafts[path];
  writeJson(DRAFTS_KEY, drafts);
}
