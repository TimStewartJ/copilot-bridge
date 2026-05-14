export type DashboardTab = "checklist" | "feed";

const LAST_DASHBOARD_TAB_KEY = "bridge-last-dashboard-tab";

const DASHBOARD_TAB_PATHS: Record<DashboardTab, string> = {
  checklist: "/dashboard/checklist",
  feed: "/dashboard/feed",
};

function normalizePathname(pathname: string): string {
  if (!pathname || pathname === "/") return "/";
  const trimmed = pathname.replace(/\/+$/, "");
  return trimmed || "/";
}

export function getDashboardTabPath(tab: DashboardTab): string {
  return DASHBOARD_TAB_PATHS[tab];
}

function isDashboardTab(value: string | null): value is DashboardTab {
  return value === "checklist" || value === "feed";
}

export function getExplicitDashboardTabFromPathname(pathname: string): DashboardTab | null {
  const normalized = normalizePathname(pathname);
  if (normalized === DASHBOARD_TAB_PATHS.checklist) return "checklist";
  if (normalized === DASHBOARD_TAB_PATHS.feed) return "feed";
  return null;
}

export function getDashboardTabFromPathname(pathname: string): DashboardTab {
  return normalizePathname(pathname) === DASHBOARD_TAB_PATHS.feed ? "feed" : "checklist";
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
    || normalized === DASHBOARD_TAB_PATHS.feed;
}
