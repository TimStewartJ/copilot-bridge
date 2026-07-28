import { describe, it, expect, beforeEach } from "vitest";
import { setupTestDb } from "./helpers.js";
import { createReadStateStore } from "../read-state-store.js";
import type { ReadStateStore } from "../read-state-store.js";
import type { DatabaseSync } from "../db.js";

let db: DatabaseSync;
let store: ReadStateStore;

beforeEach(() => {
  db = setupTestDb();
  store = createReadStateStore(db);
});

describe("read-state-store", () => {
  it("markRead can store an explicit read-through timestamp", () => {
    const ts = store.markRead("session-1", "2026-05-07T21:00:00.000Z");
    expect(ts).toBe("2026-05-07T21:00:00.000Z");
    expect(store.getReadState()["session-1"]).toBe("2026-05-07T21:00:00.000Z");
  });

  it("markRead never moves an existing cursor backward", () => {
    store.markRead("session-1", "2026-05-07T21:00:00.000Z");
    const ts = store.markRead("session-1", "2026-05-07T20:00:00.000Z");
    expect(ts).toBe("2026-05-07T21:00:00.000Z");
    expect(store.getReadState()["session-1"]).toBe("2026-05-07T21:00:00.000Z");
  });

  it("isUnread returns true for never-read session", () => {
    expect(store.isUnread("session-1", new Date().toISOString())).toBe(true);
  });

  it("isUnread returns false after markRead with no new visible activity", () => {
    const activityTime = new Date().toISOString();
    store.markRead("session-1");
    expect(store.isUnread("session-1", activityTime)).toBe(false);
  });

  it("isUnread returns true when visible activity happens after last read", () => {
    store.markRead("session-1");
    const futureTime = new Date(Date.now() + 1000).toISOString();
    expect(store.isUnread("session-1", futureTime)).toBe(true);
  });
});
