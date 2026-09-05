import type { Express } from "express";
import type { AppContext } from "../server/app-context.js";
import type { DatabaseSync } from "../server/db.js";
import * as scheduler from "../server/scheduler.js";
import { createTestApp, request } from "../test-support/api-routes.js";

export interface ScenarioWorld {
  app: Express;
  ctx: AppContext;
  db: DatabaseSync;
  createTask(title: string, extra?: Record<string, unknown>): Promise<any>;
  getTask(id: string): Promise<any>;
  updateTask(id: string, patch: Record<string, unknown>): Promise<any>;
  createGroup(name: string, extra?: Record<string, unknown>): Promise<any>;
  createTag(name: string, extra?: Record<string, unknown>): Promise<any>;
  assignTaskTags(taskId: string, tagIds: string[]): Promise<any>;
  assignGroupTags(groupId: string, tagIds: string[]): Promise<any>;
  createChecklistItem(taskId: string, text: string, deadline?: string): Promise<any>;
  createFeedCard(title: string, extra?: Record<string, unknown>): Promise<any>;
  writePage(path: string, content: string): Promise<any>;
  readPage(path: string): Promise<any>;
  createCollection(folder: string, fields?: Array<Record<string, unknown>>): Promise<any>;
  addCollectionEntry(folder: string, fields: Record<string, unknown>, body?: string): Promise<any>;
  initializeScheduler(): void;
  createSchedule(taskId: string, name: string, extra?: Record<string, unknown>): Promise<any>;
}

function bodyOrThrow(response: any, expectedStatus: number, operation: string): any {
  if (response.status !== expectedStatus) {
    throw new Error(`${operation} returned ${response.status}: ${JSON.stringify(response.body)}`);
  }
  return response.body;
}

export function createScenarioWorld(): ScenarioWorld {
  const { app, ctx, db } = createTestApp();

  return {
    app,
    ctx,
    db,
    async createTask(title, extra = {}) {
      const response = await request(app).post("/api/tasks").send({ title, ...extra });
      return bodyOrThrow(response, 200, "create task").task;
    },
    async getTask(id) {
      const response = await request(app).get(`/api/tasks/${id}`);
      return bodyOrThrow(response, 200, "get task").task;
    },
    async updateTask(id, patch) {
      const response = await request(app).patch(`/api/tasks/${id}`).send(patch);
      return bodyOrThrow(response, 200, "update task").task;
    },
    async createGroup(name, extra = {}) {
      const response = await request(app).post("/api/task-groups").send({ name, ...extra });
      return bodyOrThrow(response, 200, "create group").group;
    },
    async createTag(name, extra = {}) {
      const response = await request(app).post("/api/tags").send({ name, ...extra });
      return bodyOrThrow(response, 200, "create tag").tag;
    },
    async assignTaskTags(taskId, tagIds) {
      const response = await request(app).put(`/api/tasks/${taskId}/tags`).send({ tagIds });
      return bodyOrThrow(response, 200, "assign task tags");
    },
    async assignGroupTags(groupId, tagIds) {
      const response = await request(app).put(`/api/task-groups/${groupId}/tags`).send({ tagIds });
      return bodyOrThrow(response, 200, "assign group tags");
    },
    async createChecklistItem(taskId, text, deadline) {
      const response = await request(app)
        .post(`/api/tasks/${taskId}/checklist-items`)
        .send({ text, ...(deadline ? { deadline } : {}) });
      return bodyOrThrow(response, 200, "create checklist item").checklistItem;
    },
    async createFeedCard(title, extra = {}) {
      const response = await request(app).post("/api/feed").send({ title, ...extra });
      return bodyOrThrow(response, 201, "create feed card").card;
    },
    async writePage(pagePath, content) {
      const response = await request(app).put(`/api/docs/pages/${pagePath}`).send({ content });
      return bodyOrThrow(response, 200, "write docs page");
    },
    async readPage(pagePath) {
      const response = await request(app).get(`/api/docs/pages/${pagePath}`);
      return bodyOrThrow(response, 200, "read docs page");
    },
    async createCollection(folder, fields = [
      { name: "status", type: "select", options: ["open", "closed"] },
      { name: "priority", type: "number" },
    ]) {
      const response = await request(app)
        .put(`/api/docs/schema/${folder}`)
        .send({ name: folder, fields });
      return bodyOrThrow(response, 200, "create docs collection");
    },
    async addCollectionEntry(folder, fields, body) {
      const response = await request(app)
        .post(`/api/docs/db/${folder}`)
        .send({ fields, ...(body === undefined ? {} : { body }) });
      return bodyOrThrow(response, 200, "add docs entry");
    },
    initializeScheduler() {
      if (scheduler.isInitialized()) scheduler.shutdown();
      scheduler.initialize(ctx.sessionManager as any, {
        scheduleStore: ctx.scheduleStore,
        taskStore: ctx.taskStore,
        sessionMetaStore: ctx.sessionMetaStore,
        globalBus: ctx.globalBus,
      });
    },
    async createSchedule(taskId, name, extra = {}) {
      const response = await request(app).post("/api/schedules").send({
        taskId,
        name,
        prompt: `Run ${name}`,
        type: "cron",
        cron: "0 9 * * 1-5",
        ...extra,
      });
      return bodyOrThrow(response, 201, "create schedule");
    },
  };
}
