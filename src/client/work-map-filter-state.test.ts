import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_WORK_MAP_FILTERS,
  loadWorkMapFilters,
  saveWorkMapFilters,
  WORK_MAP_FILTERS_STORAGE_KEY,
} from "./work-map-filter-state";

function stubLocalStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const storage = {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => values.set(key, String(value))),
    removeItem: vi.fn((key: string) => values.delete(key)),
    clear: vi.fn(() => values.clear()),
    key: vi.fn((index: number) => [...values.keys()][index] ?? null),
    get length() {
      return values.size;
    },
  };
  vi.stubGlobal("localStorage", storage);
  return storage;
}

describe("Work Map filter persistence", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("round-trips every filter", () => {
    const storage = stubLocalStorage();
    const filters = {
      search: "bridge",
      assignedToMeOnly: true,
      openAdoOnly: true,
      gapsOnly: true,
      includeArchived: true,
    };

    saveWorkMapFilters(filters);

    expect(loadWorkMapFilters()).toEqual(filters);
    expect(storage.setItem).toHaveBeenCalledWith(
      WORK_MAP_FILTERS_STORAGE_KEY,
      JSON.stringify(filters),
    );
  });

  it("falls back safely when saved state is malformed", () => {
    stubLocalStorage({ [WORK_MAP_FILTERS_STORAGE_KEY]: "{invalid" });
    expect(loadWorkMapFilters()).toEqual(DEFAULT_WORK_MAP_FILTERS);
  });

  it("keeps valid fields while defaulting unsupported values", () => {
    stubLocalStorage({
      [WORK_MAP_FILTERS_STORAGE_KEY]: JSON.stringify({
        search: "ADO",
        assignedToMeOnly: "yes",
        openAdoOnly: true,
        gapsOnly: 1,
        includeArchived: false,
        futureField: true,
      }),
    });

    expect(loadWorkMapFilters()).toEqual({
      search: "ADO",
      assignedToMeOnly: false,
      openAdoOnly: true,
      gapsOnly: false,
      includeArchived: false,
    });
  });
});
