import { describe, expect, it } from "vitest";
import { resolveDocumentTitle } from "./document-title";
import { getMobileRouteMeta } from "./mobile-route-meta";

function titleForPath(pathname: string) {
  return resolveDocumentTitle({ route: getMobileRouteMeta(pathname).route, pathname });
}

describe("dashboard document titles", () => {
  it("labels dashboard route /dashboard/home as Home", () => {
    expect(titleForPath("/dashboard/home")).toBe("Home - Copilot Bridge");
  });

  it("keeps Work Map labeled separately", () => {
    expect(titleForPath("/dashboard/work-map")).toBe("Work map - Copilot Bridge");
  });
});
