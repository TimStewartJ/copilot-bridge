import { describe, expect, it } from "vitest";
import { getSessionPath } from "./session-path";

describe("getSessionPath", () => {
  it("uses the task session route when task context is present", () => {
    expect(getSessionPath({ sessionId: "session-456", taskId: "task-123" })).toBe(
      "/tasks/task-123/sessions/session-456",
    );
  });

  it("uses the quick chat route when task context is absent", () => {
    expect(getSessionPath({ sessionId: "session-456", taskId: null })).toBe("/sessions/session-456");
    expect(getSessionPath({ sessionId: "session-456" })).toBe("/sessions/session-456");
  });
});
