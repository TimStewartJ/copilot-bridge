import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DatabaseSync } from "../db.js";
import { createChecklistStore } from "../checklist-store.js";
import { createTaskStore } from "../task-store.js";
import { createFocusDataLayer } from "../focus-data-layer.js";
import { createFocusProjectionService } from "../focus-dashboard-projection.js";
import { backfillFocusDetails } from "../focus-schema.js";
import { createTestBus, setupTestDb } from "./helpers.js";
import { alertDetails, decisionDetails, eventDetails } from "./focus-test-fixtures.js";

const NOW = "2026-09-05T18:00:00.000Z";
let db: DatabaseSync;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
  db = setupTestDb();
});
afterEach(() => vi.useRealTimers());

function setup() {
  const bus = createTestBus();
  const checklistStore = createChecklistStore(db, bus);
  const taskStore = createTaskStore(db, bus);
  const layer = createFocusDataLayer(db, bus, checklistStore);
  const projection = createFocusProjectionService({
    db, taskStore, decisionStore: layer.decisionStore, alertStore: layer.alertStore, eventStore: layer.eventStore,
    compatibilityErrorCount: layer.reconciliationErrorStore.countErrors,
  });
  return { ...layer, bus, checklistStore, taskStore, projection };
}
function count(table: string) {
  const allowed = ["focus_transitions", "focus_object_details", "focus_action_links", "checklist_items"];
  if (!allowed.includes(table)) throw new Error("Unexpected test table");
  return Number(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count);
}

describe("Focus hardening contract", () => {
  it("keeps rich details attached to identity across repeated subtype replacement and idempotent backfills", () => {
    const layer = setup();
    const original = layer.mutations.saveDecision({
      ...decisionDetails, key: "choice:upgrade", title: "Upgrade?", sourceFamily: "dependency",
      producer: "maintainer", consequenceOfDelay: "Security fixes delayed",
    }).decision;
    vi.setSystemTime(Date.now() + 1000);
    layer.mutations.updateDecision(original.id, { body: "Evidence one", lifecycle: "acknowledged" });
    vi.setSystemTime(Date.now() + 1000);
    layer.mutations.updateDecision(original.id, { title: "Upgrade now?" });
    backfillFocusDetails(db);
    backfillFocusDetails(db);
    expect(count("focus_object_details")).toBe(1);
    expect(layer.decisionStore.get(original.id)?.details).toMatchObject({
      objectId: original.id, sourceFamily: "dependency", producer: "maintainer",
      alternatives: decisionDetails.alternatives, lifecycle: "acknowledged", acknowledgedAt: "2026-09-05T18:00:01.000Z",
    });
    expect(layer.decisionStore.get(original.id)?.activationId).toBe(original.activationId);
  });

  it("makes consecutive reconciliation runs write, transition, activation and timestamp idempotent", () => {
    const layer = setup();
    const decision = layer.mutations.saveDecision({ ...decisionDetails, title: "Choose", key: "choice:stable" }).decision;
    layer.mutations.updateDecision(decision.id, { lifecycle: "acknowledged" });
    const before = layer.decisionStore.get(decision.id);
    const changes = db.prepare("SELECT total_changes() AS changes").get()?.changes;
    vi.setSystemTime(Date.now() + 86_400_000);
    expect(layer.mutations.reconcileLegacyFeed()).toEqual({ imported: 0, deleted: 0, quarantined: 0 });
    expect(layer.mutations.reconcileLegacyFeed()).toEqual({ imported: 0, deleted: 0, quarantined: 0 });
    expect(db.prepare("SELECT total_changes() AS changes").get()?.changes).toBe(changes);
    expect(layer.decisionStore.get(decision.id)).toEqual(before);
    expect(count("focus_transitions")).toBe(2);
  });

  it("preserves acknowledged/handed-off semantics unless legacy status truly changes", () => {
    const layer = setup();
    const object = layer.mutations.saveDecision({ ...decisionDetails, title: "Choose" }).decision;
    layer.mutations.updateDecision(object.id, { lifecycle: "acknowledged" });
    layer.feedStore.updateCardById(object.id, { status: "active" });
    expect(layer.decisionStore.get(object.id)?.lifecycle).toBe("acknowledged");
    layer.mutations.promoteToAction(object.id, layer.checklistStore, { taskId: null });
    db.prepare("UPDATE feed_cards SET body='A legacy note', updatedAt=? WHERE id=?").run("2026-09-05T19:00:00.000Z", object.id);
    layer.mutations.reconcileLegacyFeed();
    expect(layer.decisionStore.get(object.id)?.lifecycle).toBe("handed_off");
    db.prepare("UPDATE feed_cards SET status='done' WHERE id=?").run(object.id);
    layer.mutations.reconcileLegacyFeed();
    expect(layer.decisionStore.get(object.id)?.details).toMatchObject({ lifecycle: "resolved", resolutionReason: "legacy-status-change" });
    const closed = layer.decisionStore.get(object.id)!;
    db.prepare("UPDATE feed_cards SET status='active' WHERE id=?").run(object.id);
    layer.mutations.reconcileLegacyFeed();
    expect(layer.decisionStore.get(object.id)?.lifecycle).toBe("active");
    expect(layer.decisionStore.get(object.id)?.activationId).not.toBe(closed.activationId);
    layer.mutations.updateDecision(object.id, { lifecycle: "accepted_risk", lifecycleReason: "Risk approved" });
    layer.mutations.reconcileLegacyFeed();
    expect(layer.decisionStore.get(object.id)?.lifecycle).toBe("accepted_risk");
    expect(layer.feedStore.getCard(object.id)?.status).toBe("done");
  });

  it("enforces first-class admission and does not let agents claim legacy provenance", () => {
    const layer = setup();
    expect(() => layer.mutations.saveDecision({ title: "Incomplete" })).toThrow("alternatives");
    expect(() => layer.mutations.saveDecision({ title: "No fallback", alternatives: ["One", "Two"] })).toThrow("recommendation or fallback");
    expect(() => layer.mutations.saveDecision({ ...decisionDetails, title: "Deadline", interventionBy: NOW })).toThrow("consequenceOfDelay");
    expect(() => layer.mutations.saveAlert({ title: "Unsupported" })).toThrow("evidence");
    expect(() => layer.mutations.saveAlert({ ...alertDetails(), title: "Empty evidence", evidence: [" "] })).toThrow("non-empty");
    expect(() => layer.mutations.saveEvent("note", { ...eventDetails(), title: "Unkeyed" })).toThrow("stable key");
    expect(() => layer.mutations.saveEvent("note", { title: "No provenance", key: "event:x" })).toThrow("sourceFamily");
    expect(() => layer.mutations.saveDecision({ ...decisionDetails, title: "Spoof", producer: "legacy" })).toThrow("reserved");
    const decision = layer.mutations.saveDecision({ ...decisionDetails, question: "Proceed or defer?" }).decision;
    expect(decision.title).toBe("Proceed or defer?");
    expect(() => layer.mutations.updateDecision(decision.id, { producer: "legacy", alternatives: [] })).toThrow("reserved");
    expect(() => layer.mutations.updateDecision(decision.id, { status: "done" })).toThrow("requires lifecycleReason");
    expect(() => layer.mutations.updateDecision(decision.id, { status: "dismissed" })).toThrow("requires lifecycleReason");
    expect(layer.mutations.saveAlert({ ...alertDetails(), title: "Verified" }).alert.lifecycle).toBe("active");
    expect(layer.mutations.saveEvent("note", { ...eventDetails(), key: "source:one", title: "Observed" }).event.lifecycle).toBe("active");
  });

  it("records no-op telemetry without refreshing canonical content, transition history or bus state", () => {
    const layer = setup();
    const events: unknown[] = [];
    layer.bus.subscribe((event) => events.push(event));
    const input = { ...eventDetails(), key: "source:stable", title: "Unchanged", metadata: { b: 2, a: 1 } };
    const first = layer.mutations.saveEvent("note", input).event;
    const beforeEvents = events.length;
    vi.setSystemTime(Date.now() + 6 * 86_400_000);
    const second = layer.mutations.saveEvent("note", { ...input, metadata: { a: 1, b: 2 } }).event;
    expect(second).toEqual(first);
    expect(events.length).toBe(beforeEvents);
    expect(layer.transitionStore.list(first.id)).toHaveLength(1);
    expect(layer.attentionStore.list({ objectId: first.id })[0].eventType).toBe("no_op");
    const observationOnly = layer.mutations.saveEvent("note", { ...input, observedAt: new Date().toISOString() }).event;
    expect(observationOnly.details.lastMeaningfulChangeAt).toBe(first.details.lastMeaningfulChangeAt);
    expect(observationOnly.updatedAt).toBe(first.updatedAt);
    expect(layer.transitionStore.list(first.id)).toHaveLength(1);
  });

  it("includes visual identity and content in meaningful fingerprints", () => {
    const layer = setup();
    const first = layer.mutations.saveDecision({ ...decisionDetails, title: "Visual" }).decision;
    const artifactId = "11111111-1111-4111-8111-111111111111";
    const visual = {
      artifactId, kind: "mermaid" as const, title: "Map", displayName: "map.mmd", mimeType: "text/vnd.mermaid", size: 20,
      url: `/api/feed/${first.id}/visuals/${artifactId}`, downloadUrl: `/api/feed/${first.id}/visuals/${artifactId}/download`,
    };
    vi.setSystemTime(Date.now() + 1000);
    const updated = layer.mutations.updateDecision(first.id, {}, { visual });
    expect(updated.details.contentFingerprint).not.toBe(first.details.contentFingerprint);
    expect(updated.details.lastMeaningfulChangeAt).not.toBe(first.details.lastMeaningfulChangeAt);
    expect(layer.mutations.updateDecision(first.id, {}, { visual }).updatedAt).toBe(updated.updatedAt);
  });

  it("requires explicit new episodes for reactivation and guards stale activation requests", () => {
    const layer = setup();
    const decision = layer.mutations.saveDecision({ ...decisionDetails, title: "Sticky" }).decision;
    layer.mutations.updateDecision(decision.id, { lifecycle: "dismissed", lifecycleReason: "Not useful" });
    expect(() => layer.mutations.updateDecision(decision.id, { status: "active" })).toThrow("newEpisode");
    expect(() => layer.mutations.updateDecision(decision.id, { lifecycle: "active", newEpisode: true })).toThrow("episodeReason");
    const reactivated = layer.mutations.updateDecision(decision.id, { lifecycle: "active", newEpisode: true, episodeReason: "New evidence" });
    expect(reactivated.activationId).not.toBe(decision.activationId);
    expect(() => layer.mutations.updateDecision(decision.id, { lifecycle: "acknowledged", expectedActivationId: decision.activationId })).toThrow("activation changed");
    expect(layer.attentionStore.list({ objectId: decision.id }).some((e) => e.eventType === "reactivation")).toBe(true);
  });

  it("links launch-prompt sessions as acknowledgement, never completion, including old client patches", () => {
    const layer = setup();
    const decision = layer.mutations.saveDecision({ ...decisionDetails, title: "Discuss", action: { prompt: "Discuss options" } }).decision;
    const launched = layer.mutations.updateDecision(decision.id, { sessionId: "new-session", status: "done" });
    expect(launched).toMatchObject({ lifecycle: "acknowledged", status: "active", sessionId: "new-session" });
    expect(launched.details.resolvedAt).toBeNull();
    layer.mutations.promoteToAction(decision.id, layer.checklistStore, { taskId: null });
    const handedOff = layer.mutations.linkLaunchedSession(decision.id, "second-session", decision.activationId);
    expect(handedOff.lifecycle).toBe("handed_off");
    expect(layer.feedStore.getCard(decision.id)?.status).toBe("active");
  });

  it("repairs rollback-era launch-as-done writes idempotently without resolving the concern", () => {
    const layer = setup();
    const source = layer.mutations.saveDecision({ ...decisionDetails, title: "Discuss later", action: { prompt: "Discuss" } }).decision;
    db.prepare("UPDATE feed_cards SET sessionId='rollback-session', status='done', updatedAt=? WHERE id=?").run(NOW, source.id);
    layer.mutations.reconcileLegacyFeed();
    expect(layer.decisionStore.get(source.id)).toMatchObject({ sessionId: "rollback-session", lifecycle: "acknowledged", status: "active" });
    expect(layer.feedStore.getCard(source.id)?.status).toBe("active");
    const before = db.prepare("SELECT total_changes() AS count").get()?.count;
    layer.mutations.reconcileLegacyFeed();
    expect(db.prepare("SELECT total_changes() AS count").get()?.count).toBe(before);
  });

  it("requires a visible promotion destination for archived, muted, orphaned and global defaults", () => {
    const layer = setup();
    const task = layer.taskStore.createTask("Archived");
    const visible = layer.taskStore.createTask("Visible");
    const decision = layer.mutations.saveDecision({ ...decisionDetails, title: "Task decision", taskId: task.id }).decision;
    layer.taskStore.updateTask(task.id, { status: "archived" });
    expect(() => layer.mutations.promoteToAction(decision.id, layer.checklistStore)).toThrow("visible default");
    expect(() => layer.mutations.promoteToAction(decision.id, layer.checklistStore, { taskId: task.id })).toThrow("active, unmuted");
    layer.taskStore.deleteTask(task.id);
    expect(() => layer.mutations.promoteToAction(decision.id, layer.checklistStore)).toThrow("visible default");
    const promoted = layer.mutations.promoteToAction(decision.id, layer.checklistStore, { taskId: visible.id, text: "Accepted work" });
    expect(promoted.action).toMatchObject({ taskId: visible.id, text: "Accepted work" });
    const global = layer.mutations.saveDecision({ ...decisionDetails, title: "Global" }).decision;
    expect(() => layer.mutations.promoteToAction(global.id, layer.checklistStore)).toThrow("taskId:null");
    expect(layer.mutations.promoteToAction(global.id, layer.checklistStore, { taskId: null }).action.taskId).toBeNull();
  });

  it("dedupes unfinished Actions across episodes and exposes both directions without auto-resolving", () => {
    const layer = setup();
    const source = layer.mutations.saveEvent("observation", { ...eventDetails(), key: "source:work", title: "Do work" }).event;
    const first = layer.mutations.promoteToAction(source.id, layer.checklistStore, { taskId: null });
    expect(first.object).toMatchObject({ lifecycle: "handed_off", status: "active" });
    expect(first.action.sources).toEqual([expect.objectContaining({ sourceId: source.id, lifecycle: "handed_off" })]);
    const episode = layer.mutations.updateEvent(source.id, source.category, { lifecycle: "active", newEpisode: true, episodeReason: "New observation" });
    const second = layer.mutations.promoteToAction(source.id, layer.checklistStore, { taskId: null });
    expect(second.created).toBe(false);
    expect(second.action.id).toBe(first.action.id);
    expect(count("checklist_items")).toBe(1);
    expect(second.object.linkedActions.map((link) => link.activationId)).toContain(episode.activationId);
    layer.checklistStore.updateChecklistItem(first.action.id, { done: true });
    expect(layer.eventStore.get(source.id)?.lifecycle).toBe("handed_off");
    expect(layer.eventStore.get(source.id)?.linkedActions.every((link) => link.action.done)).toBe(true);
    expect(layer.projection.getSnapshot().handedOffTotal).toBe(1);
  });

  it("moves an unfinished hidden Action to an explicitly supplied visible destination instead of duplicating it", () => {
    const layer = setup();
    const hidden = layer.taskStore.createTask("Former destination");
    const visible = layer.taskStore.createTask("Visible destination");
    const source = layer.mutations.saveDecision({ ...decisionDetails, title: "Accepted concern", taskId: hidden.id }).decision;
    const first = layer.mutations.promoteToAction(source.id, layer.checklistStore);
    layer.taskStore.updateTask(hidden.id, { muted: true });
    expect(() => layer.mutations.promoteToAction(source.id, layer.checklistStore)).toThrow("visible default");
    const reused = layer.mutations.promoteToAction(source.id, layer.checklistStore, { taskId: visible.id });
    expect(reused.created).toBe(false);
    expect(reused.action).toMatchObject({ id: first.action.id, taskId: visible.id });
    expect(layer.checklistStore.listAllOpenChecklistItems().map((action) => action.id)).toContain(first.action.id);
    expect(count("checklist_items")).toBe(1);
  });

  it("preserves task deletion provenance, keeps Alerts visible, and prevents global attention/digest leakage", () => {
    const layer = setup();
    const task = layer.taskStore.createTask("Original task");
    const decision = layer.mutations.saveDecision({
      ...decisionDetails, title: "Task decision", taskId: task.id, interventionBy: NOW, consequenceOfDelay: "Delay",
    }).decision;
    const alert = layer.mutations.saveAlert({ ...alertDetails(), title: "Task alert", taskId: task.id }).alert;
    const event = layer.mutations.saveEvent("note", { ...eventDetails(), title: "Task event", key: "task:event", taskId: task.id }).event;
    layer.taskStore.updateTask(task.id, { title: "Renamed task" });
    layer.taskStore.deleteTask(task.id);
    const snapshot = layer.projection.getSnapshot();
    expect(snapshot.decisionTotal).toBe(0);
    expect(snapshot.upcomingInterventions.some((entry) => entry.objectId === decision.id)).toBe(false);
    expect(snapshot.alertTotal).toBe(1);
    expect(snapshot.digests).toHaveLength(0);
    expect(snapshot.quietDigests[0]).toMatchObject({ orphaned: true, originalTaskId: task.id, taskTitle: "Renamed task" });
    for (const object of [decision, alert, event]) expect(layer.mutations.getAny(object.id)).toMatchObject({
      taskId: null, taskState: "orphaned",
      details: { originalTaskId: task.id, originalTaskTitle: "Renamed task", orphanedAt: expect.any(String) },
    });
    layer.mutations.reconcileLegacyFeed();
    expect(layer.projection.getSnapshot().decisionTotal).toBe(0);
    expect(layer.eventStore.listDigestPage({ taskId: null, sourceFamily: "release" }).total).toBe(0);
    expect(layer.eventStore.listDigestPage({ taskId: null, sourceFamily: "release", orphanedTaskId: task.id }).total).toBe(1);
    const global = layer.mutations.updateDecision(decision.id, { taskId: null });
    expect(global).toMatchObject({ taskState: "global", details: { orphanedAt: null, originalTaskId: task.id } });
    expect(layer.projection.getSnapshot().decisionTotal).toBe(1);
  });

  it("groups explicit families, separates quiet digests, enforces meaningful horizon and tracks viewed/new counts", () => {
    const layer = setup();
    const task = layer.taskStore.createTask("Quiet");
    layer.taskStore.updateTask(task.id, { muted: true });
    const old = layer.mutations.saveEvent("note", { ...eventDetails(), sourceFamily: "explicit", key: "wrong:old", title: "Old" }).event;
    layer.mutations.saveEvent("note", { ...eventDetails(), sourceFamily: "explicit", key: "wrong:pinned", title: "Pinned", pinned: true });
    vi.setSystemTime(Date.now() + 8 * 86_400_000);
    layer.mutations.saveEvent("note", { ...eventDetails(), sourceFamily: "explicit", key: "different:fresh", title: "Fresh" });
    layer.mutations.saveEvent("note", { ...eventDetails(), key: "quiet:one", title: "Quiet event", taskId: task.id });
    const snapshot = layer.projection.getSnapshot();
    expect(snapshot.digests).toEqual([expect.objectContaining({ family: "explicit", count: 2, newCount: 2, quiet: false })]);
    expect(snapshot.quietDigests).toEqual([expect.objectContaining({ quiet: true, count: 1 })]);
    layer.projection.markDigestViewed(snapshot.digests[0].id);
    expect(layer.projection.getSnapshot().digests[0].newCount).toBe(0);
    vi.setSystemTime(Date.now() + 1000);
    layer.mutations.updateEvent(old.id, old.category, { body: "Meaningful new evidence" });
    expect(layer.projection.getSnapshot().digests[0]).toMatchObject({ count: 3, newCount: 1, lastViewedAt: expect.any(String) });
  });

  it("keeps aged active Events and Actions in object-scoped History after deletion", () => {
    const layer = setup();
    const event = layer.mutations.saveEvent("note", { ...eventDetails(), key: "source:aged", title: "Aged active" }).event;
    layer.mutations.updateEvent(event.id, event.category, { body: "Change one" });
    layer.mutations.updateEvent(event.id, event.category, { body: "Change two" });
    const action = layer.checklistStore.createChecklistItem(null, "Accepted work");
    vi.setSystemTime(Date.now() + 8 * 86_400_000);
    expect(layer.projection.getSnapshot().digests).toHaveLength(0);
    const history = layer.projection.listHistory({ objectId: event.id });
    expect(history.total).toBe(1);
    expect(history.objects[0]).toMatchObject({ deleted: false, object: { status: "active" }, transitionTotal: 3 });
    layer.mutations.deleteById(event.id);
    layer.checklistStore.deleteChecklistItem(action.id);
    expect(layer.projection.listHistory({ objectId: event.id }).objects[0]).toMatchObject({ deleted: true, title: "Aged active" });
    expect(layer.projection.listHistory({ objectId: action.id }).objects[0]).toMatchObject({ objectType: "action", deleted: true });
    expect(() => db.prepare("DELETE FROM focus_transitions WHERE objectId=?").run(event.id)).toThrow("append-only");
  });

  it("reads digest views once even with many independent source families", () => {
    const layer = setup();
    for (let index = 0; index < 100; index++) {
      layer.mutations.saveEvent("note", { ...eventDetails(), key: `batch:${index}`, sourceFamily: `family-${index}`, title: `Observation ${index}` });
    }
    const prepare = vi.spyOn(db, "prepare");
    expect(layer.projection.getSnapshot().digests).toHaveLength(100);
    expect(prepare.mock.calls.filter(([sql]) => sql.includes("FROM focus_digest_views"))).toHaveLength(1);
  });

  it("surfaces unknown/error health rather than a false all-clear", () => {
    const layer = setup();
    expect(layer.projection.getSnapshot()).toMatchObject({ allClear: false, domainHealth: { coverage: { status: "unknown" } } });
    vi.spyOn(layer.alertStore, "listAttentionPage").mockImplementation(() => { throw new Error("Alert domain unavailable"); });
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    const snapshot = layer.projection.getSnapshot();
    expect(snapshot).toMatchObject({ allClear: false, alertTotal: null, attentionTotal: null, domainHealth: { alerts: { status: "error" } } });
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining("Alert domain unavailable"));
  });

  it("reports incomplete canonical domains as errors and does not quarantine storage failures as bad feed content", () => {
    const layer = setup();
    const source = layer.mutations.saveDecision({ ...decisionDetails, title: "Original" }).decision;
    db.prepare("UPDATE feed_cards SET title='Changed' WHERE id=?").run(source.id);
    db.exec(`CREATE TRIGGER block_reconciliation BEFORE INSERT ON decisions BEGIN SELECT RAISE(ABORT, 'disk write failed'); END;`);
    expect(() => layer.mutations.reconcileLegacyFeed()).toThrow("disk write failed");
    expect(layer.reconciliationErrorStore.countErrors()).toBe(0);
    expect(layer.decisionStore.get(source.id)?.title).toBe("Original");
    db.prepare("DELETE FROM focus_object_details WHERE objectId=?").run(source.id);
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(layer.projection.getSnapshot()).toMatchObject({
      decisionTotal: null, allClear: false, domainHealth: { decisions: { status: "error" } },
    });
  });

  it("computes coverage expiry/gaps without writes and constrains revoked authority", () => {
    const layer = setup();
    const grant = layer.authorityStore.save({
      title: "Approved health response", sourceFamily: "health", producer: "monitor", scope: "Service monitoring",
      validUntil: "2026-09-06T18:00:00.000Z", grantedBy: "user", allowImmediate: true,
    });
    const assertion = layer.coverageStore.save({
      title: "Health coverage", sourceFamily: "health", producer: "monitor", scope: "Service",
      explicitState: "valid", lastCheckedAt: NOW, validUntil: "2026-09-05T20:00:00.000Z",
      evidence: ["Probe healthy"], expectedIntervalMinutes: 30, authorityGrantId: grant.id,
    });
    expect(assertion.state).toBe("valid");
    vi.setSystemTime(Date.now() + 45 * 60_000);
    expect(layer.coverageStore.list()[0]).toMatchObject({ state: "at-risk", observationGap: "Observation overdue" });
    layer.authorityStore.revoke(grant.id, "Approval withdrawn");
    expect(layer.coverageStore.list()[0].constrainedAutonomy).toContain("No currently active matching authority grant");
    const changes = db.prepare("SELECT total_changes() AS count").get()?.count;
    vi.setSystemTime(new Date("2026-09-05T21:00:00.000Z"));
    expect(layer.coverageStore.list()[0].state).toBe("expired");
    expect(db.prepare("SELECT total_changes() AS count").get()?.count).toBe(changes);
    expect(layer.authorityStore.resolve({ taskId: null, sourceFamily: "health", producer: "monitor", immediate: true })).toBeUndefined();
  });

  it("revokes orphaned task authority rather than turning it into global permission", () => {
    const layer = setup();
    const task = layer.taskStore.createTask("Scoped authority");
    const grant = layer.authorityStore.save({
      title: "Scoped", taskId: task.id, sourceFamily: "health", producer: "monitor", scope: "Only this task",
      grantedBy: "user", validUntil: "2026-09-06T18:00:00.000Z", allowImmediate: true,
    });
    layer.taskStore.deleteTask(task.id);
    expect(layer.authorityStore.get(grant.id)).toMatchObject({ taskId: task.id, status: "revoked", revokeReason: "task-deleted" });
    expect(layer.authorityStore.resolve({ taskId: null, sourceFamily: "health", producer: "monitor" })).toBeUndefined();
  });

  it("clears incompatible detail fields on rollback type changes and retains transition history on rollback deletion", () => {
    const layer = setup();
    const decision = layer.mutations.saveDecision({ ...decisionDetails, title: "Changed type" }).decision;
    layer.feedStore.updateCardById(decision.id, { kind: "note" });
    expect(layer.eventStore.get(decision.id)?.details).toMatchObject({ alternatives: [], recommendation: null, fallback: null, notificationMode: "focus" });
    const before = layer.transitionStore.list(decision.id).length;
    db.prepare("DELETE FROM feed_cards WHERE id=?").run(decision.id);
    layer.mutations.reconcileLegacyFeed();
    layer.mutations.reconcileLegacyFeed();
    expect(layer.mutations.getAny(decision.id)).toBeUndefined();
    expect(layer.transitionStore.list(decision.id)).toHaveLength(before + 1);
  });

  it("dedupes stable-key Actions and retains Action snapshots on task cascade deletion", () => {
    const layer = setup();
    const task = layer.taskStore.createTask("Accepted task");
    const first = layer.checklistStore.createChecklistItem(task.id, "Accepted work", undefined, { key: "accepted:one", sourceUrl: "https://example.test/source" });
    const second = layer.checklistStore.createChecklistItem(task.id, "Accepted work", undefined, { key: "accepted:one" });
    expect(second.id).toBe(first.id);
    layer.taskStore.deleteTask(task.id);
    const history = layer.projection.listHistory({ objectId: first.id });
    expect(history.total).toBe(1);
    expect(history.objects[0].title).toBe("Accepted work");
    expect(history.objects[0].transitions.length).toBeGreaterThan(0);
  });
});
