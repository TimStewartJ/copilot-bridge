import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db.js";
import { createDeferredPromptStore } from "../deferred-prompt-store.js";
import { createSessionMessageOutboxStore } from "../session-message-outbox-store.js";
import { makeTestDir } from "./helpers.js";

const LEGACY_RESULT = [
  "<deferred-work-result>",
  "deferId: interval_1",
  "kind: interval",
  "</deferred-work-result>",
  "",
  "A temporary deferred-work session returned this result. Continue from it without repeating the completed check:",
  "",
  "Done.",
].join("\n");

function createLegacyDatabase(dataDir: string): DatabaseSync {
  const db = new DatabaseSync(join(dataDir, "bridge.db"));
  db.exec(`
    CREATE TABLE deferred_prompts (
      id TEXT PRIMARY KEY,
      sessionId TEXT NOT NULL,
      prompt TEXT NOT NULL,
      runAt TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      claimToken TEXT,
      leaseExpiresAt TEXT,
      createdAt TEXT NOT NULL,
      updatedAt TEXT NOT NULL,
      lastError TEXT
    )
  `);
  return db;
}

describe("session message outbox migration", () => {
  it("moves pending, failed, and archive-cancelled worker results into the outbox", () => {
    const dataDir = makeTestDir("session-message-outbox-migration");
    const legacyDb = createLegacyDatabase(dataDir);
    const insert = legacyDb.prepare(`
      INSERT INTO deferred_prompts
        (id, sessionId, prompt, runAt, status, createdAt, updatedAt)
      VALUES (?, 'session-1', ?, '2026-09-03T00:00:00.000Z', ?,
              '2026-09-03T00:00:00.000Z', '2026-09-03T00:00:00.000Z')
    `);
    insert.run("pending-return", LEGACY_RESULT, "pending");
    insert.run("failed-return", LEGACY_RESULT.replace("interval_1", "interval_3"), "failed");
    insert.run("cancelled-return", LEGACY_RESULT.replace("interval_1", "interval_2"), "cancelled");
    insert.run("scheduled", "Check the build once.", "pending");
    insert.run("reserved-looking", "<deferred-work-result>\nUser-authored test content.", "pending");
    legacyDb.close();

    const db = openDatabase(dataDir);
    const outbox = createSessionMessageOutboxStore(db);

    expect(outbox.listForSession("session-1")).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "pending-return", sourceId: "interval_1", status: "pending" }),
      expect.objectContaining({ id: "cancelled-return", sourceId: "interval_2", status: "pending" }),
      expect.objectContaining({ id: "failed-return", sourceId: "interval_3", status: "pending" }),
    ]));
    expect(db.prepare(
      "SELECT id, status FROM deferred_prompts ORDER BY id",
    ).all()).toEqual([
      { id: "cancelled-return", status: "completed" },
      { id: "failed-return", status: "completed" },
      { id: "pending-return", status: "completed" },
      { id: "reserved-looking", status: "pending" },
      { id: "scheduled", status: "pending" },
    ]);
    db.close();
  });

  it("is idempotent and keeps new user-authored scheduled prompts separate", () => {
    const dataDir = makeTestDir("session-message-outbox-idempotent");
    const db = openDatabase(dataDir);
    const deferredPrompts = createDeferredPromptStore(db);
    const scheduled = deferredPrompts.create(
      "session-1",
      "<deferred-work-result>\nThis is user-authored test content.",
      "2026-09-03T00:00:00.000Z",
    );
    db.close();

    const reopened = openDatabase(dataDir);
    expect(createDeferredPromptStore(reopened).get(scheduled.id)?.status).toBe("pending");
    expect(createSessionMessageOutboxStore(reopened).listForSession("session-1")).toEqual([]);
    reopened.close();
  });
});
