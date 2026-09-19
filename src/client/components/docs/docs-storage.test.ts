import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearDraft,
  loadDbSort,
  loadDraft,
  loadEditorMode,
  loadExpandedFolders,
  loadSidebarCollapsed,
  saveDbSort,
  saveDraft,
  saveEditorMode,
  saveExpandedFolders,
  saveSidebarCollapsed,
  type StoredDraft,
} from "./docs-storage";

function createStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
  };
}

function draft(overrides: Partial<StoredDraft> = {}): StoredDraft {
  return { title: "Plan", description: "", tags: [], body: "text", baseModified: "2026-01-01T00:00:00.000Z", savedAt: "2026-01-02T00:00:00.000Z", ...overrides };
}

let storage: ReturnType<typeof createStorage>;

beforeEach(() => {
  storage = createStorage();
  vi.stubGlobal("localStorage", storage);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("layout preferences", () => {
  it("distinguishes 'never stored' from 'everything collapsed' for the tree", () => {
    expect(loadExpandedFolders()).toBeNull();
    saveExpandedFolders(new Set());
    expect(loadExpandedFolders()).toEqual(new Set());
    saveExpandedFolders(new Set(["guides", "guides/setup"]));
    expect(loadExpandedFolders()).toEqual(new Set(["guides", "guides/setup"]));
  });

  it("round-trips the sidebar, editor mode and per-collection sort", () => {
    expect(loadSidebarCollapsed()).toBe(false);
    saveSidebarCollapsed(true);
    expect(loadSidebarCollapsed()).toBe(true);

    expect(loadEditorMode()).toBeNull();
    saveEditorMode("split");
    expect(loadEditorMode()).toBe("split");

    expect(loadDbSort("recipes")).toEqual({ field: "modified", order: "desc" });
    saveDbSort("recipes", { field: "minutes", order: "asc" });
    saveDbSort("incidents", { field: "severity", order: "desc" });
    expect(loadDbSort("recipes")).toEqual({ field: "minutes", order: "asc" });
    expect(loadDbSort("incidents")).toEqual({ field: "severity", order: "desc" });
  });

  it("ignores corrupt values instead of breaking the view", () => {
    storage.setItem("bridge-docs-expanded", "{not json");
    storage.setItem("bridge-docs-editor-mode", JSON.stringify("sideways"));
    storage.setItem("bridge-docs-db-sort", JSON.stringify({ recipes: { order: "asc" } }));
    expect(loadExpandedFolders()).toBeNull();
    expect(loadEditorMode()).toBeNull();
    expect(loadDbSort("recipes")).toEqual({ field: "modified", order: "desc" });
  });

  it("never throws when storage is unavailable", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("quota"); },
      removeItem: () => { throw new Error("blocked"); },
    });
    expect(() => saveExpandedFolders(new Set(["a"]))).not.toThrow();
    expect(loadExpandedFolders()).toBeNull();
    expect(() => saveDraft("plan", draft())).not.toThrow();
    expect(loadDraft("plan")).toBeNull();
  });
});

describe("drafts", () => {
  it("stores, restores and clears a page's unsaved edits", () => {
    expect(loadDraft("plan")).toBeNull();
    saveDraft("plan", draft({ tags: ["bridge"], fields: { severity: "sev1", done: true } }));
    expect(loadDraft("plan")).toMatchObject({ title: "Plan", body: "text", tags: ["bridge"], fields: { severity: "sev1", done: true } });
    clearDraft("plan");
    expect(loadDraft("plan")).toBeNull();
  });

  it("keeps only the most recent drafts so storage cannot grow without bound", () => {
    for (let i = 0; i < 25; i++) {
      saveDraft(`page-${i}`, draft({ savedAt: new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString() }));
    }
    expect(loadDraft("page-0")).toBeNull();
    expect(loadDraft("page-4")).toBeNull();
    expect(loadDraft("page-5")).not.toBeNull();
    expect(loadDraft("page-24")).not.toBeNull();
  });

  it("repairs a draft with missing optional fields and rejects a malformed one", () => {
    storage.setItem("bridge-docs-drafts", JSON.stringify({
      partial: { title: "T", body: "B", baseModified: "x", savedAt: "y" },
      broken: { title: 3 },
    }));
    expect(loadDraft("partial")).toMatchObject({ description: "", tags: [] });
    expect(loadDraft("broken")).toBeNull();
  });
});
