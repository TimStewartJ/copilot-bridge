import { describe, expect, it } from "vitest";
import { APP_TITLE, humanizeDocPath, resolveDocumentTitle } from "./document-title";
import { getMobileRouteMeta } from "./mobile-route-meta";

describe("resolveDocumentTitle", () => {
  it("labels the static top-level routes", () => {
    expect(resolveDocumentTitle({ route: "task-list" })).toBe("Tasks - Copilot Bridge");
    expect(resolveDocumentTitle({ route: "chat-list" })).toBe("Chats - Copilot Bridge");
    expect(resolveDocumentTitle({ route: "settings" })).toBe("Settings - Copilot Bridge");
    expect(resolveDocumentTitle({ route: "docs-root" })).toBe("Docs - Copilot Bridge");
    expect(resolveDocumentTitle({ route: "unknown" })).toBe(APP_TITLE);
  });

  it("names the dashboard sub-tab", () => {
    expect(resolveDocumentTitle({ route: "dashboard", pathname: "/dashboard" }))
      .toBe("Home - Copilot Bridge");
    expect(resolveDocumentTitle({ route: "dashboard", pathname: "/dashboard/checklist" }))
      .toBe("Checklist - Copilot Bridge");
    expect(resolveDocumentTitle({ route: "dashboard", pathname: "/dashboard/feed" }))
      .toBe("Feed - Copilot Bridge");
  });

  it("uses the task title for task routes", () => {
    expect(resolveDocumentTitle({ route: "task-cockpit", taskTitle: "Copilot Bridge" }))
      .toBe("Copilot Bridge");
    expect(resolveDocumentTitle({ route: "task-cockpit", taskTitle: "SFF pipeline" }))
      .toBe("SFF pipeline - Copilot Bridge");
    expect(resolveDocumentTitle({ route: "task-dashboard", taskTitle: "SFF pipeline" }))
      .toBe("Overview - SFF pipeline - Copilot Bridge");
  });

  it("falls back to generic labels when the task has not loaded", () => {
    expect(resolveDocumentTitle({ route: "task-cockpit" })).toBe("Task - Copilot Bridge");
    expect(resolveDocumentTitle({ route: "task-dashboard" })).toBe("Overview - Task - Copilot Bridge");
  });

  it("puts the session label ahead of the task for chat routes", () => {
    expect(resolveDocumentTitle({
      route: "task-session",
      taskTitle: "SFF pipeline",
      sessionLabel: "Triage gate failure",
    })).toBe("Triage gate failure - SFF pipeline - Copilot Bridge");

    expect(resolveDocumentTitle({ route: "quick-chat", sessionLabel: "Triage gate failure" }))
      .toBe("Triage gate failure - Copilot Bridge");
  });

  it("labels unsent drafts as new chats", () => {
    expect(resolveDocumentTitle({ route: "quick-chat", isDraft: true }))
      .toBe("New chat - Copilot Bridge");
    expect(resolveDocumentTitle({ route: "task-session", isDraft: true, taskTitle: "SFF pipeline" }))
      .toBe("New chat - SFF pipeline - Copilot Bridge");
  });

  it("falls back to a generic chat label when the session has no summary yet", () => {
    expect(resolveDocumentTitle({ route: "quick-chat", sessionLabel: "   " }))
      .toBe("Chat - Copilot Bridge");
    expect(resolveDocumentTitle({ route: "task-session", taskTitle: "SFF pipeline" }))
      .toBe("Chat - SFF pipeline - Copilot Bridge");
  });

  it("prefers a resolved docs title but falls back to the slug", () => {
    expect(resolveDocumentTitle({
      route: "docs-detail",
      docPath: "sff-pipeline/ci-dashboard-operating-model",
      docTitle: "CI Dashboard Operating Model",
    })).toBe("CI Dashboard Operating Model - Docs - Copilot Bridge");

    expect(resolveDocumentTitle({
      route: "docs-detail",
      docPath: "sff-pipeline/ci-dashboard-operating-model",
    })).toBe("Ci dashboard operating model - Docs - Copilot Bridge");

    expect(resolveDocumentTitle({ route: "docs-detail" })).toBe("Docs - Copilot Bridge");
  });

  it("collapses whitespace and truncates long segments", () => {
    expect(resolveDocumentTitle({ route: "task-cockpit", taskTitle: " SFF \n pipeline " }))
      .toBe("SFF pipeline - Copilot Bridge");

    const long = "a".repeat(200);
    const title = resolveDocumentTitle({ route: "task-cockpit", taskTitle: long });
    expect(title).toBe(`${"a".repeat(63)}\u2026 - Copilot Bridge`);
  });

  it("prefixes an attention badge when items need attention", () => {
    expect(resolveDocumentTitle({ route: "task-list", unreadCount: 3 }))
      .toBe("(3) Tasks - Copilot Bridge");
    expect(resolveDocumentTitle({ route: "task-list", unreadCount: 0 }))
      .toBe("Tasks - Copilot Bridge");
    expect(resolveDocumentTitle({ route: "task-list", unreadCount: -1 }))
      .toBe("Tasks - Copilot Bridge");
  });

  it("builds titles from real route metadata", () => {
    const sessionMeta = getMobileRouteMeta("/tasks/task-1/sessions/session-9");
    expect(resolveDocumentTitle({
      route: sessionMeta.route,
      isDraft: sessionMeta.isDraft,
      taskTitle: "Copilot Bridge",
      sessionLabel: "Descriptive page titles",
    })).toBe("Descriptive page titles - Copilot Bridge");

    const draftMeta = getMobileRouteMeta("/tasks/task-1/sessions/new");
    expect(resolveDocumentTitle({
      route: draftMeta.route,
      isDraft: draftMeta.isDraft,
      taskTitle: "SFF pipeline",
    })).toBe("New chat - SFF pipeline - Copilot Bridge");

    const docsMeta = getMobileRouteMeta("/docs/sff-pipeline/custom-code-packages-runbook");
    expect(resolveDocumentTitle({
      route: docsMeta.route,
      docPath: docsMeta.docPath,
    })).toBe("Custom code packages runbook - Docs - Copilot Bridge");
  });
});

describe("humanizeDocPath", () => {
  it("humanizes the last meaningful segment", () => {
    expect(humanizeDocPath("bootstrap")).toBe("Bootstrap");
    expect(humanizeDocPath("sff-pipeline/ci-dashboard-operating-model")).toBe("Ci dashboard operating model");
    expect(humanizeDocPath("sff_pipeline/some_page")).toBe("Some page");
  });

  it("resolves folder index pages to the folder name", () => {
    expect(humanizeDocPath("sff-pipeline/index")).toBe("Sff pipeline");
    expect(humanizeDocPath("a/b/index/index")).toBe("B");
  });

  it("returns null when there is nothing usable", () => {
    expect(humanizeDocPath(null)).toBeNull();
    expect(humanizeDocPath("")).toBeNull();
    expect(humanizeDocPath("index")).toBeNull();
    expect(humanizeDocPath("///")).toBeNull();
  });
});
