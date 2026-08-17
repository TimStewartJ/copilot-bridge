import { describe, expect, it } from "vitest";
import type { AppContext } from "../app-context.js";
import { createDocsIndex } from "../docs-index.js";
import { createDocsStore } from "../docs-store.js";
import { getBridgeToolDefinitions } from "../agent-tools-mcp/register.js";
import { createTagStore } from "../tag-store.js";
import { createTagToolDefinitions } from "../tools/tag-tools.js";
import { createTaskToolDefinitions } from "../tools/task-tools.js";
import { toolFailure } from "../tool-results.js";
import { makeTestDir, setupTestDb } from "./helpers.js";
import { createTestApp } from "./test-app.js";

const NFC_CAFE = "Café";
const NFD_CAFE = "Cafe\u0301";
const CAFE_KEY = "CAFÉ";

function getTool(ctx: AppContext, name: string) {
  const tool = [
    ...getBridgeToolDefinitions(ctx),
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

});
