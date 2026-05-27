import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";
import type { AppContext } from "../app-context.js";
import { openDatabase } from "../db.js";
import { createDocsIndex } from "../docs-index.js";
import { createDocsStore } from "../docs-store.js";
import { createBridgeTools } from "../session-manager.js";
import { createTagStore } from "../tag-store.js";
import { createTagToolDefinitions } from "../tools/tag-tools.js";
import { createTaskToolDefinitions } from "../tools/task-tools.js";
import { toolFailure } from "../tool-results.js";
import { createTestApp, makeTestDir, setupTestDb } from "./helpers.js";

const NFC_CAFE = "Café";
const NFD_CAFE = "Cafe\u0301";
const CAFE_KEY = "CAFÉ";

function getTool(ctx: AppContext, name: string) {
  const tool = [
    ...createBridgeTools(ctx),
    ...createTaskToolDefinitions(ctx),
    ...createTagToolDefinitions(ctx),
  ].find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`${name} tool not found`);
  return tool as any;
}

function createInvocation(toolName: string) {
  return {
    sessionId: "session-1",
    toolCallId: `tool-${toolName}`,
    toolName,
    arguments: {},
  };
}

function insertLegacyTag(db: DatabaseSync, id: string, name: string, instructions: string, order: number): void {
  db.prepare(`
    INSERT INTO tags (id, name, color, instructions, "order", createdAt, updatedAt)
    VALUES (?, ?, 'slate', ?, ?, '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z')
  `).run(id, name, instructions, order);
}

describe("tag name normalization", () => {
  it("stores a canonical key while preserving the display name", () => {
    const db = setupTestDb();
    const tagStore = createTagStore(db);

    const tag = tagStore.createTag(NFC_CAFE);

    expect(tagStore.getTagByName(NFD_CAFE)).toEqual(expect.objectContaining({
      id: tag.id,
      name: NFC_CAFE,
    }));
    expect(() => tagStore.createTag(NFD_CAFE)).toThrow(`Tag "${NFD_CAFE}" already exists`);
    expect(db.prepare("SELECT name, nameKey FROM tags").all()).toEqual([
      { name: NFC_CAFE, nameKey: CAFE_KEY },
    ]);
  });

  it("rejects tag renames that collide on the canonical key", () => {
    const db = setupTestDb();
    const tagStore = createTagStore(db);
    const cafeTag = tagStore.createTag(NFC_CAFE);
    const otherTag = tagStore.createTag("Other");

    expect(() => tagStore.updateTag(otherTag.id, { name: NFD_CAFE })).toThrow(`Tag "${NFD_CAFE}" already exists`);
    expect(tagStore.updateTag(cafeTag.id, { name: NFD_CAFE })).toEqual(expect.objectContaining({
      id: cafeTag.id,
      name: NFD_CAFE,
    }));
    expect(tagStore.getTagByName(NFC_CAFE)?.id).toBe(cafeTag.id);
  });

  it("uses canonical tag lookups through tag tools and task tag creation", async () => {
    const { ctx } = createTestApp();
    const tagCreateTool = getTool(ctx, "tag_create");
    const taskCreateTool = getTool(ctx, "task_create");

    await expect(tagCreateTool.handler({ name: NFC_CAFE }, createInvocation("tag_create")))
      .resolves.toMatchObject({ success: true });
    await expect(tagCreateTool.handler({ name: NFD_CAFE }, createInvocation("tag_create")))
      .resolves.toEqual(toolFailure(`Tag "${NFD_CAFE}" already exists`));

    const created = await taskCreateTool.handler({
      title: "Use canonical tag",
      tags: [NFD_CAFE],
    }, createInvocation("task_create")) as { taskId: string };

    const tags = ctx.tagStore!.listTags();
    expect(tags).toHaveLength(1);
    expect(tags[0].name).toBe(NFC_CAFE);
    expect(ctx.tagStore!.getEntityTags("task", created.taskId)).toEqual([
      expect.objectContaining({ id: tags[0].id, name: NFC_CAFE }),
    ]);
  });

  it("matches related docs with the same canonical tag keys", () => {
    const docsDir = makeTestDir("docs-related-cafe-tags");
    const db = setupTestDb();
    const docsStore = createDocsStore(docsDir);
    docsStore.writePage("notes/cafe", `---
title: Cafe Notes
tags:
  - "${NFD_CAFE}"
description: Unicode-normalized cafe tag.
---
# Cafe Notes
`);

    const docsIndex = createDocsIndex(db, docsStore);
    docsIndex.reindex();

    expect(docsIndex.findDocsByTagNames([NFC_CAFE])).toMatchObject([
      {
        path: "notes/cafe",
        title: "Cafe Notes",
        tags: [NFD_CAFE],
        matchedTags: [NFC_CAFE],
      },
    ]);
  });

  it("renames docs frontmatter tags using canonical tag keys", () => {
    const docsDir = makeTestDir("docs-rename-cafe-tags");
    const docsStore = createDocsStore(docsDir);
    docsStore.writePage("notes/cafe", `---
title: Cafe Notes
tags:
  - "${NFD_CAFE}"
description: Unicode-normalized cafe tag.
---
# Cafe Notes
`);

    expect(docsStore.renameTagInDocs(NFC_CAFE, "Coffee")).toBe(1);
    expect(docsStore.readPage("notes/cafe")?.tags).toEqual(["Coffee"]);
  });

  it("migrates existing Unicode-equivalent tag rows into one canonical tag", () => {
    const dataDir = makeTestDir("tag-name-key-migration");
    const legacyDb = new DatabaseSync(join(dataDir, "bridge.db"));
    legacyDb.exec("PRAGMA foreign_keys = ON");
    legacyDb.exec(`
      CREATE TABLE tags (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        color TEXT NOT NULL DEFAULT 'slate',
        instructions TEXT NOT NULL DEFAULT '',
        "order" INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE TABLE entity_tags (
        entityType TEXT NOT NULL,
        entityId TEXT NOT NULL,
        tagId TEXT NOT NULL,
        PRIMARY KEY (entityType, entityId, tagId),
        FOREIGN KEY (tagId) REFERENCES tags(id) ON DELETE CASCADE
      );
      CREATE TABLE mcp_servers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL UNIQUE COLLATE NOCASE,
        config TEXT NOT NULL,
        enabledByDefault INTEGER NOT NULL DEFAULT 0,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );
      CREATE TABLE tag_mcp_server_refs (
        tagId TEXT NOT NULL,
        serverId TEXT NOT NULL,
        PRIMARY KEY (tagId, serverId),
        FOREIGN KEY (tagId) REFERENCES tags(id) ON DELETE CASCADE,
        FOREIGN KEY (serverId) REFERENCES mcp_servers(id) ON DELETE CASCADE
      );
    `);
    insertLegacyTag(legacyDb, "tag-survivor", NFC_CAFE, "Primary instructions", 0);
    insertLegacyTag(legacyDb, "tag-duplicate", NFD_CAFE, "Secondary instructions", 1);
    legacyDb.prepare("INSERT INTO entity_tags (entityType, entityId, tagId) VALUES (?, ?, ?)").run("task", "task-a", "tag-survivor");
    legacyDb.prepare("INSERT INTO entity_tags (entityType, entityId, tagId) VALUES (?, ?, ?)").run("task", "task-b", "tag-duplicate");
    legacyDb.prepare(`
      INSERT INTO mcp_servers (id, name, config, enabledByDefault, createdAt, updatedAt)
      VALUES (?, ?, ?, 0, '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z')
    `).run("server-a", "Server A", JSON.stringify({ command: "a", args: [] }));
    legacyDb.prepare(`
      INSERT INTO mcp_servers (id, name, config, enabledByDefault, createdAt, updatedAt)
      VALUES (?, ?, ?, 0, '2026-05-01T00:00:00.000Z', '2026-05-01T00:00:00.000Z')
    `).run("server-b", "Server B", JSON.stringify({ command: "b", args: [] }));
    legacyDb.prepare("INSERT INTO tag_mcp_server_refs (tagId, serverId) VALUES (?, ?)").run("tag-survivor", "server-a");
    legacyDb.prepare("INSERT INTO tag_mcp_server_refs (tagId, serverId) VALUES (?, ?)").run("tag-duplicate", "server-b");
    legacyDb.close();

    const db = openDatabase(dataDir);
    try {
      expect(db.prepare('SELECT id, name, nameKey, instructions, "order" AS sortOrder FROM tags ORDER BY "order"').all()).toEqual([
        {
          id: "tag-survivor",
          name: NFC_CAFE,
          nameKey: CAFE_KEY,
          instructions: "Primary instructions\n\nSecondary instructions",
          sortOrder: 0,
        },
      ]);
      expect(db.prepare("SELECT entityType, entityId, tagId FROM entity_tags ORDER BY entityId").all()).toEqual([
        { entityType: "task", entityId: "task-a", tagId: "tag-survivor" },
        { entityType: "task", entityId: "task-b", tagId: "tag-survivor" },
      ]);
      expect(db.prepare("SELECT tagId, serverId FROM tag_mcp_server_refs ORDER BY serverId").all()).toEqual([
        { tagId: "tag-survivor", serverId: "server-a" },
        { tagId: "tag-survivor", serverId: "server-b" },
      ]);
    } finally {
      db.close();
    }
  });
});
