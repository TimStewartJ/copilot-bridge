import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  deleteCliSessionStoreRows,
  sweepLeakedCliSessionStoreRows,
} from "../cli-session-store.js";
import { makeTestDir } from "./helpers.js";

function createCliStore(copilotHome: string): DatabaseSync {
  mkdirSync(copilotHome, { recursive: true });
  const db = new DatabaseSync(join(copilotHome, "session-store.db"));
  db.exec(`
    CREATE TABLE sessions (
      id TEXT PRIMARY KEY,
      summary TEXT,
      created_at TEXT,
      updated_at TEXT
    );
    CREATE TABLE turns (
      session_id TEXT,
      content TEXT
    );
  `);
  return db;
}

describe("CLI session store cleanup", () => {
  it("deletes exact session rows and related rows", () => {
    const copilotHome = makeTestDir("cli-session-store-exact");
    const db = createCliStore(copilotHome);
    try {
      db.prepare("INSERT INTO sessions (id, summary, created_at, updated_at) VALUES (?, ?, ?, ?)").run(
        "b17e1000-old",
        null,
        "2026-05-08 23:00:00",
        "2026-05-08 23:00:00",
      );
      db.prepare("INSERT INTO turns (session_id, content) VALUES (?, ?)").run("b17e1000-old", "hello");
    } finally {
      db.close();
    }

    deleteCliSessionStoreRows(copilotHome, "b17e1000-old");

    const readDb = new DatabaseSync(join(copilotHome, "session-store.db"), { readOnly: true });
    try {
      expect(readDb.prepare("SELECT count(*) AS count FROM sessions").get()).toEqual({ count: 0 });
      expect(readDb.prepare("SELECT count(*) AS count FROM turns").get()).toEqual({ count: 0 });
    } finally {
      readDb.close();
    }
  });

  it("sweeps only old helper rows whose session directories are gone", () => {
    const copilotHome = makeTestDir("cli-session-store-sweep");
    const db = createCliStore(copilotHome);
    try {
      const insert = db.prepare("INSERT INTO sessions (id, summary, created_at, updated_at) VALUES (?, ?, ?, ?)");
      insert.run("b17e1000-stale", null, "2026-05-08 23:00:00", "2026-05-08 23:00:00");
      insert.run("b17e1000-recent", null, "2026-05-08 23:10:00", "2026-05-08 23:10:00");
      insert.run("b17e1000-active", null, "2026-05-08 23:00:00", "2026-05-08 23:00:00");
      insert.run("normal-session", "Keep me", "2026-05-08 23:00:00", "2026-05-08 23:00:00");
    } finally {
      db.close();
    }
    mkdirSync(join(copilotHome, "session-state", "b17e1000-active"), { recursive: true });

    const swept = sweepLeakedCliSessionStoreRows({
      copilotHome,
      idPrefix: "b17e1000",
      cutoffTimestampMs: Date.parse("2026-05-08T23:05:00Z"),
    });

    expect(swept).toEqual(["b17e1000-stale"]);
    const readDb = new DatabaseSync(join(copilotHome, "session-store.db"), { readOnly: true });
    try {
      const remaining = readDb.prepare("SELECT id FROM sessions ORDER BY id").all().map((row: any) => row.id);
      expect(remaining).toEqual(["b17e1000-active", "b17e1000-recent", "normal-session"]);
    } finally {
      readDb.close();
    }
  });
});
