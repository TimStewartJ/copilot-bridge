import { describe, expect, it } from "vitest";
import { getMobileRouteMeta } from "./mobile-route-meta";
import {
  BRIDGE_MOBILE_SCROLL_RESTORE_STATE,
  createBridgeMobileScrollRestoreState,
  getMobileScrollRestorationPolicy,
  hasBridgeMobileScrollRestoreState,
  hasTaskDashboardFocusParams,
} from "./mobile-scroll-restoration";

describe("getMobileScrollRestorationPolicy", () => {
  it.each([
    ["/dashboard", "mobile:dashboard"],
    ["/", "mobile:tasks:list"],
    ["/chats", "mobile:chats:list"],
  ])("restores root tab route %s by default", (pathname, key) => {
    expect(getMobileScrollRestorationPolicy(getMobileRouteMeta(pathname))).toEqual({
      key,
      restore: true,
    });
  });

  it("does not define policy for routes outside the first pass", () => {
    expect(getMobileScrollRestorationPolicy(getMobileRouteMeta("/settings"))).toBeNull();
    expect(getMobileScrollRestorationPolicy(getMobileRouteMeta("/docs"))).toBeNull();
    expect(getMobileScrollRestorationPolicy(getMobileRouteMeta("/sessions/session-123"))).toBeNull();
  });

  it("keys task dashboards by task id", () => {
    expect(getMobileScrollRestorationPolicy(getMobileRouteMeta("/tasks/task-123"))).toEqual({
      key: "mobile:task-dashboard:task-123",
      restore: false,
    });
  });

  it("restores task dashboards on browser POP navigation", () => {
    expect(getMobileScrollRestorationPolicy(getMobileRouteMeta("/tasks/task-123"), {
      navigationType: "POP",
    })).toMatchObject({ restore: true });

    expect(getMobileScrollRestorationPolicy(getMobileRouteMeta("/tasks/task-123"), {
      isPopNavigation: true,
    })).toMatchObject({ restore: true });
  });

  it("restores task dashboards for explicit Bridge mobile up navigation state", () => {
    expect(getMobileScrollRestorationPolicy(getMobileRouteMeta("/tasks/task-123"), {
      locationState: createBridgeMobileScrollRestoreState({ from: "detail" }),
    })).toMatchObject({ restore: true });
  });

  it("does not restore task dashboard visits that request focus", () => {
    expect(getMobileScrollRestorationPolicy(getMobileRouteMeta("/tasks/task-123"), {
      isPopNavigation: true,
      locationState: { [BRIDGE_MOBILE_SCROLL_RESTORE_STATE]: true },
      suppressTaskDashboardRestore: true,
    })).toEqual({
      key: "mobile:task-dashboard:task-123",
      restore: false,
    });
  });

  it.each(["?section=sessions", "?checklistItem=item-1"])(
    "lets task dashboard focus params beat restoration for %s",
    (search) => {
      expect(getMobileScrollRestorationPolicy(getMobileRouteMeta("/tasks/task-123"), {
        isPopNavigation: true,
        locationState: createBridgeMobileScrollRestoreState({ from: "detail" }),
        suppressTaskDashboardRestore: hasTaskDashboardFocusParams(search),
      })).toEqual({
        key: "mobile:task-dashboard:task-123",
        restore: false,
      });
    },
  );
});

describe("mobile scroll restoration helpers", () => {
  it("identifies explicit mobile restore state", () => {
    expect(hasBridgeMobileScrollRestoreState({ [BRIDGE_MOBILE_SCROLL_RESTORE_STATE]: true })).toBe(true);
    expect(hasBridgeMobileScrollRestoreState({ [BRIDGE_MOBILE_SCROLL_RESTORE_STATE]: false })).toBe(false);
    expect(hasBridgeMobileScrollRestoreState(null)).toBe(false);
  });

  it.each(["?section=checklist", "?checklistItem=item-1", new URLSearchParams("section=sessions")])(
    "detects task dashboard focus params in %s",
    (search) => {
      expect(hasTaskDashboardFocusParams(search)).toBe(true);
    },
  );

  it("ignores unrelated search params", () => {
    expect(hasTaskDashboardFocusParams("?foo=bar")).toBe(false);
  });
});
