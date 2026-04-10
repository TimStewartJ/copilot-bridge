import { describe, expect, it } from "vitest";
import { getLastVisibleActivityAt } from "../event-transform.js";

describe("event-transform visible activity", () => {
  it("ignores hidden lifecycle events after the last visible message", () => {
    const lastVisibleActivityAt = getLastVisibleActivityAt([
      { type: "assistant.message", timestamp: "2026-04-10T10:00:00.000Z", data: { content: "Done" } },
      { type: "assistant.turn_end", timestamp: "2026-04-10T10:00:01.000Z", data: {} },
      { type: "session.shutdown", timestamp: "2026-04-10T10:00:02.000Z", data: {} },
    ]);

    expect(lastVisibleActivityAt).toBe("2026-04-10T10:00:00.000Z");
  });

  it("ignores report_intent while still treating real tool starts as visible activity", () => {
    const lastVisibleActivityAt = getLastVisibleActivityAt([
      {
        type: "tool.execution_start",
        timestamp: "2026-04-10T10:00:00.000Z",
        data: { toolCallId: "tool-1", toolName: "report_intent" },
      },
      {
        type: "tool.execution_start",
        timestamp: "2026-04-10T10:00:03.000Z",
        data: { toolCallId: "tool-2", toolName: "bash" },
      },
      { type: "tool.execution_complete", timestamp: "2026-04-10T10:00:04.000Z", data: { toolCallId: "tool-2" } },
    ]);

    expect(lastVisibleActivityAt).toBe("2026-04-10T10:00:04.000Z");
  });

  it("advances visible activity when a visible tool completes", () => {
    const lastVisibleActivityAt = getLastVisibleActivityAt([
      {
        type: "tool.execution_start",
        timestamp: "2026-04-10T10:00:00.000Z",
        data: { toolCallId: "tool-2", toolName: "bash" },
      },
      {
        type: "tool.execution_complete",
        timestamp: "2026-04-10T10:00:08.000Z",
        data: { toolCallId: "tool-2", result: { content: "done" } },
      },
    ]);

    expect(lastVisibleActivityAt).toBe("2026-04-10T10:00:08.000Z");
  });

  it("returns undefined when no visible activity exists", () => {
    const lastVisibleActivityAt = getLastVisibleActivityAt([
      { type: "assistant.turn_end", timestamp: "2026-04-10T10:00:00.000Z", data: {} },
      { type: "session.shutdown", timestamp: "2026-04-10T10:00:01.000Z", data: {} },
    ]);

    expect(lastVisibleActivityAt).toBeUndefined();
  });
});
