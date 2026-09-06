import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "../db.js";
import type { StatusEvent } from "../global-bus.js";
import { createChecklistStore } from "../checklist-store.js";
import { createFocusDataLayer } from "../focus-data-layer.js";
import { createTestBus, setupTestDb } from "./helpers.js";
import { decisionDetails } from "./focus-test-fixtures.js";

let db: DatabaseSync;
beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-09-05T18:00:00.000Z"));
  db = setupTestDb();
});
afterEach(() => vi.useRealTimers());

describe("quiet observation refreshes", () => {
  it.each(["decision", "alert"] as const)("persists 50 %s validity refreshes without attention or history churn", (objectType) => {
    const bus = createTestBus();
    const layer = createFocusDataLayer(db, bus, createChecklistStore(db, bus));
    const input = {
      ...decisionDetails,
      title: "Unchanged concern", body: "Same verified condition", evidence: ["Original evidence"],
      impact: "Requests are affected", sourceFamily: "monitor", producer: "probe",
      observedAt: new Date().toISOString(), validUntil: new Date(Date.now() + 3_600_000).toISOString(),
      interventionBy: new Date(Date.now() + 3_600_000).toISOString(), consequenceOfDelay: "Requests remain affected",
    };
    const original = objectType === "decision" ? layer.mutations.saveDecision(input).decision : layer.mutations.saveAlert(input).alert;
    vi.setSystemTime(Date.now() + 1000);
    if (objectType === "decision") layer.mutations.saveDecision({ ...input, title: "Newer concern" });
    else layer.mutations.saveAlert({ ...input, title: "Newer concern" });
    const store = objectType === "decision" ? layer.decisionStore : layer.alertStore;
    const ordering = store.listAttentionPage().objects.map((object) => object.id);
    const projection = layer.feedStore.getCard(original.id);
    const events: StatusEvent[] = [];
    bus.subscribe((event) => events.push(event));
    let latestObservedAt = original.details.observedAt!;
    let latestValidUntil = original.details.validUntil!;
    for (let index = 0; index < 50; index++) {
      vi.setSystemTime(Date.now() + 1000);
      const observedAt = new Date().toISOString();
      const validUntil = new Date(Date.now() + 3_600_000).toISOString();
      const times = index % 3 === 0 ? { observedAt } : index % 3 === 1 ? { validUntil } : { observedAt, validUntil };
      const updates = { title: input.title, evidence: [...input.evidence], ...times };
      const refreshed = objectType === "decision"
        ? layer.mutations.updateDecision(original.id, updates)
        : layer.mutations.updateAlert(original.id, updates);
      latestObservedAt = times.observedAt ?? latestObservedAt;
      latestValidUntil = times.validUntil ?? latestValidUntil;
      expect(refreshed).toMatchObject({
        updatedAt: original.updatedAt, statusChangedAt: original.statusChangedAt, activationId: original.activationId,
        details: {
          observedAt: latestObservedAt, validUntil: latestValidUntil,
          lastMeaningfulChangeAt: original.details.lastMeaningfulChangeAt,
          contentFingerprint: original.details.contentFingerprint,
        },
      });
    }
    expect(store.listAttentionPage().objects.map((object) => object.id)).toEqual(ordering);
    expect(layer.feedStore.getCard(original.id)).toEqual(projection);
    expect(layer.transitionStore.list(original.id)).toHaveLength(1);
    expect(events).toHaveLength(50);
    for (const event of events) {
      expect(event).toMatchObject({ type: "focus:changed", reason: "observation-refresh", meaningful: false, focusObjectId: original.id });
      expect(event).not.toHaveProperty("transitionId");
    }
    const refreshes = layer.attentionStore.list({ objectId: original.id }).filter((event) => event.eventType === "observation_refresh");
    expect(refreshes).toHaveLength(50);
    for (const event of refreshes) {
      expect(Object.keys(event.details).sort()).toEqual(["observedAt", "validUntil"]);
      expect(JSON.stringify(event.details).length).toBeLessThan(150);
    }

    const changes = db.prepare("SELECT total_changes() AS count").get()?.count;
    layer.mutations.reconcileLegacyFeed();
    expect(db.prepare("SELECT total_changes() AS count").get()?.count).toBe(changes);
    expect(layer.mutations.getLastReconciliationStats()).toMatchObject({ hydrated: 0, unchanged: 2 });
    expect(store.get(original.id)?.details).toMatchObject({ observedAt: latestObservedAt, validUntil: latestValidUntil });

    const same = { observedAt: latestObservedAt, validUntil: latestValidUntil };
    if (objectType === "decision") layer.mutations.updateDecision(original.id, same);
    else layer.mutations.updateAlert(original.id, same);
    expect(events).toHaveLength(50);
    expect(layer.transitionStore.list(original.id)).toHaveLength(1);

    vi.setSystemTime(Date.now() + 1000);
    const meaningful = { ...same, evidence: ["New semantic evidence"] };
    const changed = objectType === "decision"
      ? layer.mutations.updateDecision(original.id, meaningful)
      : layer.mutations.updateAlert(original.id, meaningful);
    expect(changed.updatedAt).not.toBe(original.updatedAt);
    expect(layer.transitionStore.list(original.id)).toHaveLength(2);
    expect(layer.transitionStore.list(original.id)[0]?.details.previousEpisode).toMatchObject({
      observedAt: latestObservedAt, validUntil: latestValidUntil, evidence: input.evidence,
    });
    expect(events.at(-2)).toMatchObject({ type: "focus:changed", meaningful: true });
  });

  it("still rejects invalid validity updates without modifying observation state", () => {
    const bus = createTestBus();
    const layer = createFocusDataLayer(db, bus, createChecklistStore(db, bus));
    const source = layer.mutations.saveDecision({
      ...decisionDetails, title: "Validity", observedAt: new Date().toISOString(),
    }).decision;
    expect(() => layer.mutations.updateDecision(source.id, { validUntil: source.details.observedAt })).toThrow("validUntil");
    expect(layer.decisionStore.get(source.id)).toEqual(source);
    expect(layer.transitionStore.list(source.id)).toHaveLength(1);
  });

  it("refreshes unchanged observation data without treating repeated authorization fields as a new grant request", () => {
    const bus = createTestBus();
    const layer = createFocusDataLayer(db, bus, createChecklistStore(db, bus));
    const grant = layer.authorityStore.save({
      title: "Approved monitoring", sourceFamily: "monitor", producer: "probe", scope: "Service",
      validUntil: new Date(Date.now() + 3_600_000).toISOString(), allowImmediate: true, grantedBy: "user",
    });
    const input = {
      key: "monitor:unchanged", title: "Verified outage", evidence: ["Same evidence"], impact: "Service unavailable",
      sourceFamily: "monitor", producer: "probe", observedAt: new Date().toISOString(),
      interventionBy: new Date(Date.now() + 60_000).toISOString(),
      notificationMode: "immediate", authorizationGrantId: grant.id,
    };
    const original = layer.mutations.saveAlert(input).alert;
    layer.authorityStore.revoke(grant.id, "Notifications no longer authorized");
    vi.setSystemTime(Date.now() + 1000);
    const refreshed = layer.mutations.saveAlert({ ...input, observedAt: new Date().toISOString() }).alert;
    expect(refreshed.updatedAt).toBe(original.updatedAt);
    expect(refreshed.details.observedAt).not.toBe(original.details.observedAt);
    expect(layer.transitionStore.list(original.id)).toHaveLength(1);
    expect(layer.authorityStore.resolve({
      taskId: null, sourceFamily: "monitor", producer: "probe", authorizationGrantId: grant.id, immediate: true,
    })).toBeUndefined();
  });
});
