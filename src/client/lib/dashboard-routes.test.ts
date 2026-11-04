import { describe, expect, it } from "vitest";
import { resolveDocumentTitle } from "./document-title";
import { getMobileRouteMeta } from "./mobile-route-meta";
import {
  getDashboardPanelId,
  getDashboardTabFromPathname,
  getDashboardTabId,
  getDashboardTabPath,
  getRememberedDashboardPath,
  isDashboardRoutePath,
} from "./dashboard-routes";

describe("dashboard focus routes", () => {
  it("uses native Home as the canonical dashboard surface", () => {
    const pathname = getDashboardTabPath("focus");
    expect(pathname).toBe("/dashboard/home");
    expect(resolveDocumentTitle({ route: getMobileRouteMeta(pathname).route, pathname })).toMatch(/\bhome\b/i);
    expect(getDashboardTabFromPathname("/dashboard/focus")).toBe("focus");
    expect(getDashboardTabId("focus")).toBe("dashboard-focus-tab");
    expect(getDashboardPanelId("focus")).toBe("dashboard-focus-panel");
    expect(getRememberedDashboardPath()).toBe("/dashboard/home");
  });

  it.each([
    "/dashboard",
    "/dashboard/checklist",
    "/dashboard/feed",
  ])("maps legacy dashboard path %s to Focus", (path) => {
    expect(getDashboardTabFromPathname(path)).toBe("focus");
    expect(isDashboardRoutePath(path)).toBe(true);
  });

  it("preserves Work Map as an auxiliary dashboard route", () => {
    const pathname = getDashboardTabPath("work-map");
    expect(pathname).toBe("/dashboard/work-map");
    expect(resolveDocumentTitle({ route: getMobileRouteMeta(pathname).route, pathname })).toMatch(/\bwork map\b/i);
    expect(getDashboardTabFromPathname("/dashboard/work-map")).toBe("work-map");
    expect(getDashboardTabId("work-map")).toBe("dashboard-work-map-tab");
    expect(getDashboardPanelId("work-map")).toBe("dashboard-work-map-panel");
  });
});
