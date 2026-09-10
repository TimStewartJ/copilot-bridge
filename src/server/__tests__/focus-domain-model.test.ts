import { beforeEach, describe, expect, it } from "vitest";
import type { DatabaseSync } from "../db.js";
import { createChecklistStore } from "../checklist-store.js";
import { createFocusDataLayer } from "../focus-data-layer.js";
import { createFocusProjectionService } from "../focus-dashboard-projection.js";
import { createTaskStore } from "../task-store.js";
import { createTestBus, setupTestDb } from "./helpers.js";
import { alertDetails, decisionDetails, eventDetails } from "./focus-test-fixtures.js";

let db: DatabaseSync;

beforeEach(() => {
  db = setupTestDb();
});

function insertLegacyCard(overrides: Record<string, unknown> = {}): string {
  const id = String(overrides.id ?? crypto.randomUUID());
  const now = "2026-09-03T12:00:00.000Z";
  const value = (key: string, fallback: string | number | null): string | number | null => {
    const candidate = overrides[key];
    return typeof candidate === "string" || typeof candidate === "number" || candidate === null
      ? candidate
      : fallback;
  };
  db.prepare(`
    INSERT INTO feed_cards (
      id, dedupeKey, title, body, kind, priority, status, taskId, sessionId, url,
      linksJson, metadataJson, visualJson, actionJson, pinned,
      statusChangedAt, createdAt, updatedAt
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    value("dedupeKey", null),
    value("title", "Legacy item"),
    value("body", null),
    value("kind", "note"),
    value("priority", "normal"),
    value("status", "active"),
    value("taskId", null),
    value("sessionId", null),
    value("url", null),
    value("linksJson", "[]"),
    value("metadataJson", null),
    value("visualJson", null),
    value("actionJson", null),
    value("pinned", 0),
    value("statusChangedAt", now),
    value("createdAt", now),
    value("updatedAt", now),
  );
  return id;
}

function createLayer() {
  const bus = createTestBus();
  const checklistStore = createChecklistStore(db, bus);
  const layer = createFocusDataLayer(db, bus, checklistStore);
  const taskStore = createTaskStore(db, bus);
  const projection = createFocusProjectionService({
    db,
    taskStore,
    decisionStore: layer.decisionStore,
    alertStore: layer.alertStore,
    eventStore: layer.eventStore,
    compatibilityErrorCount: layer.reconciliationErrorStore.countErrors,
  });
  return { bus, checklistStore, taskStore, projection, ...layer };
}

describe("canonical Focus domain model", () => {
  it("migrates rich legacy rows into separate Decisions, Alerts, and Events without loss", () => {
    const visual = {
      artifactId: "11111111-1111-4111-8111-111111111111",
      kind: "mermaid",
      title: "Decision map",
      displayName: "decision.mmd",
      mimeType: "text/vnd.mermaid",
      size: 12,
      url: "/api/feed/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/visuals/11111111-1111-4111-8111-111111111111",
      downloadUrl: "/api/feed/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/visuals/11111111-1111-4111-8111-111111111111/download",
    };
    const decisionId = insertLegacyCard({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      dedupeKey: "decision:rich",
      title: "Choose migration",
      body: "**Review** the migration.",
      kind: "decision",
      priority: "high",
      url: "https://example.test/decision",
      linksJson: JSON.stringify([{ label: "Spec", url: "https://example.test/spec" }]),
      metadataJson: JSON.stringify({ source: "legacy" }),
      visualJson: JSON.stringify(visual),
      actionJson: JSON.stringify({ label: "Discuss", prompt: "Review the migration." }),
      pinned: 1,
    });
    const alertId = insertLegacyCard({
      dedupeKey: "alert:one",
      title: "Production alert",
      kind: "alert",
    });
    const eventId = insertLegacyCard({
      dedupeKey: "doc-check:offer",
      title: "Legacy todo remains an Event",
      kind: "todo",
    });

    const layer = createLayer();
    const decision = layer.decisionStore.get(decisionId);
    const alert = layer.alertStore.get(alertId);
    const event = layer.eventStore.get(eventId);

    expect(decision).toMatchObject({
      objectType: "decision",
      title: "Choose migration",
      body: "**Review** the migration.",
      priority: "high",
      url: "https://example.test/decision",
      links: [{ label: "Spec", url: "https://example.test/spec" }],
      metadata: { source: "legacy" },
      visual,
      action: { label: "Discuss", prompt: "Review the migration." },
      pinned: true,
    });
    expect(alert).toMatchObject({ objectType: "alert", title: "Production alert" });
    expect(event).toMatchObject({
      objectType: "event",
      category: "todo",
      title: "Legacy todo remains an Event",
    });
    expect(layer.reconciliation).toMatchObject({ imported: 3, quarantined: 0 });
  });

  it("makes canonical writes visible to legacy clients and atomically handles type changes", () => {
    const layer = createLayer();
    const saved = layer.mutations.saveDecision({
      ...decisionDetails,
      key: "decision:canonical",
      title: "Canonical decision",
      body: "Choose one.",
      action: { prompt: "Discuss the choice." },
    });

    expect(saved.decision).toMatchObject({
      objectType: "decision",
      dedupeKey: "decision:canonical",
      title: "Canonical decision",
    });
    expect(layer.feedStore.getCard(saved.decision.id)).toMatchObject({
      kind: "decision",
      title: "Canonical decision",
      action: { prompt: "Discuss the choice." },
    });

    const legacyProjection = layer.feedStore.updateCardById(saved.decision.id, {
      kind: "alert",
      title: "Reclassified alert",
    });
    expect(legacyProjection.kind).toBe("alert");
    expect(layer.decisionStore.get(saved.decision.id)).toBeUndefined();
    expect(layer.alertStore.get(saved.decision.id)).toMatchObject({
      objectType: "alert",
      title: "Reclassified alert",
    });
  });

  it("reconciles rollback-era updates, type changes, and deletions", () => {
    const layer = createLayer();
    const event = layer.mutations.saveEvent("note", {
      ...eventDetails(),
      key: "rollback:item",
      title: "Before rollback",
    }).event;

    db.prepare(`
      UPDATE feed_cards
      SET kind = 'decision', title = 'Changed by old binary', updatedAt = ?, statusChangedAt = ?
      WHERE id = ?
    `).run("2026-09-03T13:00:00.000Z", "2026-09-03T13:00:00.000Z", event.id);
    layer.mutations.reconcileLegacyFeed();

    expect(layer.eventStore.get(event.id)).toBeUndefined();
    expect(layer.decisionStore.get(event.id)).toMatchObject({
      title: "Changed by old binary",
      objectType: "decision",
    });

    db.prepare("DELETE FROM feed_cards WHERE id = ?").run(event.id);
    layer.mutations.reconcileLegacyFeed();
    expect(layer.decisionStore.get(event.id)).toBeUndefined();
  });

  it("imports a rollback replacement that reuses a key after the old row was deleted", () => {
    const layer = createLayer();
    const original = layer.mutations.saveDecision({
      ...decisionDetails,
      key: "rollback:reused-key",
      title: "Original object",
    }).decision;
    db.prepare("DELETE FROM feed_cards WHERE id = ?").run(original.id);
    const replacementId = insertLegacyCard({
      dedupeKey: "rollback:reused-key",
      title: "Replacement object",
      kind: "alert",
      updatedAt: "2026-09-03T14:00:00.000Z",
    });

    const result = layer.mutations.reconcileLegacyFeed();

    expect(result.quarantined).toBe(0);
    expect(layer.decisionStore.get(original.id)).toBeUndefined();
    expect(layer.alertStore.get(replacementId)).toMatchObject({
      title: "Replacement object",
      dedupeKey: "rollback:reused-key",
    });
  });

  it("quarantines malformed compatibility rows until repaired", () => {
    const id = insertLegacyCard({
      dedupeKey: "broken:visual",
      visualJson: JSON.stringify({ kind: "image" }),
    });
    const layer = createLayer();

    expect(layer.reconciliation.quarantined).toBe(1);
    expect(layer.eventStore.get(id)).toBeUndefined();
    expect(layer.reconciliationErrorStore.listErrors()).toEqual([
      expect.objectContaining({ feedCardId: id, error: expect.stringContaining("visual") }),
    ]);

    db.prepare("UPDATE feed_cards SET visualJson = NULL WHERE id = ?").run(id);
    const repaired = layer.mutations.retryQuarantined(id);
    expect(repaired).toMatchObject({ id, objectType: "event" });
    expect(layer.reconciliationErrorStore.countErrors()).toBe(0);
    expect(layer.eventStore.get(id)).toMatchObject({ id });
  });

  it("quarantines and can delete a malformed legacy row without a usable ID", () => {
    const now = "2026-09-03T12:00:00.000Z";
    db.prepare(`
      INSERT INTO feed_cards (
        id, dedupeKey, title, body, kind, priority, status, taskId, sessionId, url,
        linksJson, metadataJson, visualJson, actionJson, pinned,
        statusChangedAt, createdAt, updatedAt
      )
      VALUES (NULL, NULL, 'Missing id', NULL, 'note', 'normal', 'active', NULL, NULL, NULL,
        '[]', NULL, NULL, NULL, 0, ?, ?, ?)
    `).run(now, now, now);

    const layer = createLayer();
    const issue = layer.reconciliationErrorStore.listErrors()[0];
    expect(issue).toMatchObject({
      id: expect.stringMatching(/^rowid:/),
      feedCardId: null,
      error: "Stored feed card id is invalid",
    });
    expect(layer.mutations.deleteQuarantined(issue.id)).toBe(true);
    expect(layer.reconciliationErrorStore.countErrors()).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS count FROM feed_cards").get()).toEqual({ count: 0 });
  });

  it("serves Focus entirely from canonical stores after reconciliation", () => {
    insertLegacyCard({ kind: "decision", title: "Canonical after migration" });
    // This migration test needs a fresh digest item, not an aging date fixture.
    const now = new Date().toISOString();
    insertLegacyCard({
      kind: "note", dedupeKey: "source:event", title: "Event source",
      createdAt: now, updatedAt: now, statusChangedAt: now,
    });
    const layer = createLayer();

    db.exec("ALTER TABLE feed_cards RENAME TO unavailable_feed_cards");

    expect(layer.projection.getSnapshot()).toMatchObject({
      decisionTotal: 1,
      alertTotal: 0,
      digests: [expect.objectContaining({ family: "source", count: 1 })],
    });
    expect(layer.projection.listDecisions({ status: "active" }).objects[0]).toMatchObject({
      title: "Canonical after migration",
    });
  });

  it("keeps canonical and compatibility task references aligned after task deletion", () => {
    const layer = createLayer();
    const task = layer.taskStore.createTask("Canonical task");
    const decision = layer.mutations.saveDecision({
      ...decisionDetails,
      title: "Task-bound Decision",
      taskId: task.id,
    }).decision;
    const alert = layer.mutations.saveAlert({
      ...alertDetails(),
      title: "Task-bound Alert",
      taskId: task.id,
    }).alert;
    const event = layer.mutations.saveEvent("note", {
      ...eventDetails(),
      key: "task:bound-event",
      title: "Task-bound Event",
      taskId: task.id,
    }).event;

    layer.taskStore.deleteTask(task.id);

    expect(layer.decisionStore.get(decision.id)?.taskId).toBeNull();
    expect(layer.alertStore.get(alert.id)?.taskId).toBeNull();
    expect(layer.eventStore.get(event.id)?.taskId).toBeNull();
    expect(layer.feedStore.getCard(decision.id)?.taskId).toBeNull();
    expect(layer.feedStore.getCard(alert.id)?.taskId).toBeNull();
    expect(layer.feedStore.getCard(event.id)?.taskId).toBeNull();
  });

  it("tracks action promotion by first-class object activation while dual-writing rollback metadata", () => {
    const layer = createLayer();
    const decision = layer.mutations.saveDecision({
      ...decisionDetails,
      title: "Create canonical action",
    }).decision;

    const first = layer.mutations.promoteToAction(decision.id, layer.checklistStore, { taskId: null });
    const retry = layer.mutations.promoteToAction(decision.id, layer.checklistStore, { taskId: null });
    expect(first.created).toBe(true);
    expect(retry.created).toBe(false);
    expect(retry.action.id).toBe(first.action.id);
    expect(db.prepare("SELECT COUNT(*) AS count FROM focus_action_links").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT checklistItemId FROM feed_card_checklist_promotions WHERE feedCardId = ?")
      .get(decision.id)).toEqual({ checklistItemId: first.action.id });

    layer.checklistStore.updateChecklistItem(first.action.id, { done: true });
    layer.mutations.updateDecision(decision.id, { lifecycle: "active", newEpisode: true, episodeReason: "A new accepted work episode" });
    const nextCycle = layer.mutations.promoteToAction(decision.id, layer.checklistStore, { taskId: null });
    expect(nextCycle.created).toBe(true);
    expect(nextCycle.action.id).not.toBe(first.action.id);
    expect(db.prepare("SELECT COUNT(*) AS count FROM focus_action_links").get()).toEqual({ count: 2 });
    expect(db.prepare("SELECT checklistItemId FROM feed_card_checklist_promotions WHERE feedCardId = ?")
      .get(decision.id)).toEqual({ checklistItemId: nextCycle.action.id });
  });

  it("reuses unfinished rollback-era work after a fresh reactivation", () => {
    const layer = createLayer();
    const decision = layer.mutations.saveDecision({ ...decisionDetails, title: "Rollback reactivation" }).decision;
    const first = layer.mutations.promoteToAction(decision.id, layer.checklistStore, { taskId: null });
    layer.feedStore.updateCardById(decision.id, { status: "done" });
    const reactivatedAt = "2026-09-03T15:00:00.000Z";
    db.prepare(`
      UPDATE feed_cards
      SET status = 'active', statusChangedAt = ?, updatedAt = ?
      WHERE id = ?
    `).run(reactivatedAt, reactivatedAt, decision.id);

    layer.mutations.reconcileLegacyFeed();
    expect(db.prepare("SELECT * FROM feed_card_checklist_promotions WHERE feedCardId = ?")
      .get(decision.id)).toBeUndefined();

    const nextCycle = layer.mutations.promoteToAction(decision.id, layer.checklistStore, { taskId: null });
    expect(nextCycle.created).toBe(false);
    expect(nextCycle.action.id).toBe(first.action.id);
  });
});
