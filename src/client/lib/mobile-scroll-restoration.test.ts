import { describe, expect, it } from "vitest";
import { getMobileRouteMeta } from "./mobile-route-meta";
import {
  BRIDGE_MOBILE_SCROLL_RESTORE_STATE,
  createBridgeMobileScrollRestoreState,
  getMobileScrollRestorationPolicy,
  hasBridgeMobileScrollRestoreState,
} from "./mobile-scroll-restoration";

describe("getMobileScrollRestorationPolicy", () => {
  it.each([
    ["/dashboard", "mobile:dashboard"],
    ["/dashboard/checklist", "mobile:dashboard"],
    ["/dashboard/feed", "mobile:dashboard"],
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

  it("keys task cockpits by task id", () => {
    expect(getMobileScrollRestorationPolicy(getMobileRouteMeta("/tasks/task-123"))).toEqual({
      key: "mobile:task-cockpit:task-123",
      restore: false,
    });
  });

  it("keys task dashboards by task id", () => {
    expect(getMobileScrollRestorationPolicy(getMobileRouteMeta("/tasks/task-123/overview"))).toEqual({
      key: "mobile:task-dashboard:task-123",
      restore: false,
    });
  });

  it.each([
    ["/tasks/task-123", "mobile:task-cockpit:task-123"],
    ["/tasks/task-123/overview", "mobile:task-dashboard:task-123"],
  ])("restores %s on browser POP navigation", (pathname, key) => {
    expect(getMobileScrollRestorationPolicy(getMobileRouteMeta(pathname), {
      navigationType: "POP",
    })).toMatchObject({ key, restore: true });

    expect(getMobileScrollRestorationPolicy(getMobileRouteMeta(pathname), {
      isPopNavigation: true,
    })).toMatchObject({ key, restore: true });
  });

  it("restores task dashboards for explicit Bridge mobile up navigation state", () => {
    expect(getMobileScrollRestorationPolicy(getMobileRouteMeta("/tasks/task-123/overview"), {
      locationState: createBridgeMobileScrollRestoreState({ from: "detail" }),
    })).toMatchObject({ key: "mobile:task-dashboard:task-123", restore: true });
  });

});

describe("mobile scroll restoration helpers", () => {
  it("identifies explicit mobile restore state", () => {
    expect(hasBridgeMobileScrollRestoreState({ [BRIDGE_MOBILE_SCROLL_RESTORE_STATE]: true })).toBe(true);
    expect(hasBridgeMobileScrollRestoreState({ [BRIDGE_MOBILE_SCROLL_RESTORE_STATE]: false })).toBe(false);
    expect(hasBridgeMobileScrollRestoreState(null)).toBe(false);
  });

});
