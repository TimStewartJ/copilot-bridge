import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  findQuietIntervalDeferTailTruncationCandidate,
  truncateQuietIntervalDeferTail,
} from "../session-history-truncation.js";
import { makeTestDir } from "./helpers.js";

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
  it("returns the matching quiet interval user message when persisted history has a completed turn tail", () => {
    const candidate = findQuietIntervalDeferTailTruncationCandidate([
      { id: "normal-user", type: "user.message", data: { content: "hello" } },
      { id: "normal-turn-end", type: "assistant.turn_end", data: {} },
      quietIntervalUserMessage("quiet-user"),
      { id: "turn-start", type: "assistant.turn_start", data: {} },
      { id: "assistant", type: "assistant.message", data: { content: "No change" } },
      { id: "turn-end", type: "assistant.turn_end", data: {} },
      { id: "resume", type: "session.resume", data: {} },
    ], "interval_loop-1");

    expect(candidate).toEqual({ eventId: "quiet-user", eventsToRemove: 5 });
  });

  it("keeps accepting live-shaped session idle completion tails", () => {
    expect(findQuietIntervalDeferTailTruncationCandidate([
      quietIntervalUserMessage("quiet-user"),
      { id: "turn-start", type: "assistant.turn_start", data: {} },
      { id: "assistant", type: "assistant.message", data: { content: "No change" } },
      { id: "idle", type: "session.idle", data: {} },
    ], "interval_loop-1")).toEqual({ eventId: "quiet-user", eventsToRemove: 4 });
  });

  it("rejects tails when the latest user message is not the same quiet interval defer", () => {
    expect(findQuietIntervalDeferTailTruncationCandidate([
      quietIntervalUserMessage("quiet-user"),
      { id: "turn-end", type: "assistant.turn_end", data: {} },
      { id: "normal-user", type: "user.message", data: { content: "hello" } },
      { id: "normal-turn-end", type: "assistant.turn_end", data: {} },
    ], "interval_loop-1")).toBeUndefined();

    expect(findQuietIntervalDeferTailTruncationCandidate([
      quietIntervalUserMessage("other-quiet-user", "interval_other"),
      { id: "turn-end", type: "assistant.turn_end", data: {} },
    ], "interval_loop-1")).toBeUndefined();
  });

  it("preserves quiet interval tails that asked for input or wrote docs/tasks", () => {
    for (const toolName of [
      "ask_user",
      "docs_write",
      "docs_edit",
      "docs_delete",
      "docs_db_create",
      "docs_db_add",
      "docs_db_update",
      "docs_db_delete",
      "docs_snapshot_create",
      "docs_snapshot_restore",
      "task_create",
      "task_update",
      "task_update_momentum",
      "task_link_work_item",
      "task_unlink_work_item",
      "task_link_pr",
      "task_unlink_pr",
      "task_group_create",
      "task_group_update",
      "task_group_delete",
      "checklist_add",
      "checklist_update",
      "checklist_remove",
      "tag_create",
      "tag_update",
      "tag_delete",
    ]) {
      expect(findQuietIntervalDeferTailTruncationCandidate([
        quietIntervalUserMessage("quiet-user"),
        { id: `${toolName}-start`, type: "tool.execution_start", data: { toolCallId: "tool-1", toolName } },
        { id: `${toolName}-done`, type: "tool.execution_complete", data: { toolCallId: "tool-1", success: true } },
        { id: "turn-end", type: "assistant.turn_end", data: {} },
      ], "interval_loop-1")).toBeUndefined();
    }
  });

  it("preserves failed, interrupted, and incomplete quiet interval tails", () => {
    expect(findQuietIntervalDeferTailTruncationCandidate([
      quietIntervalUserMessage("quiet-user"),
      { id: "tool-start", type: "tool.execution_start", data: { toolCallId: "tool-1", toolName: "bash" } },
      { id: "tool-done", type: "tool.execution_complete", data: { toolCallId: "tool-1", success: false } },
      { id: "turn-end", type: "assistant.turn_end", data: {} },
    ], "interval_loop-1")).toBeUndefined();

    expect(findQuietIntervalDeferTailTruncationCandidate([
      quietIntervalUserMessage("quiet-user"),
      { id: "tool-start", type: "tool.execution_start", data: { toolCallId: "tool-1", toolName: "web_search" } },
      { id: "tool-done", type: "tool.execution_complete", data: { toolCallId: "tool-1" } },
      { id: "turn-end", type: "assistant.turn_end", data: {} },
    ], "interval_loop-1")).toBeUndefined();

    expect(findQuietIntervalDeferTailTruncationCandidate([
      quietIntervalUserMessage("quiet-user"),
      { id: "tool-start", type: "tool.execution_start", data: { toolCallId: "tool-1" } },
      { id: "tool-done", type: "tool.execution_complete", data: { toolCallId: "tool-1", success: true } },
      { id: "turn-end", type: "assistant.turn_end", data: {} },
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

  it("allows completed state-checking, browser, bash, and custom MCP tool work inside an otherwise quiet tail", () => {
    for (const toolName of ["web_search", "bash", "browser_exec", "mcp__weather__get_forecast"]) {
      expect(findQuietIntervalDeferTailTruncationCandidate([
        quietIntervalUserMessage("quiet-user"),
        { id: `${toolName}-start`, type: "tool.execution_start", data: { toolCallId: "tool-1", toolName } },
        { id: `${toolName}-done`, type: "tool.execution_complete", data: { toolCallId: "tool-1", success: true } },
        { id: "turn-end", type: "assistant.turn_end", data: {} },
      ], "interval_loop-1")).toEqual({ eventId: "quiet-user", eventsToRemove: 4 });
    }
  });

  it("allows multiple assistant turns before the final completed quiet tail", () => {
    expect(findQuietIntervalDeferTailTruncationCandidate([
      quietIntervalUserMessage("quiet-user"),
      { id: "turn-start-1", type: "assistant.turn_start", data: {} },
      { id: "assistant-tools", type: "assistant.message", data: { content: "Checking...", toolRequests: [{}] } },
      { id: "tool-start", type: "tool.execution_start", data: { toolCallId: "tool-1", toolName: "web_search" } },
      { id: "tool-done", type: "tool.execution_complete", data: { toolCallId: "tool-1", success: true } },
      { id: "turn-end-1", type: "assistant.turn_end", data: {} },
      { id: "turn-start-2", type: "assistant.turn_start", data: {} },
      { id: "assistant-final", type: "assistant.message", data: { content: "No change" } },
      { id: "turn-end-2", type: "assistant.turn_end", data: {} },
      { id: "system", type: "system.message", data: {} },
    ], "interval_loop-1")).toEqual({ eventId: "quiet-user", eventsToRemove: 10 });
  });

  it("rejects turn activity after the completion terminal because truncation would remove newer work", () => {
    expect(findQuietIntervalDeferTailTruncationCandidate([
      quietIntervalUserMessage("quiet-user"),
      { id: "turn-end", type: "assistant.turn_end", data: {} },
      { id: "late-assistant", type: "assistant.message", data: { content: "late" } },
    ], "interval_loop-1")).toBeUndefined();
  });
});

class ReceiverSensitiveFakeSession {
  readonly truncateCalls: { eventId: string }[] = [];
  /** Every method invoked on the session; the truncation path may only ever call truncateHistory. */
  readonly methodCalls: string[] = [];

  constructor(private readonly events: unknown[]) {
    return new Proxy(this, {
      get: (target, property, receiver) => {
        const value = Reflect.get(target, property, receiver);
        if (typeof value === "function" && typeof property === "string") {
          return (...args: unknown[]) => {
            target.methodCalls.push(property);
            return value.apply(receiver, args);
          };
        }
        return value;
      },
    });
  }

  async truncateHistory(params: { eventId: string }) {
    this.truncateCalls.push(params);
    const index = this.events.findIndex((event) => (event as any).id === params.eventId);
    const eventsRemoved = index < 0 ? 0 : this.events.length - index;
    return { eventsRemoved };
  }
}

const silentLogger = { log() {}, warn() {} };

function writeEventsFixture(events: unknown[]): string {
  const dir = makeTestDir("history-truncation");
  const eventsPath = join(dir, "events.jsonl");
  writeFileSync(eventsPath, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  return eventsPath;
}

function bulkyEvent(id: string, bytes: number) {
  return { id, type: "assistant.message_delta", data: { deltaContent: "x".repeat(bytes) } };
}

describe("truncateQuietIntervalDeferTail", () => {
  const fixture = (events: unknown[]): string => writeEventsFixture(events);

  it("invokes truncateHistory with its receiver so prototype methods that depend on `this` work", async () => {
    const events = [
      quietIntervalUserMessage("quiet-user"),
      { id: "turn-start", type: "assistant.turn_start", data: {} },
      { id: "assistant", type: "assistant.message", data: { content: "No change" } },
      { id: "idle", type: "session.idle", data: {} },
    ];
    const session = new ReceiverSensitiveFakeSession(events);

    const result = await truncateQuietIntervalDeferTail({
      session,
      sessionId: "session-1",
      deferId: "interval_loop-1",
      eventsPath: fixture(events),
      logger: silentLogger,
    });

    expect(result).toEqual({
      status: "truncated",
      eventId: "quiet-user",
      eventsRemoved: 4,
      candidateEventsToRemove: 4,
    });
    expect(session.truncateCalls).toEqual([{ eventId: "quiet-user" }]);
    expect(session.methodCalls).toEqual(["truncateHistory"]);
  });

  it("finds the boundary from the disk tail of a multi-MB log without any history RPC", async () => {
    // ~6 MB of older turns that must never be read, then the quiet turn at the end.
    const older: unknown[] = [];
    for (let turn = 0; turn < 24; turn += 1) {
      older.push({ id: `user-${turn}`, type: "user.message", data: { content: `question ${turn}` } });
      older.push(bulkyEvent(`delta-${turn}`, 250 * 1024));
      older.push({ id: `end-${turn}`, type: "assistant.turn_end", data: {} });
    }
    const events = [
      ...older,
      quietIntervalUserMessage("quiet-user"),
      { id: "turn-start", type: "assistant.turn_start", data: {} },
      { id: "tool-start", type: "tool.execution_start", data: { toolCallId: "t1", toolName: "powershell" } },
      { id: "tool-done", type: "tool.execution_complete", data: { toolCallId: "t1", success: true } },
      { id: "assistant", type: "assistant.message", data: { content: "Still running" } },
      { id: "turn-end", type: "assistant.turn_end", data: {} },
      { id: "idle", type: "session.idle", data: {} },
    ];
    const session = new ReceiverSensitiveFakeSession(events);
    const spans: Array<{ name: string; metadata?: Record<string, unknown> }> = [];

    const result = await truncateQuietIntervalDeferTail({
      session,
      sessionId: "session-1",
      deferId: "interval_loop-1",
      eventsPath: fixture(events),
      logger: silentLogger,
      recordSpan: (name, _duration, _sessionId, metadata) => spans.push({ name, metadata }),
    });

    expect(result).toEqual({
      status: "truncated",
      eventId: "quiet-user",
      eventsRemoved: 7,
      candidateEventsToRemove: 7,
    });
    expect(session.methodCalls).toEqual(["truncateHistory"]);
    expect(spans).toEqual([{ name: "session.history.truncate", metadata: expect.objectContaining({ outcome: "truncated" }) }]);
  });

  it("skips without truncating when the last user turn is not a quiet defer for this loop", async () => {
    const events = [
      quietIntervalUserMessage("quiet-user"),
      { id: "idle-1", type: "session.idle", data: {} },
      { id: "normal-user", type: "user.message", data: { content: "hello" } },
      { id: "assistant", type: "assistant.message", data: { content: "hi" } },
      { id: "idle-2", type: "session.idle", data: {} },
    ];
    const session = new ReceiverSensitiveFakeSession(events);

    const result = await truncateQuietIntervalDeferTail({
      session,
      sessionId: "session-1",
      deferId: "interval_loop-1",
      eventsPath: fixture(events),
      logger: silentLogger,
    });

    expect(result).toEqual({ status: "skipped", reason: "no-candidate" });
    expect(session.methodCalls).toEqual([]);
  });

  it("skips when the previous turn is larger than the tail window instead of reading more", async () => {
    const events = [
      quietIntervalUserMessage("quiet-user"),
      bulkyEvent("delta-1", 600 * 1024),
      bulkyEvent("delta-2", 600 * 1024),
      { id: "idle", type: "session.idle", data: {} },
    ];
    const session = new ReceiverSensitiveFakeSession(events);

    const result = await truncateQuietIntervalDeferTail({
      session,
      sessionId: "session-1",
      deferId: "interval_loop-1",
      eventsPath: fixture(events),
      maxTailBytes: 512 * 1024,
      logger: silentLogger,
    });

    expect(result).toEqual({ status: "skipped", reason: "tail-window-exhausted" });
    expect(session.methodCalls).toEqual([]);
  });

  it("skips with no-event-log when the session has no persisted history yet", async () => {
    const session = new ReceiverSensitiveFakeSession([]);
    const result = await truncateQuietIntervalDeferTail({
      session,
      sessionId: "session-1",
      deferId: "interval_loop-1",
      eventsPath: join(tmpdir(), "history-truncation-missing", "events.jsonl"),
      logger: silentLogger,
    });

    expect(result).toEqual({ status: "skipped", reason: "no-event-log" });
    expect(session.methodCalls).toEqual([]);
  });

  it("skips with missing-api when the session cannot truncate history", async () => {
    const result = await truncateQuietIntervalDeferTail({
      session: {},
      sessionId: "session-1",
      deferId: "interval_loop-1",
      eventsPath: fixture([quietIntervalUserMessage("quiet-user")]),
      logger: silentLogger,
    });

    expect(result).toEqual({ status: "skipped", reason: "missing-api" });
  });
});