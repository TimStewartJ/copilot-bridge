import type { DatabaseSync } from "./db.js";
import { runImmediateTransaction } from "./db-transaction.js";
import { FeedCardNotFoundError, FeedCardValidationError } from "./feed-store.js";
import {
  focusEnum, focusInteger, focusRecord, focusText, focusTimestamp,
  type FocusActor, type FocusLifecycle, type FocusObjectDetails,
} from "./focus-details-store.js";
import type { FocusObjectType } from "./focus-domain-store.js";

export type FocusHistoryObjectType = "decision" | "alert" | "event" | "action";
export interface FocusEpisodeActionLink {
  sourceId: string;
  sourceType: FocusObjectType;
  activationId: string;
  actionId: string;
  createdAt: string;
}
export interface FocusEpisodeSnapshot extends FocusObjectDetails {
  schemaVersion: 1;
  objectType: FocusObjectType;
  title: string;
  body: string | null;
  category: string | null;
  activationId: string;
  taskId: string | null;
  taskTitle: string | null;
  sessionId: string | null;
  sessionIds: string[];
  linkedActionIds: string[];
  linkedActions: FocusEpisodeActionLink[];
  createdAt: string;
  updatedAt: string;
  statusChangedAt: string;
}
export interface FocusTransitionDetails extends Record<string, unknown> {
  /** State before this transition; absent on older records and initial creation. */
  previousEpisode?: FocusEpisodeSnapshot;
}
export interface FocusTransition {
  id: string;
  objectId: string;
  objectType: FocusHistoryObjectType;
  title: string;
  activationId: string;
  fromLifecycle: FocusLifecycle | null;
  toLifecycle: FocusLifecycle | null;
  reason: string;
  actor: FocusActor;
  relatedActionId: string | null;
  sessionId: string | null;
  details: FocusTransitionDetails;
  createdAt: string;
}
export type FocusAttentionEventType =
  | "create" | "meaningful_update" | "no_op" | "observation_refresh" | "lifecycle_transition" | "reactivation"
  | "promotion" | "classification" | "deleted" | "notification_eligibility"
  | "notification_delivery" | "notification_suppression" | "muted_attention_excluded"
  | "global_leakage_prevented" | "snapshot" | "digest_viewed" | "authority_changed"
  | "coverage_changed" | "audit_changed" | "session_launch"
  | "protection_created" | "protection_started" | "protection_cancelled" | "protection_cleared"
  | "protection_postponed" | "protection_disposition";
export interface FocusAttentionEvent {
  id: string;
  eventType: FocusAttentionEventType;
  objectId: string | null;
  objectType: FocusHistoryObjectType | null;
  activationId: string | null;
  transitionId: string | null;
  actor: FocusActor;
  reason: string | null;
  details: Record<string, unknown>;
  createdAt: string;
}

export function createFocusTransitionStore(db: DatabaseSync) {
  function append(input: Omit<FocusTransition, "id" | "createdAt" | "details" | "relatedActionId" | "sessionId"> & {
    createdAt?: string; details?: FocusTransitionDetails; relatedActionId?: string | null; sessionId?: string | null;
  }): FocusTransition {
    const transition: FocusTransition = {
      ...input, id: crypto.randomUUID(), createdAt: input.createdAt ?? new Date().toISOString(),
      details: input.details ?? {}, relatedActionId: input.relatedActionId ?? null, sessionId: input.sessionId ?? null,
    };
    db.prepare(`INSERT INTO focus_transitions (
      id, objectId, objectType, title, activationId, fromLifecycle, toLifecycle, reason,
      actor, relatedActionId, sessionId, detailsJson, createdAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      transition.id, transition.objectId, transition.objectType, transition.title, transition.activationId,
      transition.fromLifecycle, transition.toLifecycle, transition.reason, transition.actor,
      transition.relatedActionId, transition.sessionId, JSON.stringify(transition.details), transition.createdAt,
    );
    return transition;
  }
  function list(objectId: string, options: { limit?: number; offset?: number } = {}): FocusTransition[] {
    const limit = focusInteger(options.limit ?? 100, "limit", 1, 500);
    const offset = focusInteger(options.offset ?? 0, "offset", 0, 1_000_000);
    return db.prepare("SELECT * FROM focus_transitions WHERE objectId = ? ORDER BY createdAt DESC, rowid DESC LIMIT ? OFFSET ?")
      .all(objectId, limit, offset).map((row) => {
        const { detailsJson, ...rest } = row as Omit<FocusTransition, "details"> & { detailsJson: string };
        return { ...rest, details: JSON.parse(detailsJson) as FocusTransitionDetails };
      });
  }
  function getEpisodeReferences(objectId: string, activationId: string): { sessionIds: string[]; actionIds: string[] } {
    const references = db.prepare(`SELECT DISTINCT sessionId, relatedActionId FROM focus_transitions
      WHERE objectId=? AND activationId=? AND (sessionId IS NOT NULL OR relatedActionId IS NOT NULL)`)
      .all(objectId, activationId) as Array<{ sessionId: string | null; relatedActionId: string | null }>;
    // Action deletion snapshots preserve links even when a second promotion was
    // a source no-op and deletion subsequently cascaded both live link tables.
    const deletedActions = db.prepare(`SELECT DISTINCT history.objectId AS actionId FROM focus_transitions history
      WHERE history.objectType='action' AND EXISTS (
        SELECT 1 FROM json_each(history.detailsJson, '$.sources') source
        WHERE CASE WHEN source.type='object' THEN
          json_extract(source.value, '$.sourceId')=? AND json_extract(source.value, '$.activationId')=?
        ELSE 0 END
      )`).all(objectId, activationId) as Array<{ actionId: string }>;
    return {
      sessionIds: [...new Set(references.flatMap((row) => row.sessionId === null ? [] : [row.sessionId]))].sort(),
      actionIds: [...new Set([
        ...references.flatMap((row) => row.relatedActionId === null ? [] : [row.relatedActionId]),
        ...deletedActions.map((row) => row.actionId),
      ])].sort(),
    };
  }
  return { append, list, getEpisodeReferences };
}

export function createFocusAttentionStore(db: DatabaseSync) {
  function record(input: Pick<FocusAttentionEvent, "eventType"> & Partial<Omit<FocusAttentionEvent, "id" | "eventType">>): FocusAttentionEvent {
    const event: FocusAttentionEvent = {
      id: crypto.randomUUID(), eventType: input.eventType, objectId: input.objectId ?? null,
      objectType: input.objectType ?? null, activationId: input.activationId ?? null,
      transitionId: input.transitionId ?? null, actor: input.actor ?? "system", reason: input.reason ?? null,
      details: input.details ?? {}, createdAt: input.createdAt ?? new Date().toISOString(),
    };
    db.prepare(`INSERT INTO focus_attention_events (
      id, eventType, objectId, objectType, activationId, transitionId, actor, reason, detailsJson, createdAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      event.id, event.eventType, event.objectId, event.objectType, event.activationId,
      event.transitionId, event.actor, event.reason, JSON.stringify(event.details), event.createdAt,
    );
    return event;
  }
  function list(options: { objectId?: string; limit?: number } = {}): FocusAttentionEvent[] {
    const limit = focusInteger(options.limit ?? 100, "limit", 1, 500);
    return db.prepare(`SELECT * FROM focus_attention_events ${options.objectId ? "WHERE objectId = ?" : ""}
      ORDER BY createdAt DESC, rowid DESC LIMIT ?`).all(...(options.objectId ? [options.objectId, limit] : [limit])).map((row) => {
      const { detailsJson, ...rest } = row as Omit<FocusAttentionEvent, "details"> & { detailsJson: string };
      return { ...rest, details: JSON.parse(detailsJson) as Record<string, unknown> };
    });
  }
  function metrics(options: { days?: number; now?: number } = {}) {
    const days = focusInteger(options.days ?? 7, "days", 1, 90);
    const until = new Date(options.now ?? Date.now()).toISOString();
    const since = new Date(Date.parse(until) - days * 86_400_000).toISOString();
    const counts = db.prepare(`SELECT eventType, COUNT(*) AS count FROM focus_attention_events
      WHERE createdAt >= ? AND createdAt <= ? GROUP BY eventType`).all(since, until) as Array<{ eventType: FocusAttentionEventType; count: number }>;
    const byType = Object.fromEntries(counts.map((row) => [row.eventType, row.count]));
    const noOps = byType.no_op ?? 0;
    const mutations = noOps + (byType.create ?? 0) + (byType.meaningful_update ?? 0);
    return {
      since, until, days, counts: byType, total: counts.reduce((sum, row) => sum + row.count, 0),
      noOpRate: mutations ? noOps / mutations : null,
      notifications: db.prepare(`SELECT status, suppressionReason, COUNT(*) AS count FROM focus_notification_deliveries
        WHERE createdAt >= ? AND createdAt <= ? GROUP BY status, suppressionReason`).all(since, until),
      audits: db.prepare(`SELECT category, status, COUNT(*) AS count FROM focus_attention_audits
        WHERE createdAt >= ? AND createdAt <= ? GROUP BY category, status`).all(since, until),
    };
  }
  return { record, list, metrics };
}

export interface FocusDigestView { digestId: string; lastViewedAt: string }
export function createFocusDigestViewStore(db: DatabaseSync) {
  function get(digestId: string): FocusDigestView | undefined {
    return db.prepare("SELECT * FROM focus_digest_views WHERE digestId = ?").get(digestId) as FocusDigestView | undefined;
  }
  function markViewed(digestId: string, viewedAt = new Date().toISOString()): FocusDigestView {
    if (typeof digestId !== "string" || !digestId || digestId.length > 2048) throw new FeedCardValidationError("digestId is required and must be at most 2048 characters");
    const at = focusTimestamp(viewedAt, "viewedAt")!;
    if (Date.parse(at) > Date.now()) throw new FeedCardValidationError("viewedAt cannot be in the future");
    db.prepare(`INSERT INTO focus_digest_views (digestId, lastViewedAt) VALUES (?, ?)
      ON CONFLICT(digestId) DO UPDATE SET lastViewedAt = MAX(lastViewedAt, excluded.lastViewedAt)`).run(digestId, at);
    return get(digestId)!;
  }
  function list(): FocusDigestView[] {
    return db.prepare("SELECT * FROM focus_digest_views").all() as unknown as FocusDigestView[];
  }
  return { get, list, markViewed };
}

export const FOCUS_AUDIT_CATEGORIES = ["false_positive", "missed_attention", "stale", "misclassified", "leakage", "notification", "coverage", "other"] as const;
export interface FocusAttentionAudit {
  id: string; objectId: string | null; title: string; category: typeof FOCUS_AUDIT_CATEGORIES[number];
  severity: "low" | "normal" | "high"; status: "open" | "resolved" | "dismissed";
  notes: string; outcome: string | null; actor: FocusActor; createdAt: string; updatedAt: string; resolvedAt: string | null;
}
export function createFocusAuditStore(db: DatabaseSync) {
  function get(id: string): FocusAttentionAudit | undefined {
    return db.prepare("SELECT * FROM focus_attention_audits WHERE id = ?").get(id) as FocusAttentionAudit | undefined;
  }
  function saveInTransaction(value: unknown, actor: FocusActor): FocusAttentionAudit {
    const input = focusRecord(value, ["id", "objectId", "title", "category", "severity", "status", "notes", "outcome"]);
    const id = input.id === undefined ? crypto.randomUUID() : focusText(input.id, "id")!;
    const existing = get(id);
    if (input.id !== undefined && !existing) throw new FeedCardNotFoundError(`Attention audit ${id} not found`);
    const now = new Date().toISOString();
    const status = input.status === undefined ? existing?.status ?? "open" : focusEnum(input.status, "status", ["open", "resolved", "dismissed"]);
    const audit: FocusAttentionAudit = {
      id, objectId: input.objectId === undefined ? existing?.objectId ?? null : focusText(input.objectId, "objectId", true),
      title: input.title === undefined && existing ? existing.title : focusText(input.title, "title")!,
      category: input.category === undefined && existing ? existing.category : focusEnum(input.category, "category", FOCUS_AUDIT_CATEGORIES),
      severity: input.severity === undefined ? existing?.severity ?? "normal" : focusEnum(input.severity, "severity", ["low", "normal", "high"]),
      status, notes: input.notes === undefined && existing ? existing.notes : focusText(input.notes, "notes")!,
      outcome: input.outcome === undefined ? existing?.outcome ?? null : focusText(input.outcome, "outcome", true),
      actor, createdAt: existing?.createdAt ?? now, updatedAt: now,
      resolvedAt: status === "open" ? null : existing?.resolvedAt ?? now,
    };
    if (status !== "open" && !audit.outcome) throw new FeedCardValidationError("outcome is required when closing an audit");
    db.prepare(`INSERT INTO focus_attention_audits (
      id, objectId, title, category, severity, status, notes, outcome, actor, createdAt, updatedAt, resolvedAt
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET objectId=excluded.objectId, title=excluded.title, category=excluded.category,
      severity=excluded.severity, status=excluded.status, notes=excluded.notes, outcome=excluded.outcome,
      actor=excluded.actor, updatedAt=excluded.updatedAt, resolvedAt=excluded.resolvedAt`).run(
      audit.id, audit.objectId, audit.title, audit.category, audit.severity, audit.status,
      audit.notes, audit.outcome, audit.actor, audit.createdAt, audit.updatedAt, audit.resolvedAt,
    );
    createFocusAttentionStore(db).record({ eventType: "audit_changed", objectId: audit.objectId, actor, details: { auditId: id, status } });
    return audit;
  }
  function save(value: unknown, actor: FocusActor = "user"): FocusAttentionAudit {
    return runImmediateTransaction(db, () => saveInTransaction(value, actor));
  }
  function list(options: { status?: FocusAttentionAudit["status"]; limit?: number; offset?: number } = {}): FocusAttentionAudit[] {
    const status = options.status === undefined ? undefined : focusEnum(options.status, "status", ["open", "resolved", "dismissed"]);
    const limit = focusInteger(options.limit ?? 50, "limit", 1, 100);
    const offset = focusInteger(options.offset ?? 0, "offset", 0, 1_000_000);
    return db.prepare(`SELECT * FROM focus_attention_audits ${status ? "WHERE status = ?" : ""}
      ORDER BY updatedAt DESC, id DESC LIMIT ? OFFSET ?`).all(...(status ? [status, limit, offset] : [limit, offset])) as unknown as FocusAttentionAudit[];
  }
  return { get, save, list };
}

export type FocusTransitionStore = ReturnType<typeof createFocusTransitionStore>;
export type FocusAttentionStore = ReturnType<typeof createFocusAttentionStore>;
export type FocusDigestViewStore = ReturnType<typeof createFocusDigestViewStore>;
export type FocusAuditStore = ReturnType<typeof createFocusAuditStore>;
