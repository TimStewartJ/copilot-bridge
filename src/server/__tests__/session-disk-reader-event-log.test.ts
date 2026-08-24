import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  findSessionEventIndex,
  readRecentUserMessages,
  readSessionEventsTail,
  resolveSessionEventsPath,
} from "../session-disk-reader.js";

const fixtures: string[] = [];

function writeFixture(lines: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), "event-log-reader-"));
  fixtures.push(dir);
  const eventsPath = join(dir, "events.jsonl");
  writeFileSync(eventsPath, lines.join("\n") + "\n");
  return eventsPath;
}

function event(id: string, type: string, data: Record<string, unknown> = {}): string {
  return JSON.stringify({ id, type, data, timestamp: "2026-08-24T20:00:00.000Z" });
}

function bulky(id: string, bytes: number): string {
  return event(id, "assistant.message_delta", { deltaContent: "z".repeat(bytes) });
}

afterEach(() => {
  for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("resolveSessionEventsPath", () => {
  it("builds the COPILOT_HOME session-state path", () => {
    expect(resolveSessionEventsPath(join("home", ".copilot"), "abc")).toBe(
      join("home", ".copilot", "session-state", "abc", "events.jsonl"),
    );
  });
});

describe("readSessionEventsTail", () => {
  it("returns the whole log for small files", async () => {
    const eventsPath = writeFixture([event("a", "user.message"), event("b", "session.idle")]);
    const tail = await readSessionEventsTail(eventsPath);
    expect(tail.complete).toBe(true);
    expect(tail.startOffset).toBe(0);
    expect(tail.events.map((e: any) => e.id)).toEqual(["a", "b"]);
  });

  it("grows the window from the end until the predicate is satisfied and never reads the whole file", async () => {
    const lines = [
      event("old-user", "user.message", { content: "first" }),
      bulky("old-delta", 700 * 1024),
      event("old-end", "assistant.turn_end"),
      event("new-user", "user.message", { content: "second" }),
      bulky("new-delta", 300 * 1024),
      event("new-end", "assistant.turn_end"),
    ];
    const eventsPath = writeFixture(lines);
    const tail = await readSessionEventsTail(eventsPath, {
      hasEnough: (events) => events.some((e: any) => e.type === "user.message"),
    });
    expect(tail.complete).toBe(false);
    const ids = tail.events.map((e: any) => e.id);
    // The window is line-aligned, so it may carry a few events before the boundary, but never the old turn body.
    expect(ids.slice(-3)).toEqual(["new-user", "new-delta", "new-end"]);
    expect(ids).not.toContain("old-user");
    expect(ids).not.toContain("old-delta");
    expect(tail.bytesRead).toBeLessThan(tail.fileSize);
    expect(tail.startOffset).toBeGreaterThan(0);
  });

  it("stops at maxBytes instead of materializing a larger window", async () => {
    const lines = [
      event("user", "user.message", { content: "q" }),
      bulky("d1", 600 * 1024),
      bulky("d2", 600 * 1024),
      event("end", "assistant.turn_end"),
    ];
    const eventsPath = writeFixture(lines);
    const tail = await readSessionEventsTail(eventsPath, {
      maxBytes: 512 * 1024,
      hasEnough: (events) => events.some((e: any) => e.type === "user.message"),
    });
    expect(tail.complete).toBe(false);
    expect(tail.bytesRead).toBeLessThanOrEqual(512 * 1024);
    expect(tail.events.map((e: any) => e.id)).toEqual(["end"]);
  });

  it("honours maxEvents and tolerates malformed lines and CRLF", async () => {
    const dir = mkdtempSync(join(tmpdir(), "event-log-reader-"));
    fixtures.push(dir);
    const eventsPath = join(dir, "events.jsonl");
    writeFileSync(eventsPath, [event("a", "x"), "{not json", event("b", "y"), event("c", "z")].join("\r\n") + "\r\n");
    const tail = await readSessionEventsTail(eventsPath, { maxEvents: 2 });
    expect(tail.events.map((e: any) => e.id)).toEqual(["a", "b", "c"]);
    expect(tail.malformedLineCount).toBe(1);
  });
});

describe("findSessionEventIndex", () => {
  it("streams the file and reports index, events after, and preceding events", async () => {
    const lines = [
      event("u1", "user.message", { content: "one" }),
      bulky("d1", 300 * 1024),
      event("e1", "assistant.turn_end"),
      event("u2", "user.message", { content: "two" }),
      bulky("d2", 300 * 1024),
      event("e2", "assistant.turn_end"),
    ];
    const eventsPath = writeFixture(lines);
    const seenBefore: string[] = [];
    const match = await findSessionEventIndex(eventsPath, "u2", {
      onEventBefore: (e: any) => seenBefore.push(e.id),
    });
    expect(match).toMatchObject({ index: 3, eventsAfter: 2, totalEvents: 6 });
    expect((match?.event as any).id).toBe("u2");
    expect(seenBefore).toEqual(["u1", "d1", "e1"]);
  });

  it("returns undefined when no event matches and supports a custom matcher", async () => {
    const eventsPath = writeFixture([event("u1", "user.message", { content: "one" }), event("e1", "assistant.turn_end")]);
    await expect(findSessionEventIndex(eventsPath, "missing")).resolves.toBeUndefined();
    const match = await findSessionEventIndex(eventsPath, "ignored", {
      matches: (e: any) => e.type === "assistant.turn_end",
    });
    expect(match).toMatchObject({ index: 1, eventsAfter: 0, totalEvents: 2 });
  });

  it("handles lines that span read chunks", async () => {
    const lines: string[] = [];
    for (let i = 0; i < 12; i += 1) lines.push(bulky(`d${i}`, 100 * 1024 + i));
    lines.push(event("target", "user.message", { content: "find me" }));
    lines.push(bulky("after", 50 * 1024));
    const eventsPath = writeFixture(lines);
    const match = await findSessionEventIndex(eventsPath, "target");
    expect(match).toMatchObject({ index: 12, eventsAfter: 1, totalEvents: 14 });
  });
});

describe("readRecentUserMessages", () => {
  it("returns the newest plain user prompts in order, skipping agent and sourced messages", async () => {
    const eventsPath = writeFixture([
      event("u1", "user.message", { content: "first" }),
      JSON.stringify({ id: "agent", type: "user.message", agentId: "agent-1", data: { content: "sub-agent instructions" } }),
      event("skill", "user.message", { content: "<skill-context>", source: "skill-browser" }),
      event("u2", "user.message", { content: "  second  " }),
      event("a", "assistant.message", { content: "reply" }),
      event("u3", "user.message", { content: "third" }),
    ]);
    await expect(readRecentUserMessages(eventsPath, 2)).resolves.toEqual(["second", "third"]);
    await expect(readRecentUserMessages(eventsPath, 10)).resolves.toEqual(["first", "second", "third"]);
  });

  it("returns an empty list when the log does not exist", async () => {
    await expect(readRecentUserMessages(join(tmpdir(), "event-log-reader-missing", "events.jsonl"), 5)).resolves.toEqual([]);
  });
});
