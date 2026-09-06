import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "../db.js";
import { createChecklistStore } from "../checklist-store.js";
import { createFocusDataLayer } from "../focus-data-layer.js";
import { focusFingerprint } from "../focus-details-store.js";
import { createTestBus, setupTestDb } from "./helpers.js";
import { decisionDetails } from "./focus-test-fixtures.js";

let db: DatabaseSync;
beforeEach(() => { db = setupTestDb(); });

function insertLegacy(id: string | null, key: string | null = null) {
  const at = new Date().toISOString();
  return Number(db.prepare(`INSERT INTO feed_cards
    (id, dedupeKey, title, kind, statusChangedAt, createdAt, updatedAt)
    VALUES (?, ?, 'Legacy observation', 'note', ?, ?, ?)`).run(id, key, at, at, at).lastInsertRowid);
}
function setup(reconcile = false) {
  const bus = createTestBus();
  const checklistStore = createChecklistStore(db, bus);
  return { checklistStore, ...createFocusDataLayer(db, bus, checklistStore, { reconcile }) };
}
function changes() { return db.prepare("SELECT total_changes() AS count").get()?.count; }

describe("legacy projection reconciliation watermarks", () => {
  it("backfills once, then skips rich hydration and all writes after reconstructing the data layer", () => {
    const count = 600;
    for (let index = 0; index < count; index++) insertLegacy(crypto.randomUUID(), `legacy:${index}`);
    const first = setup();
    expect(first.mutations.reconcileLegacyFeed()).toEqual({ imported: count, deleted: 0, quarantined: 0 });
    expect(first.mutations.getLastReconciliationStats()).toMatchObject({ scanned: count, hydrated: count, unchanged: 0 });
    const second = setup();
    const richRead = vi.spyOn(second.eventStore, "getIncludingQuarantined");
    const before = changes();
    expect(second.mutations.reconcileLegacyFeed()).toEqual({ imported: 0, deleted: 0, quarantined: 0 });
    expect(second.mutations.getLastReconciliationStats()).toMatchObject({ scanned: count, hydrated: 0, unchanged: count });
    expect(richRead).not.toHaveBeenCalled();
    expect(changes()).toBe(before);
    expect(db.prepare("SELECT COUNT(*) AS count FROM focus_transitions").get()?.count).toBe(count);
  });

  it("imports an old-binary content edit even when its timestamp did not change", () => {
    const ids = Array.from({ length: 30 }, () => crypto.randomUUID());
    for (const id of ids) insertLegacy(id);
    const layer = setup(true);
    const originalTimestamp = layer.eventStore.get(ids[0]!)!.updatedAt;
    db.prepare("UPDATE feed_cards SET title='Changed by the old binary' WHERE id=?").run(ids[0]!);
    expect(layer.mutations.reconcileLegacyFeed()).toEqual({ imported: 1, deleted: 0, quarantined: 0 });
    expect(layer.mutations.getLastReconciliationStats()).toMatchObject({ hydrated: 1, unchanged: 29 });
    expect(layer.eventStore.get(ids[0]!)).toMatchObject({ title: "Changed by the old binary", updatedAt: originalTimestamp });
    const before = changes();
    layer.mutations.reconcileLegacyFeed();
    expect(changes()).toBe(before);
  });

  it("watermarks unchanged quarantines by rowid and revalidates only repaired rows", () => {
    const repairedId = crypto.randomUUID();
    insertLegacy(null);
    insertLegacy("");
    insertLegacy(repairedId);
    db.prepare("UPDATE feed_cards SET linksJson='{}' WHERE id=?").run(repairedId);
    const layer = setup(true);
    expect(layer.reconciliation.quarantined).toBe(3);
    const issues = layer.reconciliationErrorStore.listErrors();
    const before = changes();
    expect(layer.mutations.reconcileLegacyFeed()).toEqual({ imported: 0, deleted: 0, quarantined: 3 });
    expect(layer.mutations.getLastReconciliationStats()).toMatchObject({ hydrated: 0, unchanged: 3 });
    expect(changes()).toBe(before);
    expect(layer.reconciliationErrorStore.listErrors()).toEqual(issues);
    db.prepare("UPDATE feed_cards SET linksJson='[]' WHERE id=?").run(repairedId);
    expect(layer.mutations.reconcileLegacyFeed()).toEqual({ imported: 1, deleted: 0, quarantined: 2 });
    expect(layer.mutations.getLastReconciliationStats()?.hydrated).toBe(1);
    expect(layer.eventStore.get(repairedId)?.title).toBe("Legacy observation");
  });

  it("preserves deleted-object history and permits replacement keys", () => {
    const oldId = crypto.randomUUID();
    insertLegacy(oldId, "replace:one");
    const layer = setup(true);
    db.prepare("DELETE FROM feed_cards WHERE id=?").run(oldId);
    const newId = crypto.randomUUID();
    insertLegacy(newId, "replace:one");
    expect(layer.mutations.reconcileLegacyFeed()).toEqual({ imported: 1, deleted: 1, quarantined: 0 });
    expect(layer.eventStore.getByKey("replace:one")?.id).toBe(newId);
    expect(layer.transitionStore.list(oldId).some((entry) => entry.reason === "legacy-deleted")).toBe(true);
  });

  it("prunes obsolete quarantine IDs before a malformed replacement reuses the same ID", () => {
    const id = crypto.randomUUID();
    const oldRowId = insertLegacy(id);
    insertLegacy(crypto.randomUUID());
    db.prepare("UPDATE feed_cards SET linksJson='{}' WHERE id=?").run(id);
    const layer = setup(true);
    expect(layer.reconciliationErrorStore.listErrors()[0]?.feedRowId).toBe(oldRowId);
    db.prepare("DELETE FROM feed_cards WHERE id=?").run(id);
    const newRowId = insertLegacy(id);
    expect(newRowId).not.toBe(oldRowId);
    db.prepare("UPDATE feed_cards SET linksJson='{}' WHERE id=?").run(id);
    expect(layer.mutations.reconcileLegacyFeed()).toEqual({ imported: 0, deleted: 0, quarantined: 1 });
    expect(layer.reconciliationErrorStore.listErrors()).toEqual([
      expect.objectContaining({ id, feedCardId: id, feedRowId: newRowId }),
    ]);
    const before = changes();
    layer.mutations.reconcileLegacyFeed();
    expect(changes()).toBe(before);
  });

  it("invalidates cached trust when canonical subtype data changes", () => {
    const id = crypto.randomUUID();
    insertLegacy(id);
    const layer = setup(true);
    db.prepare("UPDATE focus_events SET title='Canonical drift' WHERE id=?").run(id);
    layer.mutations.reconcileLegacyFeed();
    expect(layer.mutations.getLastReconciliationStats()?.hydrated).toBe(1);
    expect(layer.eventStore.get(id)?.title).toBe("Legacy observation");
  });

  it.each(["missing", "wrong-body", "wrong-table"] as const)("repairs %s invalidation triggers before trusting cached projections", (kind) => {
    const id = crypto.randomUUID();
    insertLegacy(id);
    const layer = setup(true);
    const trigger = "focus_projection_dirty_feed_cards_update";
    db.exec(`DROP TRIGGER ${trigger}`);
    if (kind !== "missing") {
      db.exec(`CREATE TRIGGER ${trigger} AFTER UPDATE ON ${kind === "wrong-table" ? "tasks" : "feed_cards"} BEGIN SELECT 1; END`);
    }
    db.prepare("UPDATE feed_cards SET title='Edited while invalidation was missing' WHERE id=?").run(id);
    layer.mutations.reconcileLegacyFeed();
    expect(layer.eventStore.get(id)?.title).toBe("Edited while invalidation was missing");
    expect(layer.mutations.getLastReconciliationStats()?.hydrated).toBe(1);
    const before = changes();
    layer.mutations.reconcileLegacyFeed();
    expect(layer.mutations.getLastReconciliationStats()?.hydrated).toBe(0);
    expect(changes()).toBe(before);
  });

  it("records the corrected projection after repairing legacy launch-as-done", () => {
    const layer = setup();
    const source = layer.mutations.saveDecision({ ...decisionDetails, title: "Discuss", action: { prompt: "Discuss" } }).decision;
    db.prepare("UPDATE feed_cards SET sessionId='old-client-session', status='done' WHERE id=?").run(source.id);
    layer.mutations.reconcileLegacyFeed();
    expect(layer.decisionStore.get(source.id)?.lifecycle).toBe("acknowledged");
    const row = db.prepare("SELECT rowid AS feedRowId, * FROM feed_cards WHERE id=?").get(source.id)!;
    expect(db.prepare("SELECT fingerprint FROM focus_legacy_projection_state WHERE feedRowId=?").get(row.feedRowId!)?.fingerprint)
      .toBe(focusFingerprint(row));
    const before = changes();
    layer.mutations.reconcileLegacyFeed();
    expect(changes()).toBe(before);
    expect(layer.mutations.getLastReconciliationStats()?.hydrated).toBe(0);
  });

  it("repairs missing legacy Action links without hydrating unchanged source objects", () => {
    const layer = setup();
    const source = layer.mutations.saveDecision({ ...decisionDetails, title: "Accepted work" }).decision;
    const action = layer.checklistStore.createChecklistItem(null, "Accepted legacy Action");
    db.prepare("INSERT INTO feed_card_checklist_promotions (feedCardId, checklistItemId, createdAt) VALUES (?, ?, ?)")
      .run(source.id, action.id, new Date().toISOString());
    const richRead = vi.spyOn(layer.decisionStore, "getIncludingQuarantined");
    layer.mutations.reconcileLegacyFeed();
    expect(richRead).not.toHaveBeenCalled();
    expect(layer.mutations.getLastReconciliationStats()?.hydrated).toBe(0);
    expect(layer.decisionStore.get(source.id)?.linkedActions[0]?.actionId).toBe(action.id);
    const before = changes();
    layer.mutations.reconcileLegacyFeed();
    expect(changes()).toBe(before);
  });
});
