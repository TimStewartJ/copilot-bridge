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

  it("advances visible activity to the terminal timestamp when a visible tool is interrupted", () => {
    const lastVisibleActivityAt = getLastVisibleActivityAt([
      {
        type: "tool.execution_start",
        timestamp: "2026-04-10T10:00:00.000Z",
        data: { toolCallId: "tool-2", toolName: "bash" },
      },
      {
        type: "abort",
        timestamp: "2026-04-10T10:00:02.000Z",
        data: { reason: "user cancelled" },
      },
    ]);

    expect(lastVisibleActivityAt).toBe("2026-04-10T10:00:02.000Z");
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

  it("ignores quiet interval defer turns for visible activity while keeping transcript entries", () => {
    const events = [
      {
        type: "user.message",
        timestamp: "2026-04-10T10:00:00.000Z",
        data: {
          content: [
            "<defer>",
            "deferId: interval_123",
            "kind: interval",
            "attentionMode: quiet",
            "</defer>",
            "",
            "User prompt:",
            "Poll deployment",
          ].join("\n"),
        },
      },
      { type: "assistant.message", timestamp: "2026-04-10T10:00:10.000Z", data: { content: "No change yet." } },
      { type: "session.idle", timestamp: "2026-04-10T10:00:11.000Z", data: {} },
      { type: "user.message", timestamp: "2026-04-10T10:05:00.000Z", data: { content: "What changed?" } },
      { type: "assistant.message", timestamp: "2026-04-10T10:05:05.000Z", data: { content: "Here is the update." } },
    ];

    expect(getLastVisibleActivityAt(events, "session-1")).toBe("2026-04-10T10:05:05.000Z");
    expect(transformEventsToMessages(events, "session-1").map((entry) => entry.content)).toEqual([
      expect.stringContaining("attentionMode: quiet"),
      "No change yet.",
      "What changed?",
      "Here is the update.",
    ]);
  });

  it("resumes normal visible activity at the next user turn if a quiet defer turn has no terminal event", () => {
    const lastVisibleActivityAt = getLastVisibleActivityAt([
      {
        type: "user.message",
        timestamp: "2026-04-10T10:00:00.000Z",
        data: {
          content: [
            "<defer>",
            "deferId: interval_123",
            "kind: interval",
            "attentionMode: quiet",
            "</defer>",
            "",
            "User prompt:",
            "Poll deployment",
          ].join("\n"),
        },
      },
      { type: "assistant.message", timestamp: "2026-04-10T10:00:10.000Z", data: { content: "No change yet." } },
      { type: "user.message", timestamp: "2026-04-10T10:03:00.000Z", data: { content: "Unrelated question" } },
      { type: "assistant.message", timestamp: "2026-04-10T10:03:05.000Z", data: { content: "Unrelated answer" } },
    ], "session-1");

    expect(lastVisibleActivityAt).toBe("2026-04-10T10:03:05.000Z");
  });

  it("treats terminal completion summaries as visible transcript activity", () => {
    const events = [
      { type: "user.message", timestamp: "2026-04-10T10:00:00.000Z", data: { content: "Finish this" } },
      { type: "assistant.turn_start", timestamp: "2026-04-10T10:00:01.000Z", data: {} },
      {
        type: "session.task_complete",
        timestamp: "2026-04-10T10:00:05.000Z",
        data: { summary: "Implemented and verified the fix." },
      },
    ];

    expect(getLastVisibleActivityAt(events, "session-1")).toBe("2026-04-10T10:00:05.000Z");
    expect(transformEventsToMessages(events, "session-1")).toMatchObject([
      { type: "message", role: "user", content: "Finish this" },
      {
        type: "completion",
        content: "Implemented and verified the fix.",
        completion: {
          title: "Task complete",
          status: "success",
          sourceEventType: "session.task_complete",
        },
        turnId: "turn-1",
      },
    ]);
  });
});

describe("event-transform skill injection", () => {
  it("renders agent-injected skill context as a skill entry, not a user message", () => {
    const events = [
      { type: "user.message", timestamp: "2026-04-10T10:00:00.000Z", data: { content: "Use the browser" } },
      {
        type: "user.message",
        timestamp: "2026-04-10T10:00:01.000Z",
        data: {
          content: "<skill-context name=\"browser\">\nBase directory...\n</skill-context>",
          source: "skill-browser",
        },
      },
      { type: "assistant.message", timestamp: "2026-04-10T10:00:02.000Z", data: { content: "On it." } },
    ];

    expect(transformEventsToMessages(events, "session-1")).toMatchObject([
      { type: "message", role: "user", content: "Use the browser" },
      {
        type: "skill",
        skill: { id: "skill-browser", label: "browser" },
        content: expect.stringContaining("<skill-context name=\"browser\">"),
        timestamp: "2026-04-10T10:00:01.000Z",
      },
      { type: "message", role: "assistant", content: "On it." },
    ]);
  });

  it("derives the skill label from the source when the content has no skill-context tag", () => {
    const entries = transformEventsToMessages([
      {
        type: "user.message",
        timestamp: "2026-04-10T10:00:00.000Z",
        data: { content: "preloaded skill body", source: "skill-pdf" },
      },
    ], "session-1");

    expect(entries).toMatchObject([
      { type: "skill", skill: { id: "skill-pdf", label: "pdf" } },
    ]);
    expect(entries[0]).not.toHaveProperty("role");
  });

  it("keeps the skill event counted as visible activity", () => {
    const events = [
      {
        type: "user.message",
        timestamp: "2026-04-10T10:00:00.000Z",
        data: { content: "<skill-context name=\"pdf\"></skill-context>", source: "skill-pdf" },
      },
    ];

    expect(getLastVisibleActivityAt(events, "session-1")).toBe("2026-04-10T10:00:00.000Z");
  });

  it("does not treat a non-skill source as a skill entry", () => {
    const entries = transformEventsToMessages([
      {
        type: "user.message",
        timestamp: "2026-04-10T10:00:00.000Z",
        data: { content: "real prompt", source: "autopilot" },
      },
    ], "session-1");

    expect(entries).toMatchObject([{ type: "message", role: "user", content: "real prompt" }]);
  });
});

describe("event-transform fork boundaries", () => {
  it("adds the next raw event id after a completed assistant turn as a safe fork boundary", () => {
    const entries = transformEventsToMessages([
      { id: "user-1", type: "user.message", timestamp: "2026-04-10T10:00:00.000Z", data: { content: "First" } },
      { id: "assistant-1", type: "assistant.message", timestamp: "2026-04-10T10:00:01.000Z", data: { content: "Answer one" } },
      { id: "turn-end-1", type: "assistant.turn_end", timestamp: "2026-04-10T10:00:02.000Z", data: {} },
      { id: "user-2", type: "user.message", timestamp: "2026-04-10T10:01:00.000Z", data: { content: "Second" } },
      { id: "assistant-2", type: "assistant.message", timestamp: "2026-04-10T10:01:01.000Z", data: { content: "Answer two" } },
      { id: "turn-end-2", type: "assistant.turn_end", timestamp: "2026-04-10T10:01:02.000Z", data: {} },
    ]);

    const firstAssistant = entries.find((entry) => entry.role === "assistant" && entry.content === "Answer one");
    expect(firstAssistant?.forkBoundaryEventId).toBe("user-2");
  });

  it("skips repeated system prompts when choosing a fork boundary", () => {
    const entries = transformEventsToMessages([
      { id: "user-1", type: "user.message", timestamp: "2026-04-10T10:00:00.000Z", data: { content: "First" } },
      { id: "assistant-1", type: "assistant.message", timestamp: "2026-04-10T10:00:01.000Z", data: { content: "Answer one" } },
      { id: "turn-end-1", type: "assistant.turn_end", timestamp: "2026-04-10T10:00:02.000Z", data: {} },
      { id: "system-2", type: "system.message", timestamp: "2026-04-10T10:00:03.000Z", data: { content: "Repeated instructions" } },
      { id: "user-2", type: "user.message", timestamp: "2026-04-10T10:01:00.000Z", data: { content: "Second" } },
    ]);

    const firstAssistant = entries.find((entry) => entry.role === "assistant" && entry.content === "Answer one");
    expect(firstAssistant?.forkBoundaryEventId).toBe("user-2");
  });

  it("omits fork boundaries when the completed turn has no following event", () => {
    const entries = transformEventsToMessages([
      { id: "user-1", type: "user.message", timestamp: "2026-04-10T10:00:00.000Z", data: { content: "First" } },
      { id: "assistant-1", type: "assistant.message", timestamp: "2026-04-10T10:00:01.000Z", data: { content: "Answer one" } },
      { id: "turn-end-1", type: "assistant.turn_end", timestamp: "2026-04-10T10:00:02.000Z", data: {} },
    ]);

    const assistant = entries.find((entry) => entry.role === "assistant");
    expect(assistant?.forkBoundaryEventId).toBeUndefined();
  });

  it("omits fork boundaries for in-flight assistant turns", () => {
    const entries = transformEventsToMessages([
      { id: "user-1", type: "user.message", timestamp: "2026-04-10T10:00:00.000Z", data: { content: "First" } },
      { id: "assistant-1", type: "assistant.message", timestamp: "2026-04-10T10:00:01.000Z", data: { content: "Partial answer" } },
      { id: "user-2", type: "user.message", timestamp: "2026-04-10T10:01:00.000Z", data: { content: "Second" } },
    ]);

    const assistant = entries.find((entry) => entry.role === "assistant");
    expect(assistant?.forkBoundaryEventId).toBeUndefined();
  });

  it("only marks the final top-level assistant message in a multi-message turn", () => {
    const entries = transformEventsToMessages([
      { id: "user-1", type: "user.message", timestamp: "2026-04-10T10:00:00.000Z", data: { content: "First" } },
      { id: "assistant-1", type: "assistant.message", timestamp: "2026-04-10T10:00:01.000Z", data: { content: "Interim answer" } },
      { id: "assistant-2", type: "assistant.message", timestamp: "2026-04-10T10:00:02.000Z", data: { content: "Final answer" } },
      { id: "turn-end-1", type: "assistant.turn_end", timestamp: "2026-04-10T10:00:03.000Z", data: {} },
      { id: "user-2", type: "user.message", timestamp: "2026-04-10T10:01:00.000Z", data: { content: "Second" } },
    ]);

    const assistants = entries.filter((entry) => entry.role === "assistant");
    expect(assistants.map((entry) => entry.forkBoundaryEventId)).toEqual([undefined, "user-2"]);
  });

  it("does not scan across failed turns when computing fork boundaries", () => {
    const entries = transformEventsToMessages([
      { id: "user-1", type: "user.message", timestamp: "2026-04-10T10:00:00.000Z", data: { content: "First" } },
      { id: "assistant-1", type: "assistant.message", timestamp: "2026-04-10T10:00:01.000Z", data: { content: "Failed answer" } },
      { id: "error-1", type: "session.error", timestamp: "2026-04-10T10:00:02.000Z", data: { message: "boom" } },
      { id: "user-2", type: "user.message", timestamp: "2026-04-10T10:01:00.000Z", data: { content: "Second" } },
      { id: "assistant-2", type: "assistant.message", timestamp: "2026-04-10T10:01:01.000Z", data: { content: "Answer two" } },
      { id: "turn-end-2", type: "assistant.turn_end", timestamp: "2026-04-10T10:01:02.000Z", data: {} },
      { id: "user-3", type: "user.message", timestamp: "2026-04-10T10:02:00.000Z", data: { content: "Third" } },
    ]);

    const firstAssistant = entries.find((entry) => entry.role === "assistant" && entry.content === "Failed answer");
    const secondAssistant = entries.find((entry) => entry.role === "assistant" && entry.content === "Answer two");
    expect(firstAssistant?.forkBoundaryEventId).toBeUndefined();
    expect(secondAssistant?.forkBoundaryEventId).toBe("user-3");
  });
});

describe("event-transform tool results", () => {
  it("hides terminal completion tool rows and uses the terminal summary entry instead", () => {
    const entries = transformEventsToMessages([
      {
        type: "tool.execution_start",
        timestamp: "2026-04-10T10:00:00.000Z",
        data: { toolCallId: "tool-1", toolName: "task_complete", arguments: { summary: "Done" } },
      },
      {
        type: "tool.execution_complete",
        timestamp: "2026-04-10T10:00:01.000Z",
        data: { toolCallId: "tool-1", success: true, result: { content: "Done" } },
      },
      {
        type: "session.task_complete",
        timestamp: "2026-04-10T10:00:02.000Z",
        data: { summary: "Done" },
      },
    ]);

    expect(entries).toMatchObject([
      {
        type: "completion",
        content: "Done",
        completion: { sourceEventType: "session.task_complete" },
      },
    ]);
  });

  it("falls back to terminal completion tool arguments when no completion event has content", () => {
    const entries = transformEventsToMessages([
      { type: "assistant.turn_start", timestamp: "2026-04-10T10:00:00.000Z", data: {} },
      {
        type: "tool.execution_start",
        timestamp: "2026-04-10T10:00:01.000Z",
        data: {
          toolCallId: "tool-1",
          toolName: "task_complete",
          arguments: { summary: "Fallback summary" },
        },
      },
      {
        type: "tool.execution_complete",
        timestamp: "2026-04-10T10:00:02.000Z",
        data: { toolCallId: "tool-1", success: true, result: { content: "Fallback summary" } },
      },
      { type: "session.idle", timestamp: "2026-04-10T10:00:03.000Z", data: {} },
    ]);

    expect(entries).toMatchObject([
      {
        type: "completion",
        content: "Fallback summary",
        timestamp: "2026-04-10T10:00:03.000Z",
        turnId: "turn-1",
        completion: { sourceEventType: "tool.execution_complete" },
      },
    ]);
  });

  it("prefers detailedContent for successful tools", () => {
    const entries = transformEventsToMessages([
      {
        type: "tool.execution_start",
        timestamp: "2026-04-10T10:00:00.000Z",
        data: { toolCallId: "tool-1", toolName: "bash", arguments: { command: "git diff" } },
      },
      {
        type: "tool.execution_complete",
        timestamp: "2026-04-10T10:00:01.000Z",
        data: {
          toolCallId: "tool-1",
          success: true,
          result: {
            content: "short summary",
            detailedContent: "full diff output",
          },
        },
      },
    ]);

    expect(entries).toMatchObject([
      {
        type: "tool",
        toolCall: {
          toolCallId: "tool-1",
          name: "bash",
          result: "full diff output",
          success: true,
        },
      },
    ]);
  });

  it("prefers error.message for failed tools", () => {
    const entries = transformEventsToMessages([
      {
        type: "tool.execution_start",
        timestamp: "2026-04-10T10:00:00.000Z",
        data: { toolCallId: "tool-1", toolName: "browser_fetch", arguments: { url: "https://example.com" } },
      },
      {
        type: "tool.execution_complete",
        timestamp: "2026-04-10T10:00:01.000Z",
        data: {
          toolCallId: "tool-1",
          success: false,
          error: { message: "Snapshot failed" },
        },
      },
    ]);

    expect(entries).toMatchObject([
      {
        type: "tool",
        toolCall: {
          toolCallId: "tool-1",
          name: "browser_fetch",
          result: "Snapshot failed",
          success: false,
        },
      },
    ]);
  });

  it("renders runtime failure text when handlers omit the ToolResultObject error field", () => {
    const entries = transformEventsToMessages([
      {
        type: "tool.execution_start",
        timestamp: "2026-04-10T10:00:00.000Z",
        data: { toolCallId: "tool-1", toolName: "browser_fetch", arguments: { url: "https://example.com" } },
      },
      {
        type: "tool.execution_complete",
        timestamp: "2026-04-10T10:00:01.000Z",
        data: {
          toolCallId: "tool-1",
          success: false,
          error: {
            message: "Failed to capture page: snapshot failed",
          },
        },
      },
    ]);

    expect(entries).toMatchObject([
      {
        type: "tool",
        toolCall: {
          toolCallId: "tool-1",
          name: "browser_fetch",
          result: "Failed to capture page: snapshot failed",
          success: false,
        },
      },
    ]);
  });

  it("keeps sub-agent response text over raw tool results", () => {
    const entries = transformEventsToMessages([
      {
        type: "tool.execution_start",
        timestamp: "2026-04-10T10:00:00.000Z",
        data: { toolCallId: "tool-1", toolName: "task", arguments: { prompt: "Investigate" } },
      },
      {
        type: "subagent.started",
        timestamp: "2026-04-10T10:00:01.000Z",
        data: { toolCallId: "tool-1", agentName: "explore", agentDisplayName: "Explore agent" },
      },
      {
        type: "assistant.message",
        timestamp: "2026-04-10T10:00:02.000Z",
        data: { parentToolCallId: "tool-1", content: "Agent summary" },
      },
      {
        type: "tool.execution_complete",
        timestamp: "2026-04-10T10:00:03.000Z",
        data: {
          toolCallId: "tool-1",
          success: true,
          result: {
            content: "short summary",
            detailedContent: "full detailed output",
          },
        },
      },
    ]);

    expect(entries).toMatchObject([
      {
        type: "tool",
        toolCall: {
          toolCallId: "tool-1",
          name: "🤖 Explore agent",
          result: "Agent summary",
          success: true,
          isSubAgent: true,
        },
      },
    ]);
  });

  it("keeps the latest progress text for incomplete tools", () => {
    const entries = transformEventsToMessages([
      {
        type: "tool.execution_start",
        timestamp: "2026-04-10T10:00:00.000Z",
        data: { toolCallId: "tool-2", toolName: "bash", arguments: { command: "npm test" } },
      },
      {
        type: "tool.execution_progress",
        timestamp: "2026-04-10T10:00:01.000Z",
        data: { toolCallId: "tool-2", progressMessage: "Running tests..." },
      },
      {
        type: "tool.execution_partial_result",
        timestamp: "2026-04-10T10:00:02.000Z",
        data: { toolCallId: "tool-2", partialOutput: "12 tests passed" },
      },
    ]);

    expect(entries).toMatchObject([
      {
        type: "tool",
        toolCall: {
          toolCallId: "tool-2",
          name: "bash",
          progressText: "12 tests passed",
        },
      },
    ]);
  });

  it("marks open tools as failed when the turn terminates before completion", () => {
    const entries = transformEventsToMessages([
      {
        type: "tool.execution_start",
        timestamp: "2026-04-10T10:00:00.000Z",
        data: { toolCallId: "tool-3", toolName: "bash", arguments: { command: "npm test" } },
      },
      {
        type: "tool.execution_progress",
        timestamp: "2026-04-10T10:00:01.000Z",
        data: { toolCallId: "tool-3", progressMessage: "Running tests..." },
      },
      {
        type: "session.shutdown",
        timestamp: "2026-04-10T10:00:02.000Z",
        data: { shutdownType: "graceful" },
      },
    ]);

    expect(entries).toMatchObject([
      {
        type: "tool",
        toolCall: {
          toolCallId: "tool-3",
          name: "bash",
          progressText: "Running tests...",
          success: false,
          completedAt: "2026-04-10T10:00:02.000Z",
        },
      },
    ]);
  });

  it("marks open tools as failed when the turn ends with session.error", () => {
    const entries = transformEventsToMessages([
      {
        type: "tool.execution_start",
        timestamp: "2026-04-10T10:00:00.000Z",
        data: { toolCallId: "tool-4", toolName: "bash", arguments: { command: "npm test" } },
      },
      {
        type: "tool.execution_progress",
        timestamp: "2026-04-10T10:00:01.000Z",
        data: { toolCallId: "tool-4", progressMessage: "Running tests..." },
      },
      {
        type: "session.error",
        timestamp: "2026-04-10T10:00:02.000Z",
        data: { message: "runtime failed" },
      },
    ]);

    expect(entries).toMatchObject([
      {
        type: "tool",
        toolCall: {
          toolCallId: "tool-4",
          name: "bash",
          progressText: "Running tests...",
          success: false,
          completedAt: "2026-04-10T10:00:02.000Z",
        },
      },
    ]);
  });

  it("marks open tools as failed when the turn ends with abort", () => {
    const entries = transformEventsToMessages([
      {
        type: "tool.execution_start",
        timestamp: "2026-04-10T10:00:00.000Z",
        data: { toolCallId: "tool-5", toolName: "bash", arguments: { command: "npm test" } },
      },
      {
        type: "tool.execution_progress",
        timestamp: "2026-04-10T10:00:01.000Z",
        data: { toolCallId: "tool-5", progressMessage: "Running tests..." },
      },
      {
        type: "abort",
        timestamp: "2026-04-10T10:00:02.000Z",
        data: { reason: "user cancelled" },
      },
    ]);

    expect(entries).toMatchObject([
      {
        type: "tool",
        toolCall: {
          toolCallId: "tool-5",
          name: "bash",
          progressText: "Running tests...",
          success: false,
          completedAt: "2026-04-10T10:00:02.000Z",
        },
      },
    ]);
  });
});

describe("event-transform turn grouping", () => {
  it("assigns one turn id to assistant and tool entries even when assistant text interleaves", () => {
    const entries = transformEventsToMessages([
      {
        type: "user.message",
        timestamp: "2026-04-10T10:00:00.000Z",
        data: { content: "Check the repo" },
      },
      { type: "assistant.turn_start", timestamp: "2026-04-10T10:00:01.000Z", data: {} },
      {
        type: "assistant.message",
        timestamp: "2026-04-10T10:00:02.000Z",
        data: { content: "I'll inspect it." },
      },
      {
        type: "tool.execution_start",
        timestamp: "2026-04-10T10:00:03.000Z",
        data: { toolCallId: "tool-1", toolName: "bash", arguments: { command: "git status" } },
      },
      {
        type: "assistant.message",
        timestamp: "2026-04-10T10:00:04.000Z",
        data: { content: "Still checking." },
      },
      {
        type: "tool.execution_complete",
        timestamp: "2026-04-10T10:00:05.000Z",
        data: { toolCallId: "tool-1", success: true, result: { content: "clean" } },
      },
      {
        type: "tool.execution_start",
        timestamp: "2026-04-10T10:00:06.000Z",
        data: { toolCallId: "tool-2", toolName: "view", arguments: { path: "src/server/event-transform.ts" } },
      },
      {
        type: "tool.execution_complete",
        timestamp: "2026-04-10T10:00:07.000Z",
        data: { toolCallId: "tool-2", success: true, result: { content: "source" } },
      },
      { type: "session.idle", timestamp: "2026-04-10T10:00:08.000Z", data: {} },
      {
        type: "tool.execution_start",
        timestamp: "2026-04-10T10:00:09.000Z",
        data: { toolCallId: "orphan-tool", toolName: "bash", arguments: { command: "echo late" } },
      },
      { type: "assistant.turn_start", timestamp: "2026-04-10T10:00:10.000Z", data: {} },
      {
        type: "tool.execution_start",
        timestamp: "2026-04-10T10:00:11.000Z",
        data: { toolCallId: "tool-3", toolName: "bash", arguments: { command: "echo next" } },
      },
    ]);

    expect(entries[0]).not.toHaveProperty("turnId");
    expect(entries.slice(1, 5)).toMatchObject([
      { type: "message", role: "assistant", content: "I'll inspect it.", turnId: "turn-1" },
      { type: "tool", turnId: "turn-1", toolCall: { toolCallId: "tool-1" } },
      { type: "message", role: "assistant", content: "Still checking.", turnId: "turn-1" },
      { type: "tool", turnId: "turn-1", toolCall: { toolCallId: "tool-2" } },
    ]);
    expect(entries[5]).toMatchObject({ type: "tool", toolCall: { toolCallId: "orphan-tool" } });
    expect(entries[5]).not.toHaveProperty("turnId");
    expect(entries[6]).toMatchObject({ type: "tool", turnId: "turn-2", toolCall: { toolCallId: "tool-3" } });
  });

  it("keeps sub-agent messages hidden without breaking the active turn id", () => {
    const entries = transformEventsToMessages([
      { type: "assistant.turn_start", timestamp: "2026-04-10T10:00:00.000Z", data: {} },
      {
        type: "tool.execution_start",
        timestamp: "2026-04-10T10:00:01.000Z",
        data: { toolCallId: "agent-tool", toolName: "task", arguments: { prompt: "Investigate" } },
      },
      {
        type: "subagent.started",
        timestamp: "2026-04-10T10:00:02.000Z",
        data: { toolCallId: "agent-tool", agentName: "explore", agentDisplayName: "Explore agent" },
      },
      {
        type: "assistant.message",
        timestamp: "2026-04-10T10:00:03.000Z",
        data: { parentToolCallId: "agent-tool", content: "Agent summary" },
      },
      {
        type: "tool.execution_complete",
        timestamp: "2026-04-10T10:00:04.000Z",
        data: { toolCallId: "agent-tool", success: true, result: { content: "raw result" } },
      },
      {
        type: "assistant.message",
        timestamp: "2026-04-10T10:00:05.000Z",
        data: { content: "Done." },
      },
    ]);

    expect(entries).toMatchObject([
      {
        type: "tool",
        turnId: "turn-1",
        toolCall: {
          toolCallId: "agent-tool",
          name: "🤖 Explore agent",
          result: "Agent summary",
        },
      },
      { type: "message", role: "assistant", content: "Done.", turnId: "turn-1" },
    ]);
  });
});
