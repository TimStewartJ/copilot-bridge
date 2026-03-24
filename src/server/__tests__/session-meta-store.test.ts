import { describe, it, expect, beforeEach } from "vitest";
import { setupTestDb } from "./helpers.js";
import { createSessionMetaStore } from "../session-meta-store.js";
import type { SessionMetaStore } from "../session-meta-store.js";
import type { DatabaseSync } from "../db.js";

let db: DatabaseSync;
let store: SessionMetaStore;

beforeEach(() => {
  db = setupTestDb();
  store = createSessionMetaStore(db);
});

describe("session-meta-store", () => {
  it("getMeta returns undefined for unknown session", () => {
    expect(store.getMeta("unknown")).toBeUndefined();
  });

  it("setArchived creates meta entry", () => {
    store.setArchived("session-1", true);
    expect(store.isArchived("session-1")).toBe(true);
  });

  it("setArchived(false) removes entry", () => {
    store.setArchived("session-1", true);
    store.setArchived("session-1", false);
    expect(store.isArchived("session-1")).toBe(false);
    expect(store.getMeta("session-1")).toBeUndefined();
  });

  it("isArchived returns false for unknown session", () => {
    expect(store.isArchived("nope")).toBe(false);
  });

  it("deleteMeta removes entry", () => {
    store.setArchived("session-1", true);
    store.deleteMeta("session-1");
    expect(store.getMeta("session-1")).toBeUndefined();
  });

  it("setScheduleMeta sets trigger info", () => {
    store.setScheduleMeta("session-1", "sched-1", "My Schedule");
    const meta = store.getMeta("session-1");
    expect(meta).toBeDefined();
    expect(meta!.triggeredBy).toBe("schedule");
    expect(meta!.scheduleId).toBe("sched-1");
    expect(meta!.scheduleName).toBe("My Schedule");
  });

  it("setScheduleMeta preserves existing archive state", () => {
    store.setArchived("session-1", true);
    store.setScheduleMeta("session-1", "sched-1", "Test");
    const meta = store.getMeta("session-1");
    expect(meta!.archived).toBe(true);
    expect(meta!.triggeredBy).toBe("schedule");
  });

  it("listMeta returns all entries", () => {
    store.setArchived("s1", true);
    store.setArchived("s2", true);
    const all = store.listMeta();
    expect(Object.keys(all)).toHaveLength(2);
  });
});
