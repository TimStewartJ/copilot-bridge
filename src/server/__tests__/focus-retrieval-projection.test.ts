import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createChecklistStore } from "../checklist-store.js";
import type { DatabaseSync } from "../db.js";
import { createFocusDataLayer } from "../focus-data-layer.js";
import { createFocusProjectionService, type FocusConcernListOptions, type FocusHistoryOptions } from "../focus-dashboard-projection.js";
import { createTaskStore } from "../task-store.js";
import { createTestBus, setupTestDb } from "./helpers.js";
import { alertDetails, decisionDetails, eventDetails } from "./focus-test-fixtures.js";

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
  return { ...layer, projection, taskStore, checklistStore, bus };
}

function advance(ms = 1000) {
  vi.setSystemTime(Date.now() + ms);
}

function writes() {
  return db.prepare("SELECT total_changes() AS count").get()?.count;
}

describe("overdue handoff and quiet concern inventories", () => {
  it.each(["decision", "alert"] as const)("keeps a completed-Action %s unresolved before and after its handoff becomes due", (objectType) => {
    const layer = setup();
    layer.coverageStore.save({
      title: "Verified monitoring", sourceFamily: "monitor", producer: "watchdog", scope: "Service health",
      explicitState: "valid", lastCheckedAt: new Date(NOW - 1000).toISOString(),
      validUntil: new Date(NOW + 86_400_000).toISOString(), evidence: ["Monitor checked successfully"],
    });
    const deadline = new Date(NOW + 60_000).toISOString();
    const source = objectType === "decision"
      ? layer.mutations.saveDecision({
        ...decisionDetails, title: "Review deployment", interventionBy: deadline, consequenceOfDelay: "Deployment remains blocked",
      }).decision
      : layer.mutations.saveAlert({ ...alertDetails(), title: "Review outage", interventionBy: deadline }).alert;
    const handoff = layer.mutations.promoteToAction(source.id, layer.checklistStore, { taskId: null });
    layer.checklistStore.updateChecklistItem(handoff.action.id, { done: true });

    const healthy = layer.projection.getSnapshot();
    expect(healthy).toMatchObject({
      allClear: false, attentionTotal: 0, alertTotal: 0, decisionTotal: 0, actionTotal: 0,
      handedOffTotal: 1, unresolvedHandoffTotal: 1, overdueHandoffTotal: 0, overdueHandoffs: [], quietConcernTotal: 0,
      coverage: { summary: { counts: { valid: 1 } } },
    });
    vi.setSystemTime(Date.parse(deadline));
    const due = layer.projection.getSnapshot();
    expect(due).toMatchObject({
      allClear: false, attentionTotal: 0, unresolvedHandoffTotal: 1, overdueHandoffTotal: 1,
      overdueHandoffs: [{
        objectId: source.id, objectType, activationId: source.activationId, lifecycle: "handed_off",
        interventionBy: deadline, taskId: null, taskState: "global", originalTaskId: null, attentionVisible: true,
      }],
    });
    expect(layer.mutations.getAny(source.id)?.lifecycle).toBe("handed_off");
    expect(layer.checklistStore.getChecklistItem(handoff.action.id)?.done).toBe(true);
  });

  it("keeps overdue exceptions and quiet inventory disjoint while preserving conservative Alert visibility and provenance", () => {
    const layer = setup();
    const quietIds: string[] = [];
    const dueIds: string[] = [];
    for (const state of ["muted", "archived", "orphaned"] as const) {
      const task = layer.taskStore.createTask(`${state} source`);
      for (const lifecycle of ["active", "acknowledged", "handed_off"] as const) {
        const decision = layer.mutations.saveDecision({
          ...decisionDetails, title: `${state} ${lifecycle} decision`, taskId: task.id, lifecycle,
        }).decision;
        quietIds.push(decision.id);
        const alert = layer.mutations.saveAlert({
          ...alertDetails(), title: `${state} ${lifecycle} alert`, taskId: task.id, lifecycle,
        }).alert;
        if (lifecycle === "handed_off") quietIds.push(alert.id);
      }
      const dueDecision = layer.mutations.saveDecision({
        ...decisionDetails, title: `${state} overdue decision`, taskId: task.id, lifecycle: "handed_off",
        interventionBy: new Date(NOW).toISOString(), consequenceOfDelay: "Review required",
      }).decision;
      const dueAlert = layer.mutations.saveAlert({
        ...alertDetails(), title: `${state} overdue alert`, taskId: task.id, lifecycle: "handed_off",
        interventionBy: new Date(NOW - 1).toISOString(),
      }).alert;
      dueIds.push(dueDecision.id, dueAlert.id);
      layer.mutations.saveEvent("note", {
        ...eventDetails(), key: `quiet:${state}`, title: "Separate Event digest", taskId: task.id,
      });
      if (state === "orphaned") layer.taskStore.deleteTask(task.id);
      else layer.taskStore.updateTask(task.id, state === "muted" ? { muted: true } : { status: "archived" });
      const summaries = layer.projection.getSnapshot().overdueHandoffs.filter((entry) => dueIds.includes(entry.objectId));
      expect(summaries.find((entry) => entry.objectId === dueDecision.id)).toMatchObject({
        taskId: state === "orphaned" ? null : task.id, originalTaskId: task.id,
        taskTitle: `${state} source`, originalTaskTitle: `${state} source`, taskState: state,
        orphanedAt: state === "orphaned" ? expect.any(String) : null,
      });
    }
    const visible = layer.taskStore.createTask("Visible");
    for (const taskId of [null, visible.id]) {
      layer.mutations.saveDecision({ ...decisionDetails, title: "Healthy handoff", taskId, lifecycle: "handed_off" });
      layer.mutations.saveAlert({ ...alertDetails(), title: "Healthy alert handoff", taskId, lifecycle: "handed_off" });
    }
    const snapshot = layer.projection.getSnapshot();
    expect(snapshot).toMatchObject({ decisionTotal: 0, alertTotal: 6, overdueHandoffTotal: 6, quietConcernTotal: 12 });
    expect(snapshot.quietDigests).toHaveLength(3);
    expect(snapshot.overdueHandoffs.map((entry) => entry.objectId).sort()).toEqual(dueIds.sort());
    expect(snapshot.quietConcerns.map((entry) => entry.objectId).sort()).toEqual(quietIds.sort());
    const quiet = layer.projection.listQuietConcerns({ limit: 100 });
    expect(quiet.objects.every((object) => !object.attentionVisible && object.suppressionReason === object.taskState)).toBe(true);
    expect(quiet.objects.filter((object) => object.objectType === "alert").every((object) => object.lifecycle === "handed_off")).toBe(true);
    expect(quiet.objects.some((object) => dueIds.includes(object.id))).toBe(false);
  });

  it("counts all overdue handoffs rather than the bounded displayed page", () => {
    const layer = setup();
    for (let index = 0; index < 107; index++) {
      layer.mutations.saveDecision({
        ...decisionDetails, title: `Due handoff ${index}`, lifecycle: "handed_off",
        interventionBy: new Date(NOW - index).toISOString(), consequenceOfDelay: "Review required",
      });
    }
    const snapshot = layer.projection.getSnapshot();
    expect(snapshot).toMatchObject({ overdueHandoffTotal: 107, decisionTotal: 0, allClear: false, quietConcernTotal: 0 });
    expect(snapshot.overdueHandoffs).toHaveLength(100);
    expect(snapshot.overdueHandoffs[0].title).toBe("Due handoff 106");
  });

  it("retrieves an old muted Decision by task and literal title beyond multiple quiet/History pages", () => {
    const layer = setup();
    const task = layer.taskStore.createTask("Suppressed approvals");
    layer.taskStore.updateTask(task.id, { muted: true });
    const target = layer.mutations.saveDecision({
      ...decisionDetails, title: "Review O'Brien's %_ exception", taskId: task.id, sourceFamily: "approvals",
    }).decision;
    for (let index = 0; index < 125; index++) {
      advance();
      layer.mutations.saveDecision({ ...decisionDetails, title: `New approval ${index}`, taskId: task.id, sourceFamily: "approvals" });
    }
    const seen: string[] = [];
    const offsets: Array<number | null> = [];
    let offset: number | null = 0;
    do {
      const page = layer.projection.listQuietConcerns({ taskId: task.id, limit: 40, offset });
      seen.push(...page.objects.map((object) => object.id));
      offsets.push(page.nextOffset);
      offset = page.nextOffset;
    } while (offset !== null);
    expect(offsets).toEqual([40, 80, 120, null]);
    expect(new Set(seen).size).toBe(126);
    expect(seen.at(-1)).toBe(target.id);
    const filters = { query: "O'Brien's %_", taskId: task.id, lifecycle: "active" as const, sourceFamily: "approvals", limit: 1 };
    const quiet = layer.projection.listQuietConcerns(filters);
    const history = layer.projection.listHistory(filters);
    expect(quiet).toMatchObject({ total: 1, nextOffset: null, objects: [{ id: target.id, attentionVisible: false }] });
    expect(history).toMatchObject({ total: 1, nextOffset: null, objects: [{ id: target.id, matchSource: "current" }] });
    expect(layer.projection.listQuietConcerns({ query: "%' OR 1=1 --" }).total).toBe(0);
    expect(layer.projection.listHistory({ query: "Suppressed approvals" }).total).toBe(126);
    const snapshot = layer.projection.getSnapshot();
    expect(snapshot.quietConcernTotal).toBe(126);
    expect(snapshot.quietConcerns).toHaveLength(100);
    expect(snapshot.decisionTotal).toBe(0);
  });

  it("filters orphaned quiet concerns by original task, not silently as globally scoped work", () => {
    const layer = setup();
    const task = layer.taskStore.createTask("Retired origin");
    const source = layer.mutations.saveDecision({
      ...decisionDetails, title: "Retained choice", taskId: task.id, lifecycle: "acknowledged", sourceFamily: "retirement",
    }).decision;
    layer.taskStore.deleteTask(task.id);
    const filters = { originalTaskId: task.id, sourceFamily: "retirement", lifecycle: "acknowledged" as const, query: "Retired origin" };
    expect(layer.projection.listQuietConcerns(filters)).toMatchObject({
      total: 1, objects: [{ id: source.id, taskId: null, taskState: "orphaned", suppressionReason: "orphaned" }],
    });
    expect(layer.projection.listQuietConcerns({ ...filters, taskId: task.id }).total).toBe(0);
    expect(layer.projection.listQuietConcerns({ ...filters, originalTaskId: "another-task" }).total).toBe(0);
  });

  it("reports an unknown overdue count conservatively instead of asserting all-clear", () => {
    const layer = setup();
    vi.spyOn(layer.decisionStore, "assertHealthy").mockImplementation(() => { throw new Error("Unreadable domain"); });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(layer.projection.getSnapshot()).toMatchObject({
      unresolvedHandoffTotal: null, unresolvedHandoffs: [], overdueHandoffTotal: null, overdueHandoffs: [], allClear: false,
      domainHealth: { unresolvedHandoffs: { status: "error" }, overdueHandoffs: { status: "error" }, quietConcerns: { status: "error" } },
    });
  });
});

describe("filtered retained History and exact episode reads", () => {
  it("returns the actual dismissed result beyond 100 newer transitions with filters on the same prior state", () => {
    const layer = setup();
    const originalTask = layer.taskStore.createTask("Original approval task");
    const currentTask = layer.taskStore.createTask("Current approval task");
    const source = layer.mutations.saveDecision({
      ...decisionDetails, title: "Old approval question", body: "Retained explanation", taskId: originalTask.id, sourceFamily: "old-approvals",
    }).decision;
    advance();
    const closed = layer.mutations.updateDecision(source.id, {
      lifecycle: "dismissed", outcome: "Blue-raven verification completed", resolutionReason: "Owner declined the old request",
    });
    advance();
    const reopened = layer.mutations.updateDecision(source.id, {
      lifecycle: "active", newEpisode: true, episodeReason: "Different request", title: "Current question",
      body: "Current explanation", taskId: currentTask.id, sourceFamily: "current-approvals",
    });
    const retainedTransition = layer.transitionStore.list(source.id)[0];
    for (let index = 0; index < 105; index++) {
      advance();
      layer.mutations.updateDecision(source.id, { body: `Current update ${index}` });
    }
    const before = writes();
    const filters: FocusHistoryOptions = {
      query: "blue-RAVEN", taskId: originalTask.id, originalTaskId: originalTask.id,
      lifecycle: "dismissed", sourceFamily: "old-approvals", activationId: source.activationId,
      objectType: "decision", limit: 1,
    };
    const result = layer.projection.listHistory(filters);
    expect(result).toMatchObject({ total: 1, nextOffset: null });
    const entry = result.objects[0];
    expect(entry).toMatchObject({
      id: source.id, matchSource: "previous_episode",
      object: { activationId: reopened.activationId, lifecycle: "active", details: { outcome: null } },
      matchedEpisode: {
        ...closed.details, activationId: source.activationId, title: closed.title, body: closed.body,
        taskId: originalTask.id, taskTitle: originalTask.title,
      },
      matchedTransition: { id: retainedTransition.id, activationId: reopened.activationId, reason: "new-episode" },
    });
    expect(entry.matchedEpisode).toEqual(retainedTransition.details.previousEpisode);
    expect(entry.transitions).toHaveLength(100);
    expect(entry.transitionTotal).toBe(108);
    expect(entry.transitions.some((transition) => transition.id === retainedTransition.id)).toBe(false);
    expect(layer.projection.listHistory({ ...filters, taskId: currentTask.id }).total).toBe(0);
    expect(layer.projection.listHistory({ ...filters, originalTaskId: currentTask.id }).total).toBe(0);
    expect(layer.projection.listHistory({ ...filters, lifecycle: "active" }).total).toBe(0);
    expect(layer.projection.listHistory({ ...filters, sourceFamily: "current-approvals" }).total).toBe(0);
    expect(layer.projection.listHistory({ ...filters, query: "Original approval task" }).total).toBe(1);
    expect(layer.projection.listHistory({ ...filters, query: "Owner declined" }).total).toBe(1);
    expect(writes()).toBe(before);
  });

  it("finds prior Decision types after reclassification without relabeling today's Event", () => {
    const layer = setup();
    const decision = layer.mutations.saveDecision({ ...decisionDetails, title: "Prior decision" }).decision;
    layer.mutations.updateDecision(decision.id, { lifecycle: "resolved", outcome: "Verified prior decision result" });
    layer.feedStore.updateCardById(decision.id, { kind: "note", title: "Current Event" });
    const history = layer.projection.listHistory({ objectType: "decision", query: "Verified prior", lifecycle: "resolved" });
    expect(history).toMatchObject({
      total: 1, objects: [{
        objectType: "event", object: { objectType: "event" }, matchSource: "previous_episode",
        matchedEpisode: { objectType: "decision", activationId: decision.activationId, outcome: "Verified prior decision result" },
      }],
    });
  });

  it("reads old push episodes through reactivation and deletion without writes, including a transition owned by the next activation", () => {
    const layer = setup();
    const alert = layer.mutations.saveAlert({ ...alertDetails(), title: "Original outage" }).alert;
    const closed = layer.mutations.updateAlert(alert.id, { lifecycle: "resolved", outcome: "Service recovery verified" });
    expect(layer.projection.getEpisode(alert.id, alert.activationId)).toMatchObject({
      isCurrentEpisode: true, historyIncomplete: false,
      currentObject: { lifecycle: "resolved", details: { outcome: "Service recovery verified" } },
    });
    advance();
    const reopened = layer.mutations.updateAlert(alert.id, {
      lifecycle: "active", newEpisode: true, episodeReason: "A different outage", title: "Current outage",
    });
    const before = writes();
    const old = layer.projection.getEpisode(alert.id, alert.activationId, { limit: 1 });
    expect(old).toMatchObject({
      objectId: alert.id, activationId: alert.activationId, isCurrentEpisode: false, historyIncomplete: false, deleted: false,
      currentObject: { activationId: reopened.activationId, title: "Current outage" },
      previousEpisode: { ...closed.details, activationId: alert.activationId, title: "Original outage" },
      transitionTotal: 3, nextOffset: 1,
      transitions: [{ activationId: reopened.activationId, reason: "new-episode" }],
    });
    expect(layer.projection.getEpisode(alert.id, reopened.activationId).isCurrentEpisode).toBe(true);
    expect(layer.projection.getEpisode(alert.id, alert.activationId, { offset: 100 }).previousEpisode).toEqual(old.previousEpisode);
    expect(writes()).toBe(before);

    layer.mutations.deleteById(alert.id);
    const deletedWrites = writes();
    expect(layer.projection.getEpisode(alert.id, alert.activationId)).toMatchObject({
      deleted: true, currentObject: null, previousEpisode: old.previousEpisode, historyIncomplete: false,
    });
    expect(layer.projection.getEpisode(alert.id, reopened.activationId)).toMatchObject({
      deleted: true, previousEpisode: { activationId: reopened.activationId, title: "Current outage", outcome: null },
    });
    expect(writes()).toBe(deletedWrites);
  });

  it("keeps transition-only older episodes readable without manufacturing a snapshot or resolution result", () => {
    const layer = setup();
    const legacy = layer.transitionStore.append({
      objectId: "deleted-legacy", objectType: "decision", activationId: "old-episode", title: "Old cleared concern",
      fromLifecycle: "active", toLifecycle: "resolved", actor: "legacy", reason: "legacy-resolution",
      details: { extension: "Only this older record survives" },
    });
    const before = writes();
    expect(layer.projection.getEpisode(legacy.objectId, legacy.activationId)).toEqual({
      objectId: legacy.objectId, activationId: legacy.activationId, currentObject: null, isCurrentEpisode: false,
      previousEpisode: null, transitions: [legacy], transitionTotal: 1, nextOffset: null,
      deleted: true, quarantined: false, historyIncomplete: true,
    });
    const history = layer.projection.listHistory({ query: "legacy-resolution", activationId: legacy.activationId });
    expect(history.objects[0]).toMatchObject({
      matchSource: "transition", matchedTransition: legacy, matchedEpisode: null, object: null, deleted: true,
    });
    expect(() => layer.projection.getEpisode(legacy.objectId, "unknown-episode")).toThrow("not found");
    expect(writes()).toBe(before);
  });

  it.each([
    { query: "x".repeat(501) }, { query: "" }, { taskId: [] }, { originalTaskId: false },
    { sourceFamily: 3 }, { lifecycle: "done" }, { activationId: {} }, { limit: 101 }, { offset: -1 },
  ])("rejects malformed or unbounded filters: %j", (options) => {
    const layer = setup();
    expect(() => layer.projection.listHistory(options as FocusHistoryOptions)).toThrow();
    expect(() => layer.projection.listQuietConcerns(options as FocusConcernListOptions)).toThrow();
  });
});
