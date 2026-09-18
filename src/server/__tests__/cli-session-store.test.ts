import { EventEmitter } from "node:events";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  CliSessionStore,
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
  it("deletes exact session rows and related rows", async () => {
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

    await deleteCliSessionStoreRows(copilotHome, "b17e1000-old");

    const readDb = new DatabaseSync(join(copilotHome, "session-store.db"), { readOnly: true });
    try {
      expect(readDb.prepare("SELECT count(*) AS count FROM sessions").get()).toEqual({ count: 0 });
      expect(readDb.prepare("SELECT count(*) AS count FROM turns").get()).toEqual({ count: 0 });
    } finally {
      readDb.close();
    }
  });

  it("deletes rows from new tables that reference sessions", async () => {
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

    await deleteCliSessionStoreRows(copilotHome, "delete-me");

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

  it("sweeps only old helper rows whose session directories are gone", async () => {
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

    const swept = await sweepLeakedCliSessionStoreRows({
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
  it("returns undefined when the CLI session store is missing", async () => {
    const copilotHome = makeTestDir("missing-cli-catalog");
    const catalog = createCopilotCliSessionCatalog({ copilotHome });

    expect(await catalog.listSessions()).toBeUndefined();
    expect(await catalog.getSession("session-1")).toBeUndefined();
    expect(await catalog.hasSession("session-1")).toBeUndefined();
  });

  it("lists sessions from the CLI session store without reading workspace files or hiding helper-looking rows", async () => {
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

    expect(await catalog.hasSession("session-1")).toBe(true);
    expect(await catalog.hasSession("missing-session")).toBe(false);
    expect(await catalog.getSession("session-1")).toEqual({
      sessionId: "session-1",
      summary: "Review catalog adapter",
      startTime: "2026-05-07T10:00:00.000Z",
      modifiedTime: "2026-05-07T11:00:00.000Z",
      context: { cwd: "D:\\repo" },
      repository: "owner/repo",
      branch: "main",
      hostType: "github",
    });
    expect(await catalog.listSessions()).toEqual([
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

describe("CLI session catalog failures", () => {
  it("reports a store it cannot read as unavailable and records why", async () => {
    const copilotHome = join(makeTestDir("bridge-cli-store-unreadable-"), ".copilot");
    mkdirSync(copilotHome, { recursive: true });
    writeFileSync(join(copilotHome, "session-store.db"), "this is not a SQLite database");
    const recordSpan = vi.fn();
    const catalog = createCopilotCliSessionCatalog({ copilotHome, recordSpan });

    expect(await catalog.listSessions()).toBeUndefined();
    expect(await catalog.hasSession("session-1")).toBeUndefined();

    expect(recordSpan.mock.calls.map(([name, , , metadata]) => [name, metadata.result])).toEqual([
      ["session.cliCatalog.list", "error"],
      ["session.cliCatalog.has", "error"],
    ]);
    expect(recordSpan.mock.calls[0]![3].error).toMatch(/not a database/i);
  });
});

/** A scripted worker thread: records what the store sends and replies only when the test says so. */
class ScriptedWorker extends EventEmitter {
  readonly requests: Array<{ id: number; request: { op: string } }> = [];
  referenced = true;
  terminated = false;

  postMessage(message: { id: number; request: { op: string } }): void {
    this.requests.push(message);
  }
  ref(): void {
    this.referenced = true;
  }
  unref(): void {
    this.referenced = false;
  }
  terminate(): Promise<number> {
    this.terminated = true;
    return Promise.resolve(0);
  }
}

function createWorkerStore() {
  const workers: ScriptedWorker[] = [];
  const store = new CliSessionStore({
    inline: false,
    createWorker: () => {
      const worker = new ScriptedWorker();
      workers.push(worker);
      return worker as never;
    },
  });
  return { store, workers };
}

describe("CliSessionStore worker backend", () => {
  it("runs every request on one worker thread and matches replies to their requests", async () => {
    const { store, workers } = createWorkerStore();
    const list = store.run({ op: "list", copilotHome: "home" });
    const has = store.run({ op: "has", copilotHome: "home", sessionId: "session-1" });

    expect(workers).toHaveLength(1);
    expect(workers[0]!.referenced).toBe(false);
    expect(workers[0]!.requests.map((message) => message.request.op)).toEqual(["list", "has"]);

    workers[0]!.emit("message", { id: workers[0]!.requests[1]!.id, value: { result: "miss" } });
    workers[0]!.emit("message", { id: workers[0]!.requests[0]!.id, value: { result: "hit", sessions: [] } });
    expect(await has).toEqual({ result: "miss" });
    expect(await list).toEqual({ result: "hit", sessions: [] });
  });

  it("rejects a request with the error the worker reported", async () => {
    const { store, workers } = createWorkerStore();
    const pending = store.run({ op: "delete", copilotHome: "home", sessionId: "session-1" });
    workers[0]!.emit("message", { id: workers[0]!.requests[0]!.id, error: "database is locked" });
    await expect(pending).rejects.toThrow("database is locked");
  });

  it("fails the requests a lost worker was holding and starts a new worker for the next one", async () => {
    const { store, workers } = createWorkerStore();
    const held = store.run({ op: "list", copilotHome: "home" });
    workers[0]!.emit("exit", 1);
    await expect(held).rejects.toThrow("CLI session store worker exited with code 1");

    const next = store.run({ op: "list", copilotHome: "home" });
    expect(workers).toHaveLength(2);
    workers[0]!.emit("error", new Error("late event from the lost worker"));
    workers[1]!.emit("message", { id: workers[1]!.requests[0]!.id, value: { result: "missing" } });
    expect(await next).toEqual({ result: "missing" });
  });

  it("never starts a worker thread on the inline backend", async () => {
    const createWorker = vi.fn();
    const store = new CliSessionStore({ inline: true, createWorker });
    const copilotHome = join(makeTestDir("bridge-cli-store-inline-"), ".copilot");
    expect(await store.run({ op: "list", copilotHome })).toEqual({ result: "missing" });
    expect(createWorker).not.toHaveBeenCalled();
  });
});
