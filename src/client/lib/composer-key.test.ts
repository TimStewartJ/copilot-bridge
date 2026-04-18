import { describe, expect, it } from "vitest";
import {
  getComposerKeyFromPathname,
  getDraftComposerKey,
  getTaskIdFromDraftComposerKey,
  isDraftComposerKey,
} from "./composer-key";

describe("composer key helpers", () => {
  it("builds stable draft keys for quick chats and task chats", () => {
    expect(getDraftComposerKey()).toBe("draft:quickchat");
    expect(getDraftComposerKey("task-123")).toBe("draft:task:task-123");
  });

  it("detects and parses draft keys", () => {
    expect(isDraftComposerKey("draft:quickchat")).toBe(true);
    expect(isDraftComposerKey("draft:task:task-123")).toBe(true);
    expect(isDraftComposerKey("session-123")).toBe(false);
    expect(getTaskIdFromDraftComposerKey("draft:task:task-123")).toBe("task-123");
    expect(getTaskIdFromDraftComposerKey("draft:quickchat")).toBeUndefined();
  });

  it("derives the active composer key from session and draft routes", () => {
    expect(getComposerKeyFromPathname("/sessions/new")).toBe("draft:quickchat");
    expect(getComposerKeyFromPathname("/tasks/task-123/sessions/new")).toBe("draft:task:task-123");
    expect(getComposerKeyFromPathname("/sessions/session-123")).toBe("session-123");
    expect(getComposerKeyFromPathname("/tasks/task-123/sessions/session-456")).toBe("session-456");
    expect(getComposerKeyFromPathname("/tasks/task-123")).toBeNull();
  });
});
