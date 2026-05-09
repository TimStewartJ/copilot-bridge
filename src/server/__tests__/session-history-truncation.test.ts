import { describe, expect, it } from "vitest";
import { findQuietIntervalDeferTailTruncationCandidate } from "../session-history-truncation.js";

function quietIntervalUserMessage(id: string, deferId = "interval_loop-1") {
  return {
    id,
    type: "user.message",
    data: {
      content: [
        "<defer>",
        `deferId: ${deferId}`,
        "kind: interval",
        "attentionMode: quiet",
        "runCount: 1",
        "</defer>",
        "",
        "User prompt:",
        "Poll deployment",
      ].join("\n"),
    },
  };
}

describe("findQuietIntervalDeferTailTruncationCandidate", () => {
  it("returns the matching quiet interval user message when it is the completed tail", () => {
    const candidate = findQuietIntervalDeferTailTruncationCandidate([
      { id: "normal-user", type: "user.message", data: { content: "hello" } },
      { id: "normal-idle", type: "session.idle", data: {} },
      quietIntervalUserMessage("quiet-user"),
      { id: "turn-start", type: "assistant.turn_start", data: {} },
      { id: "assistant", type: "assistant.message", data: { content: "No change" } },
      { id: "idle", type: "session.idle", data: {} },
      { id: "resume", type: "session.resume", data: {} },
    ], "interval_loop-1");

    expect(candidate).toEqual({ eventId: "quiet-user", eventsToRemove: 5 });
  });

  it("rejects tails when the latest user message is not the same quiet interval defer", () => {
    expect(findQuietIntervalDeferTailTruncationCandidate([
      quietIntervalUserMessage("quiet-user"),
      { id: "idle", type: "session.idle", data: {} },
      { id: "normal-user", type: "user.message", data: { content: "hello" } },
      { id: "normal-idle", type: "session.idle", data: {} },
    ], "interval_loop-1")).toBeUndefined();

    expect(findQuietIntervalDeferTailTruncationCandidate([
      quietIntervalUserMessage("other-quiet-user", "interval_other"),
      { id: "idle", type: "session.idle", data: {} },
    ], "interval_loop-1")).toBeUndefined();
  });

  it("preserves quiet interval tails that raised attention, produced artifacts, or used mutating tools", () => {
    for (const toolName of ["ask_user", "send_attachment", "publish_visual", "bash", "task_create"]) {
      expect(findQuietIntervalDeferTailTruncationCandidate([
        quietIntervalUserMessage("quiet-user"),
        { id: `${toolName}-start`, type: "tool.execution_start", data: { toolCallId: "tool-1", toolName } },
        { id: "idle", type: "session.idle", data: {} },
      ], "interval_loop-1")).toBeUndefined();
    }
  });

  it("preserves failed, interrupted, and incomplete quiet interval tails", () => {
    expect(findQuietIntervalDeferTailTruncationCandidate([
      quietIntervalUserMessage("quiet-user"),
      { id: "tool-start", type: "tool.execution_start", data: { toolCallId: "tool-1", toolName: "bash" } },
      { id: "tool-done", type: "tool.execution_complete", data: { toolCallId: "tool-1", success: false } },
      { id: "idle", type: "session.idle", data: {} },
    ], "interval_loop-1")).toBeUndefined();

    expect(findQuietIntervalDeferTailTruncationCandidate([
      quietIntervalUserMessage("quiet-user"),
      { id: "tool-start", type: "tool.execution_start", data: { toolCallId: "tool-1", toolName: "web_search" } },
      { id: "tool-done", type: "tool.execution_complete", data: { toolCallId: "tool-1" } },
      { id: "idle", type: "session.idle", data: {} },
    ], "interval_loop-1")).toBeUndefined();

    expect(findQuietIntervalDeferTailTruncationCandidate([
      quietIntervalUserMessage("quiet-user"),
      { id: "error", type: "session.error", data: { message: "failed" } },
    ], "interval_loop-1")).toBeUndefined();

    expect(findQuietIntervalDeferTailTruncationCandidate([
      quietIntervalUserMessage("quiet-user"),
      { id: "assistant", type: "assistant.message", data: { content: "still working" } },
    ], "interval_loop-1")).toBeUndefined();
  });

  it("allows completed read-only tool work inside an otherwise quiet tail", () => {
    expect(findQuietIntervalDeferTailTruncationCandidate([
      quietIntervalUserMessage("quiet-user"),
      { id: "tool-start", type: "tool.execution_start", data: { toolCallId: "tool-1", toolName: "web_search" } },
      { id: "tool-done", type: "tool.execution_complete", data: { toolCallId: "tool-1", success: true } },
      { id: "idle", type: "session.idle", data: {} },
    ], "interval_loop-1")).toEqual({ eventId: "quiet-user", eventsToRemove: 4 });
  });

  it("rejects turn activity after the idle terminal because truncation would remove newer work", () => {
    expect(findQuietIntervalDeferTailTruncationCandidate([
      quietIntervalUserMessage("quiet-user"),
      { id: "idle", type: "session.idle", data: {} },
      { id: "late-assistant", type: "assistant.message", data: { content: "late" } },
    ], "interval_loop-1")).toBeUndefined();
  });
});
