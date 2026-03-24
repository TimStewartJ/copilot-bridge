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
  it("getReadState returns empty object when no file", () => {
    expect(store.getReadState()).toEqual({});
  });

  it("markRead stores timestamp and returns it", () => {
    const ts = store.markRead("session-1");
    expect(ts).toBeTruthy();
    expect(new Date(ts).getTime()).toBeGreaterThan(0);
  });

  it("isUnread returns true for never-read session", () => {
    expect(store.isUnread("session-1", new Date().toISOString())).toBe(true);
  });

  it("isUnread returns false after markRead with no new modifications", () => {
    const modifiedTime = new Date().toISOString();
    // Small delay to ensure markRead timestamp is after modifiedTime
    store.markRead("session-1");
    expect(store.isUnread("session-1", modifiedTime)).toBe(false);
  });

  it("isUnread returns true when modified after last read", () => {
    store.markRead("session-1");
    // Simulate modification 1 second in the future
    const futureTime = new Date(Date.now() + 1000).toISOString();
    expect(store.isUnread("session-1", futureTime)).toBe(true);
  });

  it("isUnread returns false when modifiedTime is undefined", () => {
    expect(store.isUnread("session-1")).toBe(false);
  });

  it("pruneReadState removes entries not in validSessionIds", () => {
    store.markRead("keep");
    store.markRead("remove");
    store.pruneReadState(new Set(["keep"]));
    const state = store.getReadState();
    expect(state["keep"]).toBeDefined();
    expect(state["remove"]).toBeUndefined();
  });

  it("pruneReadState is no-op when all sessions valid", () => {
    store.markRead("s1");
    store.markRead("s2");
    store.pruneReadState(new Set(["s1", "s2"]));
    expect(Object.keys(store.getReadState())).toHaveLength(2);
  });
});
