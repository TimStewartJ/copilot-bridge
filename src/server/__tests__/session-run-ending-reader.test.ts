import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readPersistedRunEnding } from "../session-run-ending-reader.js";
import { makeTestDir } from "./helpers.js";

const RUN_STARTED_AT = Date.parse("2026-09-20T07:03:33.000Z");

function at(offsetMs: number): string {
  return new Date(RUN_STARTED_AT + offsetMs).toISOString();
}

function writeLog(name: string, events: unknown[]): string {
  const dir = makeTestDir(name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "events.jsonl");
  writeFileSync(path, events.map((event) => JSON.stringify(event)).join("\n") + "\n");
  return path;
}

describe("readPersistedRunEnding", () => {
  it("reports the main agent's last turn end and reply as an inconclusive ending", async () => {
    const path = writeLog("ending-turn-end", [
      { id: "reply-1", type: "assistant.message", timestamp: at(1_000), data: { content: "first" } },
      { id: "end-1", type: "assistant.turn_end", timestamp: at(2_000), data: { turnId: "0" } },
      { id: "reply-2", type: "assistant.message", timestamp: at(3_000), data: { content: "final" } },
      { id: "end-2", type: "assistant.turn_end", timestamp: at(4_000), data: { turnId: "1" } },
    ]);

    const ending = await readPersistedRunEnding(path, RUN_STARTED_AT);

    expect(ending).toMatchObject({
      conclusive: false,
      assistantContent: "final",
      assistantSourceEventId: "reply-2",
    });
    expect(ending.event.id).toBe("end-2");
  });

  it("skips everything a sub-agent wrote to the shared log", async () => {
    // The shape that ended a working run on 2026-09-20: the main agent is mid-turn and an explore
    // agent's last turn end is the newest line.
    const path = writeLog("ending-subagent-tail", [
      { id: "main-end", type: "assistant.turn_end", timestamp: at(1_000), data: { turnId: "5" } },
      { id: "main-start", type: "assistant.turn_start", timestamp: at(1_000), data: { turnId: "6" } },
      { id: "sub-reply", type: "assistant.message", agentId: "explore-1", timestamp: at(2_000), data: { content: "report" } },
      { id: "sub-error", type: "session.error", agentId: "explore-1", timestamp: at(2_500), data: { message: "child failed" } },
      { id: "sub-end", type: "assistant.turn_end", agentId: "explore-1", timestamp: at(3_000), data: { turnId: "7" } },
    ]);

    const ending = await readPersistedRunEnding(path, RUN_STARTED_AT);

    expect(ending.event.id).toBe("main-end");
    expect(ending.conclusive).toBe(false);
    expect(ending.assistantContent).toBeUndefined();
  });

  it("skips a sub-agent reply that an older runtime marks only with its parent tool call", async () => {
    const path = writeLog("ending-parent-tool-call", [
      { id: "reply", type: "assistant.message", timestamp: at(1_000), data: { content: "mine" } },
      { id: "child", type: "assistant.message", timestamp: at(2_000), data: { content: "theirs", parentToolCallId: "call-1" } },
    ]);

    expect(await readPersistedRunEnding(path, RUN_STARTED_AT)).toMatchObject({
      assistantContent: "mine",
      assistantSourceEventId: "reply",
    });
  });

  it.each(["session.error", "abort", "session.shutdown"])("treats %s as conclusive and keeps it over a later turn end", async (type) => {
    const path = writeLog(`ending-conclusive-${type.replace(".", "-")}`, [
      { id: "conclusive", type, timestamp: at(1_000), data: { message: "stopped" } },
      { id: "later-end", type: "assistant.turn_end", timestamp: at(1_005), data: { turnId: "2" } },
      { id: "later-shutdown", type: "session.shutdown", timestamp: at(2_000), data: { shutdownType: "routine" } },
    ]);

    const ending = await readPersistedRunEnding(path, RUN_STARTED_AT);

    expect(ending.conclusive).toBe(true);
    expect(ending.event.id).toBe("conclusive");
  });

  it("ignores events from before the run started and lines that do not parse", async () => {
    const dir = makeTestDir("ending-before-run");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, "events.jsonl");
    writeFileSync(path, [
      JSON.stringify({ id: "old-shutdown", type: "session.shutdown", timestamp: at(-60_000), data: {} }),
      JSON.stringify({ id: "old-reply", type: "assistant.message", timestamp: at(-30_000), data: { content: "earlier run" } }),
      "{ this line is still being written",
      JSON.stringify({ id: "untimed", type: "assistant.turn_end", data: {} }),
    ].join("\r\n") + "\r\n");

    expect(await readPersistedRunEnding(path, RUN_STARTED_AT)).toEqual({ conclusive: false });
  });

  it("reports no ending when the log does not exist", async () => {
    const path = join(makeTestDir("ending-missing"), "events.jsonl");
    expect(await readPersistedRunEnding(path, RUN_STARTED_AT)).toEqual({ conclusive: false });
  });
});
