import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db.js";
import { makeTestDir } from "./helpers.js";

describe("legacy JSON state guard", () => {
  it("refuses to create an empty database when legacy JSON state exists", () => {
    const dataDir = makeTestDir("legacy-json-guard");
    writeFileSync(join(dataDir, "tasks.json"), JSON.stringify([{ id: "task-1" }]));

    expect(() => openDatabase(dataDir)).toThrow(/legacy JSON state files contain data/);
    expect(existsSync(join(dataDir, "bridge.db"))).toBe(false);
  });

  it("refuses to use an empty existing database when legacy JSON state exists", () => {
    const dataDir = makeTestDir("legacy-json-empty-db");
    const db = openDatabase(dataDir);
    db.close();
    writeFileSync(join(dataDir, "tasks.json"), JSON.stringify([{ id: "task-1" }]));

    expect(() => openDatabase(dataDir)).toThrow(/legacy JSON state files contain data/);
    expect(existsSync(join(dataDir, "bridge.db"))).toBe(true);
  });

  it("treats malformed legacy JSON as state to avoid creating an empty database", () => {
    const dataDir = makeTestDir("legacy-json-malformed");
    writeFileSync(join(dataDir, "tasks.json"), "[");

    expect(() => openDatabase(dataDir)).toThrow(/legacy JSON state files contain data/);
    expect(existsSync(join(dataDir, "bridge.db"))).toBe(false);
  });

  it("treats malformed legacy JSON as state next to an empty existing database", () => {
    const dataDir = makeTestDir("legacy-json-malformed-empty-db");
    const db = openDatabase(dataDir);
    db.close();
    writeFileSync(join(dataDir, "tasks.json"), "[");

    expect(() => openDatabase(dataDir)).toThrow(/legacy JSON state files contain data/);
    expect(existsSync(join(dataDir, "bridge.db"))).toBe(true);
  });

  it("allows migrated empty databases when leftover JSON backups are also empty", () => {
    const dataDir = makeTestDir("legacy-json-empty-backups");
    const db = openDatabase(dataDir);
    db.close();
    writeFileSync(join(dataDir, "tasks.json"), "[]");
    writeFileSync(join(dataDir, "settings.json"), "{}");

    const reopenedDb = openDatabase(dataDir);
    try {
      expect(reopenedDb.prepare("SELECT COUNT(*) as count FROM tasks").get()).toEqual({ count: 0 });
      expect(reopenedDb.prepare("SELECT COUNT(*) as count FROM settings").get()).toEqual({ count: 0 });
    } finally {
      reopenedDb.close();
    }
  });

  it("allows existing SQLite databases with migrated state even if old JSON backups remain", () => {
    const dataDir = makeTestDir("legacy-json-backups");
    const db = openDatabase(dataDir);
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("app", "{}");
    db.close();
    writeFileSync(join(dataDir, "tasks.json"), "[]");

    const reopenedDb = openDatabase(dataDir);
    try {
      expect(reopenedDb.prepare("SELECT COUNT(*) as count FROM settings").get()).toEqual({ count: 1 });
    } finally {
      reopenedDb.close();
    }
  });

  it("allows existing SQLite databases whose only state is in newer tables", () => {
    const dataDir = makeTestDir("legacy-json-newer-state");
    const db = openDatabase(dataDir);
    db.prepare(`
      INSERT INTO checklist_items (id, taskId, text, done, "order", createdAt, completedAt, deadline)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run("checklist-1", null, "Global checklist item", 0, 0, "2026-01-01T00:00:00.000Z", null, null);
    db.close();
    writeFileSync(join(dataDir, "tasks.json"), JSON.stringify([{ id: "task-1" }]));

    const reopenedDb = openDatabase(dataDir);
    try {
      expect(reopenedDb.prepare("SELECT COUNT(*) as count FROM checklist_items").get()).toEqual({ count: 1 });
      expect(reopenedDb.prepare("SELECT COUNT(*) as count FROM tasks").get()).toEqual({ count: 0 });
    } finally {
      reopenedDb.close();
    }
  });
});
