import { expect, vi } from "vitest";
import { providers, request } from "../test-support/api-routes.js";
import type { IntegrationScenario } from "./scenario-types.js";

export const operationScenarios: IntegrationScenario[] = [
  {
    id: "OPS-01", title: "persists appearance settings across separate API reads",
    async run(world) {
      const updated = await request(world.app).patch("/api/settings").send({ theme: "dark", favicon: "rocket" });
      expect(updated.status).toBe(200);
      const read = await request(world.app).get("/api/settings");
      expect(read.body).toMatchObject({ theme: "dark", favicon: "rocket" });
      expect(world.ctx.settingsStore.getSettings()).toMatchObject({ theme: "dark", favicon: "rocket" });
    },
  },
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
    id: "OPS-04", title: "adds a default MCP server and evicts stale cached sessions",
    async run(world) {
      const evict = vi.spyOn(world.ctx.sessionManager, "evictAllCachedSessions");
      const created = await request(world.app).post("/api/mcp-servers").send({ name: "local", config: { command: "node", args: ["server.js"] }, enabledByDefault: true });
      expect(created.status).toBe(201);
      expect(evict).toHaveBeenCalledOnce();
      expect(world.ctx.settingsStore.getMcpServers()).toEqual({ local: { command: "node", args: ["server.js"] } });
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
    id: "OPS-06", title: "creates and lists a recurring schedule for its task",
    async run(world) {
      const task = await world.createTask("Scheduled task");
      world.initializeScheduler();
      const schedule = await world.createSchedule(task.id, "Weekday review");
      const listed = await request(world.app).get(`/api/schedules?taskId=${task.id}`);
      expect(listed.status).toBe(200);
      expect(listed.body.map((item: any) => item.id)).toContain(schedule.id);
      expect(world.ctx.scheduleStore.getSchedule(schedule.id)?.taskId).toBe(task.id);
    },
  },
  {
    id: "OPS-07", title: "renames and reschedules an existing recurring schedule",
    async run(world) {
      const task = await world.createTask("Reschedule task");
      world.initializeScheduler();
      const schedule = await world.createSchedule(task.id, "Old schedule");
      const updated = await request(world.app).patch(`/api/schedules/${schedule.id}`).send({ name: "New schedule", cron: "0 10 * * 1-5", timezone: "UTC" });
      expect(updated.status).toBe(200);
      expect(updated.body).toMatchObject({ id: schedule.id, name: "New schedule", cron: "0 10 * * 1-5", timezone: "UTC" });
      expect(world.ctx.scheduleStore.getSchedule(schedule.id)?.name).toBe("New schedule");
    },
  },
  {
    id: "OPS-08", title: "disables and re-enables a schedule without replacing it",
    async run(world) {
      const task = await world.createTask("Pause automation");
      world.initializeScheduler();
      const schedule = await world.createSchedule(task.id, "Pauseable");
      expect((await request(world.app).patch(`/api/schedules/${schedule.id}`).send({ enabled: false })).body.enabled).toBe(false);
      expect((await request(world.app).patch(`/api/schedules/${schedule.id}`).send({ enabled: true })).body.enabled).toBe(true);
      expect(world.ctx.scheduleStore.getSchedule(schedule.id)?.id).toBe(schedule.id);
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
      const deletion = await request(world.app).delete(`/api/schedules/${removed.id}`);
      expect(deletion.status).toBe(200);
      const listed = await request(world.app).get(`/api/schedules?taskId=${task.id}`);
      expect(listed.body.map((item: any) => item.id)).toEqual([kept.id]);
      expect(world.ctx.scheduleStore.getSchedule(removed.id)).toBeUndefined();
    },
  },
  {
    id: "OPS-11", title: "isolates schedule listings between tasks",
    async run(world) {
      const first = await world.createTask("First automation host");
      const second = await world.createTask("Second automation host");
      world.initializeScheduler();
      const firstSchedule = await world.createSchedule(first.id, "First automation");
      const secondSchedule = await world.createSchedule(second.id, "Second automation");
      expect((await request(world.app).get(`/api/schedules?taskId=${first.id}`)).body.map((item: any) => item.id)).toEqual([firstSchedule.id]);
      expect((await request(world.app).get(`/api/schedules?taskId=${second.id}`)).body.map((item: any) => item.id)).toEqual([secondSchedule.id]);
    },
  },
  {
    id: "OPS-12", title: "records repeated schedule runs as distinct durable history",
    async run(world) {
      const task = await world.createTask("Run history");
      world.initializeScheduler();
      const schedule = await world.createSchedule(task.id, "History schedule");
      world.ctx.sessionMetaStore.recordScheduleRun(schedule.id, "same-session", "2026-09-01T10:00:00.000Z");
      world.ctx.sessionMetaStore.recordScheduleRun(schedule.id, "same-session", "2026-09-02T10:00:00.000Z");
      const history = await request(world.app).get(`/api/schedules/${schedule.id}/sessions`);
      expect(history.status).toBe(200);
      expect(history.body.sessions).toMatchObject([
        { sessionId: "same-session", recordedAt: "2026-09-02T10:00:00.000Z", missing: true },
        { sessionId: "same-session", recordedAt: "2026-09-01T10:00:00.000Z", missing: true },
      ]);
      expect(new Set(history.body.sessions.map((item: any) => item.runId)).size).toBe(2);
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
    id: "OPS-15", title: "stores a schedule's model tier",
    async run(world) {
      const task = await world.createTask("Model schedule");
      world.initializeScheduler();
      const schedule = await world.createSchedule(task.id, "Model-aware", { modelTier: "preset2" });
      expect(schedule).toMatchObject({ taskId: task.id, name: "Model-aware", type: "cron", modelTier: "preset2" });
      expect(world.ctx.scheduleStore.getSchedule(schedule.id)).toMatchObject({ modelTier: "preset2" });
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
    id: "OPS-21", title: "creates a task session and links it durably to the task",
    async run(world) {
      const task = await world.createTask("Conversation task");
      vi.spyOn(world.ctx.sessionManager, "createTaskSession").mockResolvedValue({ sessionId: "linked-session" });
      const response = await request(world.app).post(`/api/tasks/${task.id}/session`).send({});
      expect(response.status).toBe(200);
      expect(response.body.sessionId).toBe("linked-session");
      expect(world.ctx.taskStore.getTask(task.id)?.sessionIds).toContain("linked-session");
      expect((await world.getTask(task.id)).activeSessionIds).toContain("linked-session");
    },
  },
  {
    id: "OPS-22", title: "submits new chat work through the session manager",
    async run(world) {
      const start = vi.spyOn(world.ctx.sessionManager, "startWork");
      const send = () => request(world.app).post("/api/chat").send({ sessionId: "chat-session", prompt: "Investigate the failure", clientMessageId: "client-message-1" });
      const response = await send().expect(202);
      expect(start).toHaveBeenCalledWith("chat-session", "Investigate the failure", undefined, { clientMessageId: "client-message-1", keepUndelivered: true });
      expect(response.body).toMatchObject({ status: "accepted" });

      // A browser retry of an already delivered message must not start work again.
      world.ctx.chatMessageIdStore!.record("chat-session", "runtime-message-1", "client-message-1");
      await send().expect(202);
      expect(start).toHaveBeenCalledTimes(1);
    },
  },
  {
    id: "OPS-23", title: "steers an already busy session instead of starting duplicate work",
    async run(world) {
      vi.spyOn(world.ctx.sessionManager, "isSessionBusy").mockReturnValue(true);
      const steer = vi.spyOn(world.ctx.sessionManager, "steerSession").mockResolvedValue(undefined);
      const start = vi.spyOn(world.ctx.sessionManager, "startWork");
      const response = await request(world.app).post("/api/chat").send({ sessionId: "busy-session", prompt: "Change direction", mode: "autopilot" });
      expect(response.status).toBe(202);
      expect(response.body).toEqual({ status: "accepted", mode: "steered" });
      expect(steer).toHaveBeenCalledWith("busy-session", "Change direction", undefined, undefined, { skipOpenQuestions: true });
      expect(start).not.toHaveBeenCalled();
    },
  },
  {
    id: "OPS-24", title: "keeps the server healthy after task, docs, checklist, and settings mutations",
    async run(world) {
      const task = await world.createTask("Health workflow");
      await world.createChecklistItem(task.id, "Health item");
      await world.updateTask(task.id, { nextAction: "Review the health check" });
      await world.writePage("health/workflow", "# Healthy Workflow");
      await request(world.app).patch("/api/settings").send({ theme: "dark" });
      const health = await request(world.app).get("/api/health");
      expect(health.status).toBe(200);
      expect(health.body.ok).toBe(true);
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
