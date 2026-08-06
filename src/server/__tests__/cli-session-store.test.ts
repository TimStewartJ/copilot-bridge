import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  deleteCliSessionStoreRows,
  sweepLeakedCliSessionStoreRows,
} from "../cli-session-store.js";
import { makeTestDir } from "./helpers.js";
import { createCopilotCliSessionCatalog } from "../copilot-cli-session-catalog.js";


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

  it("deletes rows from new tables that reference sessions", () => {
    const copilotHome = makeTestDir("cli-session-store-foreign-keys");
    const db = createCliStore(copilotHome);
    try {
      db.exec(`
        CREATE TABLE assistant_usage_events (
          id INTEGER PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id)
        );
        CREATE TABLE forge_trajectory_events (
          id INTEGER PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id)
        );
        CREATE TABLE future_session_events (
          id INTEGER PRIMARY KEY,
          owner_session_id TEXT NOT NULL REFERENCES sessions(id)
        );
      `);
      const insertSession = db.prepare(
        "INSERT INTO sessions (id, summary, created_at, updated_at) VALUES (?, ?, ?, ?)",
      );
      insertSession.run("delete-me", null, "2026-08-06 00:00:00", "2026-08-06 00:00:00");
      insertSession.run("keep-me", null, "2026-08-06 00:00:00", "2026-08-06 00:00:00");
      for (const table of ["assistant_usage_events", "forge_trajectory_events"]) {
        const insert = db.prepare(`INSERT INTO ${table} (session_id) VALUES (?)`);
        insert.run("delete-me");
        insert.run("keep-me");
      }
      const insertFuture = db.prepare("INSERT INTO future_session_events (owner_session_id) VALUES (?)");
      insertFuture.run("delete-me");
      insertFuture.run("keep-me");
    } finally {
      db.close();
    }

    deleteCliSessionStoreRows(copilotHome, "delete-me");

    const readDb = new DatabaseSync(join(copilotHome, "session-store.db"), { readOnly: true });
    try {
      expect(readDb.prepare("SELECT id FROM sessions ORDER BY id").all()).toEqual([{ id: "keep-me" }]);
      expect(readDb.prepare("SELECT session_id FROM assistant_usage_events").all())
        .toEqual([{ session_id: "keep-me" }]);
      expect(readDb.prepare("SELECT session_id FROM forge_trajectory_events").all())
        .toEqual([{ session_id: "keep-me" }]);
      expect(readDb.prepare("SELECT owner_session_id FROM future_session_events").all())
        .toEqual([{ owner_session_id: "keep-me" }]);
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

describe("copilot CLI session catalog", () => {
  it("returns undefined when the CLI session store is missing", () => {
    const copilotHome = makeTestDir("missing-cli-catalog");
    const catalog = createCopilotCliSessionCatalog({ copilotHome });

    expect(catalog.listSessions()).toBeUndefined();
    expect(catalog.getSession("session-1")).toBeUndefined();
    expect(catalog.hasSession("session-1")).toBeUndefined();
  });

  it("lists sessions from the CLI session store without reading workspace files or hiding helper-looking rows", () => {
    const copilotHome = makeTestDir("cli-catalog");
    mkdirSync(copilotHome, { recursive: true });
    const db = new DatabaseSync(join(copilotHome, "session-store.db"));
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        cwd TEXT,
        repository TEXT,
        branch TEXT,
        summary TEXT,
        created_at TEXT,
        updated_at TEXT,
        host_type TEXT
      );
      INSERT INTO sessions (id, cwd, repository, branch, summary, created_at, updated_at, host_type)
      VALUES (
        'session-1',
        'D:\\repo',
        'owner/repo',
        'main',
        'Review catalog adapter',
        '2026-05-07T10:00:00.000Z',
        '2026-05-07T11:00:00.000Z',
        'github'
      );
      INSERT INTO sessions (id, cwd, repository, branch, summary, created_at, updated_at, host_type)
      VALUES (
        'b17e1000-0000-4000-8000-000000000001',
        'D:\\repo',
        'owner/repo',
        'main',
        'Disposable helper',
        '2026-05-07T10:00:00.000Z',
        '2026-05-07T12:00:00.000Z',
        'github'
      );
      INSERT INTO sessions (id, cwd, repository, branch, summary, created_at, updated_at, host_type)
      VALUES (
        'legacy-title-helper',
        'D:\\repo',
        'owner/repo',
        'main',
        'Generate a concise 3-6 word title for this conversation.
Reply with ONLY the title text for a stale helper',
        '2026-05-07T10:00:00.000Z',
        '2026-05-07T13:00:00.000Z',
        'github'
      );
    `);
    db.close();
    const catalog = createCopilotCliSessionCatalog({ copilotHome });

    expect(catalog.hasSession("session-1")).toBe(true);
    expect(catalog.hasSession("missing-session")).toBe(false);
    expect(catalog.getSession("session-1")).toEqual({
      sessionId: "session-1",
      summary: "Review catalog adapter",
      startTime: "2026-05-07T10:00:00.000Z",
      modifiedTime: "2026-05-07T11:00:00.000Z",
      context: { cwd: "D:\\repo" },
      repository: "owner/repo",
      branch: "main",
      hostType: "github",
    });
    expect(catalog.listSessions()).toEqual([
      {
        sessionId: "legacy-title-helper",
        summary: "Generate a concise 3-6 word title for this conversation.\nReply with ONLY the title text for a stale helper",
        startTime: "2026-05-07T10:00:00.000Z",
        modifiedTime: "2026-05-07T13:00:00.000Z",
        context: { cwd: "D:\\repo" },
        repository: "owner/repo",
        branch: "main",
        hostType: "github",
      },
      {
        sessionId: "b17e1000-0000-4000-8000-000000000001",
        summary: "Disposable helper",
        startTime: "2026-05-07T10:00:00.000Z",
        modifiedTime: "2026-05-07T12:00:00.000Z",
        context: { cwd: "D:\\repo" },
        repository: "owner/repo",
        branch: "main",
        hostType: "github",
      },
      {
        sessionId: "session-1",
        summary: "Review catalog adapter",
        startTime: "2026-05-07T10:00:00.000Z",
        modifiedTime: "2026-05-07T11:00:00.000Z",
        context: { cwd: "D:\\repo" },
        repository: "owner/repo",
        branch: "main",
        hostType: "github",
      },
    ]);
  });
});
