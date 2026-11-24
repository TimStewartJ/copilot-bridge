import { describe, expect, it, vi } from "vitest";
import type { TransformedEntry } from "../event-transform.js";
import { readSessionHistory } from "../session-history-read.js";

const SESSION = "00000000-0000-4000-8000-000000000002";

function message(id: string, role: string, content: string, extra: Partial<TransformedEntry> = {}): TransformedEntry {
  return { id, type: "message", role, content, ...extra };
}

const HISTORY: TransformedEntry[] = [
  message("u1", "user", "Run the nightly gates on master."),
  message("p1", "assistant", "Starting the gates.", { progressUpdate: true }),
  { id: "t1", type: "tool", toolCall: { toolCallId: "c1", name: "powershell", result: "ok" } },
  {
    id: "a1",
    type: "tool",
    toolCall: {
      toolCallId: "c2", name: "task", isSubAgent: true, args: { name: "review-3" },
      result: `${"x".repeat(5_000)} ## Attention: the save proof has no failing control. ${"y".repeat(5_000)}`,
    },
  },
  { id: "t2", type: "tool", toolCall: { toolCallId: "c3", name: "view", parentToolCallId: "c2", result: "inner" } },
  message("r1", "assistant", "The gates pass; review-3 flagged the save proof."),
  message("u2", "user", "Fix the save proof."),
  message("r2", "assistant", "Fixed and merged."),
];

const readTranscript = vi.fn(async (_sessionId: string, opts?: { limit?: number }) => {
  const messages = opts?.limit ? HISTORY.slice(-opts.limit) : HISTORY;
  return { messages, total: HISTORY.length };
});

describe("readSessionHistory", () => {
  it("returns messages and sub-agent results and pages back from nextBefore", async () => {
    const latest = await readSessionHistory(readTranscript, SESSION, { limit: 2 });
    expect(latest.items.map((item) => item.content)).toEqual(["Fix the save proof.", "Fixed and merged."]);
    expect(latest.nextBefore).toBe(6);

    const earlier = await readSessionHistory(readTranscript, SESSION, { limit: 5, before: latest.nextBefore });
    expect(earlier.items.map((item) => [item.offset, item.role])).toEqual([[0, "user"], [3, "agent"], [5, "assistant"]]);
    expect(earlier.items[1]).toMatchObject({ agent: "review-3", truncated: true });
    expect(earlier.nextBefore).toBeUndefined();
  });

  it("keeps items containing every query word and clips long ones around the match", async () => {
    const result = await readSessionHistory(readTranscript, SESSION, { query: "ATTENTION save proof" });
    expect(result.matches).toBe(1);
    expect(result.items[0]!.content).toContain("## Attention: the save proof has no failing control.");
    expect(result.items[0]!.content.length).toBeLessThan(4_100);
  });
});
