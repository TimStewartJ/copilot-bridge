import { describe, expect, it } from "vitest";
import { getMobileRouteMeta } from "./mobile-route-meta";

describe("getMobileRouteMeta", () => {
  it.each([
    {
      pathname: "/dashboard",
      expected: {
        route: "dashboard",
        activeTab: "home",
        showBottomNav: true,
        isRoot: true,
        isDetail: false,
      },
    },
    {
      pathname: "/",
      expected: {
        route: "task-list",
        activeTab: "tasks",
        showBottomNav: true,
        isRoot: true,
        isDetail: false,
      },
    },
    {
      pathname: "/chats",
      expected: {
        route: "chat-list",
        activeTab: "chats",
        showBottomNav: true,
        isRoot: true,
        isDetail: false,
      },
    },
    {
      pathname: "/settings",
      expected: {
        route: "settings",
        activeTab: "settings",
        showBottomNav: true,
        isRoot: true,
        isDetail: false,
      },
    },
  ])("marks $pathname as a mobile root route", ({ pathname, expected }) => {
    const meta = getMobileRouteMeta(pathname);

    expect(meta).toMatchObject(expected);
    expect(meta.upTarget).toBeUndefined();
  });

  it.each([
    "/docs",
    "/docs/",
    "/docs/index",
    "/docs/index/",
  ])("treats %s as the docs root shell", (pathname) => {
    const meta = getMobileRouteMeta(pathname);

    expect(meta).toMatchObject({
      route: "docs-root",
      activeTab: "docs",
      showBottomNav: true,
      showSharedHeader: false,
      isRoot: true,
      isDetail: false,
      isDocsRoot: true,
      isDocsDetail: false,
      docPath: null,
    });
    expect(meta.upTarget).toBeUndefined();
  });

  it("treats db-backed docs index as a detail route with an Up target", () => {
    expect(getMobileRouteMeta("/docs/index", "?db")).toMatchObject({
      route: "docs-detail",
      activeTab: "docs",
      showBottomNav: true,
      showSharedHeader: true,
      isRoot: false,
      isDetail: true,
      isDocsRoot: false,
      isDocsDetail: true,
      docPath: "index",
      upTarget: { to: "/docs", label: "Docs" },
    });
  });

  it("classifies docs detail pages as detail routes with an Up target", () => {
    expect(getMobileRouteMeta("/docs/guides/getting-started")).toMatchObject({
      route: "docs-detail",
      activeTab: "docs",
      showBottomNav: true,
      showSharedHeader: true,
      isRoot: false,
      isDetail: true,
      isDocsRoot: false,
      isDocsDetail: true,
      docPath: "guides/getting-started",
      upTarget: { to: "/docs", label: "Docs" },
    });
  });

  it("classifies task dashboard routes as detail routes that go Up to the task list", () => {
    expect(getMobileRouteMeta("/tasks/task-123")).toMatchObject({
      route: "task-dashboard",
      activeTab: "tasks",
      taskId: "task-123",
      showBottomNav: true,
      showSharedHeader: true,
      isRoot: false,
      isDetail: true,
      upTarget: { to: "/", label: "Tasks" },
    });
  });

  it("classifies task session detail routes and Up targets", () => {
    expect(getMobileRouteMeta("/tasks/task-123/sessions/session-456")).toMatchObject({
      route: "task-session",
      activeTab: "tasks",
      taskId: "task-123",
      sessionId: "session-456",
      showBottomNav: false,
      showSharedHeader: true,
      isRoot: false,
      isDetail: true,
      isDraft: false,
      upTarget: { to: "/tasks/task-123", label: "Task" },
    });

    expect(getMobileRouteMeta("/tasks/task-123/sessions/new")).toMatchObject({
      route: "task-session",
      activeTab: "tasks",
      taskId: "task-123",
      sessionId: "new",
      showBottomNav: false,
      showSharedHeader: true,
      isRoot: false,
      isDetail: true,
      isDraft: true,
      upTarget: { to: "/tasks/task-123", label: "Task" },
    });
  });

  it("classifies quick chat routes as detail routes that go Up to chats", () => {
    expect(getMobileRouteMeta("/sessions/session-123")).toMatchObject({
      route: "quick-chat",
      activeTab: "chats",
      sessionId: "session-123",
      showBottomNav: false,
      showSharedHeader: true,
      isRoot: false,
      isDetail: true,
      isDraft: false,
      upTarget: { to: "/chats", label: "Chats" },
    });

    expect(getMobileRouteMeta("/sessions/new")).toMatchObject({
      route: "quick-chat",
      activeTab: "chats",
      sessionId: "new",
      showBottomNav: false,
      showSharedHeader: true,
      isRoot: false,
      isDetail: true,
      isDraft: true,
      upTarget: { to: "/chats", label: "Chats" },
    });
  });
});
