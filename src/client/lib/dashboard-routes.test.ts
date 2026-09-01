import { describe, expect, it } from "vitest";
import {
  getDashboardPanelId,
  getDashboardTabFromPathname,
  getDashboardTabId,
  getDashboardTabPath,
  isDashboardRoutePath,
} from "./dashboard-routes";

describe("dashboard work map routes", () => {
  it("maps the work map path and ARIA ids", () => {
    expect(getDashboardTabPath("work-map")).toBe("/dashboard/work-map");
    expect(getDashboardTabFromPathname("/dashboard/work-map")).toBe("work-map");
    expect(getDashboardTabId("work-map")).toBe("dashboard-work-map-tab");
    expect(getDashboardPanelId("work-map")).toBe("dashboard-work-map-panel");
    expect(isDashboardRoutePath("/dashboard/work-map")).toBe(true);
  });
});
