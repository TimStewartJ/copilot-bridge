import { describe, expect, it } from "vitest";
import type { ChatCompletionEntry, ChatEntry } from "../api";
import { groupActivitySegments } from "./chat-activity";
import { segmentChatEntries } from "./tool-call-tree";
import { summarizeAutopilotRuns } from "./autopilot-runs";

function completion(id: string, timestamp: string): ChatCompletionEntry {
  return {
    id,
    type: "completion",
    timestamp,
    content: "Done",
    completion: { content: "Done", title: "Task complete", status: "success", sourceEventType: "session.task_complete" },
  };
}

function summarize(entries: ChatEntry[]) {
  return summarizeAutopilotRuns(groupActivitySegments(segmentChatEntries(entries)));
}

describe("summarizeAutopilotRuns", () => {
  it("marks a run with a second message as Autopilot without figures", () => {
    const done = completion("done", "2026-09-27T10:11:00.000Z");
    const summaries = summarize([
      { type: "message", role: "user", content: "fix it", agentMode: "autopilot", timestamp: "2026-09-27T10:00:00.000Z" },
      { type: "message", role: "assistant", content: "step one" },
      { type: "continuation", id: "c1" },
      { type: "message", role: "user", content: "also the docs", agentMode: "autopilot", timestamp: "2026-09-27T10:05:00.000Z" },
      { type: "continuation", id: "c2" },
      { type: "continuation", id: "c3" },
      done,
    ]);
    // A second message (steering, or a new run after a stop) makes the start uncertain: no figures.
    expect(summaries.get(done)).toEqual({});
  });

  it("counts the turns and time of an autopilot run with no other message in it", () => {
    const done = completion("done", "2026-09-27T10:11:00.000Z");
    const summaries = summarize([
      { type: "message", role: "user", content: "fix it", agentMode: "autopilot", timestamp: "2026-09-27T10:00:00.000Z" },
      { type: "message", role: "assistant", content: "step one" },
      { type: "continuation", id: "c1" },
      { type: "message", role: "assistant", content: "step two" },
      { type: "continuation", id: "c2" },
      done,
    ]);
    expect(summaries.get(done)).toEqual({ turns: 3, durationMs: 11 * 60_000 });
  });

  it("does not summarize a completion whose run did not start with Autopilot in the loaded history", () => {
    const orphan = completion("orphan", "2026-09-27T10:02:00.000Z");
    const interrupted = completion("interrupted", "2026-09-27T10:09:00.000Z");
    const summaries = summarize([
      { type: "continuation", id: "c0" },
      orphan,
      { type: "message", role: "user", content: "go", agentMode: "autopilot", timestamp: "2026-09-27T10:03:00.000Z" },
      { type: "message", role: "user", content: "normal question", timestamp: "2026-09-27T10:04:00.000Z" },
      interrupted,
    ]);
    expect(summaries.has(orphan)).toBe(false);
    expect(summaries.has(interrupted)).toBe(false);
  });
});

