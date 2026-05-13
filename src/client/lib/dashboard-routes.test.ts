import { describe, expect, it } from "vitest";
import { getDashboardTabFromPathname, getDashboardTabPath, isDashboardRoutePath } from "./dashboard-routes";

describe("dashboard routes", () => {
  it("maps dashboard paths to tabs", () => {
    expect(getDashboardTabFromPathname("/")).toBe("checklist");
    expect(getDashboardTabFromPathname("/dashboard")).toBe("checklist");
    expect(getDashboardTabFromPathname("/dashboard/checklist")).toBe("checklist");
    expect(getDashboardTabFromPathname("/dashboard/checklist/")).toBe("checklist");
    expect(getDashboardTabFromPathname("/dashboard/feed")).toBe("feed");
    expect(getDashboardTabFromPathname("/dashboard/feed/")).toBe("feed");
  });

  it("builds dashboard tab paths", () => {
    expect(getDashboardTabPath("checklist")).toBe("/dashboard/checklist");
    expect(getDashboardTabPath("feed")).toBe("/dashboard/feed");
  });

  it("recognizes only supported dashboard route paths", () => {
    expect(isDashboardRoutePath("/dashboard")).toBe(true);
    expect(isDashboardRoutePath("/dashboard/checklist")).toBe(true);
    expect(isDashboardRoutePath("/dashboard/feed")).toBe(true);
    expect(isDashboardRoutePath("/dashboard/anything")).toBe(false);
    expect(isDashboardRoutePath("/dashboardx")).toBe(false);
  });
});
