import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { CliSessionStore, deleteCliSessionStoreRows, resetCliSessionStoreForTests } from "../cli-session-store.js";
import { createCopilotCliSessionCatalog } from "../copilot-cli-session-catalog.js";
import { getProcessHost } from "../process-host.js";
import { makeTestDir } from "./helpers.js";

// Drives a real worker thread against a real SQLite file, so it runs in the native project, which
// selects the production (worker) backend.
const store = new CliSessionStore({ inline: false });

afterAll(async () => {
  await store.shutdown();
  await resetCliSessionStoreForTests();
});

function createCliStore(prefix: string): { copilotHome: string; db: DatabaseSync } {
  const copilotHome = join(makeTestDir(prefix), ".copilot");
  mkdirSync(copilotHome, { recursive: true });
  const db = new DatabaseSync(join(copilotHome, "session-store.db"));
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, summary TEXT, created_at TEXT, updated_at TEXT);
    CREATE TABLE turns (session_id TEXT, content TEXT);
    INSERT INTO sessions VALUES ('session-1', 'D:\\repo', ' First ', '2026-05-07T10:00:00.000Z', '2026-05-07T11:00:00.000Z');
    INSERT INTO sessions VALUES ('session-2', NULL, NULL, '2026-05-07T09:00:00.000Z', NULL);
    INSERT INTO turns VALUES ('session-1', 'hello'), ('session-2', 'world');
  `);
  return { copilotHome, db };
}

describe("CLI session store on a real worker thread", () => {
  it("reads, deletes and sweeps through the worker", async () => {
    const { copilotHome, db } = createCliStore("bridge-cli-store-native-");
    try {
      expect(await store.run({ op: "list", copilotHome })).toEqual({
        result: "hit",
        sessions: [
          {
            sessionId: "session-1", summary: "First", context: { cwd: "D:\\repo" },
            startTime: "2026-05-07T10:00:00.000Z", modifiedTime: "2026-05-07T11:00:00.000Z",
          },
          { sessionId: "session-2", startTime: "2026-05-07T09:00:00.000Z" },
        ],
      });
      expect(await store.run({ op: "has", copilotHome, sessionId: "session-2" })).toEqual({ result: "hit" });
      expect(await store.run({ op: "get", copilotHome, sessionId: "nobody" })).toEqual({ result: "miss" });

      await store.run({ op: "delete", copilotHome, sessionId: "session-1" });
      expect(db.prepare("SELECT id FROM sessions").all()).toEqual([{ id: "session-2" }]);
      expect(db.prepare("SELECT session_id FROM turns").all()).toEqual([{ session_id: "session-2" }]);

      db.prepare("INSERT INTO sessions VALUES ('helper-old', NULL, NULL, '2026-01-01T00:00:00.000Z', NULL)").run();
      const swept = await store.run({ op: "sweep", copilotHome, idPrefix: "helper", cutoffTimestampMs: Date.parse("2026-02-01") });
      expect(swept).toEqual(["helper-old"]);
    } finally {
      db.close();
    }
  });

  it("reports a failure inside the worker as a rejection", async () => {
    const { copilotHome, db } = createCliStore("bridge-cli-store-native-error-");
    db.exec("DROP TABLE sessions; CREATE TABLE sessions (id TEXT PRIMARY KEY); CREATE TRIGGER no_delete BEFORE DELETE ON sessions BEGIN SELECT RAISE(ABORT, 'delete refused'); END; INSERT INTO sessions VALUES ('session-1');");
    db.close();
    await expect(store.run({ op: "delete", copilotHome, sessionId: "session-1" })).rejects.toThrow("delete refused");
  });

  it("leaves the calling thread free while a delete waits for the CLI's write lock", async () => {
    const { copilotHome, db } = createCliStore("bridge-cli-store-native-lock-");
    try {
      db.exec("BEGIN IMMEDIATE");
      // The worker answers in order: once the read has come back, the delete is what it is doing,
      // and it cannot finish while this thread holds the write lock.
      const read = store.run({ op: "has", copilotHome, sessionId: "session-1" });
      const pendingDelete = store.run({ op: "delete", copilotHome, sessionId: "session-1" });
      expect(await read).toEqual({ result: "hit" });
      await new Promise((resolve) => setImmediate(resolve));

      // Only a thread that is not stuck inside the delete can release the lock. On the calling
      // thread the delete would wait out its busy timeout here and fail with "database is locked".
      db.exec("COMMIT");
      await pendingDelete;
      expect(db.prepare("SELECT id FROM sessions ORDER BY id").all()).toEqual([{ id: "session-2" }]);
    } finally {
      db.close();
    }
  });

  it("serves the shared store from a worker thread in production", async () => {
    expect(getProcessHost().mode).toBe("worker");
    const { copilotHome, db } = createCliStore("bridge-cli-store-native-shared-");
    try {
      const catalog = createCopilotCliSessionCatalog({ copilotHome });
      expect(await catalog.hasSession("session-1")).toBe(true);
      await deleteCliSessionStoreRows(copilotHome, "session-1");
      expect(await catalog.hasSession("session-1")).toBe(false);
      expect((await catalog.listSessions())?.map((session) => session.sessionId)).toEqual(["session-2"]);
    } finally {
      db.close();
    }
  });
});
