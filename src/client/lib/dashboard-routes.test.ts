import { afterEach, describe, expect, it, vi } from "vitest";
import {
  getDashboardTabFromPathname,
  getDashboardTabPath,
  getExplicitDashboardTabFromPathname,
  getLastDashboardTab,
  getRememberedDashboardTabFromPathname,
  getRememberedDashboardPath,
  isDashboardRoutePath,
  setLastDashboardTab,
} from "./dashboard-routes";

function stubLocalStorage(initial: Record<string, string> = {}) {
  const store = new Map(Object.entries(initial));
  const storage: Storage = {
    get length() {
      return store.size;
    },
    clear: vi.fn(() => store.clear()),
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    key: vi.fn((index: number) => Array.from(store.keys())[index] ?? null),
    removeItem: vi.fn((key: string) => {
      store.delete(key);
    }),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, String(value));
    }),
  };
  vi.stubGlobal("localStorage", storage);
}

describe("dashboard routes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

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

  it("recognizes explicit dashboard tab paths", () => {
    expect(getExplicitDashboardTabFromPathname("/")).toBeNull();
    expect(getExplicitDashboardTabFromPathname("/dashboard")).toBeNull();
    expect(getExplicitDashboardTabFromPathname("/dashboard/checklist")).toBe("checklist");
    expect(getExplicitDashboardTabFromPathname("/dashboard/feed/")).toBe("feed");
  });

  it("remembers the last explicit dashboard tab", () => {
    stubLocalStorage();

    setLastDashboardTab("feed");

    expect(getLastDashboardTab()).toBe("feed");
    expect(getRememberedDashboardPath()).toBe("/dashboard/feed");
  });

  it("prefers the current explicit dashboard tab over stored state", () => {
    stubLocalStorage({ "bridge-last-dashboard-tab": "checklist" });

    expect(getRememberedDashboardPath("/dashboard/feed")).toBe("/dashboard/feed");
  });

  it("resolves dashboard landing routes from remembered tab state", () => {
    stubLocalStorage({ "bridge-last-dashboard-tab": "feed" });

    expect(getRememberedDashboardTabFromPathname("/")).toBe("feed");
    expect(getRememberedDashboardTabFromPathname("/dashboard")).toBe("feed");
    expect(getRememberedDashboardTabFromPathname("/dashboard/")).toBe("feed");
    expect(getRememberedDashboardTabFromPathname("/dashboard/checklist")).toBe("checklist");
    expect(getRememberedDashboardPath("/")).toBe("/dashboard/feed");
    expect(getRememberedDashboardPath("/dashboard")).toBe("/dashboard/feed");
  });

  it("falls back to checklist when remembered dashboard state is missing or invalid", () => {
    expect(getRememberedDashboardPath()).toBe("/dashboard/checklist");

    stubLocalStorage({ "bridge-last-dashboard-tab": "unknown" });

    expect(getLastDashboardTab()).toBe("checklist");
    expect(getRememberedDashboardPath()).toBe("/dashboard/checklist");
  });

  it("recognizes only supported dashboard route paths", () => {
    expect(isDashboardRoutePath("/dashboard")).toBe(true);
    expect(isDashboardRoutePath("/dashboard/checklist")).toBe(true);
    expect(isDashboardRoutePath("/dashboard/feed")).toBe(true);
    expect(isDashboardRoutePath("/dashboard/anything")).toBe(false);
    expect(isDashboardRoutePath("/dashboardx")).toBe(false);
  });
});
