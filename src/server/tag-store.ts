import type { DatabaseSync } from "./db.js";
import type { McpServerConfig } from "./mcp-config.js";
import { createMcpServerStore } from "./mcp-server-store.js";

// ── Types ─────────────────────────────────────────────────────────

export const TAG_COLORS = [
  "blue", "purple", "amber", "rose", "cyan", "orange", "slate", "emerald", "indigo", "pink",
] as const;

export type TagColor = (typeof TAG_COLORS)[number];

export interface Tag {
  id: string;
  name: string;
  color: TagColor;
  instructions: string;
  order: number;
  createdAt: string;
  updatedAt: string;
}

export interface TagMcpServer {
  /** Registry server id. `id` is included for client selection UIs. */
  id: string;
  serverId: string;
  serverName: string;
  config: McpServerConfig;
}

export interface ResolvedTagConfig {
  tags: Tag[];
  mergedInstructions: string;
  mcpServerIds: string[];
  mergedMcpServers: Record<string, TagMcpServer["config"]>;
}

// ── Factory ───────────────────────────────────────────────────────

export function createTagStore(db: DatabaseSync) {
  const mcpServerStore = createMcpServerStore(db);

  function hydrate(row: any): Tag {
    return {
      id: row.id,
      name: row.name,
      color: row.color as TagColor,
      instructions: row.instructions,
      order: row.order,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }

  function nextColor(): TagColor {
    const used = new Set(
      (db.prepare("SELECT color FROM tags").all() as any[]).map((r) => r.color),
    );
    return TAG_COLORS.find((c) => !used.has(c)) ?? TAG_COLORS[0];
  }

  // ── CRUD ──────────────────────────────────────────────────────────

  function listTags(): Tag[] {
    return (db.prepare('SELECT * FROM tags ORDER BY "order"').all() as any[]).map(hydrate);
  }

  function getTag(id: string): Tag | undefined {
    const row = db.prepare("SELECT * FROM tags WHERE id = ?").get(id) as any;
    return row ? hydrate(row) : undefined;
  }

  function getTagByName(name: string): Tag | undefined {
    const row = db.prepare("SELECT * FROM tags WHERE name = ?").get(name) as any;
    return row ? hydrate(row) : undefined;
  }

  function createTag(name: string, color?: TagColor): Tag {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const count = (db.prepare("SELECT COUNT(*) as cnt FROM tags").get() as any).cnt;
    const resolvedColor = color && TAG_COLORS.includes(color) ? color : nextColor();

    db.prepare(`
      INSERT INTO tags (id, name, color, instructions, "order", createdAt, updatedAt)
      VALUES (?, ?, ?, '', ?, ?, ?)
    `).run(id, name, resolvedColor, count, now, now);

    return getTag(id)!;
  }

  function updateTag(
    id: string,
    updates: Partial<Pick<Tag, "name" | "color" | "instructions">>,
  ): Tag {
    const row = db.prepare("SELECT * FROM tags WHERE id = ?").get(id) as any;
    if (!row) throw new Error(`Tag ${id} not found`);

    const fields: string[] = ["updatedAt = ?"];
    const values: any[] = [new Date().toISOString()];

    if (updates.name !== undefined) { fields.push("name = ?"); values.push(updates.name); }
    if (updates.color !== undefined && TAG_COLORS.includes(updates.color)) {
      fields.push("color = ?"); values.push(updates.color);
    }
    if (updates.instructions !== undefined) { fields.push("instructions = ?"); values.push(updates.instructions); }

    values.push(id);
    db.prepare(`UPDATE tags SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    return getTag(id)!;
  }

  function deleteTag(id: string): void {
    db.prepare("DELETE FROM tags WHERE id = ?").run(id);
    // Re-order remaining tags
    const remaining = db.prepare('SELECT id FROM tags ORDER BY "order"').all() as any[];
    const stmt = db.prepare('UPDATE tags SET "order" = ? WHERE id = ?');
    remaining.forEach((r, i) => stmt.run(i, r.id));
  }

  function reorderTags(tagIds: string[]): Tag[] {
    const stmt = db.prepare('UPDATE tags SET "order" = ? WHERE id = ?');
    for (let i = 0; i < tagIds.length; i++) {
      stmt.run(i, tagIds[i]);
    }
    return listTags();
  }

  // ── Entity tag management ─────────────────────────────────────────

  function setEntityTags(entityType: "task" | "task_group", entityId: string, tagIds: string[]): void {
    // Validate all tagIds exist
    for (const tagId of tagIds) {
      const tag = getTag(tagId);
      if (!tag) throw new Error(`Tag ${tagId} not found`);
    }

    db.prepare("DELETE FROM entity_tags WHERE entityType = ? AND entityId = ?").run(entityType, entityId);

    const stmt = db.prepare("INSERT INTO entity_tags (entityType, entityId, tagId) VALUES (?, ?, ?)");
    for (const tagId of tagIds) {
      stmt.run(entityType, entityId, tagId);
    }
  }

  function getEntityTags(entityType: "task" | "task_group", entityId: string): Tag[] {
    const rows = db.prepare(`
      SELECT t.* FROM tags t
      JOIN entity_tags et ON et.tagId = t.id
      WHERE et.entityType = ? AND et.entityId = ?
      ORDER BY t."order"
    `).all(entityType, entityId) as any[];
    return rows.map(hydrate);
  }

  function getEntitiesByTag(tagId: string, entityType?: "task" | "task_group"): { entityType: string; entityId: string }[] {
    if (entityType) {
      return db.prepare("SELECT entityType, entityId FROM entity_tags WHERE tagId = ? AND entityType = ?").all(tagId, entityType) as any[];
    }
    return db.prepare("SELECT entityType, entityId FROM entity_tags WHERE tagId = ?").all(tagId) as any[];
  }

  function getEffectiveTaskTags(taskId: string, groupId?: string): Tag[] {
    const taskTags = getEntityTags("task", taskId);
    if (!groupId) return taskTags;

    const groupTags = getEntityTags("task_group", groupId);
    // Deduplicate by tag id
    const seen = new Set(taskTags.map((t) => t.id));
    for (const tag of groupTags) {
      if (!seen.has(tag.id)) {
        taskTags.push(tag);
        seen.add(tag.id);
      }
    }
    return taskTags;
  }

  // ── Tag MCP server management ────────────────────────────────────

  function assertTagExists(tagId: string): void {
    if (!getTag(tagId)) throw new Error(`Tag ${tagId} not found`);
  }

  function assertMcpServerExists(serverId: string): void {
    if (!mcpServerStore.getMcpServer(serverId)) throw new Error(`MCP server ${serverId} not found`);
  }

  function hydrateTagMcpServer(serverId: string): TagMcpServer {
    const server = mcpServerStore.getMcpServer(serverId);
    if (!server) throw new Error(`MCP server ${serverId} not found`);
    return {
      id: server.id,
      serverId: server.id,
      serverName: server.name,
      config: server.config,
    };
  }

  function clearLegacyTagMcpServers(tagId: string): void {
    db.prepare("DELETE FROM tag_mcp_servers WHERE tagId = ?").run(tagId);
  }

  function getTagMcpServerIds(tagId: string): string[] {
    const rows = db.prepare(`
      SELECT ms.id
      FROM tag_mcp_server_refs refs
      JOIN mcp_servers ms ON ms.id = refs.serverId
      WHERE refs.tagId = ?
      ORDER BY ms.name COLLATE NOCASE
    `).all(tagId) as Array<{ id: string }>;
    return rows.map((row) => row.id);
  }

  function getTagMcpServers(tagId: string): TagMcpServer[] {
    return getTagMcpServerIds(tagId).map(hydrateTagMcpServer);
  }

  function replaceTagMcpServerRefs(tagId: string, serverIds: string[]): TagMcpServer[] {
    assertTagExists(tagId);
    const uniqueServerIds = [...new Set(serverIds)];
    for (const serverId of uniqueServerIds) {
      assertMcpServerExists(serverId);
    }

    db.exec("BEGIN");
    try {
      db.prepare("DELETE FROM tag_mcp_server_refs WHERE tagId = ?").run(tagId);
      clearLegacyTagMcpServers(tagId);

      const stmt = db.prepare("INSERT INTO tag_mcp_server_refs (tagId, serverId) VALUES (?, ?)");
      for (const serverId of uniqueServerIds) {
        stmt.run(tagId, serverId);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    return getTagMcpServers(tagId);
  }

  function addTagMcpServerRef(tagId: string, serverId: string): TagMcpServer {
    assertTagExists(tagId);
    assertMcpServerExists(serverId);
    db.prepare(`
      INSERT OR IGNORE INTO tag_mcp_server_refs (tagId, serverId)
      VALUES (?, ?)
    `).run(tagId, serverId);
    clearLegacyTagMcpServers(tagId);
    return hydrateTagMcpServer(serverId);
  }

  function removeTagMcpServerRef(tagId: string, serverId: string): void {
    db.prepare("DELETE FROM tag_mcp_server_refs WHERE tagId = ? AND serverId = ?").run(tagId, serverId);
    clearLegacyTagMcpServers(tagId);
  }

  function removeTagMcpServerRefsByServerId(serverId: string): void {
    db.prepare("DELETE FROM tag_mcp_server_refs WHERE serverId = ?").run(serverId);
  }

  function matchingTagMcpServerRefIds(tagId: string, serverName: string): string[] {
    const lowerName = serverName.trim().toLocaleLowerCase();
    if (!lowerName) return [];
    const rows = db.prepare(`
      SELECT ms.id, ms.name
      FROM tag_mcp_server_refs refs
      JOIN mcp_servers ms ON ms.id = refs.serverId
      WHERE refs.tagId = ?
    `).all(tagId) as Array<{ id: string; name: string }>;
    return rows
      .filter((row) => {
        const lowerRowName = row.name.toLocaleLowerCase();
        return lowerRowName === lowerName || lowerRowName.startsWith(`${lowerName} (`);
      })
      .map((row) => row.id);
  }

  function setTagMcpServer(tagId: string, serverName: string, config: TagMcpServer["config"]): void {
    assertTagExists(tagId);
    const server = mcpServerStore.ensureMcpServerForNameAndConfig(serverName, config, false);
    db.exec("BEGIN");
    try {
      for (const serverId of matchingTagMcpServerRefIds(tagId, serverName)) {
        db.prepare("DELETE FROM tag_mcp_server_refs WHERE tagId = ? AND serverId = ?").run(tagId, serverId);
      }
      db.prepare(`
        INSERT OR IGNORE INTO tag_mcp_server_refs (tagId, serverId)
        VALUES (?, ?)
      `).run(tagId, server.id);
      clearLegacyTagMcpServers(tagId);
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function removeTagMcpServer(tagId: string, serverName: string): void {
    for (const serverId of matchingTagMcpServerRefIds(tagId, serverName)) {
      db.prepare("DELETE FROM tag_mcp_server_refs WHERE tagId = ? AND serverId = ?").run(tagId, serverId);
    }
    clearLegacyTagMcpServers(tagId);
  }

  // ── Tag resolution ───────────────────────────────────────────────

  function resolveEffectiveTags(taskId: string, groupId?: string): ResolvedTagConfig {
    const tags = getEffectiveTaskTags(taskId, groupId);

    const instructionParts: string[] = [];
    const mcpServerIds: string[] = [];
    const seenMcpServerIds = new Set<string>();
    const mcpServers: Record<string, TagMcpServer["config"]> = {};

    for (const tag of tags) {
      if (tag.instructions.trim()) {
        instructionParts.push(`[${tag.name}] ${tag.instructions.trim()}`);
      }
      const servers = getTagMcpServers(tag.id);
      for (const srv of servers) {
        if (!seenMcpServerIds.has(srv.serverId)) {
          mcpServerIds.push(srv.serverId);
          seenMcpServerIds.add(srv.serverId);
        }
        if (!mcpServers[srv.serverName]) {
          mcpServers[srv.serverName] = srv.config;
        }
      }
    }

    return {
      tags,
      mergedInstructions: instructionParts.join("\n\n"),
      mcpServerIds,
      mergedMcpServers: mcpServers,
    };
  }

  return {
    listTags, getTag, getTagByName, createTag, updateTag, deleteTag, reorderTags,
    setEntityTags, getEntityTags, getEntitiesByTag, getEffectiveTaskTags,
    getTagMcpServerIds, getTagMcpServers,
    replaceTagMcpServerRefs, addTagMcpServerRef, removeTagMcpServerRef, removeTagMcpServerRefsByServerId,
    setTagMcpServer, removeTagMcpServer,
    resolveEffectiveTags,
  };
}

export type TagStore = ReturnType<typeof createTagStore>;
