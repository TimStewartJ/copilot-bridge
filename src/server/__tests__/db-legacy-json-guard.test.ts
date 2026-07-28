import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "../db.js";
import { makeTestDir } from "./helpers.js";

describe("legacy JSON state guard", () => {
  // Opening an empty database next to populated legacy JSON would silently discard
  // the user's pre-migration state, so every such combination must throw.
  it("refuses to open an empty database whenever legacy JSON still holds state", () => {
    const cases: { label: string; json: string; preCreateDb: boolean }[] = [
      { label: "populated JSON, no database yet", json: JSON.stringify([{ id: "task-1" }]), preCreateDb: false },
      { label: "populated JSON, empty database exists", json: JSON.stringify([{ id: "task-1" }]), preCreateDb: true },
      { label: "malformed JSON, no database yet", json: "[", preCreateDb: false },
      { label: "malformed JSON, empty database exists", json: "[", preCreateDb: true },
    ];

    for (const { label, json, preCreateDb } of cases) {
      const dataDir = makeTestDir(`legacy-json-${label.replace(/[^a-z]+/gi, "-")}`);
      if (preCreateDb) openDatabase(dataDir).close();
      writeFileSync(join(dataDir, "tasks.json"), json);

      expect(() => openDatabase(dataDir), label).toThrow(/legacy JSON state files contain data/);
      expect(existsSync(join(dataDir, "bridge.db")), label).toBe(preCreateDb);
    }
  });

  it("allows migrated databases when leftover JSON backups are empty", () => {
    const dataDir = makeTestDir("legacy-json-empty-backups");
    const db = openDatabase(dataDir);
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("app", "{}");
    db.close();
    writeFileSync(join(dataDir, "tasks.json"), "[]");
    writeFileSync(join(dataDir, "settings.json"), "{}");

    const reopenedDb = openDatabase(dataDir);
    try {
      expect(reopenedDb.prepare("SELECT COUNT(*) as count FROM tasks").get()).toEqual({ count: 0 });
      expect(reopenedDb.prepare("SELECT COUNT(*) as count FROM settings").get()).toEqual({ count: 1 });
    } finally {
      reopenedDb.close();
    }
  });

  it("allows existing databases whose only state lives in newer tables", () => {
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
