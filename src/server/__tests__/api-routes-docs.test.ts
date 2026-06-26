import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiRouteTestState, DeferredPromptRunner } from "./api-routes-test-helpers.js";
import {
  createCopilotUsageTestHome,
  createMockSessionManager,
  createMockTranscriptionService,
  createRestartRuntimePaths,
  createTestApp,
  createWavBuffer,
  eventually,
  get,
  installApiRouteTestHooks,
  join,
  makeTestDir,
  mkdirSync,
  providers,
  publishOutboundAttachment,
  RESTART_PENDING_MESSAGE,
  request,
  scheduler,
  UserInputBrokerError,
  writeCopilotUsageEvents,
  writeRawCopilotUsageEvents,
  writeFileSync,
  writeRestartState,
} from "./api-routes-test-helpers.js";
import { initializeDocsFts } from "../db.js";

let app: ApiRouteTestState["app"];
let ctx: ApiRouteTestState["ctx"];
let db: ApiRouteTestState["db"];

installApiRouteTestHooks((state) => {
  ({ app, ctx, db } = state);
});

const unsafeDocsRoutePaths = [
  ["drive-relative", "C:foo"],
  ["drive-absolute", "C:/foo"],
  ["UNC", "%5C%5Cserver%5Cshare"],
] as const;

describe("Tag MCP server routes", () => {
  let tagId: string;

  beforeEach(async () => {
    const tag = (await request(app).post("/api/tags").send({ name: "mcp-test" })).body.tag;
    tagId = tag.id;
  });

  it("GET /api/tags/:id/mcp returns empty servers initially", async () => {
    const res = await request(app).get(`/api/tags/${tagId}/mcp`);
    expect(res.status).toBe(200);
    expect(res.body.servers).toEqual([]);
  });

  it("PUT /api/tags/:id/mcp/:serverName sets an MCP server", async () => {
    const res = await request(app)
      .put(`/api/tags/${tagId}/mcp/test-server`)
      .send({ command: "echo", args: ["hello"] });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("PUT /api/tags/:id/mcp/:serverName stores remote MCP server configs", async () => {
    const remoteConfig = {
      type: "sse",
      url: "https://example.com/mcp",
      headers: { Authorization: "Bearer tag-token" },
      tools: ["search"],
    };

    const put = await request(app)
      .put(`/api/tags/${tagId}/mcp/remote-server`)
      .send(remoteConfig);

    expect(put.status).toBe(200);

    const get = await request(app).get(`/api/tags/${tagId}/mcp`);
    expect(get.body.servers).toEqual([
      expect.objectContaining({
        id: expect.any(String),
        serverId: expect.any(String),
        serverName: "remote-server",
        config: remoteConfig,
      }),
    ]);
  });

  it("DELETE /api/tags/:id/mcp/:serverName removes an MCP server", async () => {
    await request(app)
      .put(`/api/tags/${tagId}/mcp/to-delete`)
      .send({ command: "echo", args: [] });

    const res = await request(app).delete(`/api/tags/${tagId}/mcp/to-delete`);
    expect(res.status).toBe(200);

    const get = await request(app).get(`/api/tags/${tagId}/mcp`);
    expect(get.body.servers).toEqual([]);
  });
});

describe("Task group tag routes", () => {
  it("PUT /api/task-groups/:id/tags assigns tags to a group", async () => {
    const group = (await request(app).post("/api/task-groups").send({ name: "Tagged Group" })).body.group;
    const tag = (await request(app).post("/api/tags").send({ name: "group-tag" })).body.tag;

    const res = await request(app)
      .put(`/api/task-groups/${group.id}/tags`)
      .send({ tagIds: [tag.id] });
    expect(res.status).toBe(200);

    const list = await request(app).get("/api/task-groups");
    const found = list.body.groups.find((g: any) => g.id === group.id);
    expect(found.tags).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "group-tag" })]),
    );
  });
});

describe("Docs routes", () => {
  it("GET /api/docs/tree returns empty tree initially", async () => {
    const res = await request(app).get("/api/docs/tree");
    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty("tree");
    expect(res.body).toHaveProperty("hasRootIndex");
  });

  it("PUT /api/docs/pages writes a page", async () => {
    const res = await request(app)
      .put("/api/docs/pages/test-page")
      .send({ content: "# Test Page\n\nHello world" });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.path).toBe("test-page");
  });

  it("PUT /api/docs/pages rejects tagged pages without a description", async () => {
    const res = await request(app)
      .put("/api/docs/pages/tagged-page")
      .send({
        content: `---
title: Tagged page
tags:
  - deploy
---

# Tagged page
`,
      });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Tagged docs must include a non-empty frontmatter description");
    expect(ctx.docsStore!.readPage("tagged-page")).toBeNull();
  });

  it("GET /api/docs/pages reads a written page", async () => {
    await request(app)
      .put("/api/docs/pages/read-me")
      .send({ content: "# Read Me\n\nContent here" });

    const res = await request(app).get("/api/docs/pages/read-me");
    expect(res.status).toBe(200);
    expect(res.body.body).toContain("Content here");
    expect(res.body.title).toBe("read-me");
    expect(res.body.isDbItem).toBe(false);
  });

  it("GET /api/docs/pages returns 404 for missing page", async () => {
    const res = await request(app).get("/api/docs/pages/nonexistent");
    expect(res.status).toBe(404);
  });

  it.each(unsafeDocsRoutePaths)("GET /api/docs/pages rejects unsafe path: %s", async (_label, routePath) => {
    const res = await request(app).get(`/api/docs/pages/${routePath}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid page path");
  });

  it.each(unsafeDocsRoutePaths)("PUT /api/docs/pages rejects unsafe path: %s", async (_label, routePath) => {
    const res = await request(app)
      .put(`/api/docs/pages/${routePath}`)
      .send({ content: "# Unsafe" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid page path");
  });

  it("DELETE /api/docs/pages deletes a page", async () => {
    await request(app)
      .put("/api/docs/pages/to-delete")
      .send({ content: "# Delete Me" });

    const res = await request(app).delete("/api/docs/pages/to-delete");
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);

    const get = await request(app).get("/api/docs/pages/to-delete");
    expect(get.status).toBe(404);
  });

  it("PUT /api/docs/pages overwrites an existing page", async () => {
    // Write a page, then verify it can be read back
    const write = await request(app)
      .put("/api/docs/pages/overwrite-me")
      .send({ content: "# First Version" });
    expect(write.status).toBe(200);

    const read = await request(app).get("/api/docs/pages/overwrite-me");
    expect(read.status).toBe(200);
    expect(read.body.body).toContain("First Version");
  });

  it("GET /api/docs/tree reflects created pages", async () => {
    await request(app)
      .put("/api/docs/pages/notes/first")
      .send({ content: "# First Note" });

    const res = await request(app).get("/api/docs/tree");
    expect(res.status).toBe(200);
    const tree = res.body.tree;
    expect(tree.length).toBeGreaterThan(0);
  });

  it("treats folder index pages as folder paths in page routes and tree output", async () => {
    const write = await request(app)
      .put("/api/docs/pages/guides/index")
      .send({ content: "# Guide Home\n\nFolder landing page." });
    expect(write.status).toBe(200);
    expect(write.body.path).toBe("guides");

    const readByFolder = await request(app).get("/api/docs/pages/guides");
    expect(readByFolder.status).toBe(200);
    expect(readByFolder.body.path).toBe("guides");
    expect(readByFolder.body.isFolderIndex).toBe(true);
    expect(readByFolder.body.body).toContain("Folder landing page.");

    const readByAlias = await request(app).get("/api/docs/pages/guides/index");
    expect(readByAlias.status).toBe(200);
    expect(readByAlias.body.path).toBe("guides");

    const treeRes = await request(app).get("/api/docs/tree");
    const guides = treeRes.body.tree.find((node: any) => node.path === "guides");
    expect(guides).toMatchObject({ type: "folder", hasIndex: true });
    expect(guides.children?.some((node: any) => node.path === "guides/index")).toBe(false);
  });

  it("DELETE /api/docs/pages removes folder index aliases using canonical paths", async () => {
    await request(app)
      .put("/api/docs/pages/guides/index")
      .send({ content: "# Guide Home" });

    const res = await request(app).delete("/api/docs/pages/guides/index");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ path: "guides", deleted: true });

    const get = await request(app).get("/api/docs/pages/guides");
    expect(get.status).toBe(404);
  });

  it("GET /api/docs/search finds indexed pages", async () => {
    await request(app)
      .put("/api/docs/pages/searchable")
      .send({ content: "# Unique Keyword\n\nThis page has xylophone content" });

    const res = await request(app).get("/api/docs/search?q=xylophone");
    expect(res.status).toBe(200);
    expect(res.body.results.length).toBeGreaterThan(0);
  });

  it("self-heals a conflicting docs FTS table before docs search", async () => {
    await request(app)
      .put("/api/docs/pages/self-healing-search")
      .send({ content: "# Self Healing Search\n\nThis page has xylophone content" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      db.exec("DROP TABLE docs_fts");
      db.exec("CREATE TABLE docs_fts(dummy TEXT)");
      initializeDocsFts(db);

      const health = await request(app).get("/api/health");
      expect(health.status).toBe(200);
      expect(health.body).toMatchObject({
        ok: true,
        docsFts: {
          ok: true,
          status: "available",
          repaired: true,
          previousFailure: { detectedBy: "schema_probe" },
        },
      });

      const res = await request(app).get("/api/docs/search?q=xylophone");
      expect(res.status).toBe(200);
      expect(res.body.results.map((result: any) => result.path)).toContain("self-healing-search");
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn.mock.calls[0]?.[0]).toContain("Repaired docs full-text search index");
    } finally {
      warn.mockRestore();
    }
  });

  it("GET /api/docs/search surfaces unhealthy docs FTS state when repair is unavailable", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      db.exec("DROP TABLE docs_fts");
      db.exec("CREATE TABLE docs_fts(dummy TEXT)");
      initializeDocsFts(db, { repair: false });

      const write = await request(app)
        .put("/api/docs/pages/degraded-search")
        .send({ content: "# Degraded Search\n\nThis page persists even when FTS is unhealthy." });
      expect(write.status).toBe(200);
      expect(write.body).toMatchObject({
        success: true,
        indexed: false,
        indexError: {
          code: "docs_fts_unavailable",
          health: { ok: false },
        },
      });

      const health = await request(app).get("/api/health");
      expect(health.status).toBe(200);
      expect(health.body).toMatchObject({
        ok: true,
        docsFts: {
          ok: false,
          status: "unavailable",
          code: "docs_fts_init_failed",
        },
      });

      const res = await request(app).get("/api/docs/search?q=xylophone");
      expect(res.status).toBe(503);
      expect(res.body).toMatchObject({
        code: "docs_fts_unavailable",
        operation: "search docs",
        health: {
          ok: false,
          status: "unavailable",
          code: "docs_fts_init_failed",
          detectedBy: "schema_probe",
        },
      });
      expect(res.body.error).toContain("Docs full-text search is unavailable");
      expect(warn).toHaveBeenCalledTimes(1);
    } finally {
      warn.mockRestore();
    }
  });

  it("POST /api/docs/reindex rebuilds the index", async () => {
    const res = await request(app).post("/api/docs/reindex");
    expect(res.status).toBe(200);
    expect(typeof res.body.indexed).toBe("number");
  });

  it("POST /api/docs/snapshots creates a restorable docs snapshot", async () => {
    await request(app)
      .put("/api/docs/pages/snapshot-source")
      .send({ content: "# Snapshot Source\n\nDurable content" });

    const create = await request(app)
      .post("/api/docs/snapshots")
      .send({ reason: "manual-test" });

    expect(create.status).toBe(200);
    expect(create.body.created).toBe(true);
    expect(create.body.snapshot).toMatchObject({
      reason: "manual-test",
      fileCount: 1,
    });

    const list = await request(app).get("/api/docs/snapshots");
    expect(list.status).toBe(200);
    expect(list.body.snapshots.map((snapshot: any) => snapshot.id)).toContain(create.body.snapshot.id);
  });

  it("POST /api/docs/snapshots/:id/restore restores docs and rebuilds the search index", async () => {
    await request(app)
      .put("/api/docs/pages/restorable")
      .send({ content: "# Restorable\n\nOriginal body" });
    const create = await request(app)
      .post("/api/docs/snapshots")
      .send({ reason: "restore-test" });
    const snapshotId = create.body.snapshot.id;

    await request(app)
      .put("/api/docs/pages/restorable")
      .send({ content: "# Restorable\n\nChanged body" });
    await request(app)
      .put("/api/docs/pages/temporary")
      .send({ content: "# Temporary\n\nShould disappear" });

    const rejected = await request(app)
      .post(`/api/docs/snapshots/${snapshotId}/restore`)
      .send({});
    expect(rejected.status).toBe(400);

    const restore = await request(app)
      .post(`/api/docs/snapshots/${snapshotId}/restore`)
      .send({ confirm: true });

    expect(restore.status).toBe(200);
    expect(restore.body.success).toBe(true);
    expect(restore.body.restoredFrom.id).toBe(snapshotId);
    expect(restore.body.preRestoreSnapshotId).toBeTruthy();

    const restored = await request(app).get("/api/docs/pages/restorable");
    expect(restored.status).toBe(200);
    expect(restored.body.body).toContain("Original body");

    const missing = await request(app).get("/api/docs/pages/temporary");
    expect(missing.status).toBe(404);

    const staleSearch = await request(app).get("/api/docs/search?q=disappear");
    expect(staleSearch.status).toBe(200);
    expect(staleSearch.body.results.map((result: any) => result.path)).not.toContain("temporary");
  });

  it("DELETE /api/docs/pages creates a throttled pre-delete snapshot", async () => {
    await request(app)
      .put("/api/docs/pages/to-delete-with-snapshot")
      .send({ content: "# Snapshot Before Delete" });
    await request(app)
      .put("/api/docs/pages/to-delete-with-same-snapshot")
      .send({ content: "# Same Snapshot Window" });

    const res = await request(app).delete("/api/docs/pages/to-delete-with-snapshot");
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);

    const list = await request(app).get("/api/docs/snapshots");
    expect(list.status).toBe(200);
    const preDeleteSnapshots = list.body.snapshots.filter((snapshot: any) => snapshot.reason === "pre-delete");
    expect(preDeleteSnapshots).toHaveLength(1);

    const secondDelete = await request(app).delete("/api/docs/pages/to-delete-with-same-snapshot");
    expect(secondDelete.status).toBe(200);
    const secondList = await request(app).get("/api/docs/snapshots");
    expect(secondList.body.snapshots.filter((snapshot: any) => snapshot.reason === "pre-delete")).toHaveLength(1);
  });

  it("GET /api/docs/search returns empty for no match", async () => {
    const res = await request(app).get("/api/docs/search?q=nonexistentterm12345");
    expect(res.status).toBe(200);
    expect(res.body.results).toEqual([]);
  });
});

describe("Docs DB routes", () => {
  const folder = "incidents";

  beforeEach(async () => {
    await request(app)
      .put(`/api/docs/schema/${folder}`)
      .send({
        name: "Incidents",
        fields: [
          { name: "severity", type: "select", options: ["sev1", "sev2", "sev3"] },
          { name: "date", type: "date" },
          { name: "resolved", type: "boolean" },
        ],
      });
  });

  it("PUT /api/docs/schema creates a collection schema", async () => {
    const res = await request(app).get(`/api/docs/schema/${folder}`);
    expect(res.status).toBe(200);
    expect(res.body.name).toBe("Incidents");
    expect(res.body.fields.length).toBe(3);
    expect(typeof res.body.entryCount).toBe("number");
  });

  it.each(unsafeDocsRoutePaths)("PUT /api/docs/schema rejects unsafe collection path: %s", async (_label, routePath) => {
    const res = await request(app)
      .put(`/api/docs/schema/${routePath}`)
      .send({ name: "Unsafe", fields: [] });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid folder");
  });

  it.each(unsafeDocsRoutePaths)("GET /api/docs/db rejects unsafe collection path: %s", async (_label, routePath) => {
    const res = await request(app).get(`/api/docs/db/${routePath}`);

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid folder");
  });

  it("POST /api/docs/db creates an entry", async () => {
    const res = await request(app)
      .post(`/api/docs/db/${folder}`)
      .send({
        fields: { title: "March Outage", severity: "sev1", date: "2026-03-15" },
        body: "The database went down.",
      });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(res.body.slug).toBeTruthy();
  });

  it("POST /api/docs/db normalizes top-level fields into a DB entry", async () => {
    const res = await request(app)
      .post(`/api/docs/db/${folder}`)
      .send({
        title: "Top-level outage",
        severity: "sev2",
        body: "Normalized from top-level fields.",
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const page = ctx.docsStore!.readPage(`${folder}/${res.body.slug}`);
    expect(page?.frontmatter.title).toBe("Top-level outage");
    expect(page?.frontmatter.severity).toBe("sev2");
    expect(page?.body).toBe("Normalized from top-level fields.");
  });

  it("GET /api/docs/pages marks DB entries", async () => {
    const create = await request(app)
      .post(`/api/docs/db/${folder}`)
      .send({
        fields: { title: "Marked outage", severity: "sev1" },
        body: "Body content",
      });

    const res = await request(app).get(`/api/docs/pages/${folder}/${create.body.slug}`);
    expect(res.status).toBe(200);
    expect(res.body.isDbItem).toBe(true);
    expect(res.body.folder).toBe(folder);
  });

  it("DELETE /api/docs/pages refuses to remove DB entries", async () => {
    const create = await request(app)
      .post(`/api/docs/db/${folder}`)
      .send({
        fields: { title: "Protected outage", severity: "sev1" },
        body: "Body content",
      });

    const res = await request(app).delete(`/api/docs/pages/${folder}/${create.body.slug}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("database entry");
    expect(ctx.docsStore!.readPage(`${folder}/${create.body.slug}`)?.isDbItem).toBe(true);
  });

  it("POST /api/docs/db extracts DB fields from body frontmatter when fields are missing", async () => {
    const res = await request(app)
      .post(`/api/docs/db/${folder}`)
      .send({
        body: "---\ntitle: Frontmatter outage\nseverity: sev1\nresolved: false\ncreated: 2026-04-09T00:00:00.000Z\nmodified: 2026-04-09T00:00:00.000Z\n---\n\nRecovered from pasted raw markdown.",
      });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const page = ctx.docsStore!.readPage(`${folder}/${res.body.slug}`);
    expect(page?.frontmatter.title).toBe("Frontmatter outage");
    expect(page?.frontmatter.severity).toBe("sev1");
    expect(page?.frontmatter.resolved).toBe(false);
    expect(page?.body).toBe("Recovered from pasted raw markdown.");
  });

  it("GET /api/docs/db queries entries", async () => {
    await request(app)
      .post(`/api/docs/db/${folder}`)
      .send({ fields: { title: "Entry A", severity: "sev1" } });
    await request(app)
      .post(`/api/docs/db/${folder}`)
      .send({ fields: { title: "Entry B", severity: "sev2" } });

    const res = await request(app).get(`/api/docs/db/${folder}`);
    expect(res.status).toBe(200);
    expect(res.body.entries.length).toBe(2);
    expect(typeof res.body.total).toBe("number");
    expect(res.body.entries.every((entry: any) => !("body" in entry))).toBe(true);
  });

  it("GET /api/docs/db can include markdown bodies", async () => {
    await request(app)
      .post(`/api/docs/db/${folder}`)
      .send({ fields: { title: "Body entry", severity: "sev1" }, body: "Body text for query results." });

    const res = await request(app).get(`/api/docs/db/${folder}?_includeBody=true`);
    expect(res.status).toBe(200);
    expect(res.body.entries).toHaveLength(1);
    expect(res.body.entries[0].body).toBe("Body text for query results.");
  });

  it("PATCH /api/docs/db updates an entry", async () => {
    const create = await request(app)
      .post(`/api/docs/db/${folder}`)
      .send({ fields: { title: "Patchable", severity: "sev3" } });
    const slug = create.body.slug;

    const res = await request(app)
      .patch(`/api/docs/db/${folder}/${slug}`)
      .send({ fields: { severity: "sev1" } });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
  });

  it("PATCH /api/docs/db normalizes top-level update fields", async () => {
    const create = await request(app)
      .post(`/api/docs/db/${folder}`)
      .send({ fields: { title: "Patch top-level", severity: "sev3" } });
    const slug = create.body.slug;

    const res = await request(app)
      .patch(`/api/docs/db/${folder}/${slug}`)
      .send({ severity: "sev1" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(ctx.docsStore!.readPage(`${folder}/${slug}`)?.frontmatter.severity).toBe("sev1");
  });

  it("PATCH /api/docs/db allows body-only updates", async () => {
    const create = await request(app)
      .post(`/api/docs/db/${folder}`)
      .send({ fields: { title: "Body only patch", severity: "sev3" }, body: "Original body" });
    const slug = create.body.slug;

    const res = await request(app)
      .patch(`/api/docs/db/${folder}/${slug}`)
      .send({ body: "Updated body only" });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(ctx.docsStore!.readPage(`${folder}/${slug}`)?.body).toBe("Updated body only");

    const updatedSearch = await request(app).get("/api/docs/search?q=Updated%20body%20only");
    expect(updatedSearch.status).toBe(200);
    expect(updatedSearch.body.results.map((r: any) => r.path)).toContain(`${folder}/${slug}`);

    const staleSearch = await request(app).get("/api/docs/search?q=Original%20body");
    expect(staleSearch.status).toBe(200);
    expect(staleSearch.body.results.map((r: any) => r.path)).not.toContain(`${folder}/${slug}`);
  });

  it("POST /api/docs/db validates required title", async () => {
    const res = await request(app)
      .post(`/api/docs/db/${folder}`)
      .send({ fields: { severity: "sev1" } });
    expect(res.status).toBe(400);
  });

  it("POST /api/docs/db returns actionable guidance when no fields can be inferred", async () => {
    const res = await request(app)
      .post(`/api/docs/db/${folder}`)
      .send({ body: "# Just markdown" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("docs_db_add expects");
    expect(res.body.error).toContain(`folder: "${folder}"`);
  });

  it("PUT /api/docs/pages rejects DB-folder writes with docs_db_add guidance", async () => {
    const res = await request(app)
      .put(`/api/docs/pages/${folder}/manual-write`)
      .send({ content: "# Raw write" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain(`Cannot write raw content to DB folder "${folder}"`);
    expect(res.body.error).toContain("docs_db_add");
    expect(res.body.error).toContain(`folder: "${folder}"`);
  });

  it("PUT /api/docs/pages rejects DB collection folder index writes", async () => {
    const res = await request(app)
      .put(`/api/docs/pages/${folder}/index`)
      .send({ content: "# Raw collection index" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain(`Cannot write raw content to DB folder "${folder}"`);
    expect(res.body.error).toContain("docs_db_add");
  });

  it("DELETE /api/docs/db removes a DB entry", async () => {
    const create = await request(app)
      .post(`/api/docs/db/${folder}`)
      .send({ fields: { title: "Deletable outage", severity: "sev1" }, body: "Body content" });
    const slug = create.body.slug;
    expect(ctx.docsStore!.readPage(`${folder}/${slug}`)?.isDbItem).toBe(true);

    const res = await request(app).delete(`/api/docs/db/${folder}/${slug}`);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(true);
    expect(res.body.path).toBe(`${folder}/${slug}`);
    expect(ctx.docsStore!.readPage(`${folder}/${slug}`)).toBeNull();

    const search = await request(app).get("/api/docs/search?q=Deletable%20outage");
    expect(search.body.results.map((r: any) => r.path)).not.toContain(`${folder}/${slug}`);
  });

  it("DELETE /api/docs/db returns deleted:false for a missing slug", async () => {
    const res = await request(app).delete(`/api/docs/db/${folder}/does-not-exist`);
    expect(res.status).toBe(200);
    expect(res.body.deleted).toBe(false);
  });

  it("DELETE /api/docs/db rejects an unknown collection", async () => {
    const res = await request(app).delete("/api/docs/db/not-a-collection/some-slug");
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("No database collection found");
  });

  it("DELETE /api/docs/db rejects a path without a slug", async () => {
    const res = await request(app).delete(`/api/docs/db/${folder}`);
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("folder/slug");
  });

  it("PATCH /api/docs/db updates fields and body from raw editor content", async () => {
    const create = await request(app)
      .post(`/api/docs/db/${folder}`)
      .send({ fields: { title: "Raw editable", severity: "sev3" }, body: "Original body" });
    const slug = create.body.slug;
    const originalCreated = ctx.docsStore!.readPage(`${folder}/${slug}`)?.frontmatter.created;

    const content = [
      "---",
      'title: "Raw editable"',
      'severity: "sev1"',
      'created: "2000-01-01T00:00:00.000Z"',
      'modified: "2000-01-01T00:00:00.000Z"',
      "---",
      "",
      "Updated raw body",
    ].join("\n");

    const res = await request(app)
      .patch(`/api/docs/db/${folder}/${slug}`)
      .send({ content });

    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);

    const page = ctx.docsStore!.readPage(`${folder}/${slug}`);
    expect(page?.frontmatter.severity).toBe("sev1");
    expect(page?.frontmatter.title).toBe("Raw editable");
    expect(page?.body).toBe("Updated raw body");
    // System fields from the editor payload are ignored; original created is preserved.
    expect(page?.frontmatter.created).toBe(originalCreated);
    expect(page?.frontmatter.modified).not.toBe("2000-01-01T00:00:00.000Z");
  });

  it("PATCH /api/docs/db rejects malformed frontmatter content without mutating the entry", async () => {
    const create = await request(app)
      .post(`/api/docs/db/${folder}`)
      .send({ fields: { title: "Protected from corruption", severity: "sev2" }, body: "Keep me" });
    const slug = create.body.slug;

    const res = await request(app)
      .patch(`/api/docs/db/${folder}/${slug}`)
      .send({ content: "---\nseverity: [unterminated\n---\n\nNew body" });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Invalid frontmatter");

    const page = ctx.docsStore!.readPage(`${folder}/${slug}`);
    expect(page?.frontmatter.severity).toBe("sev2");
    expect(page?.body).toBe("Keep me");
  });
});
