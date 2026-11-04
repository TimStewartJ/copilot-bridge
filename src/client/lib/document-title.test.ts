import { describe, expect, it } from "vitest";
import { resolveDocumentTitle } from "./document-title";
import { getMobileRouteMeta } from "./mobile-route-meta";

function titleForPath(pathname: string) {
  return resolveDocumentTitle({ route: getMobileRouteMeta(pathname).route, pathname });
}

describe("dashboard document titles", () => {
  it.each([
    "/dashboard/home",
    "/dashboard",
    "/dashboard/checklist",
  ])("labels dashboard route %s as Home", (pathname) => {
    expect(titleForPath(pathname)).toBe("Home - Copilot Bridge");
  });

  it("keeps Work Map labeled separately", () => {
    expect(titleForPath("/dashboard/work-map")).toBe("Work map - Copilot Bridge");
  });
});
