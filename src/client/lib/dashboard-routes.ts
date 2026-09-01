export type DashboardTab = "checklist" | "feed" | "work-map";

const LAST_DASHBOARD_TAB_KEY = "bridge-last-dashboard-tab";

const DASHBOARD_TAB_PATHS: Record<DashboardTab, string> = {
  checklist: "/dashboard/checklist",
  feed: "/dashboard/feed",
  "work-map": "/dashboard/work-map",
};

const DASHBOARD_TAB_IDS: Record<DashboardTab, string> = {
  checklist: "dashboard-checklist-tab",
  feed: "dashboard-feed-tab",
  "work-map": "dashboard-work-map-tab",
};

const DASHBOARD_PANEL_IDS: Record<DashboardTab, string> = {
  checklist: "dashboard-checklist-panel",
  feed: "dashboard-feed-panel",
  "work-map": "dashboard-work-map-panel",
};

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

function isDashboardTab(value: string | null): value is DashboardTab {
  return value === "checklist" || value === "feed" || value === "work-map";
}

export function getExplicitDashboardTabFromPathname(pathname: string): DashboardTab | null {
  const normalized = normalizePathname(pathname);
  if (normalized === DASHBOARD_TAB_PATHS.checklist) return "checklist";
  if (normalized === DASHBOARD_TAB_PATHS.feed) return "feed";
  if (normalized === DASHBOARD_TAB_PATHS["work-map"]) return "work-map";
  return null;
}

export function getDashboardTabFromPathname(pathname: string): DashboardTab {
  return getExplicitDashboardTabFromPathname(pathname) ?? "checklist";
}

export function getRememberedDashboardTabFromPathname(pathname: string): DashboardTab {
  const explicitTab = getExplicitDashboardTabFromPathname(pathname);
  if (explicitTab) return explicitTab;
  const normalized = normalizePathname(pathname);
  return normalized === "/" || normalized === "/dashboard" ? getLastDashboardTab() : "checklist";
}

export function getLastDashboardTab(): DashboardTab {
  try {
    const tab = localStorage.getItem(LAST_DASHBOARD_TAB_KEY);
    if (isDashboardTab(tab)) return tab;
  } catch {}
  return "checklist";
}

export function setLastDashboardTab(tab: DashboardTab): void {
  try {
    localStorage.setItem(LAST_DASHBOARD_TAB_KEY, tab);
  } catch {}
}

export function getRememberedDashboardPath(currentPathname?: string): string {
  const currentTab = currentPathname ? getExplicitDashboardTabFromPathname(currentPathname) : null;
  return getDashboardTabPath(currentTab ?? getLastDashboardTab());
}

export function isDashboardRoutePath(pathname: string): boolean {
  const normalized = normalizePathname(pathname);
  return normalized === "/dashboard"
    || normalized === DASHBOARD_TAB_PATHS.checklist
    || normalized === DASHBOARD_TAB_PATHS.feed
    || normalized === DASHBOARD_TAB_PATHS["work-map"];
}
