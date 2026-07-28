import { describe, expect, it, vi } from "vitest";
import { getBridgeToolDefinitions } from "../agent-tools-mcp/register.js";
import { createFeedToolDefinitions } from "../tools/feed-tools.js";
import type { ApiRouteTestState } from "./api-routes-test-helpers.js";
import { installApiRouteTestHooks, request } from "./api-routes-test-helpers.js";

let app: ApiRouteTestState["app"];
let ctx: ApiRouteTestState["ctx"];

function createInvocation(toolName: string) {
  return {
    sessionId: "session-1",
    toolCallId: `tool-${toolName}`,
    toolName,
    arguments: {},
  };
}

function getTool(name: string) {
  const tool = [
    ...getBridgeToolDefinitions(ctx),
    ...createFeedToolDefinitions(ctx),
  ].find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`${name} tool not found`);
  return tool as any;
}

installApiRouteTestHooks((state) => {
  ({ app, ctx } = state);
});

describe("Feed routes", () => {
  it("POST /api/feed creates cards and keyed saves upsert", async () => {
    const create = await request(app)
      .post("/api/feed")
      .send({
        key: "preview:abc",
        title: "Preview building",
        body: "Validation is running",
        kind: "status",
        priority: "high",
        links: [{ label: "Preview", url: "https://example.test/preview" }],
        metadata: { prefix: "abc" },
        action: { label: "Open review", prompt: "Review the preview.", taskId: null },
        pinned: true,
      });

    expect(create.status).toBe(201);
    expect(create.body.created).toBe(true);
    expect(create.body.card).toEqual(expect.objectContaining({
      dedupeKey: "preview:abc",
      title: "Preview building",
      body: "Validation is running",
      kind: "status",
      priority: "high",
      links: [{ label: "Preview", url: "https://example.test/preview" }],
      metadata: { prefix: "abc" },
      action: { label: "Open review", prompt: "Review the preview.", taskId: null },
      pinned: true,
    }));

    const update = await request(app)
      .post("/api/feed")
      .send({
        key: "preview:abc",
        title: "Preview ready",
        body: "Open the preview",
      });

    expect(update.status).toBe(200);
    expect(update.body.created).toBe(false);
    expect(update.body.card.id).toBe(create.body.card.id);
    expect(update.body.card).toEqual(expect.objectContaining({
      title: "Preview ready",
      body: "Open the preview",
      action: { label: "Open review", prompt: "Review the preview.", taskId: null },
      status: "active",
    }));
  });

  it("PATCH and DELETE update cards by id", async () => {
    const create = await request(app)
      .post("/api/feed")
      .send({ title: "Patch me" });
    const id = create.body.card.id;

    const patch = await request(app)
      .patch(`/api/feed/${id}`)
      .send({ status: "done", pinned: true, action: { prompt: "Resolve this card." } });
    expect(patch.status).toBe(200);
    expect(patch.body.card).toEqual(expect.objectContaining({
      status: "done",
      pinned: true,
      action: { prompt: "Resolve this card." },
    }));

    const clearAction = await request(app)
      .patch(`/api/feed/${id}`)
      .send({ action: null });
    expect(clearAction.status).toBe(200);
    expect(clearAction.body.card.action).toBeNull();

    const remove = await request(app).delete(`/api/feed/${id}`);
    expect(remove.status).toBe(200);
    expect(remove.body).toEqual({ ok: true });

    const missing = await request(app).delete(`/api/feed/${id}`);
    expect(missing.status).toBe(404);
  });

  it("serves feed-owned visual artifacts for cards", async () => {
    const saveTool = getTool("feed_save");
    const created = await saveTool.handler({
      title: "Visual route card",
      visual: { kind: "mermaid", content: "graph TD\n  A-->B" },
    }, createInvocation("feed_save")) as any;
    const visual = created.card.visual;

    const inline = await request(app).get(visual.url);
    expect(inline.status).toBe(200);
    expect(inline.text).toContain("graph TD");

    const meta = await request(app).get(`${visual.url}/meta`);
    expect(meta.status).toBe(200);
    expect(meta.body).toEqual(expect.objectContaining({
      artifactId: visual.artifactId,
      kind: "mermaid",
      title: "Visual route card",
    }));

    const crossOwner = await request(app)
      .get(`/api/sessions/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/visuals/${visual.artifactId}`);
    expect(crossOwner.status).toBe(404);
  });

  it("returns validation errors", async () => {
    const missingTitle = await request(app).post("/api/feed").send({});
    expect(missingTitle.status).toBe(400);
    expect(missingTitle.body.error).toContain("title is required");

    const invalidStatus = await request(app).get("/api/feed?status=paused");
    expect(invalidStatus.status).toBe(400);
    expect(invalidStatus.body.error).toContain("status must be one of");

    const invalidBody = await request(app).post("/api/feed").send([]);
    expect(invalidBody.status).toBe(400);
    expect(invalidBody.body.error).toContain("Request body must be an object");

    const unknownField = await request(app).post("/api/feed").send({ title: "Bad", pinnned: true });
    expect(unknownField.status).toBe(400);
    expect(unknownField.body.error).toContain("Unknown feed card field");

    const unsafeUrl = await request(app).post("/api/feed").send({ title: "Bad", url: "javascript:alert(1)" });
    expect(unsafeUrl.status).toBe(400);
    expect(unsafeUrl.body.error).toContain("url must be http");

    const invalidAction = await request(app).post("/api/feed").send({ title: "Bad", action: { label: "Run" } });
    expect(invalidAction.status).toBe(400);
    expect(invalidAction.body.error).toContain("action.prompt is required");

    const rejectedVisual = await request(app).post("/api/feed").send({ title: "Bad", visual: { kind: "mermaid" } });
    expect(rejectedVisual.status).toBe(400);
    expect(rejectedVisual.body.error).toContain("Unknown feed card field");
  });

  describe("GET /api/feed/kind-stats", () => {
    it("returns per-kind totals and activity buckets", async () => {
      ctx.feedStore.saveCard({ title: "s1", kind: "status" });
      ctx.feedStore.saveCard({ title: "s2", kind: "status", status: "done" });
      ctx.feedStore.saveCard({ title: "n1", kind: "note" });

      const res = await request(app).get("/api/feed/kind-stats");

      expect(res.status).toBe(200);
      expect(res.body.windowDays).toBe(30);
      expect(res.body.bucketCount).toBe(14);
      expect(res.body.total).toBe(3);
      expect(res.body.active).toBe(2);
      expect(res.body.kinds.map((stat: { kind: string }) => stat.kind)).toEqual(["status", "note"]);
      const status = res.body.kinds.find((stat: { kind: string }) => stat.kind === "status");
      expect(status).toMatchObject({ total: 2, active: 1, done: 1, dismissed: 0 });
      expect(status.buckets).toHaveLength(14);
    });

    it("rejects invalid query parameters", async () => {
      const invalidDays = await request(app).get("/api/feed/kind-stats?days=abc");
      expect(invalidDays.status).toBe(400);
      const zeroBuckets = await request(app).get("/api/feed/kind-stats?buckets=0");
      expect(zeroBuckets.status).toBe(400);
    });
  });
});
