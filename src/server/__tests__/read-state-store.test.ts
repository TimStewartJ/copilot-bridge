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
  it("settles a batch without regressing read cursors and projects just the requested sessions", () => {
    store.markRead("ahead", "2999-01-01T00:00:00.000Z");
    store.markRead("behind", "2020-01-01T00:00:00.000Z");
    store.markReadMany(["ahead", "behind", "new"], "2026-05-07T21:00:00Z");
    store.markReadMany([]);
    expect(store.getReadState()).toEqual({
      ahead: "2999-01-01T00:00:00.000Z",
      behind: "2026-05-07T21:00:00.000Z",
      new: "2026-05-07T21:00:00.000Z",
    });
    expect(store.getReadStateFor(["new", "never-read"])).toEqual({ new: "2026-05-07T21:00:00.000Z" });
    expect(store.getReadStateFor([])).toEqual({});
    expect(() => store.markReadMany(["new"], "not a date")).toThrow("Invalid read timestamp");
  });

  it("markRead never moves an existing cursor backward", () => {
    store.markRead("session-1", "2026-05-07T21:00:00.000Z");
    const ts = store.markRead("session-1", "2026-05-07T20:00:00.000Z");
    expect(ts).toBe("2026-05-07T21:00:00.000Z");
    expect(store.getReadState()["session-1"]).toBe("2026-05-07T21:00:00.000Z");
  });

});
