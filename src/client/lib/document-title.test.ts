import { describe, expect, it } from "vitest";
import { resolveDocumentTitle } from "./document-title";

describe("dashboard document titles", () => {
  it.each([
    "/dashboard/focus",
    "/dashboard",
    "/dashboard/checklist",
    "/dashboard/feed",
  ])("labels dashboard route %s as Focus", (pathname) => {
    expect(resolveDocumentTitle({ route: "dashboard", pathname })).toBe("Focus - Copilot Bridge");
  });

  it("keeps Work Map labeled separately", () => {
    expect(resolveDocumentTitle({ route: "dashboard", pathname: "/dashboard/work-map" }))
      .toBe("Work map - Copilot Bridge");
  });
});
