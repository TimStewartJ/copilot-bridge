import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "../db.js";
import { createChecklistStore } from "../checklist-store.js";
import { createTaskStore } from "../task-store.js";
import { createFocusDataLayer } from "../focus-data-layer.js";
import { createFocusProjectionService } from "../focus-dashboard-projection.js";
import { serializeFocusHistoryPage } from "../focus-serialization.js";
import { createTestBus, setupTestDb } from "./helpers.js";
import { alertDetails, decisionDetails } from "./focus-test-fixtures.js";

let db: DatabaseSync;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-05T18:00:00.000Z"));
  db = setupTestDb();
});
afterEach(() => vi.useRealTimers());

function setup() {
  const bus = createTestBus();
  const checklistStore = createChecklistStore(db, bus);
  const layer = createFocusDataLayer(db, bus, checklistStore);
  const projection = createFocusProjectionService({
    db, taskStore: createTaskStore(db, bus),
    decisionStore: layer.decisionStore, alertStore: layer.alertStore, eventStore: layer.eventStore,
    compatibilityErrorCount: layer.reconciliationErrorStore.countErrors,
  });
  return { ...layer, projection, checklistStore };
}

function advance() {
  vi.setSystemTime(Date.now() + 1000);
}

describe("retained Focus episode history", () => {
  it.each(["resolved", "accepted_risk"] as const)("preserves the complete %s episode when reactivated", (lifecycle) => {
    const layer = setup();
    const source = layer.mutations.saveDecision({
      ...decisionDetails, title: "Choose a rollout", body: "Compare a staged release with waiting.",
      fallback: "Keep the current release", consequenceOfDelay: "Fixes remain unavailable",
    }).decision;
    advance();
    layer.mutations.linkLaunchedSession(source.id, "first-session");
    advance();
    const promoted = layer.mutations.promoteToAction(source.id, layer.checklistStore, { taskId: null });
    advance();
    layer.checklistStore.updateChecklistItem(promoted.action.id, { done: true });
    layer.mutations.linkLaunchedSession(source.id, "second-session");
    advance();
    const closed = layer.mutations.updateDecision(source.id, {
      lifecycle, outcome: "The staged release was verified", resolutionReason: "User confirmed the trade-off",
    });
    const previousTransitions = layer.transitionStore.list(source.id);
    advance();
    const reopened = layer.mutations.updateDecision(source.id, {
      lifecycle: "active", newEpisode: true, episodeReason: "A new release needs review",
      recommendation: "Re-evaluate the release", fallback: "Wait for a fresh review",
    });

    expect(reopened.activationId).not.toBe(closed.activationId);
    expect(reopened.details).toMatchObject({
      outcome: null, resolutionReason: null, resolvedAt: null, acknowledgedAt: null, handedOffAt: null,
      recommendation: "Re-evaluate the release", fallback: "Wait for a fresh review",
    });
    const history = serializeFocusHistoryPage(layer.projection.listHistory({ objectId: source.id }));
    const transition = history.objects[0]!.transitions.find((entry) => entry.reason === "new-episode");
    expect(transition).toMatchObject({ activationId: reopened.activationId, fromLifecycle: lifecycle, toLifecycle: "active" });
    expect(transition?.details.previousEpisode).toEqual({
      ...closed.details,
      schemaVersion: 1, objectType: "decision", title: closed.title, body: closed.body, category: null,
      activationId: closed.activationId, taskId: closed.taskId, taskTitle: closed.taskTitle, sessionId: closed.sessionId,
      sessionIds: ["first-session", "second-session"], linkedActionIds: [promoted.action.id],
      linkedActions: [{
        sourceId: source.id, sourceType: "decision", activationId: closed.activationId,
        actionId: promoted.action.id, createdAt: promoted.object.linkedActions[0]!.createdAt,
      }],
      createdAt: closed.createdAt, updatedAt: closed.updatedAt, statusChangedAt: closed.statusChangedAt,
    });
    const previousIds = new Set(previousTransitions.map((entry) => entry.id));
    expect(layer.transitionStore.list(source.id).filter((entry) => previousIds.has(entry.id))).toEqual(previousTransitions);

    const rows = db.prepare("SELECT * FROM focus_transitions ORDER BY rowid").all();
    layer.mutations.reconcileLegacyFeed();
    layer.mutations.reconcileLegacyFeed();
    expect(db.prepare("SELECT * FROM focus_transitions ORDER BY rowid").all()).toEqual(rows);
  });

  describe.each(["adapter", "reconciliation"] as const)("legacy %s mutations", (path) => {
    it("retains resolved results when legacy status reactivates the object", () => {
      const layer = setup();
      const source = layer.mutations.saveDecision({ ...decisionDetails, title: "Legacy reactivation" }).decision;
      const closed = layer.mutations.updateDecision(source.id, {
        lifecycle: "resolved", outcome: "Verified before rollback", resolutionReason: "Owner approved the result",
      });
      advance();
      if (path === "adapter") layer.feedStore.updateCardById(source.id, { status: "active" });
      else {
        db.prepare("UPDATE feed_cards SET status='active', updatedAt=? WHERE id=?")
          .run(new Date().toISOString(), source.id);
        layer.mutations.reconcileLegacyFeed();
      }
      const current = layer.decisionStore.get(source.id)!;
      expect(current.details).toMatchObject({ lifecycle: "active", outcome: null, resolutionReason: null, resolvedAt: null });
      expect(current.activationId).not.toBe(closed.activationId);
      expect(layer.transitionStore.list(source.id)[0]?.details.previousEpisode).toMatchObject({
        ...closed.details, activationId: closed.activationId,
      });
    });

    it.each(["decision", "alert"] as const)("retains prior %s details while clearing the current Event", (objectType) => {
      const layer = setup();
      const source = objectType === "decision"
        ? layer.mutations.saveDecision({ ...decisionDetails, title: "Review a change", fallback: "Keep current settings" }).decision
        : layer.mutations.saveAlert({ ...alertDetails(), title: "Service condition", consequenceOfDelay: "Requests will fail" }).alert;
      const promoted = layer.mutations.promoteToAction(source.id, layer.checklistStore, { taskId: null });
      const completion = { lifecycle: "resolved", outcome: "Verified result", resolutionReason: "Verified completion" };
      const closed = objectType === "decision"
        ? layer.mutations.updateDecision(source.id, completion)
        : layer.mutations.updateAlert(source.id, completion);
      advance();
      if (path === "adapter") layer.feedStore.updateCardById(source.id, { kind: "note", title: "Retained observation" });
      else {
        db.prepare("UPDATE feed_cards SET kind='note', title='Retained observation', updatedAt=? WHERE id=?")
          .run(new Date().toISOString(), source.id);
        layer.mutations.reconcileLegacyFeed();
      }

      const current = layer.eventStore.get(source.id)!;
      expect(current.details).toMatchObject({
        outcome: null, resolutionReason: null, alternatives: [], recommendation: null, fallback: null,
        evidence: [], impact: null, consequenceOfDelay: null,
      });
      const history = serializeFocusHistoryPage(layer.projection.listHistory({ objectId: source.id }));
      const transition = history.objects[0]!.transitions.find((entry) => entry.reason === "reclassified");
      expect(transition?.details.previousEpisode).toMatchObject({
        ...closed.details, objectType, title: closed.title, activationId: closed.activationId,
        linkedActionIds: [promoted.action.id],
      });
      expect(transition?.activationId).toBe(current.activationId);
      expect(transition?.activationId).not.toBe(closed.activationId);

      // Later snapshots must not relabel a retained link as an Event/new activation.
      advance();
      layer.feedStore.updateCardById(source.id, { body: "A later observation" });
      expect(layer.transitionStore.list(source.id)[0]?.details.previousEpisode?.linkedActions).toEqual([
        expect.objectContaining({ sourceType: objectType, activationId: closed.activationId, actionId: promoted.action.id }),
      ]);
    });
  });

  it("preserves superseded outcome and decision fields even within the same activation", () => {
    const layer = setup();
    const source = layer.mutations.saveDecision({ ...decisionDetails, title: "Choose", fallback: "Wait" }).decision;
    const closed = layer.mutations.updateDecision(source.id, {
      lifecycle: "resolved", outcome: "Initial result", resolutionReason: "Initial verification",
    });
    advance();
    const corrected = layer.mutations.updateDecision(source.id, {
      lifecycle: "resolved", outcome: "Corrected result", resolutionReason: "Follow-up verification",
      alternatives: ["Expand", "Stop"], recommendation: "Stop", fallback: null,
    });
    expect(corrected.activationId).toBe(closed.activationId);
    expect(layer.transitionStore.list(source.id)[0]?.details.previousEpisode).toMatchObject({
      ...closed.details, activationId: closed.activationId,
    });
  });

  it("retains a deleted second Action when promotion was a source no-op", () => {
    const layer = setup();
    const source = layer.mutations.saveDecision({ ...decisionDetails, title: "Accepted work" }).decision;
    const first = layer.mutations.promoteToAction(source.id, layer.checklistStore, { taskId: null });
    layer.checklistStore.updateChecklistItem(first.action.id, { done: true });
    const second = layer.mutations.promoteToAction(source.id, layer.checklistStore, { taskId: null });
    expect(second.created).toBe(true);
    expect(layer.transitionStore.list(source.id).some((entry) => entry.relatedActionId === second.action.id)).toBe(false);
    layer.checklistStore.deleteChecklistItem(second.action.id);
    layer.mutations.updateDecision(source.id, { lifecycle: "resolved", outcome: "Work complete", resolutionReason: "Verified" });
    advance();
    layer.mutations.updateDecision(source.id, { lifecycle: "active", newEpisode: true, episodeReason: "Another request" });
    expect(layer.transitionStore.list(source.id)[0]?.details.previousEpisode?.linkedActionIds)
      .toEqual([first.action.id, second.action.id].sort());
  });

  it("retains uncapped session references only from the prior activation", () => {
    const layer = setup();
    const source = layer.mutations.saveDecision({ ...decisionDetails, title: "Long-running choice" }).decision;
    const sessionIds = Array.from({ length: 105 }, (_, index) => `session-${index}`);
    for (const sessionId of [...sessionIds, "another-episode"]) {
      layer.transitionStore.append({
        objectId: source.id, objectType: "decision", title: source.title,
        activationId: sessionId === "another-episode" ? "another-activation" : source.activationId,
        fromLifecycle: "active", toLifecycle: "active", actor: "legacy", reason: "session-linked", sessionId,
      });
    }
    layer.mutations.updateDecision(source.id, { lifecycle: "resolved", outcome: "Chosen", resolutionReason: "Confirmed" });
    advance();
    layer.mutations.updateDecision(source.id, { lifecycle: "active", newEpisode: true, episodeReason: "New circumstances" });
    expect(layer.transitionStore.list(source.id)[0]?.details.previousEpisode?.sessionIds).toEqual(sessionIds.sort());
  });

  it("appends the prior result before clearing persistent details", () => {
    const layer = setup();
    const source = layer.mutations.saveDecision({ ...decisionDetails, title: "Durable result" }).decision;
    const closed = layer.mutations.updateDecision(source.id, { lifecycle: "resolved", outcome: "Verified", resolutionReason: "Confirmed" });
    db.exec(`CREATE TRIGGER require_episode_snapshot BEFORE UPDATE OF outcome ON focus_object_details
      WHEN OLD.outcome IS NOT NULL AND NEW.outcome IS NULL
      BEGIN
        SELECT CASE WHEN NOT EXISTS (
          SELECT 1 FROM focus_transitions WHERE objectId=OLD.objectId
            AND json_extract(detailsJson, '$.previousEpisode.activationId')='${closed.activationId}'
            AND json_extract(detailsJson, '$.previousEpisode.outcome')=OLD.outcome
            AND json_extract(detailsJson, '$.previousEpisode.resolutionReason')=OLD.resolutionReason
        ) THEN RAISE(ABORT, 'Prior episode snapshot missing before clear') END;
      END;`);
    expect(() => layer.mutations.updateDecision(source.id, {
      lifecycle: "active", newEpisode: true, episodeReason: "New request",
    })).not.toThrow();
  });

  it.each(["snapshot", "canonical"] as const)("rolls back both state and history when the %s write fails", (failure) => {
    const layer = setup();
    const source = layer.mutations.saveDecision({ ...decisionDetails, title: "Atomic result" }).decision;
    const closed = layer.mutations.updateDecision(source.id, { lifecycle: "resolved", outcome: "Verified", resolutionReason: "Confirmed" });
    const transitions = layer.transitionStore.list(source.id);
    const projection = layer.feedStore.getCard(source.id);
    if (failure === "snapshot") {
      db.exec(`CREATE TRIGGER fail_snapshot BEFORE INSERT ON focus_transitions
        WHEN NEW.reason='new-episode' BEGIN SELECT RAISE(ABORT, 'Snapshot write failed'); END;`);
    } else {
      db.exec(`CREATE TRIGGER fail_canonical BEFORE UPDATE ON focus_object_details
        BEGIN SELECT RAISE(ABORT, 'Canonical write failed'); END;`);
    }
    expect(() => layer.mutations.updateDecision(source.id, {
      lifecycle: "active", newEpisode: true, episodeReason: "New request",
    })).toThrow(failure === "snapshot" ? "Snapshot write failed" : "Canonical write failed");
    expect(layer.decisionStore.get(source.id)).toEqual(closed);
    expect(layer.transitionStore.list(source.id)).toEqual(transitions);
    expect(layer.feedStore.getCard(source.id)).toEqual(projection);
  });
});
