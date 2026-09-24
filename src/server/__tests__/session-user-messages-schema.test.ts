import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { initializeSessionUserMessagesSchema } from "../session-user-messages-schema.js";

function legacyDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE search_chat_messages (sessionId TEXT, sourceEventId TEXT, role TEXT, timestamp TEXT, content TEXT);
    CREATE TABLE search_indexed_sessions (sessionId TEXT PRIMARY KEY);
    INSERT INTO search_indexed_sessions VALUES ('chat');
    CREATE TABLE bridge_session_state (sessionId TEXT PRIMARY KEY, triggeredBy TEXT);
    CREATE TABLE deferred_prompts (sessionId TEXT, prompt TEXT, createdAt TEXT, updatedAt TEXT);
    CREATE TABLE defer_loops (sessionId TEXT, prompt TEXT, createdAt TEXT, updatedAt TEXT);
  `);
  return db;
}
const add = (db: DatabaseSync, sessionId: string, timestamp: string, content: string, role = "user") =>
  db.prepare("INSERT INTO search_chat_messages VALUES (?, ?, ?, ?, ?)").run(sessionId, `${sessionId}-${timestamp}`, role, timestamp, content);
const lastSent = (db: DatabaseSync) => Object.fromEntries((db.prepare("SELECT sessionId, lastSentAt FROM session_user_messages").all() as any[]).map(row => [row.sessionId, row.lastSentAt]));

describe("session user message history", () => {
  it("backfills only Tim's own words from the search index, once", () => {
    const db = legacyDb();
    add(db, "chat", "2026-09-01T10:00:00Z", "Please plan the trip");
    add(db, "chat", "2026-09-05T10:00:00Z", "<deferred-work-result>\ndeferId: x");
    add(db, "chat", "2026-09-06T10:00:00Z", "<bridge_notice>\nThe Bridge restarted");
    add(db, "chat", "2026-09-07T10:00:00Z", "Check the job status and report back");
    add(db, "chat", "2026-09-08T10:00:00Z", "Here is my answer", "assistant");
    db.prepare("INSERT INTO deferred_prompts VALUES (?, ?, ?, ?)").run("chat", "Check the job status and report back", "2026-09-07T09:00:00Z", "2026-09-07T10:00:00Z");
    // The same words typed by Tim long after that defer had finished still count.
    add(db, "typed", "2026-09-15T10:00:00Z", "Check the job status and report back");
    db.prepare("INSERT INTO deferred_prompts VALUES (?, ?, ?, ?)").run("typed", "Check the job status and report back", "2026-09-01T09:00:00Z", "2026-09-01T10:00:00Z");
    add(db, "scheduled", "2026-09-10T08:00:00Z", "Run the daily scan");
    add(db, "scheduled", "2026-09-10T09:00:00Z", "thanks, keep the second one");
    add(db, "scheduled-only", "2026-09-11T08:00:00Z", "Run the daily scan");
    add(db, "loop", "2026-09-12T08:00:00Z", "<defer>\ndeferId: interval_1");
    db.prepare("INSERT INTO bridge_session_state VALUES (?, 'schedule'), (?, 'schedule')").run("scheduled", "scheduled-only");
    initializeSessionUserMessagesSchema(db);
    expect(lastSent(db)).toEqual({ chat: "2026-09-01T10:00:00.000Z", scheduled: "2026-09-10T09:00:00.000Z", typed: "2026-09-15T10:00:00.000Z" });
    add(db, "chat", "2026-09-20T10:00:00Z", "a later message");
    initializeSessionUserMessagesSchema(db);
    expect(lastSent(db).chat).toBe("2026-09-01T10:00:00.000Z");
  });

  it("waits for a populated search index instead of settling for no history", () => {
    const db = new DatabaseSync(":memory:");
    initializeSessionUserMessagesSchema(db);
    expect(lastSent(db)).toEqual({});
    db.exec(`
      CREATE TABLE search_chat_messages (sessionId TEXT, sourceEventId TEXT, role TEXT, timestamp TEXT, content TEXT);
      CREATE TABLE search_indexed_sessions (sessionId TEXT PRIMARY KEY);
    `);
    initializeSessionUserMessagesSchema(db);
    db.exec("INSERT INTO search_indexed_sessions VALUES ('late')");
    add(db, "late", "2026-09-02T10:00:00Z", "Hello");
    initializeSessionUserMessagesSchema(db);
    expect(lastSent(db)).toEqual({ late: "2026-09-02T10:00:00.000Z" });
  });
});
