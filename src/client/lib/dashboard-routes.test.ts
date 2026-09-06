import { describe, expect, it } from "vitest";
import {
  getDashboardPanelId,
  getDashboardTabFromPathname,
  getDashboardTabId,
  getDashboardTabPath,
  getRememberedDashboardPath,
  isDashboardRoutePath,
} from "./dashboard-routes";

describe("dashboard focus routes", () => {
  it("uses Focus as the canonical dashboard surface", () => {
    expect(getDashboardTabPath("focus")).toBe("/dashboard/focus");
    expect(getDashboardTabFromPathname("/dashboard/focus")).toBe("focus");
    expect(getDashboardTabId("focus")).toBe("dashboard-focus-tab");
    expect(getDashboardPanelId("focus")).toBe("dashboard-focus-panel");
    expect(getRememberedDashboardPath()).toBe("/dashboard/focus");
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
    expect(getDashboardTabPath("work-map")).toBe("/dashboard/work-map");
    expect(getDashboardTabFromPathname("/dashboard/work-map")).toBe("work-map");
    expect(getDashboardTabId("work-map")).toBe("dashboard-work-map-tab");
    expect(getDashboardPanelId("work-map")).toBe("dashboard-work-map-panel");
  });
});
