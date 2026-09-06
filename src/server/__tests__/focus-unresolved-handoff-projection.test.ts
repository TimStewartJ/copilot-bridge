import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChecklistStore } from "../checklist-store.js";
import type { DatabaseSync } from "../db.js";
import { createFocusDataLayer } from "../focus-data-layer.js";
import { createFocusProjectionService } from "../focus-dashboard-projection.js";
import { createTaskStore } from "../task-store.js";
import { createTestBus, setupTestDb } from "./helpers.js";
import { decisionDetails, eventDetails } from "./focus-test-fixtures.js";

const NOW = Date.parse("2026-09-05T18:00:00.000Z");
let db: DatabaseSync;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  db = setupTestDb();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  db.close();
});

function setup() {
  const bus = createTestBus();
  const checklistStore = createChecklistStore(db, bus);
  const taskStore = createTaskStore(db, bus);
  const layer = createFocusDataLayer(db, bus, checklistStore);
  const projection = createFocusProjectionService({
    db, taskStore, decisionStore: layer.decisionStore, alertStore: layer.alertStore, eventStore: layer.eventStore,
    compatibilityErrorCount: layer.reconciliationErrorStore.countErrors,
  });
  layer.coverageStore.save({
    title: "Verified monitoring", sourceFamily: "monitor", producer: "watchdog", scope: "Service health",
    explicitState: "valid", lastCheckedAt: new Date(NOW - 1000).toISOString(),
    validUntil: new Date(NOW + 86_400_000).toISOString(), evidence: ["Monitor checked successfully"],
  });
  expect(projection.getSnapshot().allClear).toBe(true);
  return { ...layer, projection, taskStore, checklistStore };
}

function noDeadlineConcern(layer: ReturnType<typeof setup>, objectType: "alert" | "decision", taskId: string) {
  return objectType === "alert"
    ? layer.alertStore.get(layer.feedStore.saveCard({
      kind: "alert", key: `monitor:${taskId}`, title: "Legacy outage review", taskId, sessionId: "review-session",
    }).card.id)!
    : layer.mutations.saveDecision({
      ...decisionDetails, title: "Deployment review", taskId, sourceFamily: "approvals", producer: "reviewer",
      sessionId: "review-session",
    }).decision;
}

describe("unresolved handed-off concerns", () => {
  it.each(["alert", "decision"] as const)(
    "does not declare all-clear after promoting and completing a no-deadline %s",
    (objectType) => {
      const layer = setup();
      const task = layer.taskStore.createTask("Deployment");
      const source = noDeadlineConcern(layer, objectType, task.id);
      expect(source.details.interventionBy).toBeNull();
      if (objectType === "alert") expect(source.details).toMatchObject({ producer: "legacy", evidence: [], impact: null });

      const handoff = layer.mutations.promoteToAction(source.id, layer.checklistStore);
      layer.checklistStore.updateChecklistItem(handoff.action.id, { done: true });
      const snapshot = layer.projection.getSnapshot();
      expect(snapshot).toMatchObject({
        allClear: false, alertTotal: 0, decisionTotal: 0, actionTotal: 0, attentionTotal: 0,
        handedOffTotal: 1, unresolvedHandoffTotal: 1, overdueHandoffTotal: 0, overdueHandoffs: [],
        quietConcernTotal: 0, quietConcerns: [], domainHealth: { unresolvedHandoffs: { status: "ok" } },
        coverage: { summary: { total: 1, counts: { valid: 1 } } },
      });
      expect(snapshot.unresolvedHandoffs).toEqual([{
        objectId: source.id, objectType, activationId: source.activationId, title: source.title,
        lifecycle: "handed_off", interventionBy: null,
        taskId: task.id, taskTitle: task.title, taskState: "active", originalTaskId: task.id,
        originalTaskTitle: task.title, orphanedAt: null,
        sourceFamily: objectType === "alert" ? "monitor" : "approvals",
        producer: objectType === "alert" ? "legacy" : "reviewer", sessionId: "review-session",
        updatedAt: expect.any(String),
      }]);
      expect(layer.projection.listAlerts().total).toBe(0);
      expect(layer.projection.listDecisions().total).toBe(0);
      expect(layer.mutations.getAny(source.id)?.lifecycle).toBe("handed_off");
      expect(layer.checklistStore.getChecklistItem(handoff.action.id)?.done).toBe(true);
      expect(layer.projection.getSnapshot().allClear).toBe(false);

      const resolution = { lifecycle: "resolved", outcome: "Owner verified the underlying concern is resolved" };
      if (objectType === "alert") layer.mutations.updateAlert(source.id, resolution);
      else layer.mutations.updateDecision(source.id, resolution);
      expect(layer.projection.getSnapshot()).toMatchObject({
        allClear: true, handedOffTotal: 0, unresolvedHandoffTotal: 0, unresolvedHandoffs: [],
      });
    },
  );

  it.each(["muted", "archived", "orphaned"] as const)(
    "retains unresolved %s handoffs and their task provenance without putting them in direct queues",
    (state) => {
      const layer = setup();
      const task = layer.taskStore.createTask(`${state} origin`);
      for (const objectType of ["alert", "decision"] as const) {
        const source = noDeadlineConcern(layer, objectType, task.id);
        const handoff = layer.mutations.promoteToAction(source.id, layer.checklistStore);
        layer.checklistStore.updateChecklistItem(handoff.action.id, { done: true });
      }
      if (state === "orphaned") layer.taskStore.deleteTask(task.id);
      else layer.taskStore.updateTask(task.id, state === "muted" ? { muted: true } : { status: "archived" });
      const snapshot = layer.projection.getSnapshot();
      expect(snapshot).toMatchObject({
        allClear: false, attentionTotal: 0, alertTotal: 0, decisionTotal: 0,
        unresolvedHandoffTotal: 2, handedOffTotal: 2, overdueHandoffTotal: 0, quietConcernTotal: 2,
      });
      expect(snapshot.unresolvedHandoffs).toHaveLength(2);
      for (const summary of snapshot.unresolvedHandoffs) {
        expect(summary).toMatchObject({
          lifecycle: "handed_off", interventionBy: null, taskState: state,
          taskId: state === "orphaned" ? null : task.id, taskTitle: task.title,
          originalTaskId: task.id, originalTaskTitle: task.title,
          orphanedAt: state === "orphaned" ? expect.any(String) : null,
        });
      }
    },
  );

  it("does not treat a handed-off Event as an unresolved Alert or Decision", () => {
    const layer = setup();
    const source = layer.mutations.saveEvent("note", {
      ...eventDetails(), key: "release:report", title: "Informational report",
    }).event;
    const handoff = layer.mutations.promoteToAction(source.id, layer.checklistStore, { taskId: null });
    layer.checklistStore.updateChecklistItem(handoff.action.id, { done: true });
    expect(layer.projection.getSnapshot()).toMatchObject({
      allClear: true, attentionTotal: 0, handedOffTotal: 1,
      unresolvedHandoffTotal: 0, unresolvedHandoffs: [], overdueHandoffTotal: 0,
    });
    expect(layer.eventStore.get(source.id)?.lifecycle).toBe("handed_off");
  });

  it("counts the entire unresolved inventory independently of its bounded samples", () => {
    const layer = setup();
    for (let index = 0; index < 107; index++) {
      vi.setSystemTime(NOW + index);
      layer.mutations.saveDecision({ ...decisionDetails, title: `Handoff ${index}`, lifecycle: "handed_off" });
    }
    const snapshot = layer.projection.getSnapshot();
    expect(snapshot).toMatchObject({
      allClear: false, attentionTotal: 0, handedOffTotal: 107, unresolvedHandoffTotal: 107, overdueHandoffTotal: 0,
    });
    expect(snapshot.unresolvedHandoffs).toHaveLength(100);
    expect(snapshot.unresolvedHandoffs[0].title).toBe("Handoff 106");
    expect(snapshot.unresolvedHandoffs.every((summary) => summary.interventionBy === null)).toBe(true);
  });
});
