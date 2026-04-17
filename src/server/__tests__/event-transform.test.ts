import { describe, expect, it } from "vitest";
import { getLastVisibleActivityAt, transformEventsToMessages } from "../event-transform.js";

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

  it("hides self-renames that omit sessionId", () => {
    const events = [
      {
        type: "tool.execution_start",
        timestamp: "2026-04-10T10:00:00.000Z",
        data: {
          toolCallId: "tool-1",
          toolName: "session_rename",
          arguments: { title: "Local rename" },
        },
      },
      {
        type: "tool.execution_complete",
        timestamp: "2026-04-10T10:00:01.000Z",
        data: { toolCallId: "tool-1", success: true, result: { content: "ok" } },
      },
    ];

    expect(getLastVisibleActivityAt(events, "session-1")).toBeUndefined();
    expect(transformEventsToMessages(events, "session-1")).toEqual([]);
  });

  it("hides self-renames that explicitly target the current session", () => {
    const events = [
      {
        type: "tool.execution_start",
        timestamp: "2026-04-10T10:00:00.000Z",
        data: {
          toolCallId: "tool-1",
          toolName: "session_rename",
          arguments: { sessionId: "session-1", title: "Local rename" },
        },
      },
      {
        type: "tool.execution_complete",
        timestamp: "2026-04-10T10:00:01.000Z",
        data: { toolCallId: "tool-1", success: true, result: { content: "ok" } },
      },
    ];

    expect(getLastVisibleActivityAt(events, "session-1")).toBeUndefined();
    expect(transformEventsToMessages(events, "session-1")).toEqual([]);
  });

  it("hides self-renames whose target only differs by trailing whitespace", () => {
    const events = [
      {
        type: "tool.execution_start",
        timestamp: "2026-04-10T10:00:00.000Z",
        data: {
          toolCallId: "tool-1",
          toolName: "session_rename",
          arguments: { sessionId: "session-1   ", title: "Local rename" },
        },
      },
      {
        type: "tool.execution_complete",
        timestamp: "2026-04-10T10:00:01.000Z",
        data: { toolCallId: "tool-1", success: true, result: { content: "ok" } },
      },
    ];

    expect(getLastVisibleActivityAt(events, "session-1")).toBeUndefined();
    expect(transformEventsToMessages(events, "session-1")).toEqual([]);
  });

  it("keeps explicit cross-session renames visible", () => {
    const events = [
      {
        type: "tool.execution_start",
        timestamp: "2026-04-10T10:00:00.000Z",
        data: {
          toolCallId: "tool-2",
          toolName: "session_rename",
          arguments: { sessionId: "session-2", title: "Renamed elsewhere" },
        },
      },
      {
        type: "tool.execution_complete",
        timestamp: "2026-04-10T10:00:04.000Z",
        data: { toolCallId: "tool-2", success: true, result: { content: "ok" } },
      },
    ];

    expect(getLastVisibleActivityAt(events, "session-1")).toBe("2026-04-10T10:00:04.000Z");
    expect(transformEventsToMessages(events, "session-1")).toMatchObject([
      {
        type: "tool",
        toolCall: {
          toolCallId: "tool-2",
          name: "session_rename",
          args: { sessionId: "session-2", title: "Renamed elsewhere" },
          success: true,
          completedAt: "2026-04-10T10:00:04.000Z",
        },
      },
    ]);
  });

  it("returns undefined when no visible activity exists", () => {
    const lastVisibleActivityAt = getLastVisibleActivityAt([
      { type: "assistant.turn_end", timestamp: "2026-04-10T10:00:00.000Z", data: {} },
      { type: "session.shutdown", timestamp: "2026-04-10T10:00:01.000Z", data: {} },
    ]);

    expect(lastVisibleActivityAt).toBeUndefined();
  });
});
