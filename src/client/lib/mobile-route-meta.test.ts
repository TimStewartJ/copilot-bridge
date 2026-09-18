import { describe, expect, it } from "vitest";
import { getMobileRouteMeta } from "./mobile-route-meta";

describe("getMobileRouteMeta", () => {
  it("treats Helm as a root tab that keeps the bottom navigation", () => {
    expect(getMobileRouteMeta("/helm")).toMatchObject({
      route: "helm",
      activeTab: "helm",
      showBottomNav: true,
      showSharedHeader: false,
      isRoot: true,
      isDetail: false,
      sessionId: null,
      taskId: null,
    });
    expect(getMobileRouteMeta("/helm/").route).toBe("helm");
  });

  it("still resolves chat routes next to it", () => {
    expect(getMobileRouteMeta("/sessions/abc")).toMatchObject({ route: "quick-chat", activeTab: "chats", sessionId: "abc" });
    expect(getMobileRouteMeta("/tasks/t1/sessions/abc")).toMatchObject({ route: "task-session", taskId: "t1", sessionId: "abc" });
  });
});
