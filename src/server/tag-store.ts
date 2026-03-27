import type { DatabaseSync } from "./db.js";

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
  serverName: string;
  config: {
    command: string;
    args: string[];
    env?: Record<string, string>;
    tools?: string[];
  };
}

export interface ResolvedTagConfig {
  tags: Tag[];
  mergedInstructions: string;
  mergedMcpServers: Record<string, TagMcpServer["config"]>;
}

// ── Factory ───────────────────────────────────────────────────────

export function createTagStore(db: DatabaseSync) {
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

  function getTagMcpServers(tagId: string): TagMcpServer[] {
    const rows = db.prepare("SELECT serverName, config FROM tag_mcp_servers WHERE tagId = ?").all(tagId) as any[];
    return rows.map((r) => ({
      serverName: r.serverName,
      config: JSON.parse(r.config),
    }));
  }

  function setTagMcpServer(tagId: string, serverName: string, config: TagMcpServer["config"]): void {
    const tag = getTag(tagId);
    if (!tag) throw new Error(`Tag ${tagId} not found`);
    db.prepare(`
      INSERT OR REPLACE INTO tag_mcp_servers (tagId, serverName, config)
      VALUES (?, ?, ?)
    `).run(tagId, serverName, JSON.stringify(config));
  }

  function removeTagMcpServer(tagId: string, serverName: string): void {
    db.prepare("DELETE FROM tag_mcp_servers WHERE tagId = ? AND serverName = ?").run(tagId, serverName);
  }

  // ── Tag resolution ───────────────────────────────────────────────

  function resolveEffectiveTags(taskId: string, groupId?: string): ResolvedTagConfig {
    const tags = getEffectiveTaskTags(taskId, groupId);

    const instructionParts: string[] = [];
    const mcpServers: Record<string, TagMcpServer["config"]> = {};

    for (const tag of tags) {
      if (tag.instructions.trim()) {
        instructionParts.push(`[${tag.name}] ${tag.instructions.trim()}`);
      }
      const servers = getTagMcpServers(tag.id);
      for (const srv of servers) {
        if (!mcpServers[srv.serverName]) {
          mcpServers[srv.serverName] = srv.config;
        }
      }
    }

    return {
      tags,
      mergedInstructions: instructionParts.join("\n\n"),
      mergedMcpServers: mcpServers,
    };
  }

  return {
    listTags, getTag, getTagByName, createTag, updateTag, deleteTag, reorderTags,
    setEntityTags, getEntityTags, getEntitiesByTag, getEffectiveTaskTags,
    getTagMcpServers, setTagMcpServer, removeTagMcpServer,
    resolveEffectiveTags,
  };
}

export type TagStore = ReturnType<typeof createTagStore>;
