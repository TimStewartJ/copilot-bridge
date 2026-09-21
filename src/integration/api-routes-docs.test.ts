import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiRouteTestState, DeferredPromptRunner } from "../test-support/api-routes.js";
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
  request,
  scheduler,
  writeCopilotUsageEvents,
  writeRawCopilotUsageEvents,
  writeFileSync,
  writeRestartState,
} from "../test-support/api-routes.js";
import { initializeDocsFts } from "../server/db.js";

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

describe.each(["/api/docs/search", "/api/docs/db/incidents"])("%s pagination", (route) => {
  it.each(["-1", "1.5", "NaN", "Infinity", "9007199254740992"])("rejects offset=%s", async (offset) => {
    const res = await request(app).get(route).query({ offset });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "offset must be a non-negative integer." });
  });

  it.each(["0", "-1", "1.5", "NaN"])("rejects limit=%s", async (limit) => {
    const res = await request(app).get(route).query({ limit });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "limit must be a positive integer." });
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

  it("GET /api/docs/search finds indexed pages", async () => {
    await request(app)
      .put("/api/docs/pages/searchable")
      .send({ content: "# Unique Keyword\n\nThis page has xylophone content" });

    const res = await request(app).get("/api/docs/search?q=xylophone");
    expect(res.status).toBe(200);
    expect(res.body.results.length).toBeGreaterThan(0);
  });

  it.each([
    { query: {}, limit: 50, offset: 0 },
    { query: { limit: "201", offset: "0" }, limit: 200, offset: 0 },
    { query: { offset: String(Number.MAX_SAFE_INTEGER) }, limit: 50, offset: Number.MAX_SAFE_INTEGER },
  ])("GET /api/docs/search passes validated pagination $query to the index", async ({ query, limit, offset }) => {
    const search = vi.spyOn(ctx.docsIndex!, "search");
    try {
      const res = await request(app).get("/api/docs/search").query({ q: "xylophone", ...query });

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ results: [], total: 0 });
      expect(search).toHaveBeenCalledWith("xylophone", limit, offset);
    } finally {
      search.mockRestore();
    }
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

    const preDeleteSnapshots = ctx.docsSnapshotStore!
      .listSnapshots()
      .filter((snapshot) => snapshot.reason === "pre-delete");
    expect(preDeleteSnapshots).toHaveLength(1);

    const secondDelete = await request(app).delete("/api/docs/pages/to-delete-with-same-snapshot");
    expect(secondDelete.status).toBe(200);
    expect(ctx.docsSnapshotStore!
      .listSnapshots()
      .filter((snapshot) => snapshot.reason === "pre-delete")).toHaveLength(1);
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

  it.each([
    { query: {}, limit: 10000, offset: 0 },
    { query: { limit: "10001", offset: "0" }, limit: 10000, offset: 0 },
    { query: { offset: String(Number.MAX_SAFE_INTEGER) }, limit: 10000, offset: Number.MAX_SAFE_INTEGER },
  ])("GET /api/docs/db passes validated pagination $query to the index", async ({ query, limit, offset }) => {
    const queryByFolder = vi.spyOn(ctx.docsIndex!, "queryByFolder");
    try {
      const res = await request(app).get(`/api/docs/db/${folder}`).query(query);

      expect(res.status).toBe(200);
      expect(res.body).toEqual({ entries: [], total: 0 });
      expect(queryByFolder).toHaveBeenCalledWith(folder, undefined, undefined, limit, offset, false);
    } finally {
      queryByFolder.mockRestore();
    }
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

});

describe("Docs routes for the docs UI", () => {
  it("GET /api/docs/tree carries titles, summaries and collection names", async () => {
    await request(app).put("/api/docs/pages/guides/deploy").send({
      frontmatter: { title: "Deploying: the safe way", description: "How releases ship.", tags: ["release"] },
      body: "Body",
    });
    await request(app).put("/api/docs/schema/runbooks").send({ name: "Runbook library", fields: [{ name: "owner", type: "text" }] });

    const res = await request(app).get("/api/docs/tree");
    expect(res.status).toBe(200);
    const guides = res.body.tree.find((node: any) => node.path === "guides");
    expect(guides.children).toEqual([
      expect.objectContaining({
        path: "guides/deploy",
        title: "Deploying: the safe way",
        description: "How releases ship.",
        tags: ["release"],
        modified: expect.any(String),
      }),
    ]);
    expect(res.body.tree.find((node: any) => node.path === "runbooks")).toMatchObject({ isDb: true, title: "Runbook library" });
  });

  it("GET /api/docs/tree still answers when tree metadata cannot be read", async () => {
    await request(app).put("/api/docs/pages/plain").send({ content: "# Plain" });
    const decorate = vi.spyOn(ctx.docsIndex!, "decorateTree").mockImplementation(() => {
      throw new Error("index unavailable");
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const res = await request(app).get("/api/docs/tree");
      expect(res.status).toBe(200);
      expect(res.body.tree).toEqual([{ name: "plain", type: "file", path: "plain" }]);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("Tree metadata unavailable"));
    } finally {
      decorate.mockRestore();
      warn.mockRestore();
    }
  });

  it("PUT /api/docs/pages serializes structured frontmatter on the server", async () => {
    const save = await request(app).put("/api/docs/pages/notes/plan").send({
      frontmatter: { title: "Plan: phase #2", description: "Why: because", tags: ["a: b"], owner: { team: "core" } },
      body: "# Plan\n\nText",
    });
    expect(save.status).toBe(200);

    const page = await request(app).get("/api/docs/pages/notes/plan");
    expect(page.body).toMatchObject({
      title: "Plan: phase #2",
      tags: ["a: b"],
      body: "# Plan\n\nText",
      frontmatter: { description: "Why: because", owner: { team: "core" } },
    });
  });

  it("PUT /api/docs/pages still requires content or structured fields", async () => {
    const res = await request(app).put("/api/docs/pages/notes/nothing").send({ frontmatter: { title: "No body" } });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: "content is required" });
  });

  it("PUT /api/docs/pages refuses to overwrite a revision the editor never saw", async () => {
    await request(app).put("/api/docs/pages/notes/shared").send({ frontmatter: { title: "Shared" }, body: "first" });
    const opened = (await request(app).get("/api/docs/pages/notes/shared")).body;
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse(opened.modified) + 60_000 });
    try {
      // An agent saves while the page is open in the editor.
      await request(app).put("/api/docs/pages/notes/shared").send({ content: "---\ntitle: Shared\n---\n\nagent version" });

      const stale = await request(app).put("/api/docs/pages/notes/shared")
        .send({ frontmatter: { title: "Shared" }, body: "my version", baseModified: opened.modified });
      expect(stale.status).toBe(409);
      expect(stale.body).toMatchObject({ code: "docs_page_conflict", currentModified: expect.any(String) });
      expect(stale.body.currentModified).not.toBe(opened.modified);
      expect((await request(app).get("/api/docs/pages/notes/shared")).body.body).toBe("agent version");

      // Naming the latest revision, or none at all (a deliberate overwrite), goes through.
      const current = await request(app).put("/api/docs/pages/notes/shared")
        .send({ frontmatter: { title: "Shared" }, body: "merged", baseModified: stale.body.currentModified });
      expect(current.status).toBe(200);
      const forced = await request(app).put("/api/docs/pages/notes/shared").send({ frontmatter: { title: "Shared" }, body: "forced" });
      expect(forced.status).toBe(200);
    } finally {
      vi.useRealTimers();
    }
  });

  it("PATCH /api/docs/db applies the same revision check and clears a field sent as null", async () => {
    await request(app).put("/api/docs/schema/incidents").send({
      name: "Incidents",
      fields: [{ name: "severity", type: "select", options: ["sev1", "sev2"] }, { name: "minutes", type: "number" }],
    });
    const created = await request(app).post("/api/docs/db/incidents").send({ fields: { title: "Outage", severity: "sev1", minutes: 12 } });
    const opened = (await request(app).get(`/api/docs/pages/${created.body.path}`)).body;
    vi.useFakeTimers({ toFake: ["Date"], now: Date.parse(opened.modified) + 60_000 });
    try {
      await request(app).patch(`/api/docs/db/${created.body.path}`).send({ fields: { severity: "sev2" } });

      const stale = await request(app).patch(`/api/docs/db/${created.body.path}`)
        .send({ fields: { title: "Outage" }, body: "mine", baseModified: opened.modified });
      expect(stale.status).toBe(409);
      expect(stale.body.code).toBe("docs_page_conflict");

      const saved = await request(app).patch(`/api/docs/db/${created.body.path}`)
        .send({ fields: { title: "Outage", minutes: null }, body: "mine", baseModified: stale.body.currentModified });
      expect(saved.status).toBe(200);
      const page = (await request(app).get(`/api/docs/pages/${created.body.path}`)).body;
      expect(page).toMatchObject({ body: "mine", frontmatter: { severity: "sev2", minutes: null } });
      expect(page.frontmatter).not.toHaveProperty("baseModified");
    } finally {
      vi.useRealTimers();
    }
  });

  it("GET /api/docs/search matches a half-typed word only with prefix=1", async () => {
    await request(app).put("/api/docs/pages/notes/toolchain").send({ content: "# Toolchain\n\nStonecutter drives the build." });

    expect((await request(app).get("/api/docs/search?q=stonecut")).body.results).toEqual([]);
    const prefixed = await request(app).get("/api/docs/search?q=stonecut&prefix=1");
    expect(prefixed.body.results.map((result: any) => result.path)).toEqual(["notes/toolchain"]);
  });
});
