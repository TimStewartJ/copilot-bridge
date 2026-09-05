import { expect } from "vitest";
import { request } from "../test-support/api-routes.js";
import type { IntegrationScenario } from "./scenario-types.js";

async function listCards(app: any, query = "") {
  const response = await request(app).get(`/api/feed${query}`);
  expect(response.status).toBe(200);
  return response.body.cards as any[];
}

export const attentionScenarios: IntegrationScenario[] = [
  {
    id: "ATTN-01", title: "publishes a task-linked decision and resolves it",
    async run(world) {
      const task = await world.createTask("Choose architecture");
      const card = await world.createFeedCard("Architecture decision", { taskId: task.id, kind: "decision", priority: "high" });
      expect((await listCards(world.app, `?taskId=${task.id}`))[0].id).toBe(card.id);
      const done = await request(world.app).patch(`/api/feed/${card.id}`).send({ status: "done" });
      expect(done.status).toBe(200);
      expect(await listCards(world.app, `?taskId=${task.id}`)).toEqual([]);
      expect((await listCards(world.app, `?taskId=${task.id}&status=done`))[0].id).toBe(card.id);
    },
  },
  {
    id: "ATTN-02", title: "upserts a keyed status card without creating dashboard noise",
    async run(world) {
      const first = await world.createFeedCard("Build running", { key: "build:main", kind: "status", body: "queued" });
      const update = await request(world.app).post("/api/feed").send({ key: "build:main", title: "Build complete", body: "green" });
      expect(update.status).toBe(200);
      expect(update.body.created).toBe(false);
      expect(update.body.card.id).toBe(first.id);
      const cards = await listCards(world.app, "?keyPrefix=build:");
      expect(cards).toHaveLength(1);
      expect(cards[0]).toMatchObject({ title: "Build complete", body: "green" });
    },
  },
  {
    id: "ATTN-03", title: "keeps distinct unkeyed historical cards",
    async run(world) {
      const first = await world.createFeedCard("First deployment", { kind: "artifact" });
      const second = await world.createFeedCard("Second deployment", { kind: "artifact" });
      const cards = await listCards(world.app, "?kind=artifact");
      expect(cards.map((card) => card.id)).toEqual(expect.arrayContaining([first.id, second.id]));
      expect(new Set(cards.map((card) => card.id)).size).toBe(2);
    },
  },
  {
    id: "ATTN-04", title: "dismisses and explicitly inspects a no-longer-relevant card",
    async run(world) {
      const card = await world.createFeedCard("Expired alert", { kind: "status" });
      await request(world.app).patch(`/api/feed/${card.id}`).send({ status: "dismissed" });
      expect(await listCards(world.app)).toEqual([]);
      const dismissed = await listCards(world.app, "?status=dismissed");
      expect(dismissed[0]).toMatchObject({ id: card.id, status: "dismissed" });
    },
  },
  {
    id: "ATTN-05", title: "pins a card while preserving its action payload",
    async run(world) {
      const card = await world.createFeedCard("Needs review", { action: { label: "Review", prompt: "Review this work." } });
      const pinned = await request(world.app).patch(`/api/feed/${card.id}`).send({ pinned: true, priority: "high" });
      expect(pinned.status).toBe(200);
      expect(pinned.body.card).toMatchObject({ pinned: true, priority: "high", action: { label: "Review", prompt: "Review this work." } });
      expect((await listCards(world.app))[0].id).toBe(card.id);
    },
  },
  {
    id: "ATTN-06", title: "clears a prompt action after the decision is no longer actionable",
    async run(world) {
      const card = await world.createFeedCard("Actionable", { action: { prompt: "Continue the task." } });
      const cleared = await request(world.app).patch(`/api/feed/${card.id}`).send({ action: null, body: "Handled manually" });
      expect(cleared.status).toBe(200);
      expect(cleared.body.card.action).toBeNull();
      expect((await listCards(world.app))[0].body).toBe("Handled manually");
    },
  },
  {
    id: "ATTN-07", title: "filters cards by task while retaining global cards",
    async run(world) {
      const firstTask = await world.createTask("First focus");
      const secondTask = await world.createTask("Second focus");
      const first = await world.createFeedCard("First task alert", { taskId: firstTask.id });
      await world.createFeedCard("Second task alert", { taskId: secondTask.id });
      const global = await world.createFeedCard("Global alert");
      expect((await listCards(world.app, `?taskId=${firstTask.id}`)).map((card) => card.id)).toEqual([first.id]);
      expect((await listCards(world.app)).map((card) => card.id)).toEqual(expect.arrayContaining([first.id, global.id]));
    },
  },
  {
    id: "ATTN-08", title: "filters cards by session independently of task linkage",
    async run(world) {
      const task = await world.createTask("Session focus");
      const first = await world.createFeedCard("Session one", { taskId: task.id, sessionId: "session-one" });
      await world.createFeedCard("Session two", { taskId: task.id, sessionId: "session-two" });
      const cards = await listCards(world.app, "?sessionId=session-one");
      expect(cards.map((card) => card.id)).toEqual([first.id]);
      expect(cards[0].taskId).toBe(task.id);
    },
  },
  {
    id: "ATTN-09", title: "deletes a card without deleting its related task",
    async run(world) {
      const task = await world.createTask("Durable task");
      const card = await world.createFeedCard("Temporary notice", { taskId: task.id });
      const removed = await request(world.app).delete(`/api/feed/${card.id}`);
      expect(removed.status).toBe(200);
      expect(await listCards(world.app, `?taskId=${task.id}`)).toEqual([]);
      expect((await world.getTask(task.id)).title).toBe("Durable task");
    },
  },
  {
    id: "ATTN-10", title: "retains a feed card after its task is deleted but clears the stale relation",
    async run(world) {
      const task = await world.createTask("Short-lived task");
      const card = await world.createFeedCard("Historical note", { taskId: task.id, kind: "note" });
      await request(world.app).delete(`/api/tasks/${task.id}`);
      const cards = await listCards(world.app, "?kind=note");
      const retained = cards.find((item) => item.id === card.id);
      expect(retained).toBeDefined();
      expect(retained.taskId).toBeNull();
    },
  },
  {
    id: "ATTN-11", title: "summarizes mixed active and completed card kinds",
    async run(world) {
      const active = await world.createFeedCard("Running", { kind: "status" });
      const done = await world.createFeedCard("Finished", { kind: "status" });
      await world.createFeedCard("Reference", { kind: "note" });
      await request(world.app).patch(`/api/feed/${done.id}`).send({ status: "done" });
      const stats = await request(world.app).get("/api/feed/kind-stats");
      expect(stats.status).toBe(200);
      expect(stats.body.total).toBe(3);
      expect(stats.body.kinds.find((item: any) => item.kind === "status")).toMatchObject({ total: 2, active: 1, done: 1 });
      expect(active.id).not.toBe(done.id);
    },
  },
  {
    id: "ATTN-12", title: "limits feed pages while preserving a continuation cursor",
    async run(world) {
      const one = await world.createFeedCard("One");
      const two = await world.createFeedCard("Two");
      const three = await world.createFeedCard("Three");
      const firstPage = await request(world.app).get("/api/feed?limit=2");
      expect(firstPage.status).toBe(200);
      expect(firstPage.body.cards).toHaveLength(2);
      expect(firstPage.body.nextCursor).toEqual(expect.any(String));
      const secondPage = await request(world.app).get(`/api/feed?limit=2&cursor=${encodeURIComponent(firstPage.body.nextCursor)}`);
      expect(secondPage.body.cards).toHaveLength(1);
      const allIds = [...firstPage.body.cards, ...secondPage.body.cards].map((card: any) => card.id);
      expect(new Set(allIds).size).toBe(3);
      expect(allIds).toEqual(expect.arrayContaining([one.id, two.id, three.id]));
      expect(secondPage.body.nextCursor).toBeNull();
    },
  },
  {
    id: "ATTN-13", title: "preserves links and metadata while updating card prose",
    async run(world) {
      const card = await world.createFeedCard("Preview building", {
        links: [{ label: "Preview", url: "https://example.test/preview" }],
        metadata: { prefix: "abc" },
      });
      const update = await request(world.app).patch(`/api/feed/${card.id}`).send({ title: "Preview ready", body: "Open it" });
      expect(update.status).toBe(200);
      expect(update.body.card.links).toEqual([{ label: "Preview", url: "https://example.test/preview" }]);
      expect(update.body.card.metadata).toEqual({ prefix: "abc" });
    },
  },
  {
    id: "ATTN-14", title: "reactivates a resolved keyed card through a later save",
    async run(world) {
      const card = await world.createFeedCard("Waiting", { key: "decision:launch" });
      await request(world.app).patch(`/api/feed/${card.id}`).send({ status: "done" });
      const revived = await request(world.app).post("/api/feed").send({ key: "decision:launch", title: "Decision reopened", status: "active" });
      expect(revived.status).toBe(200);
      expect(revived.body.card).toMatchObject({ id: card.id, status: "active", title: "Decision reopened" });
      expect((await listCards(world.app, "?keyPrefix=decision:"))).toHaveLength(1);
    },
  },
  {
    id: "ATTN-15", title: "moves a card between task contexts",
    async run(world) {
      const first = await world.createTask("Old owner");
      const second = await world.createTask("New owner");
      const card = await world.createFeedCard("Transfer", { taskId: first.id });
      const moved = await request(world.app).patch(`/api/feed/${card.id}`).send({ taskId: second.id });
      expect(moved.status).toBe(200);
      expect(await listCards(world.app, `?taskId=${first.id}`)).toEqual([]);
      expect((await listCards(world.app, `?taskId=${second.id}`))[0].id).toBe(card.id);
    },
  },
  {
    id: "ATTN-16", title: "marks visible session activity as read and persists the cursor",
    async run(world) {
      world.ctx.sessionMetaStore.setLastVisibleActivityAt("session-visible", "2026-09-01T10:00:00.000Z");
      const marked = await request(world.app).post("/api/read-state/session-visible");
      expect(marked.status).toBe(200);
      expect(marked.body.lastReadAt).toBe("2026-09-01T10:00:00.000Z");
      const state = await request(world.app).get("/api/read-state");
      expect(state.body["session-visible"]).toBe("2026-09-01T10:00:00.000Z");
    },
  },
  {
    id: "ATTN-17", title: "uses attention activity when it is newer than visible activity",
    async run(world) {
      world.ctx.sessionMetaStore.setLastVisibleActivityAt("session-attention", "2026-09-01T10:00:00.000Z");
      world.ctx.sessionMetaStore.setLastAttentionAt("session-attention", "2026-09-01T10:05:00.000Z");
      const marked = await request(world.app).post("/api/read-state/session-attention");
      expect(marked.body.readThroughActivityAt).toBe("2026-09-01T10:05:00.000Z");
      expect((await request(world.app).get("/api/read-state")).body["session-attention"]).toBe("2026-09-01T10:05:00.000Z");
    },
  },
  {
    id: "ATTN-18", title: "clamps a client read cursor to server-known activity",
    async run(world) {
      world.ctx.sessionMetaStore.setLastAttentionAt("session-clamped", "2026-09-01T10:00:00.000Z");
      const marked = await request(world.app).post("/api/read-state/session-clamped").send({ readThroughActivityAt: "2026-09-01T11:00:00.000Z" });
      expect(marked.status).toBe(200);
      expect(marked.body.lastReadAt).toBe("2026-09-01T10:00:00.000Z");
      expect((await request(world.app).get("/api/read-state")).body["session-clamped"]).toBe("2026-09-01T10:00:00.000Z");
    },
  },
  {
    id: "ATTN-19", title: "clears one session read cursor without disturbing another",
    async run(world) {
      await request(world.app).post("/api/read-state/session-one").send({ readThroughActivityAt: "2026-08-01T10:00:00.000Z" });
      await request(world.app).post("/api/read-state/session-two").send({ readThroughActivityAt: "2026-08-01T11:00:00.000Z" });
      const cleared = await request(world.app).delete("/api/read-state/session-one");
      expect(cleared.status).toBe(200);
      const state = await request(world.app).get("/api/read-state");
      expect(state.body["session-one"]).toBeUndefined();
      expect(state.body["session-two"]).toBe("2026-08-01T11:00:00.000Z");
    },
  },
  {
    id: "ATTN-20", title: "rejects an invalid read cursor without overwriting prior state",
    async run(world) {
      await request(world.app).post("/api/read-state/session-safe").send({ readThroughActivityAt: "2026-08-01T10:00:00.000Z" });
      const rejected = await request(world.app).post("/api/read-state/session-safe").send({ readThroughActivityAt: "tomorrow" });
      expect(rejected.status).toBe(400);
      expect((await request(world.app).get("/api/read-state")).body["session-safe"]).toBe("2026-08-01T10:00:00.000Z");
    },
  },
  {
    id: "ATTN-21", title: "keeps completed checklist history attached to its task",
    async run(world) {
      const task = await world.createTask("Historical checklist");
      const item = await world.createChecklistItem(task.id, "Complete me");
      await request(world.app).patch(`/api/checklist-items/${item.id}`).send({ done: true });
      const dashboard = await request(world.app).get("/api/dashboard/checklist");
      const completed = dashboard.body.completedChecklistItems.find((entry: any) => entry.id === item.id);
      expect(completed).toMatchObject({ taskId: task.id, taskTitle: "Historical checklist" });
    },
  },
  {
    id: "ATTN-22", title: "reflects a task rename in dashboard checklist context",
    async run(world) {
      const task = await world.createTask("Old dashboard title");
      const item = await world.createChecklistItem(task.id, "Visible item");
      await world.updateTask(task.id, { title: "New dashboard title" });
      const dashboard = await request(world.app).get("/api/dashboard/checklist");
      expect(dashboard.body.openChecklistItems.find((entry: any) => entry.id === item.id).taskTitle).toBe("New dashboard title");
    },
  },
  {
    id: "ATTN-23", title: "removes deleted checklist work from the dashboard",
    async run(world) {
      const task = await world.createTask("Dashboard cleanup");
      const item = await world.createChecklistItem(task.id, "Remove from dashboard");
      expect((await request(world.app).get("/api/dashboard/checklist")).body.openChecklistItems.map((entry: any) => entry.id)).toContain(item.id);
      await request(world.app).delete(`/api/checklist-items/${item.id}`);
      expect((await request(world.app).get("/api/dashboard/checklist")).body.openChecklistItems.map((entry: any) => entry.id)).not.toContain(item.id);
    },
  },
  {
    id: "ATTN-24", title: "filters a keyed card family after mixed lifecycle transitions",
    async run(world) {
      const first = await world.createFeedCard("First audit", { key: "audit:first", kind: "status" });
      const second = await world.createFeedCard("Second audit", { key: "audit:second", kind: "status" });
      await world.createFeedCard("Other", { key: "other:first", kind: "status" });
      await request(world.app).patch(`/api/feed/${first.id}`).send({ status: "done" });
      const active = await listCards(world.app, "?keyPrefix=audit:");
      expect(active.map((card) => card.id)).toEqual([second.id]);
      const done = await listCards(world.app, "?keyPrefix=audit:&status=done");
      expect(done.map((card) => card.id)).toEqual([first.id]);
    },
  },
  {
    id: "ATTN-25", title: "updates task and attention card as one user workflow",
    async run(world) {
      const task = await world.createTask("Waiting task");
      await world.updateTask(task.id, { waitingOn: "Approval", nextTouchAt: "2030-01-01T00:00:00.000Z" });
      const card = await world.createFeedCard("Approval needed", { taskId: task.id, kind: "todo", priority: "high" });
      await world.updateTask(task.id, { waitingOn: "", nextTouchAt: "", nextAction: "Deploy" });
      await request(world.app).patch(`/api/feed/${card.id}`).send({ status: "done" });
      expect(await world.getTask(task.id)).toMatchObject({ nextAction: "Deploy" });
      expect((await listCards(world.app, `?taskId=${task.id}&status=done`))[0].id).toBe(card.id);
    },
  },
];
