import { afterEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../db.js";
import { createSettingsStore } from "../settings-store.js";

const dataDirs: string[] = [];

afterEach(() => {
  for (const dir of dataDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  rmSync(join(process.cwd(), ".mcp-registry-test-data"), { recursive: true, force: true });
});

function createLocalDataDir(): string {
  const dir = join(process.cwd(), ".mcp-registry-test-data", crypto.randomUUID());
  mkdirSync(dir, { recursive: true });
  dataDirs.push(dir);
  return dir;
}

function insertTag(db: DatabaseSync, id: string, name: string): void {
  db.prepare(`
    INSERT INTO tags (id, name, color, instructions, "order", createdAt, updatedAt)
    VALUES (?, ?, 'slate', '', 0, '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z')
  `).run(id, name);
}

function selectServers(db: DatabaseSync) {
  return db.prepare(`
    SELECT id, name, config, enabledByDefault, createdAt, updatedAt
    FROM mcp_servers
    ORDER BY name COLLATE NOCASE
  `).all() as Array<{
    id: string;
    name: string;
    config: string;
    enabledByDefault: number;
    createdAt: string;
    updatedAt: string;
  }>;
}

function selectRefs(db: DatabaseSync) {
  return db.prepare(`
    SELECT refs.tagId, refs.serverId, ms.name AS serverName, ms.config
    FROM tag_mcp_server_refs refs
    JOIN mcp_servers ms ON ms.id = refs.serverId
    ORDER BY refs.tagId, ms.name COLLATE NOCASE
  `).all() as Array<{ tagId: string; serverId: string; serverName: string; config: string }>;
}

describe("database MCP registry migration", () => {
  it("promotes legacy settings and tag MCP configs into the canonical registry idempotently", () => {
    const dataDir = createLocalDataDir();
    const legacyDb = new DatabaseSync(join(dataDir, "bridge.db"));
    legacyDb.exec("PRAGMA foreign_keys = ON");
    legacyDb.exec(`
      CREATE TABLE settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE tags (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        color TEXT NOT NULL DEFAULT 'slate',
        instructions TEXT NOT NULL DEFAULT '',
        "order" INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE TABLE tag_mcp_servers (
        tagId TEXT NOT NULL,
        serverName TEXT NOT NULL,
        config TEXT NOT NULL,
        PRIMARY KEY (tagId, serverName),
        FOREIGN KEY (tagId) REFERENCES tags(id) ON DELETE CASCADE
      );
    `);

    const globalConfig = { command: "global-mcp", args: ["--global"] };
    const sharedConfig = { type: "http" as const, url: "https://shared.example/mcp" };
    const overrideConfig = { command: "override-mcp", args: ["--tag"] };
    const tagOnlyConfig = { type: "sse" as const, url: "https://tag-only.example/sse" };

    legacyDb.prepare("INSERT INTO settings (key, value) VALUES ('app', ?)").run(JSON.stringify({
      theme: "dark",
      mcpServers: {
        global: globalConfig,
        shared: sharedConfig,
      },
    }));
    insertTag(legacyDb, "tag-shared", "Shared");
    insertTag(legacyDb, "tag-override", "Override");
    insertTag(legacyDb, "tag-only", "Tag only");
    legacyDb.prepare("INSERT INTO tag_mcp_servers (tagId, serverName, config) VALUES (?, ?, ?)").run(
      "tag-shared",
      "shared",
      JSON.stringify(sharedConfig),
    );
    legacyDb.prepare("INSERT INTO tag_mcp_servers (tagId, serverName, config) VALUES (?, ?, ?)").run(
      "tag-override",
      "global",
      JSON.stringify(overrideConfig),
    );
    legacyDb.prepare("INSERT INTO tag_mcp_servers (tagId, serverName, config) VALUES (?, ?, ?)").run(
      "tag-only",
      "tag-only",
      JSON.stringify(tagOnlyConfig),
    );
    legacyDb.close();

    const db = openDatabase(dataDir);
    const servers = selectServers(db);
    expect(servers).toHaveLength(4);
    expect(servers.map((server) => [server.name, server.enabledByDefault])).toEqual([
      ["global", 1],
      [expect.stringMatching(/^global \(tag override/), 0],
      ["shared", 1],
      ["tag-only", 0],
    ]);

    const global = servers.find((server) => server.name === "global")!;
    const shared = servers.find((server) => server.name === "shared")!;
    const override = servers.find((server) => server.name.startsWith("global (tag override"))!;
    const tagOnly = servers.find((server) => server.name === "tag-only")!;
    expect(JSON.parse(global.config)).toEqual(globalConfig);
    expect(JSON.parse(shared.config)).toEqual(sharedConfig);
    expect(JSON.parse(override.config)).toEqual(overrideConfig);
    expect(JSON.parse(tagOnly.config)).toEqual(tagOnlyConfig);

    expect(selectRefs(db).map((ref) => [ref.tagId, ref.serverName])).toEqual([
      ["tag-only", "tag-only"],
      ["tag-override", override.name],
      ["tag-shared", "shared"],
    ]);
    expect((db.prepare("SELECT COUNT(*) AS count FROM tag_mcp_servers").get() as any).count).toBe(0);

    const rawSettings = JSON.parse((db.prepare("SELECT value FROM settings WHERE key = 'app'").get() as any).value);
    expect(rawSettings).toEqual({ theme: "dark" });
    expect(createSettingsStore(db).getMcpServers()).toEqual({
      global: globalConfig,
      shared: sharedConfig,
    });

    const beforeServers = selectServers(db);
    const beforeRefs = selectRefs(db);
    db.close();

    const reopened = openDatabase(dataDir);
    expect(selectServers(reopened)).toEqual(beforeServers);
    expect(selectRefs(reopened)).toEqual(beforeRefs);
    reopened.close();
  });
});
