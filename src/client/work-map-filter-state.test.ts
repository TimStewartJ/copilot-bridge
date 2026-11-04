import { createElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createReactDomHarness } from "./test-react-harness";
import {
  DEFAULT_WORK_MAP_FILTERS,
  loadWorkMapFilters,
  useWorkMapFilters,
  WORK_MAP_FILTERS_STORAGE_KEY,
  type WorkMapFilters,
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

  it("falls back safely when saved state is malformed", () => {
    stubLocalStorage({ [WORK_MAP_FILTERS_STORAGE_KEY]: "{invalid" });
    expect(loadWorkMapFilters()).toEqual(DEFAULT_WORK_MAP_FILTERS);
  });

  it("keeps valid fields while defaulting unsupported values", () => {
    stubLocalStorage({
      [WORK_MAP_FILTERS_STORAGE_KEY]: JSON.stringify({
        // Saved by a version that still had a second layout.
        view: "clusters",
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

  it("starts from the saved filters and saves each change", async () => {
    const storage = stubLocalStorage({
      [WORK_MAP_FILTERS_STORAGE_KEY]: JSON.stringify({ search: "SDL", openAdoOnly: true, includeArchived: true }),
    });
    const harness = await createReactDomHarness();
    let current: [WorkMapFilters, (change: Partial<WorkMapFilters>) => void] | undefined;
    function Probe() {
      current = useWorkMapFilters();
      return null;
    }
    await harness.render(createElement(Probe));

    expect(current?.[0]).toEqual({ ...DEFAULT_WORK_MAP_FILTERS, search: "SDL", openAdoOnly: true, includeArchived: true });

    await harness.act(async () => {
      current?.[1]({ assignedToMeOnly: true, gapsOnly: true, search: "" });
    });

    expect(current?.[0]).toEqual({ search: "", assignedToMeOnly: true, openAdoOnly: true, gapsOnly: true, includeArchived: true });
    expect(JSON.parse(storage.getItem(WORK_MAP_FILTERS_STORAGE_KEY) ?? "{}")).toEqual(current?.[0]);
    expect(loadWorkMapFilters()).toEqual(current?.[0]);
  });
});
