import { describe, expect, it } from "vitest";
import { createBridgeTools } from "../session-manager.js";
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
  const tool = createBridgeTools(ctx).find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`${name} tool not found`);
  return tool;
}

installApiRouteTestHooks((state) => {
  ({ app, ctx } = state);
});

describe("Feed routes", () => {
  it("GET /api/feed returns active cards by default", async () => {
    const active = ctx.feedStore.saveCard({ title: "Active card" }).card;
    ctx.feedStore.saveCard({ title: "Done card", status: "done" });

    const res = await request(app).get("/api/feed");

    expect(res.status).toBe(200);
    expect(res.body.cards).toEqual([
      expect.objectContaining({ id: active.id, title: "Active card", status: "active" }),
    ]);
  });

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

  it("keyed saves do not reactivate dismissed cards unless status is explicit", async () => {
    const create = await request(app)
      .post("/api/feed")
      .send({ key: "decision:one", title: "Pick one" });
    const id = create.body.card.id;

    await request(app)
      .patch(`/api/feed/${id}`)
      .send({ status: "dismissed" })
      .expect(200);

    const implicit = await request(app)
      .post("/api/feed")
      .send({ key: "decision:one", title: "Still pick one" });
    expect(implicit.status).toBe(200);
    expect(implicit.body.card.status).toBe("dismissed");

    const explicit = await request(app)
      .post("/api/feed")
      .send({ key: "decision:one", status: "active" });
    expect(explicit.status).toBe(200);
    expect(explicit.body.card.status).toBe("active");
  });

  it("GET /api/feed filters cards", async () => {
    const task = ctx.taskStore.createTask("Feed task");
    const taskCard = ctx.feedStore.saveCard({ title: "Task todo", taskId: task.id, kind: "todo" }).card;
    ctx.feedStore.saveCard({ title: "Session note", sessionId: "session-1", kind: "note" });
    ctx.feedStore.saveCard({ title: "Dismissed", status: "dismissed", kind: "todo" });

    const byTask = await request(app).get(`/api/feed?taskId=${task.id}`);
    expect(byTask.body.cards.map((card: any) => card.id)).toEqual([taskCard.id]);

    const bySession = await request(app).get("/api/feed?sessionId=session-1");
    expect(bySession.body.cards).toHaveLength(1);

    const byKind = await request(app).get("/api/feed?kind=todo");
    expect(byKind.body.cards.map((card: any) => card.id)).toEqual([taskCard.id]);

    const all = await request(app).get("/api/feed?includeDismissed=true");
    expect(all.body.cards).toHaveLength(3);
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

  it("PATCH /api/feed/:id rejects key field updates without changing the card", async () => {
    const create = await request(app)
      .post("/api/feed")
      .send({ key: "stable:key", title: "Stable" });
    const id = create.body.card.id;
    const before = ctx.feedStore.getCard(id);

    for (const { payload, field } of [
      { payload: { key: "renamed:key", title: "Renamed" }, field: "key" },
      { payload: { dedupeKey: null, title: "Renamed" }, field: "dedupeKey" },
    ]) {
      const res = await request(app)
        .patch(`/api/feed/${id}`)
        .send(payload);

      expect(res.status).toBe(400);
      expect(res.body).toEqual({
        error: expect.stringContaining(`Feed card key fields cannot be updated (${field})`),
      });
      expect(ctx.feedStore.getCard(id)).toEqual(before);
    }
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

  it("emits feed changed events", async () => {
    const events: unknown[] = [];
    ctx.globalBus.subscribe((event) => {
      if (event.type === "feed:changed") events.push(event);
    });

    const create = await request(app)
      .post("/api/feed")
      .send({ key: "event:one", title: "Event card", taskId: ctx.taskStore.createTask("Task").id });
    const id = create.body.card.id;
    await request(app).patch(`/api/feed/${id}`).send({ status: "done" });
    await request(app).delete(`/api/feed/${id}`);

    expect(events).toEqual([
      expect.objectContaining({ type: "feed:changed", cardId: id, dedupeKey: "event:one" }),
      expect.objectContaining({ type: "feed:changed", cardId: id, dedupeKey: "event:one" }),
      expect.objectContaining({ type: "feed:changed", cardId: id, dedupeKey: "event:one" }),
    ]);
  });
});
