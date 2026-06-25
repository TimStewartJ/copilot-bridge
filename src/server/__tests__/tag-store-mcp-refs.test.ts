import { beforeEach, describe, expect, it } from "vitest";
import { setupTestDb } from "./helpers.js";
import type { DatabaseSync } from "../db.js";
import { createMcpServerStore, type McpServerStore } from "../mcp-server-store.js";
import { createTagStore, type TagStore } from "../tag-store.js";

let db: DatabaseSync;
let mcpStore: McpServerStore;
let tagStore: TagStore;

beforeEach(() => {
  db = setupTestDb();
  mcpStore = createMcpServerStore(db);
  tagStore = createTagStore(db);
});

function legacyTagServerCount(tagId: string): number {
  return (db.prepare("SELECT COUNT(*) AS count FROM tag_mcp_servers WHERE tagId = ?").get(tagId) as any).count;
}

function tagRefCount(tagId: string): number {
  return (db.prepare("SELECT COUNT(*) AS count FROM tag_mcp_server_refs WHERE tagId = ?").get(tagId) as any).count;
}

function serverRefCount(serverId: string): number {
  return (db.prepare("SELECT COUNT(*) AS count FROM tag_mcp_server_refs WHERE serverId = ?").get(serverId) as any).count;
}

function insertLegacyTagServer(tagId: string, serverName: string): void {
  db.prepare("INSERT OR REPLACE INTO tag_mcp_servers (tagId, serverName, config) VALUES (?, ?, ?)").run(
    tagId,
    serverName,
    JSON.stringify({ command: "legacy", args: [] }),
  );
}

describe("tag-store MCP server references", () => {
  it("sets selected registry server IDs and returns registry identity", () => {
    const tag = tagStore.createTag("AI");
    const local = mcpStore.createMcpServer({ name: "Local", config: { command: "local-mcp", args: ["serve"] } });
    const remote = mcpStore.createMcpServer({
      name: "Remote",
      config: { type: "http", url: "https://remote.example/mcp" },
    });

    const selected = tagStore.replaceTagMcpServerRefs(tag.id, [remote.id, local.id, local.id]);

    expect(selected.map((server) => [server.id, server.serverId, server.serverName])).toEqual([
      [local.id, local.id, "Local"],
      [remote.id, remote.id, "Remote"],
    ]);
    expect(selected[0].config).toEqual({ command: "local-mcp", args: ["serve"] });
    expect(tagStore.getTagMcpServerIds(tag.id)).toEqual([local.id, remote.id]);
    expect(tagStore.resolveEffectiveTags("task-1").mcpServerIds).toEqual([]);
    tagStore.setEntityTags("task", "task-1", [tag.id]);
    expect(tagStore.resolveEffectiveTags("task-1").mcpServerIds).toEqual([local.id, remote.id]);
    expect(tagRefCount(tag.id)).toBe(2);
    expect(legacyTagServerCount(tag.id)).toBe(0);
  });

  it("adds, removes, and replaces refs without preserving legacy tag-owned rows", () => {
    const tag = tagStore.createTag("Tools");
    const alpha = mcpStore.createMcpServer({ name: "Alpha", config: { command: "alpha", args: [] } });
    const beta = mcpStore.createMcpServer({ name: "Beta", config: { command: "beta", args: [] } });

    expect(tagStore.addTagMcpServerRef(tag.id, alpha.id).serverId).toBe(alpha.id);
    expect(tagStore.getTagMcpServerIds(tag.id)).toEqual([alpha.id]);

    insertLegacyTagServer(tag.id, "stale");
    const replaced = tagStore.replaceTagMcpServerRefs(tag.id, [beta.id]);
    expect(replaced.map((server) => server.serverId)).toEqual([beta.id]);
    expect(tagStore.getTagMcpServerIds(tag.id)).toEqual([beta.id]);
    expect(legacyTagServerCount(tag.id)).toBe(0);

    insertLegacyTagServer(tag.id, "stale-again");
    tagStore.removeTagMcpServerRef(tag.id, beta.id);
    expect(tagStore.getTagMcpServerIds(tag.id)).toEqual([]);
    expect(tagRefCount(tag.id)).toBe(0);
    expect(legacyTagServerCount(tag.id)).toBe(0);
  });

  it("removes a deleted registry server's refs across tags via SQLite cascade", () => {
    const tag = tagStore.createTag("Cascade");
    const otherTag = tagStore.createTag("Other cascade");
    const server = mcpStore.createMcpServer({ name: "Cascade MCP", config: { command: "cascade", args: [] } });
    const survivor = mcpStore.createMcpServer({ name: "Survivor MCP", config: { command: "survivor", args: [] } });
    tagStore.addTagMcpServerRef(tag.id, server.id);
    tagStore.addTagMcpServerRef(tag.id, survivor.id);
    tagStore.addTagMcpServerRef(otherTag.id, server.id);
    expect(serverRefCount(server.id)).toBe(2);

    // Delete only the parent row — no tag-store helper. SQLite ON DELETE CASCADE owns child cleanup.
    mcpStore.deleteMcpServer(server.id);

    expect(mcpStore.getMcpServer(server.id)).toBeUndefined();
    // Raw junction rows for the deleted server are gone (cascade), not merely hidden by the registry JOIN.
    expect(serverRefCount(server.id)).toBe(0);
    // Refs to other servers survive.
    expect(tagStore.getTagMcpServerIds(tag.id)).toEqual([survivor.id]);
    expect(tagRefCount(tag.id)).toBe(1);
    expect(serverRefCount(survivor.id)).toBe(1);
    // The other tag loses its only ref.
    expect(tagStore.getTagMcpServers(otherTag.id)).toEqual([]);
    expect(tagRefCount(otherTag.id)).toBe(0);
  });

  it("preserves tag refs when deleting an unrelated or missing registry server", () => {
    const tag = tagStore.createTag("Stable");
    const kept = mcpStore.createMcpServer({ name: "Kept MCP", config: { command: "kept", args: [] } });
    const unrelated = mcpStore.createMcpServer({ name: "Unrelated MCP", config: { command: "unrelated", args: [] } });
    tagStore.addTagMcpServerRef(tag.id, kept.id);

    mcpStore.deleteMcpServer(unrelated.id);
    mcpStore.deleteMcpServer("missing-server");

    expect(tagStore.getTagMcpServerIds(tag.id)).toEqual([kept.id]);
    expect(tagRefCount(tag.id)).toBe(1);
    expect(serverRefCount(kept.id)).toBe(1);
  });

  it("locks in the serverId → mcp_servers ON DELETE CASCADE foreign key", () => {
    expect((db.prepare("PRAGMA foreign_keys").get() as any).foreign_keys).toBe(1);
    const fks = db.prepare("PRAGMA foreign_key_list(tag_mcp_server_refs)").all() as Array<{
      table: string;
      from: string;
      to: string;
      on_delete: string;
    }>;
    const serverFk = fks.find((fk) => fk.from === "serverId");
    expect(serverFk).toMatchObject({ table: "mcp_servers", to: "id", on_delete: "CASCADE" });
  });

  it("routes legacy compatibility writes through registry refs and clears old rows", () => {
    const tag = tagStore.createTag("Legacy");
    insertLegacyTagServer(tag.id, "linear");

    tagStore.setTagMcpServer(tag.id, "linear", { type: "http", url: "https://linear.example/mcp" });

    const first = tagStore.getTagMcpServers(tag.id);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      id: expect.any(String),
      serverId: expect.any(String),
      serverName: "linear",
      config: { type: "http", url: "https://linear.example/mcp" },
    });
    expect(mcpStore.getMcpServer(first[0].serverId)).toBeDefined();
    expect(tagRefCount(tag.id)).toBe(1);
    expect(legacyTagServerCount(tag.id)).toBe(0);

    insertLegacyTagServer(tag.id, "linear");
    tagStore.setTagMcpServer(tag.id, "linear", { type: "http", url: "https://override.example/mcp" });
    const replaced = tagStore.getTagMcpServers(tag.id);
    expect(replaced).toHaveLength(1);
    expect(replaced[0].serverName).toMatch(/^linear \(tag override/);
    expect(replaced[0].config).toEqual({ type: "http", url: "https://override.example/mcp" });
    expect(tagRefCount(tag.id)).toBe(1);
    expect(legacyTagServerCount(tag.id)).toBe(0);

    insertLegacyTagServer(tag.id, "linear");
    tagStore.removeTagMcpServer(tag.id, "linear");
    expect(tagStore.getTagMcpServers(tag.id)).toEqual([]);
    expect(tagRefCount(tag.id)).toBe(0);
    expect(legacyTagServerCount(tag.id)).toBe(0);
  });
});
