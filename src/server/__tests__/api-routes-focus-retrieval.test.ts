import express, { Router } from "express";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppContext } from "../app-context.js";
import { createChecklistStore } from "../checklist-store.js";
import type { DatabaseSync } from "../db.js";
import { createFocusDataLayer } from "../focus-data-layer.js";
import { createFocusProjectionService } from "../focus-dashboard-projection.js";
import { registerFocusGovernanceRoutes } from "../focus-governance-routes.js";
import { createTaskStore } from "../task-store.js";
import { createFocusGovernanceToolDefinitions } from "../tools/focus-governance-tools.js";
import { createTestBus, setupTestDb } from "./helpers.js";
import { alertDetails, decisionDetails } from "./focus-test-fixtures.js";
import request from "./test-http.js";

function setup() {
  const db = setupTestDb();
  const bus = createTestBus();
  const checklistStore = createChecklistStore(db, bus);
  const taskStore = createTaskStore(db, bus);
  const layer = createFocusDataLayer(db, bus, checklistStore);
  const projection = createFocusProjectionService({
    db, taskStore, decisionStore: layer.decisionStore, alertStore: layer.alertStore, eventStore: layer.eventStore,
    compatibilityErrorCount: layer.reconciliationErrorStore.countErrors,
  });
  const ctx = {
    globalBus: bus, focusProjection: projection, focusTransitionStore: layer.transitionStore,
  } as unknown as AppContext;
  const app = express();
  const router = Router();
  registerFocusGovernanceRoutes(router, ctx);
  app.use("/api", router);
  const tools = createFocusGovernanceToolDefinitions(ctx);
  async function tool(name: string, args: Record<string, unknown>) {
    const definition = tools.find((entry) => entry.name === name);
    if (!definition?.handler) throw new Error(`Missing tool ${name}`);
    return await definition.handler(args, {
      sessionId: "retrieval-test", toolCallId: name, toolName: name, arguments: args,
    }) as Record<string, any>;
  }
  return { db, bus, taskStore, layer, projection, app, tool };
}

let state: ReturnType<typeof setup>;
let db: DatabaseSync;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-05T18:00:00.000Z"));
  state = setup();
  db = state.db;
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  db.close();
});

function writes() {
  return db.prepare("SELECT total_changes() AS count").get()?.count;
}

describe("Focus retrieval APIs and tools", () => {
  it("serializes the matched prior episode beyond the transition window at both History boundaries", async () => {
    const { layer, taskStore, app, tool } = state;
    const task = taskStore.createTask("Prior source task");
    const source = layer.mutations.saveDecision({
      ...decisionDetails, title: "Prior question", taskId: task.id, sourceFamily: "approvals",
      action: { prompt: "Review the canonical concern" },
    }).decision;
    layer.mutations.updateDecision(source.id, { lifecycle: "dismissed", outcome: "Old cobalt result", resolutionReason: "Verified reason" });
    const current = layer.mutations.updateDecision(source.id, { lifecycle: "active", newEpisode: true, episodeReason: "Reconsider" });
    const retained = layer.transitionStore.list(source.id)[0];
    for (let index = 0; index < 105; index++) {
      vi.setSystemTime(Date.now() + 1000);
      layer.mutations.updateDecision(source.id, { body: `Current evidence ${index}` });
    }
    const filters = {
      query: "cobalt result", objectId: source.id, objectType: "decision", taskId: task.id,
      originalTaskId: task.id, lifecycle: "dismissed", sourceFamily: "approvals", activationId: source.activationId,
      limit: 1, offset: 0,
    };
    const before = writes();
    const response = await request(app).get("/api/focus/history").query(filters);
    expect(response.status).toBe(200);
    const result = await tool("focus_history_list", filters);
    for (const page of [response.body, result]) {
      expect(page).toMatchObject({
        total: 1, nextOffset: null, objects: [{
          id: source.id, object: { activationId: current.activationId, launchPrompt: { prompt: "Review the canonical concern" } },
          matchSource: "previous_episode",
          matchedEpisode: { activationId: source.activationId, lifecycle: "dismissed", outcome: "Old cobalt result" },
          matchedTransition: { id: retained.id },
        }],
      });
      expect(page.objects[0].transitions).toHaveLength(100);
      expect(page.objects[0].transitions.some((transition: { id: string }) => transition.id === retained.id)).toBe(false);
      expect(page.objects[0].object).not.toHaveProperty("action");
      expect(page.objects[0].object).not.toHaveProperty("kind");
      expect(page.objects[0].matchedEpisode).toEqual(retained.details.previousEpisode);
    }
    expect(writes()).toBe(before);
  });

  it("paginates suppressed concerns separately and applies all current-state filters without mutating attention", async () => {
    const { layer, taskStore, app, tool } = state;
    const task = taskStore.createTask("Quiet original task");
    const decisions = Array.from({ length: 5 }, (_, index) => layer.mutations.saveDecision({
      ...decisionDetails, title: `Suppressed option ${index}`, taskId: task.id, sourceFamily: "quiet-approvals",
      action: { prompt: `Discuss option ${index}` },
    }).decision);
    layer.mutations.saveAlert({ ...alertDetails(), title: "Still direct attention", taskId: task.id });
    taskStore.updateTask(task.id, { muted: true });
    const filters = {
      objectType: "decision", query: "Suppressed option", taskId: task.id, originalTaskId: task.id,
      lifecycle: "active", sourceFamily: "quiet-approvals", limit: 2, offset: 2,
    };
    const before = writes();
    const response = await request(app).get("/api/focus/quiet-concerns").query(filters);
    expect(response.status).toBe(200);
    const result = await tool("focus_quiet_concerns_list", filters);
    for (const page of [response.body, result]) {
      expect(page).toMatchObject({ total: 5, nextOffset: 4 });
      expect(page.objects).toHaveLength(2);
      expect(page.objects.every((object: { id: string }) => decisions.some((decision) => decision.id === object.id))).toBe(true);
      for (const object of page.objects) {
        expect(object).toMatchObject({ attentionVisible: false, taskState: "muted", suppressionReason: "muted", launchPrompt: { prompt: expect.any(String) } });
        expect(object).not.toHaveProperty("action");
        expect(object).not.toHaveProperty("kind");
      }
    }
    expect((await request(app).get("/api/focus/quiet-concerns").query({ objectType: "alert" })).body.total).toBe(0);
    expect((await request(app).get("/api/focus/history").query({ taskId: task.id, objectType: "decision" })).body.total).toBe(5);
    expect(writes()).toBe(before);
  });

  it("serves a pushed activation after resolution, reactivation and deletion without invoking writes", async () => {
    const { layer, app, tool, bus } = state;
    const source = layer.mutations.saveAlert({
      ...alertDetails(), title: "Pushed outage", sessionId: "discussion-session", action: { prompt: "Inspect the outage" },
    }).alert;
    layer.mutations.updateAlert(source.id, { lifecycle: "resolved", outcome: "Outage resolved and verified" });
    const current = layer.mutations.updateAlert(source.id, {
      lifecycle: "active", newEpisode: true, episodeReason: "New outage", title: "Different outage",
    });
    const expected = {
      objectId: source.id, activationId: source.activationId, isCurrentEpisode: false, deleted: false,
      historyIncomplete: false, currentObject: { activationId: current.activationId, launchPrompt: { prompt: "Inspect the outage" } },
      previousEpisode: { activationId: source.activationId, lifecycle: "resolved", outcome: "Outage resolved and verified" },
    };
    const emit = vi.spyOn(bus, "emit");
    const before = writes();
    const url = `/api/focus/objects/${encodeURIComponent(source.id)}/episodes/${encodeURIComponent(source.activationId)}`;
    const response = await request(app).get(url).query({ limit: 1 });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject(expected);
    expect(response.body.transitions).toHaveLength(1);
    expect(response.body.transitions[0].activationId).toBe(current.activationId);
    expect(response.body.nextOffset).toBe(1);
    expect(await tool("focus_episode_get", { objectId: source.id, activationId: source.activationId })).toMatchObject(expected);
    expect(writes()).toBe(before);
    expect(emit).not.toHaveBeenCalled();

    layer.mutations.deleteById(source.id);
    const afterDelete = writes();
    expect((await request(app).get(url)).body).toMatchObject({ ...expected, currentObject: null, deleted: true });
    expect(writes()).toBe(afterDelete);
  });

  it("returns incomplete legacy history unchanged and validates episode identity", async () => {
    const { layer, app, tool } = state;
    const objectId = "old object/with spaces";
    const activationId = "episode / one&two";
    const legacy = layer.transitionStore.append({
      objectId, activationId, objectType: "alert", title: "Old alert", fromLifecycle: "active",
      toLifecycle: "resolved", reason: "legacy-state", actor: "legacy", details: { extension: "unchanged" },
    });
    const url = `/api/focus/objects/${encodeURIComponent(objectId)}/episodes/${encodeURIComponent(activationId)}`;
    const before = writes();
    const response = await request(app).get(url);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      objectId, activationId, currentObject: null, previousEpisode: null, historyIncomplete: true, transitions: [legacy],
    });
    expect((await request(app).get(`/api/focus/objects/${encodeURIComponent(objectId)}/episodes/unknown`)).status).toBe(404);
    expect(await tool("focus_episode_get", { objectId, activationId: "unknown" })).toMatchObject({ error: expect.stringContaining("not found") });
    expect((await request(app).get(url).query({ limit: 101 })).status).toBe(400);
    expect(writes()).toBe(before);
  });

  it.each([
    { query: "x".repeat(501) }, { query: ["one", "two"] }, { taskId: ["one", "two"] },
    { originalTaskId: ["one", "two"] }, { sourceFamily: ["one", "two"] },
    { lifecycle: "done" }, { activationId: ["one", "two"] }, { limit: 101 }, { offset: -1 },
  ])("rejects invalid filters in routes and tools: %j", async (filters) => {
    for (const path of ["/api/focus/history", "/api/focus/quiet-concerns"]) {
      expect((await request(state.app).get(path).query(filters)).status).toBe(400);
    }
    for (const name of ["focus_history_list", "focus_quiet_concerns_list"]) {
      const result = await state.tool(name, filters);
      expect(result.success).not.toBe(true);
      expect(result.error ?? (result.resultType === "failure" ? result.textResultForLlm : undefined)).toEqual(expect.any(String));
    }
  });

  it("rejects Event quiet-inventory filters instead of conflating Events with suppressed concerns", async () => {
    expect((await request(state.app).get("/api/focus/quiet-concerns").query({ objectType: "event" })).status).toBe(400);
    expect(await state.tool("focus_quiet_concerns_list", { objectType: "event" })).toMatchObject({ resultType: "failure" });
  });
});
