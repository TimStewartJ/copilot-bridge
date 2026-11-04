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

function tagRefCount(tagId: string): number {
  return (db.prepare("SELECT COUNT(*) AS count FROM tag_mcp_server_refs WHERE tagId = ?").get(tagId) as any).count;
}

function serverRefCount(serverId: string): number {
  return (db.prepare("SELECT COUNT(*) AS count FROM tag_mcp_server_refs WHERE serverId = ?").get(serverId) as any).count;
}

describe("tag-store MCP server references", () => {
  it("replaces a tag’s old registry references and removes individual selected servers", () => {
    const tag = tagStore.createTag("AI");
    const local = mcpStore.createMcpServer({ name: "Local", config: { command: "local-mcp", args: ["serve"] } });
    const remote = mcpStore.createMcpServer({
      name: "Remote",
      config: { type: "http", url: "https://remote.example/mcp" },
    });

    const old = mcpStore.createMcpServer({ name: "Old", config: { command: "old-mcp", args: [] } });
    expect(tagStore.addTagMcpServerRef(tag.id, old.id).serverId).toBe(old.id);
    expect(tagStore.getTagMcpServerIds(tag.id)).toEqual([old.id]);

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
    tagStore.removeTagMcpServerRef(tag.id, remote.id);
    expect(tagStore.getTagMcpServerIds(tag.id)).toEqual([local.id]);
    tagStore.removeTagMcpServerRef(tag.id, local.id);
    expect(tagStore.getTagMcpServerIds(tag.id)).toEqual([]);
    expect(tagRefCount(tag.id)).toBe(0);
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
    mcpStore.deleteMcpServer("missing-server");
    // Refs to other servers survive.
    expect(tagStore.getTagMcpServerIds(tag.id)).toEqual([survivor.id]);
    expect(tagRefCount(tag.id)).toBe(1);
    expect(serverRefCount(survivor.id)).toBe(1);
    // The other tag loses its only ref.
    expect(tagStore.getTagMcpServers(otherTag.id)).toEqual([]);
    expect(tagRefCount(otherTag.id)).toBe(0);
  });
});
