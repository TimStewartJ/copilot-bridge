import { describe, expect, it } from "vitest";
import { getBridgeToolDefinitions } from "../agent-tools-mcp/register.js";
import type { ApiRouteTestState } from "../../test-support/api-routes.js";
import { installApiRouteTestHooks, request } from "../../test-support/api-routes.js";
import { alertDetails, decisionDetails, eventDetails } from "./focus-test-fixtures.js";

let app: ApiRouteTestState["app"];
let ctx: ApiRouteTestState["ctx"];
let db: ApiRouteTestState["db"];

installApiRouteTestHooks((state) => {
  ({ app, ctx, db } = state);
});

describe("first-class Focus routes", () => {
  it("creates and lists Decisions, Alerts, and Events independently", async () => {
    const decision = await request(app).post("/api/focus/decisions").send({
      ...decisionDetails,
      key: "decision:api",
      title: "Choose API direction",
      launchPrompt: { label: "Discuss", prompt: "Review the API direction." },
    });
    const alert = await request(app).post("/api/focus/alerts").send({
      ...alertDetails(),
      key: "alert:api",
      title: "API alert",
    });
    const event = await request(app).post("/api/focus/events").send({
      ...eventDetails(),
      key: "release:api",
      category: "release",
      title: "API release event",
    });

    expect(decision.status).toBe(201);
    expect(decision.body.decision).toMatchObject({
      objectType: "decision",
      title: "Choose API direction",
      launchPrompt: { label: "Discuss", prompt: "Review the API direction." },
    });
    expect(decision.body.decision).not.toHaveProperty("kind");
    expect(alert.body.alert).toMatchObject({
      objectType: "alert",
      title: "API alert",
      priority: "high",
    });
    expect(event.body.event).toMatchObject({
      objectType: "event",
      category: "release",
      title: "API release event",
    });

    const snapshot = await request(app).get("/api/focus");
    expect(snapshot.body).toMatchObject({
      decisionTotal: 1,
      alertTotal: 1,
      compatibilityErrorCount: 0,
      digests: [expect.objectContaining({ family: "release", count: 1 })],
    });
    const decisions = await request(app).get("/api/focus/decisions?status=active");
    const alerts = await request(app).get("/api/focus/alerts?status=active");
    const events = await request(app).get("/api/focus/events/digest-items?keyPrefix=release%3A");
    expect(decisions.body.objects).toHaveLength(1);
    expect(alerts.body.objects).toHaveLength(1);
    expect(events.body.objects).toEqual([
      expect.objectContaining({ objectType: "event", category: "release" }),
    ]);

    expect(ctx.feedStore.getCard(decision.body.decision.id)).toMatchObject({
      kind: "decision",
      action: { label: "Discuss", prompt: "Review the API direction." },
    });
  });

  it("updates, dismisses, reactivates, and deletes canonical objects", async () => {
    const create = await request(app).post("/api/focus/decisions").send({
      ...decisionDetails,
      title: "Lifecycle decision",
    });
    const id = create.body.decision.id;

    const dismissed = await request(app).patch(`/api/focus/decisions/${id}`).send({
      status: "dismissed",
      body: "Not now.",
      lifecycleReason: "Not now",
    });
    expect(dismissed.body.decision).toMatchObject({ status: "dismissed", body: "Not now." });

    const cleared = await request(app).get("/api/focus/cleared");
    expect(cleared.body.objects).toEqual([
      expect.objectContaining({ id, objectType: "decision", status: "dismissed" }),
    ]);

    const reactivated = await request(app).patch(`/api/focus/decisions/${id}`).send({
      status: "active",
      newEpisode: true,
      episodeReason: "The user revisited the choice",
    });
    expect(reactivated.body.decision.status).toBe("active");

    const individual = await request(app).get(`/api/focus/decisions/${id}`);
    expect(individual.body.decision.id).toBe(id);

    const remove = await request(app).delete(`/api/focus/decisions/${id}`);
    expect(remove.status).toBe(200);
    expect(ctx.feedStore.getCard(id)).toBeUndefined();
  });

  it("promotes a first-class Decision into an Action idempotently", async () => {
    const decision = await request(app).post("/api/focus/decisions").send({
      ...decisionDetails,
      title: "Create action from Decision",
    });
    const id = decision.body.decision.id;

    const first = await request(app).post(`/api/focus/decisions/${id}/make-action`).send({ taskId: null });
    const second = await request(app).post(`/api/focus/decisions/${id}/make-action`).send({ taskId: null });

    expect(first.status).toBe(201);
    expect(first.body).toMatchObject({
      created: true,
      object: { id, objectType: "decision", status: "active", lifecycle: "handed_off" },
      action: { text: "Create action from Decision", done: false },
    });
    expect(second.status).toBe(200);
    expect(second.body.created).toBe(false);
    expect(second.body.action.id).toBe(first.body.action.id);
  });

  it("exposes first-class Action route aliases", async () => {
    const task = ctx.taskStore.createTask("Action API task");
    const create = await request(app).post("/api/actions").send({
      taskId: task.id,
      text: "Use the Action API",
      deadline: "2026-09-10",
    });
    expect(create.status).toBe(201);
    expect(create.body.action).toMatchObject({
      taskId: task.id,
      text: "Use the Action API",
      deadline: "2026-09-10",
    });

    const list = await request(app).get(`/api/actions?taskId=${encodeURIComponent(task.id)}`);
    expect(list.body.actions).toHaveLength(1);
    const update = await request(app).patch(`/api/actions/${create.body.action.id}`).send({ done: true });
    expect(update.body.action.done).toBe(true);
    const remove = await request(app).delete(`/api/actions/${create.body.action.id}`);
    expect(remove.status).toBe(200);
  });

  it("rejects reserved Event categories and wrong subtype routes", async () => {
    const reserved = await request(app).post("/api/focus/events").send({
      category: "decision",
      title: "Wrong event",
    });
    expect(reserved.status).toBe(400);
    expect(reserved.body.error).toContain("event category cannot be decision");

    const decision = await request(app).post("/api/focus/decisions").send({ ...decisionDetails, title: "Typed object" });
    const wrongRoute = await request(app).get(`/api/focus/alerts/${decision.body.decision.id}`);
    expect(wrongRoute.status).toBe(404);
  });

  it("supports Event-category-only updates", async () => {
    const created = await request(app).post("/api/focus/events").send({
      ...eventDetails(),
      key: "release:reclassify",
      category: "note",
      title: "Reclassify event",
    });
    const updated = await request(app).patch(`/api/focus/events/${created.body.event.id}`).send({
      category: "link",
    });

    expect(updated.status).toBe(200);
    expect(updated.body.event).toMatchObject({
      id: created.body.event.id,
      objectType: "event",
      category: "link",
    });
    expect(ctx.feedStore.getCard(created.body.event.id)?.kind).toBe("link");
  });

  it("serves canonical visual artifacts without reading the legacy feed projection", async () => {
    const tool = getBridgeToolDefinitions(ctx).find((candidate) => candidate.name === "decision_save") as any;
    const created = await tool.handler({
      ...decisionDetails,
      title: "Canonical visual Decision",
      visual: { kind: "mermaid", content: "graph TD\n  A-->B" },
    }, {
      sessionId: "focus-visual-session",
      toolCallId: "focus-visual-tool",
      toolName: "decision_save",
      arguments: {},
    });
    const visual = created.decision.visual;
    const originalGetCard = ctx.feedStore.getCard;
    ctx.feedStore.getCard = (() => {
      throw new Error("legacy feed reads disabled");
    }) as typeof ctx.feedStore.getCard;
    try {
      const response = await request(app).get(visual.url);
      expect(response.status).toBe(200);
      expect(response.text).toContain("graph TD");
    } finally {
      ctx.feedStore.getCard = originalGetCard;
    }
  });

  it("reports, retries, and can explicitly delete quarantined legacy rows", async () => {
    const retryCard = ctx.feedStore.saveCard({ title: "Retry quarantine" }).card;
    const deleteCard = ctx.feedStore.saveCard({ title: "Delete quarantine" }).card;
    db.prepare("UPDATE feed_cards SET visualJson = ? WHERE id IN (?, ?)")
      .run(JSON.stringify({ kind: "image" }), retryCard.id, deleteCard.id);
    ctx.focusMutationCoordinator.reconcileLegacyFeed();

    const errors = await request(app).get("/api/focus/reconciliation-errors");
    expect(errors.body.errors.map((error: any) => error.feedCardId)).toEqual(
      expect.arrayContaining([retryCard.id, deleteCard.id]),
    );

    db.prepare("UPDATE feed_cards SET visualJson = NULL WHERE id = ?").run(retryCard.id);
    const retried = await request(app).post(`/api/focus/reconciliation-errors/${retryCard.id}/retry`).send({});
    expect(retried.status).toBe(200);
    expect(retried.body.object.id).toBe(retryCard.id);

    const removed = await request(app).delete(`/api/focus/reconciliation-errors/${deleteCard.id}`);
    expect(removed.status).toBe(200);
    expect(ctx.focusMutationCoordinator.getAny(deleteCard.id)).toBeUndefined();
  });
});
