import { useCallback, useEffect, useState } from "react";

export const WORK_MAP_FILTERS_STORAGE_KEY = "bridge-work-map-filters";

export interface WorkMapFilters {
  search: string;
  /** Adds the open work assigned to the signed-in ADO user to the map, and shows only that. */
  assignedToMeOnly: boolean;
  openAdoOnly: boolean;
  gapsOnly: boolean;
  /** Adds the work linked to archived Bridge tasks. */
  includeArchived: boolean;
}

export const DEFAULT_WORK_MAP_FILTERS: WorkMapFilters = {
  search: "",
  assignedToMeOnly: false,
  openAdoOnly: false,
  gapsOnly: false,
  includeArchived: false,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function loadWorkMapFilters(): WorkMapFilters {
  try {
    const raw = localStorage.getItem(WORK_MAP_FILTERS_STORAGE_KEY);
    if (!raw) return { ...DEFAULT_WORK_MAP_FILTERS };
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) return { ...DEFAULT_WORK_MAP_FILTERS };
    return {
      search: typeof parsed.search === "string" ? parsed.search : "",
      assignedToMeOnly: parsed.assignedToMeOnly === true,
      openAdoOnly: parsed.openAdoOnly === true,
      gapsOnly: parsed.gapsOnly === true,
      includeArchived: parsed.includeArchived === true,
    };
  } catch {
    return { ...DEFAULT_WORK_MAP_FILTERS };
  }
}

export function saveWorkMapFilters(filters: WorkMapFilters): void {
  try {
    localStorage.setItem(WORK_MAP_FILTERS_STORAGE_KEY, JSON.stringify(filters));
  } catch {
    // Filter persistence is best-effort when browser storage is unavailable.
  }
}

/** The work map's filters, kept across visits. The setter takes the fields that change. */
export function useWorkMapFilters(): [WorkMapFilters, (change: Partial<WorkMapFilters>) => void] {
  const [filters, setFilters] = useState(loadWorkMapFilters);
  useEffect(() => saveWorkMapFilters(filters), [filters]);
  const change = useCallback((next: Partial<WorkMapFilters>) => setFilters((current) => ({ ...current, ...next })), []);
  return [filters, change];
}
