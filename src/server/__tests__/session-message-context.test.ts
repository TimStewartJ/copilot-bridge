import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  readMessagesAroundEventFromDisk,
  SessionMessageNotFoundError,
} from "../session-disk-reader.js";
import { makeTestDir } from "./helpers.js";

function deps(copilotHome: string) {
  return {
    copilotHome,
    eventBusRegistry: { getBus: () => undefined },
    resolveEffectiveSessionCwdFromWorkspaceYaml: () => undefined,
    recordSpan: () => {},
    persistLastVisibleActivityAt: () => {},
  };
}

describe("exact message context", () => {
  it("preserves embedded Unicode separators and still rejects malformed physical records", async () => {
    const copilotHome = makeTestDir("message-context-unicode");
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const dir = join(copilotHome, "session-state", sessionId);
    mkdirSync(dir, { recursive: true });
    const content = "needle\u2028separator\u2029tail";
    const record = JSON.stringify({ type: "assistant.message", id: "unicode", data: { content } });
    const path = join(dir, "events.jsonl");
    writeFileSync(path, `${record}\r\n`);
    const result = await readMessagesAroundEventFromDisk(deps(copilotHome), sessionId, "unicode", { before: 1, after: 1 });
    expect(result.messages).toMatchObject([{ sourceEventId: "unicode", content }]);
    writeFileSync(path, `${record}\r\n{"broken":`);
    await expect(readMessagesAroundEventFromDisk(deps(copilotHome), sessionId, "unicode", { before: 1, after: 1 }))
      .rejects.toThrow("malformed JSON at line 2");
  });

  it("returns a bounded window around the durable source event without warming", async () => {
    const copilotHome = makeTestDir("message-context");
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const dir = join(copilotHome, "session-state", sessionId);
    mkdirSync(dir, { recursive: true });
    const events = Array.from({ length: 7 }, (_, index) => ({
      type: index % 2 === 0 ? "user.message" : "assistant.message",
      id: `event-${index}`,
      timestamp: `2026-09-01T10:00:0${index}.000Z`,
      data: { content: `message ${index}` },
    }));
    writeFileSync(join(dir, "events.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);

    const result = await readMessagesAroundEventFromDisk(deps(copilotHome), sessionId, "event-3", {
      before: 2,
      after: 1,
    });

    expect(result.messages.map((message) => message.sourceEventId))
      .toEqual(["event-1", "event-2", "event-3", "event-4"]);
    expect(result).toMatchObject({
      total: 7,
      targetOffset: 3,
      startOffset: 1,
      endOffset: 5,
      hasMore: true,
      hasNewer: true,
    });
  });

  it("reports an explicit not-found error instead of falling back to latest", async () => {
    const copilotHome = makeTestDir("message-context-missing");
    const sessionId = "11111111-1111-4111-8111-111111111111";
    const dir = join(copilotHome, "session-state", sessionId);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "events.jsonl"), "");

    await expect(readMessagesAroundEventFromDisk(deps(copilotHome), sessionId, "missing", {
      before: 2,
      after: 2,
    })).rejects.toBeInstanceOf(SessionMessageNotFoundError);
  });
});
