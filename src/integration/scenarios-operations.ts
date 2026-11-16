import { expect, vi } from "vitest";
import { providers, request } from "../test-support/api-routes.js";
import type { IntegrationScenario } from "./scenario-types.js";

export const operationScenarios: IntegrationScenario[] = [
  {
    id: "OPS-02", title: "preserves prior settings while updating an unrelated preference",
    async run(world) {
      await request(world.app).patch("/api/settings").send({ theme: "dark", favicon: "rocket" });
      await request(world.app).patch("/api/settings").send({ theme: "light" });
      const read = await request(world.app).get("/api/settings");
      expect(read.body).toMatchObject({ theme: "light", favicon: "rocket" });
      expect(world.ctx.settingsStore.getSettings().favicon).toBe("rocket");
    },
  },
  {
    id: "OPS-03", title: "persists deferred worker launch configuration",
    async run(world) {
      const worker = { model: "gpt-5-mini", reasoningEffort: "low", contextTier: "default" };
      const evict = vi.spyOn(world.ctx.sessionManager, "evictAllCachedSessions");
      const validate = vi.spyOn(world.ctx.sessionManager, "validateModelSelection").mockResolvedValue({ ok: false, error: "Model is not available: gpt-5-mini" });
      const updated = await request(world.app).patch("/api/settings").send({ deferWorker: worker }).expect(200);
      expect(updated.body.deferWorker).toEqual(worker);
      const read = await request(world.app).get("/api/settings").expect(200);
      expect(read.body.deferWorker).toEqual(worker);
      expect(world.ctx.settingsStore.getSettings().deferWorker).toEqual(worker);
      expect(validate).not.toHaveBeenCalled();
      expect(evict).not.toHaveBeenCalled();
    },
  },
  {
    id: "OPS-05", title: "rejects a mixed invalid settings update atomically",
    async run(world) {
      await request(world.app).patch("/api/settings").send({ theme: "dark" }).expect(200);
      const evict = vi.spyOn(world.ctx.sessionManager, "evictAllCachedSessions");
      const cachedProvider = providers.getProvider("github");
      try {
        const rejected = await request(world.app).patch("/api/settings").send({ theme: "light", contextTier: "enormous" }).expect(400);
        expect(rejected.body.error).toContain("contextTier must be default or long_context");
        expect((await request(world.app).get("/api/settings")).body.theme).toBe("dark");
        expect(world.ctx.settingsStore.getSettings().theme).toBe("dark");
        expect(evict).not.toHaveBeenCalled();
        expect(providers.getProvider("github")).toBe(cachedProvider);
      } finally {
        providers.clearProviderCache();
      }
    },
  },
  {
    id: "OPS-08", title: "pauses and resumes a task trigger without replacing it",
    async run(world) {
      const task = await world.createTask("Pause automation");
      const trigger = await world.createTaskTrigger(task.id, "Pauseable");
      expect((await request(world.app).patch(`/api/triggers/${trigger.id}`).send({ active: false }).expect(200)).body.status).toBe("paused");
      const resumed = await request(world.app).patch(`/api/triggers/${trigger.id}`)
        .send({ name: "New trigger", cron: "0 10 * * 1-5", timezone: "UTC", active: true }).expect(200);
      const expected = { id: trigger.id, name: "New trigger", when: { kind: "cron", cron: "0 10 * * 1-5", timezone: "UTC" }, status: "active" };
      expect(resumed.body).toMatchObject(expected);
      expect(world.ctx.triggerStore!.get(trigger.id)).toMatchObject(expected);
    },
  },
  {
    id: "OPS-09", title: "creates a one-time task trigger and keeps its run time in UTC",
    async run(world) {
      const task = await world.createTask("One shot task");
      const utc = new Date(Math.ceil(Date.now() / 60_000) * 60_000 + 86_400_000);
      const plusTwo = `${new Date(utc.getTime() + 2 * 3_600_000).toISOString().slice(0, 19)}+02:00`;
      const response = await request(world.app).post("/api/triggers")
        .send({ taskId: task.id, name: "One shot", prompt: "Run once", then: "new_chat", runAt: plusTwo }).expect(201);
      expect(response.body).toMatchObject({ when: { kind: "at", at: utc.toISOString() }, nextRunAt: utc.toISOString(), taskId: task.id });
      expect(world.ctx.triggerStore!.get(response.body.id)?.nextRunAt).toBe(utc.toISOString());
    },
  },
  {
    id: "OPS-10", title: "deletes one task trigger with its run history while keeping another",
    async run(world) {
      const task = await world.createTask("Multiple triggers");
      const removed = await world.createTaskTrigger(task.id, "Remove");
      const kept = await world.createTaskTrigger(task.id, "Keep", { cron: "0 11 * * *" });
      world.ctx.triggerStore!.recordRun({ triggerId: removed.id, sessionId: "run-1" }, "2030-01-01T00:00:00.000Z");
      await request(world.app).delete(`/api/triggers/${removed.id}`).expect(200);
      const listed = await request(world.app).get(`/api/triggers?taskId=${task.id}`).expect(200);
      expect(listed.body.triggers.map((item: any) => item.id)).toEqual([kept.id]);
      expect(world.ctx.triggerStore!.get(removed.id)).toBeUndefined();
      expect(world.ctx.triggerStore!.listRuns(removed.id).total).toBe(0);
    },
  },
  {
    id: "OPS-11", title: "isolates trigger listings between tasks",
    async run(world) {
      const first = await world.createTask("First automation host");
      const second = await world.createTask("Second automation host");
      const firstTrigger = await world.createTaskTrigger(first.id, "First automation");
      const secondTrigger = await world.createTaskTrigger(second.id, "Second automation");
      expect((await request(world.app).get(`/api/triggers?taskId=${first.id}`)).body.triggers.map((item: any) => item.id)).toEqual([firstTrigger.id]);
      expect((await request(world.app).get(`/api/triggers?taskId=${second.id}`)).body.triggers.map((item: any) => item.id)).toEqual([secondTrigger.id]);
    },
  },
  {
    id: "OPS-13", title: "paginates the chats a trigger started without changing their total",
    async run(world) {
      const task = await world.createTask("Paged history");
      const trigger = await world.createTaskTrigger(task.id, "Paged trigger");
      const store = world.ctx.triggerStore!;
      store.recordRun({ triggerId: trigger.id, sessionId: "run-one" }, "2026-01-01T00:00:00.000Z");
      store.recordRun({ triggerId: trigger.id, sessionId: "run-two" }, "2026-01-02T00:00:00.000Z");
      store.recordRun({ triggerId: trigger.id, sessionId: "run-three" }, "2026-01-03T00:00:00.000Z");
      const history = `/api/triggers/${trigger.id}/chats`;
      const page = await request(world.app).get(history).query({ limit: 2, offset: 1 }).expect(200);
      expect(page.body).toMatchObject({ total: 3, limit: 2, offset: 1, sessions: [{ sessionId: "run-two" }, { sessionId: "run-one" }] });
      const single = await request(world.app).get(history).query({ limit: 1, offset: 1 }).expect(200);
      expect(single.body).toMatchObject({ total: 3, limit: 1, offset: 1, sessions: [{ sessionId: "run-two" }] });
    },
  },  {
    id: "OPS-20", title: "creates a global session with validated model launch options",
    async run(world) {
      const selection = { model: "gpt-test", reasoningEffort: "high", contextTier: "long_context" };
      const validate = vi.spyOn(world.ctx.sessionManager, "validateModelSelection");
      const create = vi.spyOn(world.ctx.sessionManager, "createSession").mockResolvedValue({ sessionId: "global-session" });
      const response = await request(world.app).post("/api/sessions").set("X-Bridge-Client", "web").send(selection).expect(200);
      expect(response.body.sessionId).toBe("global-session");
      expect(validate).toHaveBeenCalledWith(selection);
      expect(create).toHaveBeenCalledWith({ background: true, ...selection });
    },
  },
  {
    id: "OPS-22", title: "submits new chat work through the session manager",
    async run(world) {
      const start = vi.spyOn(world.ctx.sessionManager, "startWork");
      const send = () => request(world.app).post("/api/chat").send({ sessionId: "chat-session", prompt: "Investigate the failure", mode: "autopilot", clientMessageId: "client-message-1" });
      const response = await send().expect(202);
      expect(start).toHaveBeenCalledWith("chat-session", "Investigate the failure", undefined, { clientMessageId: "client-message-1", mode: "autopilot", keepUndelivered: true });
      expect(response.body).toMatchObject({ status: "accepted" });

      // A browser retry of an already delivered message must not start work again.
      world.ctx.chatMessageIdStore!.record("chat-session", "runtime-message-1", "client-message-1");
      await send().expect(202);
      expect(start).toHaveBeenCalledTimes(1);
    },
  },
  {
    id: "OPS-25", title: "coordinates a task, trigger, knowledge page, and native Home",
    async run(world) {
      const task = await world.createTask("Cross-boundary launch", { notes: "Coordinate all systems" });
      const trigger = await world.createTaskTrigger(task.id, "Daily launch review");

      await world.writePage("launch/readiness", "# Launch Readiness\n\nReview daily.");
      await world.updateTask(task.id, { nextAction: "Run the launch review" });
      const triggers = await request(world.app).get(`/api/triggers?taskId=${task.id}`);
      const search = await request(world.app).get("/api/docs/search?q=readiness");
      expect(triggers.body.triggers[0].id).toBe(trigger.id);
      expect(search.body.results[0].path).toBe("launch/readiness");
      expect((await request(world.app).get("/api/home")).body.resume[0]).toMatchObject({ id: task.id, nextAction: "Run the launch review" });
    },
  },
];
