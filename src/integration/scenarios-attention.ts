import { expect } from "vitest";
import { request } from "../test-support/api-routes.js";
import type { IntegrationScenario } from "./scenario-types.js";

export const attentionScenarios: IntegrationScenario[] = [
  {
    id: "ATTN-17", title: "uses attention activity when it is newer than visible activity",
    async run(world) {
      world.ctx.sessionMetaStore.setLastVisibleActivityAt("session-attention", "2026-09-01T10:00:00.000Z");
      world.ctx.sessionMetaStore.setLastAttentionAt("session-attention", "2026-09-01T10:05:00.000Z");
      const marked = await request(world.app).post("/api/read-state/session-attention");
      expect(marked.body).toMatchObject({ lastReadAt: "2026-09-01T10:05:00.000Z", readThroughActivityAt: "2026-09-01T10:05:00.000Z" });
      expect((await request(world.app).get("/api/read-state")).body["session-attention"]).toBe("2026-09-01T10:05:00.000Z");
    },
  },
  {
    id: "ATTN-19", title: "clears one session read cursor without disturbing another",
    async run(world) {
      world.ctx.sessionMetaStore.setLastVisibleActivityAt("session-one", "2026-08-01T10:00:00.000Z");
      const marked = await request(world.app).post("/api/read-state/session-one").expect(200);
      expect(marked.body.lastReadAt).toBe("2026-08-01T10:00:00.000Z");
      expect((await request(world.app).get("/api/read-state")).body["session-one"]).toBe("2026-08-01T10:00:00.000Z");
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
      const accepted = await request(world.app).post("/api/read-state/session-safe").send({ readThroughActivityAt: "2026-08-01T10:00:00.000Z" }).expect(200);
      expect(accepted.body.lastReadAt).toBe("2026-08-01T10:00:00.000Z");
      const rejected = await request(world.app).post("/api/read-state/session-safe").send({ readThroughActivityAt: "tomorrow" });
      expect(rejected.status).toBe(400);
      expect(rejected.body.error).toContain("readThroughActivityAt");
      expect((await request(world.app).get("/api/read-state")).body["session-safe"]).toBe("2026-08-01T10:00:00.000Z");
    },
  },
];
