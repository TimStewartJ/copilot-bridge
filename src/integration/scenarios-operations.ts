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
    id: "OPS-08", title: "disables and re-enables a schedule without replacing it",
    async run(world) {
      const task = await world.createTask("Pause automation");
      world.initializeScheduler();
      const schedule = await world.createSchedule(task.id, "Pauseable");
      expect((await request(world.app).patch(`/api/schedules/${schedule.id}`).send({ enabled: false })).body.enabled).toBe(false);
      const changes = { name: "New schedule", cron: "0 10 * * 1-5", timezone: "UTC", enabled: true };
      const resumed = await request(world.app).patch(`/api/schedules/${schedule.id}`).send(changes).expect(200);
      expect(resumed.body).toMatchObject({ id: schedule.id, ...changes });
      expect(world.ctx.scheduleStore.getSchedule(schedule.id)).toMatchObject({ id: schedule.id, ...changes });
    },
  },
  {
    id: "OPS-09", title: "creates a one-shot schedule and keeps its UTC run time",
    async run(world) {
      const task = await world.createTask("One shot task");
      world.initializeScheduler();
      const response = await request(world.app).post("/api/schedules").send({ taskId: task.id, name: "One shot", prompt: "Run once", type: "once", runAt: "2030-01-01T12:00:00.000Z" });
      expect(response.status).toBe(201);
      expect(response.body).toMatchObject({ type: "once", runAt: "2030-01-01T12:00:00.000Z", taskId: task.id });
      expect(world.ctx.scheduleStore.getSchedule(response.body.id)?.runAt).toBe("2030-01-01T12:00:00.000Z");
    },
  },
  {
    id: "OPS-10", title: "deletes one schedule while retaining another for the same task",
    async run(world) {
      const task = await world.createTask("Multiple schedules");
      world.initializeScheduler();
      const removed = await world.createSchedule(task.id, "Remove");
      const kept = await world.createSchedule(task.id, "Keep", { cron: "0 11 * * *" });
      world.ctx.sessionMetaStore.recordScheduleRun(removed.id, "run-1", "2030-01-01T00:00:00.000Z");
      expect(world.ctx.scheduleStore.claimScheduleRun(removed.id, "manual").acquired).toBe(true);
      const deletion = await request(world.app).delete(`/api/schedules/${removed.id}`);
      expect(deletion.status).toBe(200);
      const listed = await request(world.app).get(`/api/schedules?taskId=${task.id}`);
      expect(listed.body.map((item: any) => item.id)).toEqual([kept.id]);
      expect(world.ctx.scheduleStore.getSchedule(removed.id)).toBeUndefined();
      expect(world.ctx.sessionMetaStore.listScheduleRuns(removed.id)).toEqual([]);
      expect(world.db.prepare("SELECT runKey FROM schedule_run_claims WHERE scheduleId = ?").all(removed.id)).toEqual([]);
    },
  },
  {
    id: "OPS-11", title: "isolates schedule listings between tasks",
    async run(world) {
      const first = await world.createTask("First automation host");
      const second = await world.createTask("Second automation host");
      world.initializeScheduler();
      const cron = "0 */5 * * * *";
      const firstSchedule = await world.createSchedule(first.id, "First automation", { cron });
      expect(firstSchedule.cron).toBe(cron);
      const secondSchedule = await world.createSchedule(second.id, "Second automation");
      expect((await request(world.app).get(`/api/schedules?taskId=${first.id}`)).body.map((item: any) => item.id)).toEqual([firstSchedule.id]);
      expect((await request(world.app).get(`/api/schedules?taskId=${second.id}`)).body.map((item: any) => item.id)).toEqual([secondSchedule.id]);
    },
  },
  {
    id: "OPS-13", title: "paginates schedule run history without changing its total",
    async run(world) {
      const task = await world.createTask("Paged history");
      world.initializeScheduler();
      const schedule = await world.createSchedule(task.id, "Paged schedule");
      const runs = world.ctx.sessionMetaStore;
      runs.recordScheduleRun(schedule.id, "run-one", "2026-01-01T00:00:00.000Z");
      runs.recordScheduleRun(schedule.id, "run-two", "2026-01-02T00:00:00.000Z");
      runs.recordScheduleRun(schedule.id, "run-three", "2026-01-03T00:00:00.000Z");
      const history = `/api/schedules/${schedule.id}/sessions`;
      const page = await request(world.app).get(history).query({ limit: 2, offset: 1 }).expect(200);
      expect(page.body).toMatchObject({ total: 3, limit: 2, offset: 1, sessions: [{ sessionId: "run-two" }, { sessionId: "run-one" }] });
      const single = await request(world.app).get(history).query({ limit: 1, offset: 1 }).expect(200);
      expect(single.body).toMatchObject({ total: 3, limit: 1, offset: 1, sessions: [{ sessionId: "run-two" }] });
    },
  },
  {
    id: "OPS-14", title: "applies schedule session retention immediately",
    async run(world) {
      const task = await world.createTask("Retention host");
      world.initializeScheduler();
      const schedule = await world.createSchedule(task.id, "Retained schedule");
      world.ctx.sessionMetaStore.recordScheduleRun(schedule.id, "new-run", "2026-09-02T00:00:00.000Z");
      world.ctx.sessionMetaStore.recordScheduleRun(schedule.id, "old-run", "2026-09-01T00:00:00.000Z");
      world.ctx.sessionManager.listSessionsFromDisk = async () => [{ sessionId: "new-run", summary: "New" }, { sessionId: "old-run", summary: "Old" }] as any;
      const updated = await request(world.app).patch(`/api/schedules/${schedule.id}`).send({ autoArchiveKeep: 1 });
      expect(updated.status).toBe(200);
      expect(updated.body.autoArchiveKeep).toBe(1);
      expect(world.ctx.sessionMetaStore.isArchived("new-run")).toBe(false);
      expect(world.ctx.sessionMetaStore.isArchived("old-run")).toBe(true);
    },
  },
  {
    id: "OPS-20", title: "creates a global session with validated model launch options",
    async run(world) {
      const selection = { model: "gpt-test", reasoningEffort: "high", contextTier: "long_context" };
      const validate = vi.spyOn(world.ctx.sessionManager, "validateModelSelection");
      const create = vi.spyOn(world.ctx.sessionManager, "createSession").mockResolvedValue({ sessionId: "global-session" });
      const response = await request(world.app).post("/api/sessions").send(selection).expect(200);
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
    id: "OPS-25", title: "coordinates a task, schedule, knowledge page, and native Home",
    async run(world) {
      const task = await world.createTask("Cross-boundary launch", { notes: "Coordinate all systems" });
      world.initializeScheduler();
      const schedule = await world.createSchedule(task.id, "Daily launch review");
      await world.writePage("launch/readiness", "# Launch Readiness\n\nReview daily.");
      await world.updateTask(task.id, { nextAction: "Run the launch review" });
      const schedules = await request(world.app).get(`/api/schedules?taskId=${task.id}`);
      const search = await request(world.app).get("/api/docs/search?q=readiness");
      expect(schedules.body[0].id).toBe(schedule.id);
      expect(search.body.results[0].path).toBe("launch/readiness");
      expect((await request(world.app).get("/api/home")).body.resume[0]).toMatchObject({ id: task.id, nextAction: "Run the launch review" });
    },
  },
];
