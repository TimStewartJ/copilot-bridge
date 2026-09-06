import type { DatabaseSync } from "./db.js";
import {
  FeedCardValidationError,
  hydrateFeedCardRow,
  type FeedCard,
  type FeedCardStatus,
} from "./feed-store.js";
import { createFocusDetailsStore, defaultFocusDetails, focusEnum, focusText, FOCUS_LIFECYCLES, legacyStatusToLifecycle, type FocusLifecycle, type FocusObjectDetails } from "./focus-details-store.js";
import { listLinkedActions, type FocusLinkedAction } from "./focus-action-links.js";

export type FocusObjectType = "decision" | "alert" | "event";

export interface FocusObjectContext {
  lifecycle: FocusLifecycle;
  details: FocusObjectDetails;
  linkedActions: FocusLinkedAction[];
  taskState: "global" | "active" | "muted" | "archived" | "orphaned";
  taskTitle: string | null;
}

export interface FocusDecision extends FeedCard, FocusObjectContext {
  objectType: "decision";
  activationId: string;
}

export interface FocusAlert extends FeedCard, FocusObjectContext {
  objectType: "alert";
  activationId: string;
}

export interface FocusEvent extends FeedCard, FocusObjectContext {
  objectType: "event";
  category: string;
  activationId: string;
}

export type FocusObject = FocusDecision | FocusAlert | FocusEvent;

export interface FocusObjectPage<T extends FocusObject> {
  objects: T[];
  total: number;
  nextOffset: number | null;
}

export interface FocusReconciliationError {
  id: string;
  feedCardId: string | null;
  feedRowId: number;
  error: string;
  rawRowJson: string;
  detectedAt: string;
}

export interface FocusStoreListOptions {
  status?: FeedCardStatus;
  lifecycle?: FocusLifecycle;
  taskId?: string | null;
  offset?: number;
  limit?: number;
}

const DEFAULT_PAGE_LIMIT = 20;
const MAX_PAGE_LIMIT = 100;

function normalizePageOptions(options: FocusStoreListOptions): {
  status?: FeedCardStatus;
  taskId?: string | null;
  offset: number;
  limit: number;
} {
  const offset = options.offset ?? 0;
  const limit = options.limit ?? DEFAULT_PAGE_LIMIT;
  if (!Number.isInteger(offset) || offset < 0) {
    throw new FeedCardValidationError("offset must be a non-negative integer");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE_LIMIT) {
    throw new FeedCardValidationError(`limit must be an integer from 1 to ${MAX_PAGE_LIMIT}`);
  }
  if (options.status !== undefined) focusEnum(options.status, "status", ["active", "done", "dismissed"]);
  if (options.lifecycle !== undefined) focusEnum(options.lifecycle, "lifecycle", FOCUS_LIFECYCLES);
  if (options.taskId !== undefined && options.taskId !== null) focusText(options.taskId, "taskId");
  return { ...options, offset, limit };
}

function canonicalRowToFeedRow(row: any, objectType: FocusObjectType): any {
  return {
    ...row,
    kind: objectType === "event" ? row.category : objectType,
    actionJson: row.launchPromptJson ?? null,
  };
}

export function hydrateCanonicalObject(row: any, objectType: FocusObjectType, db: DatabaseSync, allowMissingDetails = false): FocusObject {
  const card = hydrateFeedCardRow(canonicalRowToFeedRow(row, objectType));
  const storedDetails = createFocusDetailsStore(db).get(card.id);
  if (!storedDetails && !allowMissingDetails) throw new Error(`Focus details missing for ${card.id}`);
  const details = storedDetails ?? {
    ...defaultFocusDetails(card.id, card.updatedAt ?? card.statusChangedAt ?? card.createdAt),
    lifecycle: legacyStatusToLifecycle(card.status),
    producer: "legacy",
  };
  const task = card.taskId ? db.prepare("SELECT title, status, muted FROM tasks WHERE id = ?").get(card.taskId) : undefined;
  const context: FocusObjectContext = {
    details, lifecycle: details.lifecycle, linkedActions: listLinkedActions(db, card.id),
    taskTitle: typeof task?.title === "string" ? task.title : details.originalTaskTitle,
    taskState: details.orphanedAt || (card.taskId && !task) ? "orphaned"
      : !card.taskId ? "global" : task?.status !== "active" ? "archived" : task.muted === 1 ? "muted" : "active",
  };
  if (objectType === "decision") {
    return { ...card, ...context, objectType, activationId: row.activationId };
  }
  if (objectType === "alert") {
    return { ...card, ...context, objectType, activationId: row.activationId };
  }
  return {
    ...card,
    ...context,
    objectType,
    category: row.category,
    activationId: row.activationId,
  };
}

function createTypedFocusStore<T extends FocusObject>(
  db: DatabaseSync,
  objectType: FocusObjectType,
  table: "decisions" | "alerts" | "focus_events",
) {
  const selectColumns = `focus_object_identities.dedupeKey, ${table}.*`;
  const visiblePredicate = `NOT EXISTS (
    SELECT 1
    FROM focus_legacy_reconciliation_issues
    WHERE focus_legacy_reconciliation_issues.feedCardId = focus_object_identities.id
  )`;

  function get(id: string): T | undefined {
    const row = db.prepare(`
      SELECT ${selectColumns}
      FROM ${table}
      JOIN focus_object_identities ON focus_object_identities.id = ${table}.id
      WHERE ${table}.id = ? AND ${visiblePredicate}
    `).get(id) as any;
    return row ? hydrateCanonicalObject(row, objectType, db) as T : undefined;
  }

  function getIncludingQuarantined(id: string): T | undefined {
    const row = db.prepare(`
      SELECT ${selectColumns}
      FROM ${table}
      JOIN focus_object_identities ON focus_object_identities.id = ${table}.id
      WHERE ${table}.id = ?
    `).get(id) as any;
    return row ? hydrateCanonicalObject(row, objectType, db, true) as T : undefined;
  }

  function getByKey(dedupeKey: string): T | undefined {
    const row = db.prepare(`
      SELECT ${selectColumns}
      FROM ${table}
      JOIN focus_object_identities ON focus_object_identities.id = ${table}.id
      WHERE focus_object_identities.dedupeKey = ? AND ${visiblePredicate}
    `).get(dedupeKey) as any;
    return row ? hydrateCanonicalObject(row, objectType, db) as T : undefined;
  }
  function getBySessionId(sessionId: string): T | undefined {
    const row = db.prepare(`SELECT ${selectColumns} FROM ${table}
      JOIN focus_object_identities ON focus_object_identities.id=${table}.id
      JOIN focus_object_details details ON details.objectId=${table}.id
      WHERE ${table}.sessionId=? AND details.lifecycle IN ('active','acknowledged','handed_off') AND ${visiblePredicate}
      ORDER BY ${table}.updatedAt DESC, ${table}.id LIMIT 1`).get(sessionId);
    return row ? hydrateCanonicalObject(row, objectType, db) as T : undefined;
  }
  function assertHealthy(): void {
    const row = db.prepare(`SELECT COUNT(*) AS count FROM focus_object_identities i
      LEFT JOIN ${table} objects ON objects.id=i.id
      LEFT JOIN focus_object_details details ON details.objectId=i.id
      WHERE i.objectType=? AND (objects.id IS NULL OR details.objectId IS NULL)
        AND NOT EXISTS (SELECT 1 FROM focus_legacy_reconciliation_issues q WHERE q.feedCardId=i.id)`).get(objectType);
    if (Number(row?.count ?? 0) > 0) throw new Error(`${objectType} domain has missing canonical rows/details`);
  }

  function listPage(options: FocusStoreListOptions = {}): FocusObjectPage<T> {
    const normalized = normalizePageOptions(options);
    const where = [visiblePredicate];
    const values: Array<string | number> = [];
    if (normalized.status) {
      where.push(`${table}.status = ?`);
      values.push(normalized.status);
    }
    if (options.lifecycle) {
      where.push(`EXISTS (SELECT 1 FROM focus_object_details details WHERE details.objectId = ${table}.id AND details.lifecycle = ?)`);
      values.push(options.lifecycle);
    }
    if (normalized.taskId === null) {
      where.push(`${table}.taskId IS NULL`);
    } else if (normalized.taskId) {
      where.push(`${table}.taskId = ?`);
      values.push(normalized.taskId);
    }
    const whereClause = where.join(" AND ");
    const totalRow = db.prepare(`
      SELECT COUNT(*) AS count
      FROM ${table}
      JOIN focus_object_identities ON focus_object_identities.id = ${table}.id
      WHERE ${whereClause}
    `).get(...values) as { count?: number };
    const rows = db.prepare(`
      SELECT ${selectColumns}
      FROM ${table}
      JOIN focus_object_identities ON focus_object_identities.id = ${table}.id
      WHERE ${whereClause}
      ORDER BY
        ${table}.pinned DESC,
        CASE ${table}.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
        CASE WHEN ${table}.status = 'active' THEN 0 ELSE 1 END,
        ${table}.statusChangedAt DESC,
        ${table}.updatedAt DESC,
        ${table}.id DESC
      LIMIT ? OFFSET ?
    `).all(...values, normalized.limit, normalized.offset) as any[];
    const objects = rows.map((row) => hydrateCanonicalObject(row, objectType, db) as T);
    const total = Number(totalRow.count) || 0;
    const nextOffset = normalized.offset + rows.length < total
      ? normalized.offset + rows.length
      : null;
    return { objects, total, nextOffset };
  }

  return {
    objectType,
    table,
    get,
    getIncludingQuarantined,
    getByKey,
    getBySessionId,
    assertHealthy,
    listPage,
  };
}

export function createDecisionStore(db: DatabaseSync) {
  const base = createTypedFocusStore<FocusDecision>(db, "decision", "decisions");

  function listAttentionPage(options: { offset?: number; limit?: number } = {}): FocusObjectPage<FocusDecision> {
    const normalized = normalizePageOptions(options);
    const visiblePredicate = `NOT EXISTS (
      SELECT 1
      FROM focus_legacy_reconciliation_issues
      WHERE focus_legacy_reconciliation_issues.feedCardId = decisions.id
    )`;
    const attentionPredicate = `(
      (decisions.taskId IS NULL AND details.orphanedAt IS NULL)
      OR (tasks.status = 'active' AND tasks.muted = 0)
    ) AND details.lifecycle IN ('active','acknowledged')`;
    const totalRow = db.prepare(`
      SELECT COUNT(*) AS count
      FROM decisions
      JOIN focus_object_identities ON focus_object_identities.id = decisions.id
      JOIN focus_object_details details ON details.objectId = decisions.id
      LEFT JOIN tasks ON tasks.id = decisions.taskId
      WHERE decisions.status = 'active' AND ${visiblePredicate} AND ${attentionPredicate}
    `).get() as { count?: number };
    const rows = db.prepare(`
      SELECT focus_object_identities.dedupeKey, decisions.*
      FROM decisions
      JOIN focus_object_identities ON focus_object_identities.id = decisions.id
      JOIN focus_object_details details ON details.objectId = decisions.id
      LEFT JOIN tasks ON tasks.id = decisions.taskId
      WHERE decisions.status = 'active' AND ${visiblePredicate} AND ${attentionPredicate}
      ORDER BY
        decisions.pinned DESC,
        CASE decisions.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
        decisions.updatedAt DESC,
        decisions.id DESC
      LIMIT ? OFFSET ?
    `).all(normalized.limit, normalized.offset) as any[];
    const objects = rows.map((row) => hydrateCanonicalObject(row, "decision", db) as FocusDecision);
    const total = Number(totalRow.count) || 0;
    const nextOffset = normalized.offset + rows.length < total
      ? normalized.offset + rows.length
      : null;
    return { objects, total, nextOffset };
  }

  return { ...base, listAttentionPage };
}

export function createAlertStore(db: DatabaseSync) {
  const base = createTypedFocusStore<FocusAlert>(db, "alert", "alerts");
  function listAttentionPage(options: { offset?: number; limit?: number } = {}): FocusObjectPage<FocusAlert> {
    const normalized = normalizePageOptions(options);
    const predicate = `alerts.status = 'active' AND details.lifecycle IN ('active','acknowledged')
      AND NOT EXISTS (SELECT 1 FROM focus_legacy_reconciliation_issues q WHERE q.feedCardId = alerts.id)`;
    const total = Number(db.prepare(`SELECT COUNT(*) AS count FROM alerts
      JOIN focus_object_details details ON details.objectId = alerts.id WHERE ${predicate}`).get()?.count ?? 0);
    const rows = db.prepare(`SELECT i.dedupeKey, alerts.* FROM alerts
      JOIN focus_object_identities i ON i.id = alerts.id
      JOIN focus_object_details details ON details.objectId = alerts.id WHERE ${predicate}
      ORDER BY alerts.pinned DESC, CASE alerts.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
        alerts.updatedAt DESC, alerts.id DESC LIMIT ? OFFSET ?`).all(normalized.limit, normalized.offset);
    return {
      objects: rows.map((row) => hydrateCanonicalObject(row, "alert", db) as FocusAlert), total,
      nextOffset: normalized.offset + rows.length < total ? normalized.offset + rows.length : null,
    };
  }
  return { ...base, listAttentionPage };
}

export function createFocusEventStore(db: DatabaseSync) {
  const base = createTypedFocusStore<FocusEvent>(db, "event", "focus_events");

  function listActiveForDigests(now = Date.now()): FocusEvent[] {
    const horizon = new Date(now - 7 * 86_400_000).toISOString();
    const rows = db.prepare(`
      SELECT focus_object_identities.dedupeKey, focus_events.*
      FROM focus_events
      JOIN focus_object_identities ON focus_object_identities.id = focus_events.id
      JOIN focus_object_details details ON details.objectId = focus_events.id
      WHERE focus_events.status = 'active'
        AND details.lifecycle IN ('active','acknowledged')
        AND (focus_events.pinned = 1 OR details.lastMeaningfulChangeAt >= ?)
        AND NOT EXISTS (
          SELECT 1
          FROM focus_legacy_reconciliation_issues
          WHERE focus_legacy_reconciliation_issues.feedCardId = focus_events.id
        )
      ORDER BY
        focus_events.pinned DESC,
        CASE focus_events.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
        focus_events.updatedAt DESC,
        focus_events.id DESC
    `).all(horizon) as any[];
    return rows.map((row) => hydrateCanonicalObject(row, "event", db) as FocusEvent);
  }

  function listDigestPage(options: {
    taskId: string | null;
    keyPrefix?: string;
    category?: string;
    sourceFamily?: string;
    orphanedTaskId?: string;
    offset?: number;
    limit?: number;
  }): FocusObjectPage<FocusEvent> {
    const normalized = normalizePageOptions(options);
    const keyPrefix = options.keyPrefix?.trim();
    const category = options.category?.trim();
    const sourceFamily = options.sourceFamily?.trim();
    if ([keyPrefix, category, sourceFamily].filter(Boolean).length !== 1) {
      throw new FeedCardValidationError("Provide exactly one of sourceFamily, keyPrefix or category");
    }
    const where = [
      "focus_events.status = 'active'",
      "details.lifecycle IN ('active','acknowledged')",
      "(focus_events.pinned = 1 OR details.lastMeaningfulChangeAt >= ?)",
      `NOT EXISTS (
        SELECT 1
        FROM focus_legacy_reconciliation_issues
        WHERE focus_legacy_reconciliation_issues.feedCardId = focus_events.id
      )`,
    ];
    const values: Array<string | number> = [new Date(Date.now() - 7 * 86_400_000).toISOString()];
    if (options.orphanedTaskId) {
      if (options.taskId !== null) throw new FeedCardValidationError("orphanedTaskId cannot be combined with taskId");
      where.push("details.orphanedAt IS NOT NULL", "details.originalTaskId = ?");
      values.push(options.orphanedTaskId);
    } else if (options.taskId === null) {
      where.push("focus_events.taskId IS NULL", "details.orphanedAt IS NULL");
    } else {
      where.push("focus_events.taskId = ?");
      values.push(options.taskId);
    }
    if (sourceFamily) {
      where.push("details.sourceFamily = ?");
      values.push(sourceFamily);
    } else if (keyPrefix) {
      where.push(keyPrefix.endsWith(":")
        ? "instr(focus_object_identities.dedupeKey, ?) = 1"
        : "focus_object_identities.dedupeKey = ?");
      values.push(keyPrefix);
    } else {
      where.push("focus_object_identities.dedupeKey IS NULL", "focus_events.category = ?");
      values.push(category!);
    }
    const whereClause = where.join(" AND ");
    const totalRow = db.prepare(`
      SELECT COUNT(*) AS count
      FROM focus_events
      JOIN focus_object_identities ON focus_object_identities.id = focus_events.id
      JOIN focus_object_details details ON details.objectId = focus_events.id
      WHERE ${whereClause}
    `).get(...values) as { count?: number };
    const rows = db.prepare(`
      SELECT focus_object_identities.dedupeKey, focus_events.*
      FROM focus_events
      JOIN focus_object_identities ON focus_object_identities.id = focus_events.id
      JOIN focus_object_details details ON details.objectId = focus_events.id
      WHERE ${whereClause}
      ORDER BY
        focus_events.pinned DESC,
        CASE focus_events.priority WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END,
        focus_events.updatedAt DESC,
        focus_events.id DESC
      LIMIT ? OFFSET ?
    `).all(...values, normalized.limit, normalized.offset) as any[];
    const objects = rows.map((row) => hydrateCanonicalObject(row, "event", db) as FocusEvent);
    const total = Number(totalRow.count) || 0;
    const nextOffset = normalized.offset + rows.length < total
      ? normalized.offset + rows.length
      : null;
    return { objects, total, nextOffset };
  }

  return { ...base, listActiveForDigests, listDigestPage };
}

export function createFocusIdentityStore(db: DatabaseSync) {
  function getType(id: string): FocusObjectType | undefined {
    const row = db.prepare("SELECT objectType FROM focus_object_identities WHERE id = ?")
      .get(id) as { objectType?: FocusObjectType } | undefined;
    return row?.objectType;
  }

  function getIdByKey(dedupeKey: string): string | undefined {
    const row = db.prepare("SELECT id FROM focus_object_identities WHERE dedupeKey = ?")
      .get(dedupeKey) as { id?: string } | undefined;
    return row?.id;
  }

  function listIds(): string[] {
    return (db.prepare("SELECT id FROM focus_object_identities ORDER BY id").all() as Array<{ id: string }>)
      .map((row) => row.id);
  }

  return { getType, getIdByKey, listIds };
}

export function createFocusReconciliationErrorStore(db: DatabaseSync) {
  function listErrors(): FocusReconciliationError[] {
    return db.prepare(`
      SELECT id, feedCardId, feedRowId, error, rawRowJson, detectedAt
      FROM focus_legacy_reconciliation_issues
      ORDER BY detectedAt DESC, feedCardId
    `).all() as unknown as FocusReconciliationError[];
  }

  function countErrors(): number {
    const row = db.prepare("SELECT COUNT(*) AS count FROM focus_legacy_reconciliation_issues")
      .get() as { count?: number };
    return Number(row.count) || 0;
  }

  return { listErrors, countErrors };
}

export type DecisionStore = ReturnType<typeof createDecisionStore>;
export type AlertStore = ReturnType<typeof createAlertStore>;
export type FocusEventStore = ReturnType<typeof createFocusEventStore>;
export type FocusIdentityStore = ReturnType<typeof createFocusIdentityStore>;
export type FocusReconciliationErrorStore = ReturnType<typeof createFocusReconciliationErrorStore>;
