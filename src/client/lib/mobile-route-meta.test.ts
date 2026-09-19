import { describe, expect, it } from "vitest";
import { getMobileRouteMeta, resolveMobileWorkTabTarget } from "./mobile-route-meta";

describe("getMobileRouteMeta", () => {
  it("treats Helm as a root tab that keeps the bottom navigation", () => {
    expect(getMobileRouteMeta("/helm")).toMatchObject({
      route: "helm",
      activeTab: "helm",
      workSegment: null,
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
    expect(getMobileRouteMeta("/sessions/abc")).toMatchObject({ route: "quick-chat", activeTab: "work", workSegment: "chats", sessionId: "abc" });
    expect(getMobileRouteMeta("/tasks/t1/sessions/abc")).toMatchObject({ route: "task-session", taskId: "t1", sessionId: "abc" });
  });

  it("puts the task list and the quick chats under one Work tab, told apart by segment", () => {
    expect(getMobileRouteMeta("/")).toMatchObject({ route: "task-list", activeTab: "work", workSegment: "tasks", isRoot: true });
    expect(getMobileRouteMeta("/chats")).toMatchObject({ route: "chat-list", activeTab: "work", workSegment: "chats", isRoot: true });
    expect(getMobileRouteMeta("/tasks/t1")).toMatchObject({ route: "task-cockpit", activeTab: "work", workSegment: "tasks", isRoot: false });
    expect(getMobileRouteMeta("/tasks/t1/overview")).toMatchObject({ activeTab: "work", workSegment: "tasks" });
    expect(getMobileRouteMeta("/sessions/new")).toMatchObject({ activeTab: "work", workSegment: "chats", isDraft: true });
  });

  it("leaves routes outside the two lists without a segment", () => {
    for (const pathname of ["/dashboard/focus", "/settings", "/docs", "/search", "/nowhere"]) {
      expect(getMobileRouteMeta(pathname).workSegment).toBeNull();
    }
  });
});

describe("resolveMobileWorkTabTarget", () => {
  it("reopens the list shown last when Work is tapped from another tab", () => {
    expect(resolveMobileWorkTabTarget(getMobileRouteMeta("/dashboard/focus"), "chats")).toEqual({ segment: "chats", replace: false });
    expect(resolveMobileWorkTabTarget(getMobileRouteMeta("/settings"), "tasks")).toEqual({ segment: "tasks", replace: false });
  });

  it("flips between the two lists without adding history when Work is already showing one", () => {
    expect(resolveMobileWorkTabTarget(getMobileRouteMeta("/"), "tasks")).toEqual({ segment: "chats", replace: true });
    expect(resolveMobileWorkTabTarget(getMobileRouteMeta("/chats"), "chats")).toEqual({ segment: "tasks", replace: true });
  });

  it("leads back to the task list from inside a task, whatever was shown last", () => {
    expect(resolveMobileWorkTabTarget(getMobileRouteMeta("/tasks/t1"), "chats")).toEqual({ segment: "tasks", replace: false });
    expect(resolveMobileWorkTabTarget(getMobileRouteMeta("/tasks/t1/overview"), "chats")).toEqual({ segment: "tasks", replace: false });
  });
});
