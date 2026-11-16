import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createScratchSessionId, SCRATCH_SESSION_IDLE_TTL_MS, sweepExpiredScratchSessions } from "../scratch-sessions.js";
import { makeTestDir } from "./helpers.js";

describe("sweepExpiredScratchSessions", () => {
  it("deletes only scratch chats idle past the limit that nothing is using", async () => {
    const copilotHome = makeTestDir("scratch-sweep");
    const now = Date.parse("2026-06-10T12:00:00.000Z");
    const writeSession = (sessionId: string, idleMs: number) => {
      const dir = join(copilotHome, "session-state", sessionId);
      mkdirSync(dir, { recursive: true });
      const events = join(dir, "events.jsonl");
      writeFileSync(events, "{}\n");
      const at = new Date(now - idleMs);
      utimesSync(events, at, at);
      return sessionId;
    };
    const day = SCRATCH_SESSION_IDLE_TTL_MS;
    const expired = writeSession(createScratchSessionId(), day + 60_000);
    writeSession(createScratchSessionId(), day - 60_000);
    const running = writeSession(createScratchSessionId(), 2 * day);
    writeSession("0b1e2c3d-0000-4000-8000-000000000001", 2 * day);
    const deleteSession = vi.fn(async (_sessionId: string) => {});

    const deleted = await sweepExpiredScratchSessions({
      copilotHome,
      isProtected: (sessionId) => sessionId === running,
      deleteSession,
      now: () => now,
    });

    expect(deleted).toEqual([expired]);
    expect(deleteSession.mock.calls).toEqual([[expired]]);
  });
});
