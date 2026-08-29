import { describe, expect, it } from "vitest";
import {
  getLastVisibleActivityAt,
  getUndoBoundaryEventId,
  isVisibleMessageEvent,
  transformEventsToMessages,
} from "../event-transform.js";

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

  it("hides self-renames (no sessionId, exact match, and trailing-whitespace match)", () => {
    // omit sessionId: treated as self-rename
    expect(getLastVisibleActivityAt([
      { type: "tool.execution_start", timestamp: "2026-04-10T10:00:00.000Z", data: { toolCallId: "tool-1", toolName: "session_rename", arguments: { title: "Local rename" } } },
      { type: "tool.execution_complete", timestamp: "2026-04-10T10:00:01.000Z", data: { toolCallId: "tool-1", success: true, result: { content: "ok" } } },
    ], "session-1"), "omit sessionId: no visible activity").toBeUndefined();
    expect(transformEventsToMessages([
      { type: "tool.execution_start", timestamp: "2026-04-10T10:00:00.000Z", data: { toolCallId: "tool-1", toolName: "session_rename", arguments: { title: "Local rename" } } },
      { type: "tool.execution_complete", timestamp: "2026-04-10T10:00:01.000Z", data: { toolCallId: "tool-1", success: true, result: { content: "ok" } } },
    ], "session-1"), "omit sessionId: empty messages").toEqual([]);

    // explicit match
    expect(getLastVisibleActivityAt([
      { type: "tool.execution_start", timestamp: "2026-04-10T10:00:00.000Z", data: { toolCallId: "tool-1", toolName: "session_rename", arguments: { sessionId: "session-1", title: "Local rename" } } },
      { type: "tool.execution_complete", timestamp: "2026-04-10T10:00:01.000Z", data: { toolCallId: "tool-1", success: true, result: { content: "ok" } } },
    ], "session-1"), "explicit match: no visible activity").toBeUndefined();
    expect(transformEventsToMessages([
      { type: "tool.execution_start", timestamp: "2026-04-10T10:00:00.000Z", data: { toolCallId: "tool-1", toolName: "session_rename", arguments: { sessionId: "session-1", title: "Local rename" } } },
      { type: "tool.execution_complete", timestamp: "2026-04-10T10:00:01.000Z", data: { toolCallId: "tool-1", success: true, result: { content: "ok" } } },
    ], "session-1"), "explicit match: empty messages").toEqual([]);

    // trailing whitespace
    expect(getLastVisibleActivityAt([
      { type: "tool.execution_start", timestamp: "2026-04-10T10:00:00.000Z", data: { toolCallId: "tool-1", toolName: "session_rename", arguments: { sessionId: "session-1   ", title: "Local rename" } } },
      { type: "tool.execution_complete", timestamp: "2026-04-10T10:00:01.000Z", data: { toolCallId: "tool-1", success: true, result: { content: "ok" } } },
    ], "session-1"), "trailing whitespace: no visible activity").toBeUndefined();
    expect(transformEventsToMessages([
      { type: "tool.execution_start", timestamp: "2026-04-10T10:00:00.000Z", data: { toolCallId: "tool-1", toolName: "session_rename", arguments: { sessionId: "session-1   ", title: "Local rename" } } },
      { type: "tool.execution_complete", timestamp: "2026-04-10T10:00:01.000Z", data: { toolCallId: "tool-1", success: true, result: { content: "ok" } } },
    ], "session-1"), "trailing whitespace: empty messages").toEqual([]);
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

  it("keeps SDK-sourced user messages inside the quiet defer activity window", () => {
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
          ].join("\n"),
        },
      },
      {
        type: "user.message",
        timestamp: "2026-04-10T10:00:01.000Z",
        data: { content: "<skill-context name=\"browser\">", source: "skill-browser" },
      },
      {
        type: "user.message",
        timestamp: "2026-04-10T10:00:02.000Z",
        data: { content: "runtime context", source: "system" },
      },
      { type: "assistant.message", timestamp: "2026-04-10T10:00:03.000Z", data: { content: "No change yet." } },
      { type: "session.idle", timestamp: "2026-04-10T10:00:04.000Z", data: {} },
    ], "session-1");

    expect(lastVisibleActivityAt).toBeUndefined();
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

describe("event-transform stable identity", () => {
  it("preserves provider turn identity while deriving a unique turn instance from the start event", () => {
    const entries = transformEventsToMessages([
      {
        id: "turn-start-event",
        type: "assistant.turn_start",
        data: { turnId: "provider-turn-1" },
      },
      {
        id: "assistant-event",
        type: "assistant.message",
        data: { content: "Hello" },
      },
      {
        id: "terminal-event",
        type: "session.idle",
        data: {},
      },
    ]);

    expect(entries).toMatchObject([
      {
        type: "message",
        content: "Hello",
        turnId: "provider-turn-1",
        turnInstanceId: "turn-start-event",
        sourceEventId: "assistant-event",
      },
    ]);
  });

  it("keeps repeated provider turn ids in distinct turn instances", () => {
    const entries = transformEventsToMessages([
      {
        id: "turn-start-first",
        type: "assistant.turn_start",
        data: { turnId: "0" },
      },
      {
        id: "tool-first-event",
        type: "tool.execution_start",
        data: { toolCallId: "tool-first", toolName: "bash" },
      },
      {
        id: "terminal-first",
        type: "session.idle",
        data: {},
      },
      {
        id: "turn-start-resumed",
        type: "assistant.turn_start",
        data: { turnId: "0" },
      },
      {
        id: "tool-resumed-event",
        type: "tool.execution_start",
        data: { toolCallId: "tool-resumed", toolName: "view" },
      },
    ]);

    expect(entries).toMatchObject([
      {
        type: "tool",
        turnId: "0",
        turnInstanceId: "turn-start-first",
        toolCall: { toolCallId: "tool-first" },
      },
      {
        type: "tool",
        turnId: "0",
        turnInstanceId: "turn-start-resumed",
        toolCall: { toolCallId: "tool-resumed" },
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

// The agent runtime injects its own `user.message` events tagged `source: "system"`
// to carry model-only context, currently the deferred-tool `<system_reminder>`
// block. Copilot CLI <= 1.0.73 left `content` empty and put the text in
// `transformedContent` (which Bridge never reads), so these dropped out of the
// timeline by accident. CLI 1.0.75 also emits a copy with the text in `content`,
// which rendered as though the user had pasted it into the chat.
describe("event-transform agent-injected system messages", () => {
  const REMINDER = "<system_reminder>\nIMPORTANT: The tools listed below are deferred"
    + " — their full definitions are NOT loaded.\n</system_reminder>";

  it("hides a system-sourced reminder that carries visible content", () => {
    const entries = transformEventsToMessages([
      { type: "user.message", timestamp: "2026-04-10T10:00:00.000Z", data: { content: "Reply with just: PONG" } },
      {
        type: "user.message",
        timestamp: "2026-04-10T10:00:01.000Z",
        data: { content: REMINDER, source: "system" },
      },
      { type: "assistant.message", timestamp: "2026-04-10T10:00:02.000Z", data: { content: "PONG" } },
    ], "session-1");

    expect(entries).toMatchObject([
      { type: "message", role: "user", content: "Reply with just: PONG" },
      { type: "message", role: "assistant", content: "PONG" },
    ]);
    expect(JSON.stringify(entries)).not.toContain("system_reminder");
  });

  it("hides the pre-1.0.74 shape that kept the reminder in transformedContent", () => {
    const entries = transformEventsToMessages([
      {
        type: "user.message",
        timestamp: "2026-04-10T10:00:00.000Z",
        data: { content: "", transformedContent: REMINDER, source: "system" },
      },
    ], "session-1");

    expect(entries).toEqual([]);
  });

  it("does not count an injected system message as visible activity", () => {
    expect(getLastVisibleActivityAt([
      { type: "user.message", timestamp: "2026-04-10T10:00:00.000Z", data: { content: "Real prompt" } },
      {
        type: "user.message",
        timestamp: "2026-04-10T10:05:00.000Z",
        data: { content: REMINDER, source: "system" },
      },
    ], "session-1")).toBe("2026-04-10T10:00:00.000Z");
  });

  it("still renders a genuine user message that merely mentions the marker", () => {
    const entries = transformEventsToMessages([
      {
        type: "user.message",
        timestamp: "2026-04-10T10:00:00.000Z",
        data: { content: `why do i see this? ${REMINDER}` },
      },
    ], "session-1");

    expect(entries).toMatchObject([{ type: "message", role: "user" }]);
    expect(entries[0].content).toContain("why do i see this?");
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

  it("does not let a sub-agent instruction interrupt the parent turn boundary", () => {
    const entries = transformEventsToMessages([
      { id: "user-1", type: "user.message", data: { content: "First" } },
      { id: "assistant-1", type: "assistant.message", data: { content: "Answer one" } },
      {
        id: "agent-prompt",
        type: "user.message",
        agentId: "agent-1",
        data: {
          content: "Inspect the repository",
          source: "agent-parent-session",
          parentAgentTaskId: "task-1",
        },
      },
      { id: "turn-end-1", type: "assistant.turn_end", data: {} },
      { id: "user-2", type: "user.message", data: { content: "Second" } },
    ]);

    const firstAssistant = entries.find((entry) => entry.role === "assistant");
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

describe("event-transform undo boundaries", () => {
  it("anchors user and assistant messages to the visible user event that began the turn", () => {
    const entries = transformEventsToMessages([
      { id: "user-1", type: "user.message", timestamp: "2026-04-10T10:00:00.000Z", data: { content: "First" } },
      { id: "assistant-1", type: "assistant.message", timestamp: "2026-04-10T10:00:01.000Z", data: { content: "Answer one" } },
      {
        id: "skill-browser",
        type: "user.message",
        timestamp: "2026-04-10T10:00:02.000Z",
        data: { content: "<skill-context name=\"browser\">", source: "skill-browser" },
      },
      { id: "assistant-2", type: "assistant.message", timestamp: "2026-04-10T10:00:03.000Z", data: { content: "Still turn one" } },
      { id: "user-2", type: "user.message", timestamp: "2026-04-10T10:01:00.000Z", data: { content: "Second" } },
      { id: "assistant-3", type: "assistant.message", timestamp: "2026-04-10T10:01:01.000Z", data: { content: "Answer two" } },
    ]);

    expect(entries.filter((entry) => entry.type === "message").map((entry) => ({
      content: entry.content,
      undoEventId: entry.undoEventId,
    }))).toEqual([
      { content: "First", undoEventId: "user-1" },
      { content: "Answer one", undoEventId: "user-1" },
      { content: "Still turn one", undoEventId: "user-1" },
      { content: "Second", undoEventId: "user-2" },
      { content: "Answer two", undoEventId: "user-2" },
    ]);
  });

  it("omits undo actions when the visible user event has no stable raw id", () => {
    const entries = transformEventsToMessages([
      { type: "user.message", data: { content: "No id" } },
      { id: "assistant-1", type: "assistant.message", data: { content: "Answer" } },
    ]);

    expect(entries.filter((entry) => entry.type === "message").map((entry) => entry.undoEventId))
      .toEqual([undefined, undefined]);
  });

  it("keeps the human undo boundary across hidden sub-agent instructions", () => {
    const entries = transformEventsToMessages([
      { id: "user-1", type: "user.message", data: { content: "First" } },
      {
        id: "agent-prompt",
        type: "user.message",
        agentId: "agent-1",
        data: {
          content: "Inspect the repository",
          source: "agent-parent-session",
          parentAgentTaskId: "task-1",
        },
      },
      { id: "assistant-1", type: "assistant.message", data: { content: "Answer" } },
    ]);

    expect(entries.filter((entry) => entry.type === "message").map((entry) => ({
      content: entry.content,
      undoEventId: entry.undoEventId,
    }))).toEqual([
      { content: "First", undoEventId: "user-1" },
      { content: "Answer", undoEventId: "user-1" },
    ]);
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

  it("flushes a pending terminal completion when the turn aborts, shuts down, or errors", () => {
    // abort before a completion event: uses the abort timestamp
    const abortEntries = transformEventsToMessages([
      { type: "assistant.turn_start", timestamp: "2026-04-10T10:00:00.000Z", data: {} },
      {
        type: "tool.execution_start",
        timestamp: "2026-04-10T10:00:01.000Z",
        data: { toolCallId: "tool-1", toolName: "task_complete", arguments: { summary: "Stopped after wrapping up" } },
      },
      {
        type: "tool.execution_complete",
        timestamp: "2026-04-10T10:00:02.000Z",
        data: { toolCallId: "tool-1", success: true, result: { content: "ok" } },
      },
      { type: "abort", timestamp: "2026-04-10T10:00:03.000Z", data: { reason: "user cancelled" } },
    ]);

    expect(abortEntries, "abort").toMatchObject([{
      type: "completion",
      content: "Stopped after wrapping up",
      timestamp: "2026-04-10T10:00:03.000Z",
      turnId: "turn-1",
      completion: { sourceEventType: "tool.execution_complete" },
    }]);

    // shutdown and error terminals
    for (const terminal of ["session.shutdown", "session.error"]) {
      const entries = transformEventsToMessages([
        {
          type: "tool.execution_start",
          timestamp: "2026-04-10T10:00:00.000Z",
          data: { toolCallId: "tool-1", toolName: "task_complete", arguments: { summary: "Final summary" } },
        },
        {
          type: "tool.execution_complete",
          timestamp: "2026-04-10T10:00:01.000Z",
          data: { toolCallId: "tool-1", success: true, result: { content: "ok" } },
        },
        { type: terminal, timestamp: "2026-04-10T10:00:02.000Z", data: {} },
      ]);

      expect(entries, terminal).toMatchObject([{
        type: "completion",
        content: "Final summary",
        completion: { sourceEventType: "tool.execution_complete" },
      }]);
    }
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

  it("nests sub-agent instructions instead of rendering them as human messages", () => {
    const initialPrompt = "Inspect the scheduler recovery tests.";
    const followUp = "Also verify the Windows path.";
    const initialInstructionEvent = {
      id: "agent-prompt-1",
      type: "user.message",
      agentId: "agent-instance-1",
      timestamp: "2026-04-10T10:00:04.000Z",
      data: {
        content: "Inspect the scheduler\nrecovery tests.",
        source: "agent-parent-session",
        parentAgentTaskId: "task-1",
      },
    };
    const entries = transformEventsToMessages([
      {
        id: "user-1",
        type: "user.message",
        timestamp: "2026-04-10T10:00:00.000Z",
        data: { content: "Please investigate the flaky test." },
      },
      {
        type: "tool.execution_start",
        timestamp: "2026-04-10T10:00:01.000Z",
        data: {
          toolCallId: "agent-tool",
          toolName: "task",
          arguments: {
            description: "Investigate scheduler race",
            prompt: initialPrompt,
            mode: "background",
          },
        },
      },
      {
        type: "subagent.started",
        agentId: "agent-instance-1",
        timestamp: "2026-04-10T10:00:02.000Z",
        data: {
          toolCallId: "agent-tool",
          agentName: "explore",
          agentDisplayName: "Explore agent",
        },
      },
      {
        type: "tool.execution_complete",
        timestamp: "2026-04-10T10:00:03.000Z",
        data: {
          toolCallId: "agent-tool",
          success: true,
          result: { content: "Agent started in background" },
        },
      },
      initialInstructionEvent,
      {
        type: "tool.execution_start",
        timestamp: "2026-04-10T10:00:05.000Z",
        data: {
          toolCallId: "child-tool",
          toolName: "rg",
          parentToolCallId: "agent-tool",
          arguments: { pattern: "scheduler" },
        },
      },
      {
        type: "user.message",
        timestamp: "2026-04-10T10:00:06.000Z",
        data: {
          content: followUp,
          source: "agent-parent-session",
          parentAgentTaskId: "task-1",
        },
      },
      {
        type: "assistant.message",
        agentId: "agent-instance-1",
        timestamp: "2026-04-10T10:00:07.000Z",
        data: { parentToolCallId: "agent-tool", content: "The race is in the restart-state read." },
      },
    ]);

    expect(entries.filter((entry) => entry.type === "message")).toMatchObject([
      { role: "user", content: "Please investigate the flaky test." },
    ]);
    expect(entries.find((entry) => entry.type === "tool" && entry.toolCall?.toolCallId === "agent-tool"))
      .toMatchObject({
        toolCall: {
          name: "🤖 Explore agent",
          result: "The race is in the restart-state read.",
          agentInstructions: [
            { kind: "task", content: initialPrompt },
            { kind: "follow_up", content: followUp },
          ],
        },
      });
    expect(isVisibleMessageEvent(initialInstructionEvent)).toBe(false);
    expect(getUndoBoundaryEventId(initialInstructionEvent)).toBeUndefined();
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

  it("marks open tools as failed when the turn terminates (shutdown, session.error, abort)", () => {
    for (const { label, terminalEvent } of [
      { label: "shutdown", terminalEvent: { type: "session.shutdown", timestamp: "2026-04-10T10:00:02.000Z", data: { shutdownType: "graceful" } } },
      { label: "session.error", terminalEvent: { type: "session.error", timestamp: "2026-04-10T10:00:02.000Z", data: { message: "runtime failed" } } },
      { label: "abort", terminalEvent: { type: "abort", timestamp: "2026-04-10T10:00:02.000Z", data: { reason: "user cancelled" } } },
    ]) {
      const toolCallId = `tool-${label}`;
      const entries = transformEventsToMessages([
        { type: "tool.execution_start", timestamp: "2026-04-10T10:00:00.000Z", data: { toolCallId, toolName: "bash", arguments: { command: "npm test" } } },
        { type: "tool.execution_progress", timestamp: "2026-04-10T10:00:01.000Z", data: { toolCallId, progressMessage: "Running tests..." } },
        terminalEvent,
      ]);

      expect(entries, label).toMatchObject([{
        type: "tool",
        toolCall: {
          toolCallId,
          name: "bash",
          progressText: "Running tests...",
          success: false,
          completedAt: "2026-04-10T10:00:02.000Z",
        },
      }]);
    }
  });

  it("keeps subagent session.error scoped to the agent tool", () => {
    const entries = transformEventsToMessages([
      {
        type: "assistant.turn_start",
        timestamp: "2026-07-24T17:54:20.000Z",
        data: { turnId: "35" },
      },
      {
        type: "tool.execution_start",
        timestamp: "2026-07-24T17:54:28.000Z",
        data: {
          toolCallId: "agent-call-1",
          toolName: "task",
          arguments: { mode: "sync", agent_type: "code-review" },
        },
      },
      {
        type: "subagent.started",
        agentId: "subagent-instance-9",
        timestamp: "2026-07-24T17:54:28.100Z",
        data: {
          toolCallId: "agent-call-1",
          agentName: "code-review",
          agentDisplayName: "Code Review Agent",
        },
      },
      {
        type: "session.error",
        agentId: "subagent-instance-9",
        timestamp: "2026-07-24T17:59:30.000Z",
        data: {
          errorType: "query",
          message: "CAPIError: flagged child request",
        },
      },
      {
        type: "subagent.completed",
        agentId: "subagent-instance-9",
        timestamp: "2026-07-24T17:59:30.010Z",
        data: { toolCallId: "agent-call-1" },
      },
      {
        type: "tool.execution_complete",
        timestamp: "2026-07-24T17:59:30.020Z",
        data: { toolCallId: "agent-call-1", success: true, result: "" },
      },
      {
        type: "assistant.message",
        timestamp: "2026-07-24T17:59:31.000Z",
        data: { content: "Parent continued." },
      },
    ]);

    expect(entries).toMatchObject([
      {
        type: "tool",
        toolCall: {
          toolCallId: "agent-call-1",
          name: "🤖 Code Review Agent",
          result: "CAPIError: flagged child request",
          success: false,
        },
      },
      {
        type: "message",
        role: "assistant",
        content: "Parent continued.",
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

  it("does not project sub-agent turn starts as primary assistant turns", () => {
    const entries = transformEventsToMessages([
      { type: "assistant.turn_start", data: { turnId: "parent-turn" } },
      {
        type: "tool.execution_start",
        data: { toolCallId: "agent-tool", toolName: "task", arguments: { prompt: "Investigate" } },
      },
      {
        type: "subagent.started",
        agentId: "agent-1",
        data: { toolCallId: "agent-tool", agentName: "explore" },
      },
      { type: "assistant.turn_end", data: { turnId: "parent-turn" } },
      { type: "assistant.turn_start", data: { turnId: "child-turn" } },
      {
        type: "tool.execution_start",
        data: {
          toolCallId: "child-tool",
          toolName: "rg",
          parentToolCallId: "agent-tool",
        },
      },
      {
        type: "subagent.completed",
        agentId: "agent-1",
        data: { toolCallId: "agent-tool" },
      },
      { type: "user.message", data: { content: "What did you find?" } },
      { type: "assistant.turn_start", data: { turnId: "next-parent-turn" } },
      { type: "assistant.message", data: { content: "Here is the result." } },
    ]);

    const childTool = entries.find((entry) => entry.type === "tool" && entry.toolCall?.toolCallId === "child-tool");
    const nextAssistant = entries.find((entry) => entry.role === "assistant");
    expect(childTool).toMatchObject({
      turnId: "subagent-turn-1",
      turnInstanceId: "subagent-turn-instance-1",
    });
    expect(nextAssistant).toMatchObject({
      content: "Here is the result.",
      turnId: "next-parent-turn",
      turnInstanceId: "turn-instance-2",
    });
  });
});

describe("event-transform file attachment display names", () => {
  it("derives the basename from both Windows-style backslash and POSIX-style forward-slash paths", () => {
    for (const { label, path, displayName } of [
      { label: "Windows", path: "C:\\Users\\me\\report.png", displayName: "report.png" },
      { label: "POSIX", path: "/home/me/report.png", displayName: "report.png" },
    ]) {
      const entries = transformEventsToMessages([{
        type: "user.message",
        timestamp: "2026-04-10T10:00:00.000Z",
        data: { content: "See attached", attachments: [{ type: "file", path }] },
      }]);

      expect(entries, label).toMatchObject([{
        type: "message",
        role: "user",
        attachments: [{ type: "file", path, displayName }],
      }]);
    }
  });

  it("prefers an explicit displayName over the derived basename", () => {
    const entries = transformEventsToMessages([
      {
        type: "user.message",
        timestamp: "2026-04-10T10:00:00.000Z",
        data: {
          content: "See attached",
          attachments: [{ type: "file", path: "C:\\Users\\me\\report.png", displayName: "Quarterly report" }],
        },
      },
    ]);

    expect(entries).toMatchObject([
      {
        type: "message",
        role: "user",
        attachments: [{ type: "file", path: "C:\\Users\\me\\report.png", displayName: "Quarterly report" }],
      },
    ]);
  });
});
