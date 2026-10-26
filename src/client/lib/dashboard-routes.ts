export type DashboardTab = "focus" | "work-map";

const DASHBOARD_TAB_PATHS: Record<DashboardTab, string> = {
  focus: "/dashboard/home",
  "work-map": "/dashboard/work-map",
};

const DASHBOARD_TAB_IDS: Record<DashboardTab, string> = {
  focus: "dashboard-focus-tab",
  "work-map": "dashboard-work-map-tab",
};

const DASHBOARD_PANEL_IDS: Record<DashboardTab, string> = {
  focus: "dashboard-focus-panel",
  "work-map": "dashboard-work-map-panel",
};

const LEGACY_FOCUS_PATHS = new Set([
  "/dashboard/focus",
  "/dashboard",
  "/dashboard/checklist",
  "/dashboard/feed",
]);

function normalizePathname(pathname: string): string {
  if (!pathname || pathname === "/") return "/";
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed || "/";
}

export function getDashboardTabPath(tab: DashboardTab): string {
  return DASHBOARD_TAB_PATHS[tab];
}

export function getDashboardTabId(tab: DashboardTab): string {
  return DASHBOARD_TAB_IDS[tab];
}

export function getDashboardPanelId(tab: DashboardTab): string {
  return DASHBOARD_PANEL_IDS[tab];
}

export function getExplicitDashboardTabFromPathname(pathname: string): DashboardTab | null {
  const normalized = normalizePathname(pathname);
  if (normalized === DASHBOARD_TAB_PATHS.focus || LEGACY_FOCUS_PATHS.has(normalized)) return "focus";
  if (normalized === DASHBOARD_TAB_PATHS["work-map"]) return "work-map";
  return null;
}

export function getDashboardTabFromPathname(pathname: string): DashboardTab {
  return getExplicitDashboardTabFromPathname(pathname) ?? "focus";
}

export function getRememberedDashboardTabFromPathname(pathname: string): DashboardTab {
  return getDashboardTabFromPathname(pathname);
}

export function getRememberedDashboardPath(): string {
  return DASHBOARD_TAB_PATHS.focus;
}

/** The All tasks view: a task-state overview. On a phone it is the Work tab's task list. */
export const ALL_TASKS_PATH = "/dashboard/tasks";

export function isAllTasksPath(pathname: string): boolean {
  return normalizePathname(pathname) === ALL_TASKS_PATH;
}

export function isDashboardRoutePath(pathname: string): boolean {
  const normalized = normalizePathname(pathname);
  return normalized === DASHBOARD_TAB_PATHS.focus
    || normalized === "/dashboard/archive"
    || normalized === DASHBOARD_TAB_PATHS["work-map"]
    || LEGACY_FOCUS_PATHS.has(normalized);
}
