import { expect } from "vitest";
import { request } from "../test-support/api-routes.js";
import type { IntegrationScenario } from "./scenario-types.js";

export const attentionScenarios: IntegrationScenario[] = [
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
];
