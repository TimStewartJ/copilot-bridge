import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { setupTestDb, createTestBus } from "./helpers.js";
import { createMcpServerStore } from "../mcp-server-store.js";
import { createBridgeSessionStateStore } from "../bridge-session-state-store.js";
import { createFeedStore } from "../feed-store.js";
import type { DatabaseSync } from "../db.js";

let db: DatabaseSync;
let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  db = setupTestDb();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warn.mockRestore();
});

function insertRawMcpServer(id: string, name: string, config: string, enabledByDefault = 1): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO mcp_servers (id, name, config, enabledByDefault, createdAt, updatedAt)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, name, config, enabledByDefault, now, now);
}

describe("store row hydration resilience", () => {
  describe("mcp-server-store", () => {
    it("returns the readable servers when a row's config is not valid JSON", () => {
      const store = createMcpServerStore(db);
      store.createMcpServer({ name: "Good", config: { command: "echo", args: [] }, enabledByDefault: true });
      insertRawMcpServer("broken-json", "Broken", "{not json");

      expect(store.listMcpServers().map((server) => server.name)).toEqual(["Good"]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("broken-json"));
    });

    it("returns the readable servers when a row parses but fails validation", () => {
      const store = createMcpServerStore(db);
      store.createMcpServer({ name: "Good", config: { command: "echo", args: [] } });
      insertRawMcpServer("invalid-shape", "Invalid", JSON.stringify({ nonsense: true }));

      expect(store.listMcpServers().map((server) => server.name)).toEqual(["Good"]);
      expect(store.getMcpServer("invalid-shape")).toBeUndefined();
      expect(store.getMcpServerByName("Invalid")).toBeUndefined();
    });

    it("keeps default resolution working when an enabled-by-default row is unreadable", () => {
      const store = createMcpServerStore(db);
      store.createMcpServer({ name: "Good", config: { command: "echo", args: [] }, enabledByDefault: true });
      insertRawMcpServer("broken-default", "BrokenDefault", "{not json", 1);

      expect(store.resolveMcpServers()).toEqual({ Good: { command: "echo", args: [] } });
    });

    it("still rejects a duplicate name held by an unreadable row", () => {
      const store = createMcpServerStore(db);
      insertRawMcpServer("broken-name", "Taken", "{not json");

      expect(() => store.createMcpServer({ name: "Taken", config: { command: "echo", args: [] } }))
        .toThrow(/already exists/);
    });

    it("lets an unreadable row be repaired by writing a valid config", () => {
      const store = createMcpServerStore(db);
      insertRawMcpServer("repairable", "Repairable", "{not json");

      const repaired = store.updateMcpServer("repairable", { config: { command: "echo", args: ["ok"] } });
      expect(repaired.config).toEqual({ command: "echo", args: ["ok"] });
      expect(store.listMcpServers().map((server) => server.name)).toEqual(["Repairable"]);
    });

    it("keeps write-side validation strict", () => {
      const store = createMcpServerStore(db);
      expect(() => store.createMcpServer({ name: "Bad", config: { nope: true } as never })).toThrow();
    });

    it("rolls back a rename that leaves the row unreadable", () => {
      const store = createMcpServerStore(db);
      insertRawMcpServer("still-broken", "StillBroken", "{not json");

      expect(() => store.updateMcpServer("still-broken", { name: "Renamed" }))
        .toThrow(/unreadable stored config/);

      // The rejected update must not have committed the new name.
      const row = db.prepare("SELECT name, config FROM mcp_servers WHERE id = ?").get("still-broken") as {
        name: string;
        config: string;
      };
      expect(row.name).toBe("StillBroken");
      expect(row.config).toBe("{not json");
      expect(db.isTransaction).toBe(false);
    });
  });

  describe("bridge-session-state-store", () => {
    it("keeps every state row when one terminal overlay is unreadable", () => {
      const store = createBridgeSessionStateStore(db);
      store.setArchived("good-session", true);
      store.setArchived("bad-session", true);
      db.prepare("UPDATE bridge_session_state SET terminalOverlayJson = ? WHERE sessionId = ?")
        .run("{not json", "bad-session");

      const states = store.listStates();
      expect(Object.keys(states).sort()).toEqual(["bad-session", "good-session"]);
      expect(states["bad-session"]!.archived).toBe(true);
      expect(states["bad-session"]!.terminalOverlay).toBeUndefined();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("bad-session"));
    });
  });

  describe("feed-store", () => {
    it("skips a card whose stored visual JSON is invalid and returns the rest", () => {
      const store = createFeedStore(db, createTestBus());
      store.saveCard({ title: "First" });
      const broken = store.saveCard({ title: "Broken" });
      store.saveCard({ title: "Third" });
      db.prepare("UPDATE feed_cards SET visualJson = ? WHERE id = ?")
        .run(JSON.stringify({ kind: "image" }), broken.card.id);

      const page = store.listCardPage();
      expect(page.cards.map((card) => card.title).sort()).toEqual(["First", "Third"]);
      expect(page.returnedCount).toBe(2);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(broken.card.id));
    });

    it("keeps cursor paging correct across a skipped row", () => {
      const store = createFeedStore(db, createTestBus());
      for (let i = 0; i < 4; i++) store.saveCard({ title: `Card ${i}` });
      const rows = db.prepare("SELECT id FROM feed_cards ORDER BY updatedAt DESC, id DESC").all() as Array<{ id: string }>;
      db.prepare("UPDATE feed_cards SET actionJson = ? WHERE id = ?")
        .run(JSON.stringify({ label: "no prompt" }), rows[1]!.id);

      const first = store.listCardPage({ limit: 2 });
      // The bad row is inside the first page window, so the page returns one card
      // but the cursor must still advance past it.
      expect(first.cards).toHaveLength(1);
      expect(first.returnedCount).toBe(1);
      expect(first.hasMore).toBe(true);

      const second = store.listCardPage({ limit: 2, cursor: first.nextCursor! });
      const seen = [...first.cards, ...second.cards].map((card) => card.id);
      expect(new Set(seen).size).toBe(seen.length);
      expect(seen).not.toContain(rows[1]!.id);
      expect(seen).toContain(rows[2]!.id);
      expect(seen).toContain(rows[3]!.id);
    });

    it("still surfaces an unreadable card on a direct single-card read", () => {
      const store = createFeedStore(db, createTestBus());
      const broken = store.saveCard({ title: "Broken" });
      db.prepare("UPDATE feed_cards SET visualJson = ? WHERE id = ?")
        .run(JSON.stringify({ kind: "image" }), broken.card.id);

      expect(() => store.getCard(broken.card.id)).toThrow();
    });
  });
});
