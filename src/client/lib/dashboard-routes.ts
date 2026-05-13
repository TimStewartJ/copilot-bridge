export type DashboardTab = "checklist" | "feed";

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

export function getDashboardTabFromPathname(pathname: string): DashboardTab {
  return normalizePathname(pathname) === DASHBOARD_TAB_PATHS.feed ? "feed" : "checklist";
}

export function isDashboardRoutePath(pathname: string): boolean {
  const normalized = normalizePathname(pathname);
  return normalized === "/dashboard"
    || normalized === DASHBOARD_TAB_PATHS.checklist
    || normalized === DASHBOARD_TAB_PATHS.feed;
}
