import { expect } from "vitest";
import { request } from "../test-support/api-routes.js";
import type { IntegrationScenario } from "./scenario-types.js";

export const knowledgeScenarios: IntegrationScenario[] = [
  {
    id: "KNOW-05", title: "resolves a wikilink by page title",
    async run(world) {
      await world.writePage("people/alex", "---\ntitle: Alex Rivera\ndescription: Teammate\n---\n# Alex Rivera");
      const resolved = await request(world.app).get("/api/docs/resolve?target=Alex%20Rivera");
      expect(resolved.status).toBe(200);
      expect(resolved.body.path).toBe("people/alex");
      expect((await world.readPage(resolved.body.path)).body).toContain("# Alex Rivera");
    },
  },
  {
    id: "KNOW-06", title: "batch-resolves existing and missing wikilinks",
    async run(world) {
      await world.writePage("references/one", "---\ntitle: Reference One\ndescription: One\n---\n# One");
      await world.writePage("references/two", "---\ntitle: Reference Two\ndescription: Two\n---\n# Two");
      const resolved = await request(world.app).post("/api/docs/resolve").send({ targets: ["Reference One", "Reference Two", "Missing"] });
      expect(resolved.status).toBe(200);
      expect(JSON.stringify(resolved.body)).toContain("references/one");
      expect(JSON.stringify(resolved.body)).toContain("references/two");
      expect(resolved.body.Missing).toBeNull();
    },
  },
  {
    id: "KNOW-08", title: "creates a pre-delete snapshot before removing user knowledge",
    async run(world) {
      await world.writePage("safety/delete-me", "# Draft\n\nobsolete-keyword");
      const oldSearch = "/api/docs/search?q=obsolete-keyword";
      expect((await request(world.app).get(oldSearch)).body.results).toMatchObject([{ path: "safety/delete-me" }]);
      await world.writePage("safety/delete-me", "# Safety Copy");
      expect((await request(world.app).get(oldSearch)).body.results).toEqual([]);
      const searchPath = "/api/docs/search?q=Safety";
      expect((await request(world.app).get(searchPath)).body.results).toMatchObject([{ path: "safety/delete-me" }]);
      const store = world.ctx.docsSnapshotStore!;
      const before = store.listSnapshots().length;
      const deleted = await request(world.app).delete("/api/docs/pages/safety/delete-me").expect(200);
      expect(deleted.body.deleted).toBe(true);
      const snapshots = store.listSnapshots();
      expect(snapshots).toHaveLength(before + 1);
      expect(snapshots[0].reason).toBe("pre-delete");
      await request(world.app).get("/api/docs/pages/safety/delete-me").expect(404);
      expect((await request(world.app).get(searchPath)).body).toMatchObject({ results: [], total: 0 });
      store.restoreSnapshot(snapshots[0].id);
      expect((await world.readPage("safety/delete-me")).body).toBe("# Safety Copy");
    },
  },
  {
    id: "KNOW-09", title: "throttles repeated pre-delete snapshots during a cleanup batch",
    async run(world) {
      await world.writePage("cleanup/one", "# One");
      await world.writePage("cleanup/two", "# Two");
      const preDeleteSnapshots = () => world.ctx.docsSnapshotStore!.listSnapshots().filter((item) => item.reason === "pre-delete");
      const first = await request(world.app).delete("/api/docs/pages/cleanup/one").expect(200);
      expect(first.body.deleted).toBe(true);
      const snapshots = preDeleteSnapshots();
      expect(snapshots).toHaveLength(1);
      const second = await request(world.app).delete("/api/docs/pages/cleanup/two").expect(200);
      expect(second.body.deleted).toBe(true);
      expect(preDeleteSnapshots()).toEqual(snapshots);
    },
  },
  {
    id: "KNOW-15", title: "paginates structured collection results",
    async run(world) {
      await world.createCollection("records/pages");
      await world.addCollectionEntry("records/pages", { title: "Three", status: "open", priority: 3 });
      await world.addCollectionEntry("records/pages", { title: "One", status: "open", priority: 1 });
      await world.addCollectionEntry("records/pages", { title: "Two", status: "open", priority: 2 }, "A saved body");
      await world.addCollectionEntry("records/pages", { title: "Four", status: "open", priority: 4 });
      const schema = await request(world.app).get("/api/docs/schema/records/pages").expect(200);
      expect(schema.body).toMatchObject({ name: "records/pages", entryCount: 4 });
      expect(schema.body.fields).toHaveLength(2);
      const page = await request(world.app).get("/api/docs/db/records/pages?limit=2&offset=1&_sort=priority&_order=asc").expect(200);
      expect(page.body.entries.map((entry: any) => entry.title)).toEqual(["Two", "Three"]);
      expect(page.body.total).toBe(4);
      expect(page.body.entries.every((entry: any) => !("body" in entry))).toBe(true);
    },
  },
  {
    id: "KNOW-17", title: "updates structured fields and makes the new value queryable",
    async run(world) {
      await world.createCollection("records/update");
      const entry = await world.addCollectionEntry("records/update", { title: "Mutable", status: "open", priority: 1 });
      const updated = await request(world.app).patch(`/api/docs/db/records/update/${entry.slug}`).send({ fields: { status: "closed", priority: 8 } });
      expect(updated.status).toBe(200);
      expect((await request(world.app).get("/api/docs/db/records/update?status=open")).body.entries).toHaveLength(0);
      const closed = await request(world.app).get("/api/docs/db/records/update?status=closed");
      expect(closed.body.entries[0]).toMatchObject({ title: "Mutable", fields: expect.objectContaining({ priority: 8, status: "closed" }) });
    },
  },
  {
    id: "KNOW-18", title: "updates an entry body while retaining unmodified fields",
    async run(world) {
      await world.createCollection("records/body-update");
      const entry = await world.addCollectionEntry("records/body-update", { title: "Body mutable", status: "open", priority: 4 }, "old-body-term");
      await request(world.app).patch(`/api/docs/db/records/body-update/${entry.slug}`).send({ body: "new-body-term" }).expect(200);
      const result = await request(world.app).get("/api/docs/db/records/body-update?_includeBody=true");
      expect(result.body.entries[0]).toMatchObject({ title: "Body mutable", fields: expect.objectContaining({ status: "open", priority: 4 }), body: "new-body-term" });
      expect((await request(world.app).get("/api/docs/search?q=old-body-term")).body.results).toEqual([]);
      expect((await request(world.app).get("/api/docs/search?q=new-body-term")).body.results).toMatchObject([{ path: entry.path }]);
    },
  },
  {
    id: "KNOW-19", title: "deletes one structured entry and preserves its siblings",
    async run(world) {
      await world.createCollection("records/delete");
      const removed = await world.addCollectionEntry("records/delete", { title: "Remove", status: "open", priority: 1 }, "rare-collection-term");
      await world.addCollectionEntry("records/delete", { title: "Keep", status: "closed", priority: 2 });
      const searchPath = "/api/docs/search?q=rare-collection-term";
      expect((await request(world.app).get(searchPath)).body.results).toMatchObject([{ path: removed.path }]);
      const deletion = await request(world.app).delete(`/api/docs/db/records/delete/${removed.slug}`);
      expect(deletion.status).toBe(200);
      expect(deletion.body.deleted).toBe(true);
      expect((await request(world.app).get(searchPath)).body).toMatchObject({ results: [], total: 0 });
      const remaining = await request(world.app).get("/api/docs/db/records/delete");
      expect(remaining.body.entries.map((item: any) => item.title)).toEqual(["Keep"]);
      const again = await request(world.app).delete(`/api/docs/db/records/delete/${removed.slug}`).expect(200);
      expect(again.body.deleted).toBe(false);
    },
  },
  {
    id: "KNOW-22", title: "rejects raw page writes inside a structured collection without damage",
    async run(world) {
      await world.createCollection("records/protected");
      await world.addCollectionEntry("records/protected", { title: "Safe", status: "open", priority: 1 });
      const rejected = await request(world.app).put("/api/docs/pages/records/protected/manual").send({ content: "# Bypass" });
      expect(rejected.status).toBe(400);
      expect(rejected.body.error).toContain('Cannot write raw content to DB folder "records/protected"');
      expect(rejected.body.error).toContain("docs_db_add");
      expect(rejected.body.error).toContain('folder: "records/protected"');
      expect((await request(world.app).get("/api/docs/db/records/protected")).body.entries).toHaveLength(1);
    },
  },
  {
    id: "KNOW-23", title: "keeps independent collections isolated during filtering",
    async run(world) {
      await world.createCollection("records/alpha");
      await world.createCollection("records/beta");
      await world.addCollectionEntry("records/alpha", { title: "Alpha", status: "open", priority: 1 });
      await world.addCollectionEntry("records/beta", { title: "Beta", status: "open", priority: 1 });
      const alpha = await request(world.app).get("/api/docs/db/records/alpha?status=open");
      const beta = await request(world.app).get("/api/docs/db/records/beta?status=open");
      expect(alpha.body.entries.map((item: any) => item.title)).toEqual(["Alpha"]);
      expect(beta.body.entries.map((item: any) => item.title)).toEqual(["Beta"]);
    },
  },
  {
    id: "KNOW-24", title: "searches both freeform and structured knowledge after reindex",
    async run(world) {
      await world.createCollection("mixed/records");
      // Changes made on disk have not gone through the search index yet.
      world.ctx.docsStore!.writePage("mixed/freeform", "# Freeform\n\ncombined-search-term");
      world.ctx.docsStore!.addDbEntry("mixed/records", { title: "Structured", status: "open", priority: 1 }, "combined-search-term");
      const rebuilt = await request(world.app).post("/api/docs/reindex").expect(200);
      expect(rebuilt.body.indexed).toBeGreaterThanOrEqual(2);
      const search = await request(world.app).get("/api/docs/search?q=combined-search-term");
      expect(search.body.results.map((item: any) => item.path)).toEqual(expect.arrayContaining(["mixed/freeform"]));
      expect(search.body.results.some((item: any) => item.path.startsWith("mixed/records/"))).toBe(true);
    },
  },
];
