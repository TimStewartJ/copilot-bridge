import { expect, vi } from "vitest";
import { request } from "../test-support/api-routes.js";
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
      const updated = await request(world.app).patch("/api/settings").send({ deferWorker: { model: "gpt-5-mini", reasoningEffort: "low", contextTier: "default" } });
      expect(updated.status).toBe(200);
      const read = await request(world.app).get("/api/settings");
      expect(read.body.deferWorker).toEqual({ model: "gpt-5-mini", reasoningEffort: "low", contextTier: "default" });
      expect(world.ctx.settingsStore.getSettings().deferWorker?.model).toBe("gpt-5-mini");
    },
  },
  {
    id: "OPS-04", title: "updates MCP configuration and evicts stale cached sessions",
    async run(world) {
      const evict = vi.spyOn(world.ctx.sessionManager, "evictAllCachedSessions");
      const updated = await request(world.app).patch("/api/settings").send({ mcpServers: { local: { command: "node", args: ["server.js"] } } });
      expect(updated.status).toBe(200);
      expect(evict).toHaveBeenCalledOnce();
      expect(world.ctx.settingsStore.getMcpServers()).toEqual({ local: { command: "node", args: ["server.js"] } });
    },
  },
  {
    id: "OPS-05", title: "rejects a mixed invalid settings update atomically",
    async run(world) {
      await request(world.app).patch("/api/settings").send({ theme: "dark" });
      const rejected = await request(world.app).patch("/api/settings").send({ theme: "light", contextTier: "enormous" });
      expect(rejected.status).toBe(400);
      expect((await request(world.app).get("/api/settings")).body.theme).toBe("dark");
      expect(world.ctx.settingsStore.getSettings().theme).toBe("dark");
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
      expect(updated.body).toMatchObject({ name: "New schedule", cron: "0 10 * * 1-5", timezone: "UTC" });
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
      expect(history.body.sessions).toHaveLength(2);
      expect(new Set(history.body.sessions.map((item: any) => item.runId)).size).toBe(2);
    },
  },
  {
    id: "OPS-13", title: "paginates schedule run history without changing its total",
    async run(world) {
      const task = await world.createTask("Paged history");
      world.initializeScheduler();
      const schedule = await world.createSchedule(task.id, "Paged schedule");
      for (const id of ["run-one", "run-two", "run-three"]) world.ctx.sessionMetaStore.recordScheduleRun(schedule.id, id);
      const page = await request(world.app).get(`/api/schedules/${schedule.id}/sessions?limit=1&offset=1`);
      expect(page.body).toMatchObject({ total: 3, limit: 1, offset: 1 });
      expect(page.body.sessions).toHaveLength(1);
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
      expect(world.ctx.sessionMetaStore.isArchived("new-run")).toBe(false);
      expect(world.ctx.sessionMetaStore.isArchived("old-run")).toBe(true);
    },
  },
  {
    id: "OPS-15", title: "validates and stores model-specific schedule launch options",
    async run(world) {
      const task = await world.createTask("Model schedule");
      world.initializeScheduler();
      vi.spyOn(world.ctx.sessionManager, "listModels").mockResolvedValue([{ id: "gpt-test", name: "GPT Test", supportedReasoningEfforts: ["high"], billing: { tokenPrices: { contextMax: 100_000, longContext: { contextMax: 500_000 } } } }] as any);
      const schedule = await world.createSchedule(task.id, "Model-aware", { model: "gpt-test", reasoningEffort: "high", contextTier: "long_context" });
      expect(schedule).toMatchObject({ model: "gpt-test", reasoningEffort: "high", contextTier: "long_context" });
      expect(world.ctx.scheduleStore.getSchedule(schedule.id)).toMatchObject({ model: "gpt-test", reasoningEffort: "high", contextTier: "long_context" });
    },
  },
  {
    id: "OPS-16", title: "lists task agent summaries and retrieves protected prompt detail",
    async run(world) {
      const task = await world.createTask("Agent host");
      world.ctx.taskAgentDefinitionStore!.createTaskAgentDefinition({ taskId: task.id, name: "reviewer", displayName: "Reviewer", description: "Reviews changes", prompt: "Review all changes.", tools: ["view"] });
      const list = await request(world.app).get(`/api/tasks/${task.id}/agent-definitions`);
      expect(list.body.agentDefinitions[0]).not.toHaveProperty("prompt");
      const detail = await request(world.app).get(`/api/tasks/${task.id}/agent-definitions/reviewer`);
      expect(detail.body.agentDefinition).toMatchObject({ name: "reviewer", prompt: "Review all changes.", tools: ["view"] });
    },
  },
  {
    id: "OPS-17", title: "launches a task session with a selected task-scoped agent",
    async run(world) {
      const task = await world.createTask("Agent launch host");
      world.ctx.taskAgentDefinitionStore!.createTaskAgentDefinition({ taskId: task.id, name: "planner", description: "Plans work", prompt: "Plan the work." });
      const create = vi.spyOn(world.ctx.sessionManager, "createTaskSession").mockResolvedValue({ sessionId: "agent-session" });
      const launched = await request(world.app).post(`/api/tasks/${task.id}/session`).send({ agent: "planner" });
      expect(launched.status).toBe(200);
      expect(create).toHaveBeenCalledWith(task.id, task.title, task.workItems, [], task.notes, task.cwd, undefined, null, expect.objectContaining({ agent: "planner", background: true }));
      expect(world.ctx.taskStore.getTask(task.id)?.sessionIds).toContain("agent-session");
    },
  },
  {
    id: "OPS-18", title: "rejects a task agent from an unrelated task",
    async run(world) {
      const owner = await world.createTask("Agent owner");
      const other = await world.createTask("Other task");
      world.ctx.taskAgentDefinitionStore!.createTaskAgentDefinition({ taskId: owner.id, name: "private-agent", description: "Private", prompt: "Private prompt" });
      const rejected = await request(world.app).post(`/api/tasks/${other.id}/session`).send({ agent: "private-agent" });
      expect(rejected.status).toBe(400);
      expect(rejected.body.error).toContain("not available for this task");
      expect(world.ctx.taskStore.getTask(other.id)?.sessionIds).toEqual([]);
    },
  },
  {
    id: "OPS-19", title: "removes task agent definitions when the owning task is deleted",
    async run(world) {
      const task = await world.createTask("Disposable agent host");
      world.ctx.taskAgentDefinitionStore!.createTaskAgentDefinition({ taskId: task.id, name: "temporary-agent", description: "Temporary", prompt: "Temporary prompt" });
      expect((await request(world.app).get(`/api/tasks/${task.id}/agent-definitions`)).body.agentDefinitions).toHaveLength(1);
      await request(world.app).delete(`/api/tasks/${task.id}`);
      expect(world.ctx.taskAgentDefinitionStore!.listTaskAgentDefinitions(task.id)).toEqual([]);
    },
  },
  {
    id: "OPS-20", title: "creates a global session with validated model launch options",
    async run(world) {
      vi.spyOn(world.ctx.sessionManager, "listModels").mockResolvedValue([{ id: "gpt-test", name: "GPT Test", policy: { state: "enabled" }, supportedReasoningEfforts: ["high"] }] as any);
      const create = vi.spyOn(world.ctx.sessionManager, "createSession").mockResolvedValue({ sessionId: "global-session" });
      const response = await request(world.app).post("/api/sessions").send({ model: "gpt-test", reasoningEffort: "high" });
      expect(response.status).toBe(200);
      expect(response.body.sessionId).toBe("global-session");
      expect(create).toHaveBeenCalledWith(expect.objectContaining({ background: true, model: "gpt-test", reasoningEffort: "high" }));
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
      expect((await world.getTask(task.id)).sessionIds).toContain("linked-session");
    },
  },
  {
    id: "OPS-22", title: "submits new chat work through the session manager",
    async run(world) {
      const start = vi.spyOn(world.ctx.sessionManager, "startWork");
      const response = await request(world.app).post("/api/chat").send({ sessionId: "chat-session", prompt: "Investigate the failure", clientMessageId: "client-message-1" });
      expect(response.status).toBe(202);
      expect(start).toHaveBeenCalledWith("chat-session", "Investigate the failure", undefined, { clientMessageId: "client-message-1" });
      expect(response.body).toMatchObject({ status: "accepted" });
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
      expect(steer).toHaveBeenCalledWith("busy-session", "Change direction", undefined);
      expect(start).not.toHaveBeenCalled();
    },
  },
  {
    id: "OPS-24", title: "keeps the server healthy after task, docs, feed, and settings mutations",
    async run(world) {
      const task = await world.createTask("Health workflow");
      await world.createChecklistItem(task.id, "Health item");
      await world.createFeedCard("Health card", { taskId: task.id });
      await world.writePage("health/workflow", "# Healthy Workflow");
      await request(world.app).patch("/api/settings").send({ theme: "dark" });
      const health = await request(world.app).get("/api/health");
      expect(health.status).toBe(200);
      expect(health.body.ok).toBe(true);
    },
  },
  {
    id: "OPS-25", title: "coordinates a task, specialist, schedule, knowledge page, and attention card",
    async run(world) {
      const task = await world.createTask("Cross-boundary launch", { notes: "Coordinate all systems" });
      world.ctx.taskAgentDefinitionStore!.createTaskAgentDefinition({ taskId: task.id, name: "launch-reviewer", description: "Reviews launch", prompt: "Review launch readiness." });
      world.initializeScheduler();
      const schedule = await world.createSchedule(task.id, "Daily launch review");
      await world.writePage("launch/readiness", "# Launch Readiness\n\nReview daily.");
      const card = await world.createFeedCard("Launch review pending", { taskId: task.id, kind: "todo", action: { prompt: "Run the launch review.", taskId: task.id } });
      const agents = await request(world.app).get(`/api/tasks/${task.id}/agent-definitions`);
      const schedules = await request(world.app).get(`/api/schedules?taskId=${task.id}`);
      const search = await request(world.app).get("/api/docs/search?q=readiness");
      expect(agents.body.agentDefinitions[0].name).toBe("launch-reviewer");
      expect(schedules.body[0].id).toBe(schedule.id);
      expect(search.body.results[0].path).toBe("launch/readiness");
      expect((await request(world.app).get(`/api/feed?taskId=${task.id}`)).body.cards[0].id).toBe(card.id);
    },
  },
];
