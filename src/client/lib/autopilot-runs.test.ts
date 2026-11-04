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
  it("links the last matching report only within its run and selected playbook", () => {
    const start: ChatEntry = { type: "message", role: "user", content: "Check the change", agentMode: "autopilot" };
    const select = (id: string, playbook: string, success = true): ChatEntry => ({
      type: "tool", toolCall: { toolCallId: id, name: "bridge-tools-session-playbook_select", success: true,
        args: { playbook }, result: JSON.stringify({ success, playbook }) },
    });
    const report = (id: string, playbook: string, parentToolCallId?: string): ChatEntry => ({
      type: "tool", toolCall: { toolCallId: id, parentToolCallId, name: "verify_complete", success: true,
        args: { summary: "Checked the form", evidence: [{ kind: "tested", claim: "Desktop form works", result: "pass" }] },
        result: JSON.stringify({ success: true, status: "partial", playbook }) },
    });
    const end = (id: string) => completion(id, "2026-09-27T10:11:00.000Z");
    const withReport = end("reported"), missing = end("missing"), switched = end("switched"), direct = end("direct"), uncertain = end("uncertain");
    const summaries = summarize([
      start, select("s1", "feature"), report("r1", "feature"), report("r2", "feature"), withReport,
      start, select("s2", "feature"), report("child", "feature", "worker"), missing,
      start, select("s3", "investigate"), report("earlier", "investigate"), select("s4", "bug-fix"), report("wrong", "investigate"), switched,
      start, select("s5", "none"), select("rejected", "feature", false), report("other", "feature"), direct,
      start, select("s6", "feature"), report("r3", "feature"), start, uncertain,
    ]);
    expect(summaries.get(withReport)?.verification).toEqual({ kind: "recorded", status: "partial", toolCallId: "r2" });
    expect(summaries.get(missing)?.verification).toEqual({ kind: "missing" });
    expect(summaries.get(switched)?.verification).toEqual({ kind: "missing" });
    expect(summaries.get(direct)?.verification).toBeUndefined();
    expect(summaries.get(uncertain)?.verification).toBeUndefined();
  });

  it("reports figures only for unsteered Autopilot runs in the same transcript", () => {
    const steered = completion("steered", "2026-09-27T10:11:00.000Z");
    const measured = completion("measured", "2026-09-27T11:11:00.000Z");
    const summaries = summarize([
      { type: "message", role: "user", content: "fix it", agentMode: "autopilot", timestamp: "2026-09-27T10:00:00.000Z" },
      { type: "message", role: "assistant", content: "step one" },
      { type: "continuation", id: "c1" },
      { type: "message", role: "user", content: "also the docs", agentMode: "autopilot", timestamp: "2026-09-27T10:05:00.000Z" },
      { type: "continuation", id: "c2" },
      { type: "continuation", id: "c3" },
      steered,
      { type: "message", role: "user", content: "verify it", agentMode: "autopilot", timestamp: "2026-09-27T11:00:00.000Z" },
      { type: "message", role: "assistant", content: "running checks" },
      { type: "continuation", id: "c4" },
      { type: "message", role: "assistant", content: "checking the results" },
      { type: "continuation", id: "c5" },
      measured,
    ]);
    expect(summaries.get(steered)).toEqual({});
    expect(summaries.get(measured)).toEqual({ turns: 3, durationMs: 11 * 60_000 });
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

