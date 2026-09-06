import type { DatabaseSync } from "./db.js";
import type {
  AlertStore,
  DecisionStore,
  FocusAlert,
  FocusDecision,
  FocusEvent,
  FocusEventStore,
  FocusObject,
  FocusObjectPage,
  FocusObjectType,
} from "./focus-domain-store.js";
import type { TaskStore } from "./task-store.js";
import { FeedCardNotFoundError, FeedCardValidationError } from "./feed-store.js";
import { createChecklistStore, type ChecklistItem } from "./checklist-store.js";
import { createFocusAttentionStore, createFocusAuditStore, createFocusDigestViewStore, createFocusTransitionStore, type FocusAttentionAudit, type FocusEpisodeSnapshot, type FocusTransition, type FocusTransitionDetails } from "./focus-attention-store.js";
import { createFocusAuthorityStore, createFocusCoverageStore, type FocusAuthorityGrant, type FocusCoverageRead, type FocusCoverageSummary } from "./focus-governance-store.js";
import { FOCUS_LIFECYCLES, focusEnum, focusInteger, focusText, type FocusLifecycle } from "./focus-details-store.js";
import type { TelemetryStore } from "./telemetry-store.js";

export interface FocusDigestSample {
  id: string;
  title: string;
  category: string;
  priority: FocusEvent["priority"];
  updatedAt: string;
}

export interface FocusDigest {
  id: string;
  family: string;
  keyPrefix: string | null;
  category: string | null;
  taskId: string | null;
  taskTitle: string | null;
  quiet: boolean;
  count: number;
  highPriorityCount: number;
  latestUpdatedAt: string;
  sourceFamily: string | null;
  originalTaskId: string | null;
  orphaned: boolean;
  lastViewedAt: string | null;
  newCount: number;
  samples: FocusDigestSample[];
}

export interface FocusSnapshot {
  generatedAt: string;
  alertTotal: number | null;
  decisionTotal: number | null;
  actionTotal: number | null;
  attentionTotal: number | null;
  handedOffTotal: number | null;
  unresolvedHandoffTotal: number | null;
  unresolvedHandoffs: FocusUnresolvedHandoffSummary[];
  overdueHandoffTotal: number | null;
  overdueHandoffs: FocusOverdueHandoffSummary[];
  quietConcernTotal: number | null;
  quietConcerns: FocusQuietConcernSummary[];
  digests: FocusDigest[];
  quietDigests: FocusDigest[];
  domainHealth: Record<FocusDomain, FocusDomainHealth>;
  allClear: boolean;
  coverage: { summary: FocusCoverageSummary | null; assertions: FocusCoverageRead[] };
  upcomingInterventions: FocusIntervention[];
  authorityConstraints: Array<FocusAuthorityGrant & { currentlyActive: boolean }>;
  auditExceptions: FocusAttentionAudit[];
  compatibilityErrorCount: number | null;
}

export type FocusDomain = "actions" | "alerts" | "decisions" | "unresolvedHandoffs" | "overdueHandoffs" | "quietConcerns" | "digests" | "coverage" | "authority" | "audits" | "compatibility" | "telemetry";
export interface FocusDomainHealth { status: "ok" | "error" | "unknown"; error?: string }
export interface FocusIntervention { objectId: string; objectType: FocusObjectType; title: string; interventionBy: string; lifecycle: FocusLifecycle }
const DIGEST_SAMPLE_LIMIT = 3;
const CONCERN_SUMMARY_LIMIT = 100;

export interface FocusReadFilters {
  query?: string;
  taskId?: string;
  originalTaskId?: string;
  lifecycle?: FocusLifecycle;
  sourceFamily?: string;
  activationId?: string;
}
export interface FocusHistoryOptions extends FocusReadFilters {
  objectId?: string;
  objectType?: FocusObjectType | "action";
  limit?: number;
  offset?: number;
}
export interface FocusConcernListOptions extends FocusReadFilters {
  objectType?: "decision" | "alert";
  limit?: number;
  offset?: number;
}
export type FocusConcern = FocusDecision | FocusAlert;
export type FocusSuppressionReason = "muted" | "archived" | "orphaned";
export type FocusQuietConcern = FocusConcern & { attentionVisible: false; suppressionReason: FocusSuppressionReason };
export interface FocusConcernSummary {
  objectId: string;
  objectType: "decision" | "alert";
  activationId: string;
  title: string;
  lifecycle: FocusLifecycle;
  interventionBy: string | null;
  taskId: string | null;
  taskTitle: string | null;
  taskState: FocusObject["taskState"];
  originalTaskId: string | null;
  originalTaskTitle: string | null;
  orphanedAt: string | null;
  sourceFamily: string | null;
  producer: string | null;
  sessionId: string | null;
  updatedAt: string;
}
export interface FocusUnresolvedHandoffSummary extends FocusConcernSummary {
  lifecycle: "handed_off";
}
export interface FocusOverdueHandoffSummary extends FocusUnresolvedHandoffSummary {
  interventionBy: string;
  attentionVisible: true;
}
export interface FocusQuietConcernSummary extends FocusConcernSummary {
  attentionVisible: false;
  suppressionReason: FocusSuppressionReason;
}

export function normalizeFocusReadFilters(input: { [K in keyof FocusReadFilters]?: unknown }): FocusReadFilters {
  const filters: FocusReadFilters = {};
  for (const field of ["query", "taskId", "originalTaskId", "sourceFamily", "activationId"] as const) {
    if (input[field] !== undefined) filters[field] = focusText(input[field], field)!;
  }
  if (filters.query && filters.query.length > 500) throw new FeedCardValidationError("query must be at most 500 characters");
  if (input.lifecycle !== undefined) filters.lifecycle = focusEnum(input.lifecycle, "lifecycle", FOCUS_LIFECYCLES);
  return filters;
}

function filterSql(filters: FocusReadFilters): { predicates: string[]; values: Array<string | number> } {
  const predicates: string[] = [];
  const values: Array<string | number> = [];
  for (const field of ["taskId", "originalTaskId", "lifecycle", "sourceFamily", "activationId"] as const) {
    if (filters[field] !== undefined) {
      predicates.push(`candidate.${field} = ?`);
      values.push(filters[field]);
    }
  }
  if (filters.query !== undefined) {
    const fields = ["title", "body", "outcome", "resolutionReason", "sourceFamily", "producer", "taskTitle", "originalTaskTitle"];
    predicates.push(`(${fields.map((field) => `instr(lower(COALESCE(candidate.${field}, '')), lower(?)) > 0`).join(" OR ")})`);
    values.push(...fields.map(() => filters.query!));
  }
  return { predicates, values };
}

function concernSummary(object: FocusConcern): FocusConcernSummary {
  return {
    objectId: object.id, objectType: object.objectType, activationId: object.activationId, title: object.title,
    lifecycle: object.lifecycle, interventionBy: object.details.interventionBy, taskId: object.taskId,
    taskTitle: object.taskTitle, taskState: object.taskState, originalTaskId: object.details.originalTaskId,
    originalTaskTitle: object.details.originalTaskTitle, orphanedAt: object.details.orphanedAt,
    sourceFamily: object.details.sourceFamily, producer: object.details.producer,
    sessionId: object.sessionId, updatedAt: object.updatedAt,
  };
}

function listConcernInventory(
  db: DatabaseSync,
  stores: { decisionStore: DecisionStore; alertStore: AlertStore },
  mode: "unresolved" | "overdue" | "quiet",
  options: FocusConcernListOptions = {},
  now = Date.now(),
): FocusObjectPage<FocusConcern> {
  const limit = focusInteger(options.limit ?? 20, "limit", 1, 100);
  const offset = focusInteger(options.offset ?? 0, "offset", 0, 1_000_000);
  const { predicates, values } = filterSql(normalizeFocusReadFilters(options));
  if (options.objectType !== undefined) {
    predicates.push("candidate.objectType = ?");
    values.push(focusEnum(options.objectType, "objectType", ["decision", "alert"] as const));
  }
  const at = new Date(now).toISOString();
  const overdue = "(candidate.lifecycle = 'handed_off' AND candidate.interventionBy IS NOT NULL AND candidate.interventionBy <= ?)";
  if (mode === "unresolved") {
    predicates.push("candidate.lifecycle = 'handed_off'");
  } else if (mode === "overdue") {
    predicates.push(overdue);
  } else {
    predicates.push(
      "candidate.taskState IN ('muted','archived','orphaned')",
      "(candidate.objectType = 'decision' AND candidate.lifecycle IN ('active','acknowledged','handed_off') OR candidate.objectType = 'alert' AND candidate.lifecycle = 'handed_off')",
      `NOT ${overdue}`,
    );
  }
  if (mode !== "unresolved") values.push(at);
  stores.decisionStore.assertHealthy();
  stores.alertStore.assertHealthy();
  const source = `WITH concerns AS (
    SELECT id, 'decision' AS objectType, title, body, taskId, activationId, updatedAt FROM decisions
    UNION ALL SELECT id, 'alert', title, body, taskId, activationId, updatedAt FROM alerts
  ), candidate AS (
    SELECT concerns.*, details.lifecycle, details.interventionBy, details.originalTaskId,
      details.originalTaskTitle, details.sourceFamily, details.producer, details.outcome, details.resolutionReason,
      COALESCE(tasks.title, details.originalTaskTitle) AS taskTitle,
      CASE WHEN details.orphanedAt IS NOT NULL OR (concerns.taskId IS NOT NULL AND tasks.id IS NULL) THEN 'orphaned'
        WHEN concerns.taskId IS NULL THEN 'global' WHEN tasks.status <> 'active' THEN 'archived'
        WHEN tasks.muted = 1 THEN 'muted' ELSE 'active' END AS taskState
    FROM concerns JOIN focus_object_identities identity ON identity.id=concerns.id AND identity.objectType=concerns.objectType
      JOIN focus_object_details details ON details.objectId=concerns.id LEFT JOIN tasks ON tasks.id=concerns.taskId
    WHERE NOT EXISTS (SELECT 1 FROM focus_legacy_reconciliation_issues q WHERE q.feedCardId=concerns.id)
  )`;
  const predicate = predicates.join(" AND ");
  const total = Number(db.prepare(`${source} SELECT COUNT(*) AS count FROM candidate WHERE ${predicate}`).get(...values)?.count ?? 0);
  const order = mode === "overdue" ? "interventionBy, id" : "updatedAt DESC, id DESC";
  const rows = db.prepare(`${source} SELECT id, objectType FROM candidate WHERE ${predicate} ORDER BY ${order} LIMIT ? OFFSET ?`)
    .all(...values, limit, offset) as Array<{ id: string; objectType: "decision" | "alert" }>;
  const objects = rows.map(({ id, objectType }) => {
    const object = objectType === "decision" ? stores.decisionStore.get(id) : stores.alertStore.get(id);
    if (!object) throw new Error(`Focus ${mode} concern ${id} is unavailable`);
    return object;
  });
  return { objects, total, nextOffset: offset + rows.length < total ? offset + rows.length : null };
}

function listQuietConcerns(
  db: DatabaseSync, stores: { decisionStore: DecisionStore; alertStore: AlertStore },
  options: FocusConcernListOptions = {}, now = Date.now(),
): FocusObjectPage<FocusQuietConcern> {
  const page = listConcernInventory(db, stores, "quiet", options, now);
  return {
    ...page,
    objects: page.objects.map((object) => ({
      ...object, attentionVisible: false, suppressionReason: object.taskState as FocusSuppressionReason,
    })),
  };
}

function objectFromStores(
  objectType: FocusObjectType,
  id: string,
  stores: {
    decisionStore: DecisionStore;
    alertStore: AlertStore;
    eventStore: FocusEventStore;
  },
): FocusObject | undefined {
  if (objectType === "decision") return stores.decisionStore.get(id);
  if (objectType === "alert") return stores.alertStore.get(id);
  return stores.eventStore.get(id);
}

export function buildFocusSnapshot({
  db,
  decisionStore,
  alertStore,
  eventStore,
  compatibilityErrorCount,
  telemetryStore,
}: {
  db: DatabaseSync;
  taskStore: TaskStore;
  decisionStore: DecisionStore;
  alertStore: AlertStore;
  eventStore: FocusEventStore;
  compatibilityErrorCount: () => number;
  telemetryStore?: TelemetryStore;
}): FocusSnapshot {
  const startedAt = Date.now();
  const domainHealth: Record<FocusDomain, FocusDomainHealth> = {
    actions: { status: "unknown" }, alerts: { status: "unknown" }, decisions: { status: "unknown" },
    unresolvedHandoffs: { status: "unknown" }, overdueHandoffs: { status: "unknown" }, quietConcerns: { status: "unknown" },
    digests: { status: "unknown" }, coverage: { status: "unknown" }, authority: { status: "unknown" },
    audits: { status: "unknown" }, compatibility: { status: "unknown" }, telemetry: { status: "unknown" },
  };
  function readDomain<T>(domain: FocusDomain, operation: () => T): T | undefined {
    try {
      const result = operation();
      domainHealth[domain] = { status: "ok" };
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      domainHealth[domain] = { status: "error", error: message };
      console.error(`[focus:${domain}] Snapshot read failed: ${message}`);
      return undefined;
    }
  }
  const attention = createFocusAttentionStore(db);
  const views = createFocusDigestViewStore(db);
  const coverageStore = createFocusCoverageStore(db);
  const alertTotal = readDomain("alerts", () => { alertStore.assertHealthy(); return alertStore.listAttentionPage({ limit: 1 }).total; }) ?? null;
  const decisionTotal = readDomain("decisions", () => { decisionStore.assertHealthy(); return decisionStore.listAttentionPage({ limit: 1 }).total; }) ?? null;
  const actionTotal = readDomain("actions", () => Number(db.prepare(`SELECT COUNT(*) AS count FROM checklist_items c
    LEFT JOIN tasks t ON t.id = c.taskId LEFT JOIN focus_action_details d ON d.actionId = c.id
    WHERE c.done = 0 AND ((c.taskId IS NULL AND d.orphanedAt IS NULL) OR (t.status = 'active' AND t.muted = 0))`).get()?.count ?? 0)) ?? null;
  const unresolved = readDomain("unresolvedHandoffs", () => listConcernInventory(
    db, { decisionStore, alertStore }, "unresolved", { limit: CONCERN_SUMMARY_LIMIT }, startedAt,
  ));
  const overdue = readDomain("overdueHandoffs", () => listConcernInventory(
    db, { decisionStore, alertStore }, "overdue", { limit: CONCERN_SUMMARY_LIMIT }, startedAt,
  ));
  const quiet = readDomain("quietConcerns", () => listQuietConcerns(
    db, { decisionStore, alertStore }, { limit: CONCERN_SUMMARY_LIMIT }, startedAt,
  ));
  const events = readDomain("digests", () => { eventStore.assertHealthy(); return eventStore.listActiveForDigests(startedAt); });
  const viewed = events ? readDomain("digests", () => new Map(views.list().map((view) => [view.digestId, view.lastViewedAt]))) : undefined;
  const digestById = new Map<string, FocusDigest>();
  for (const event of events ?? []) {
    const dedupeKey = event.dedupeKey?.trim() ?? "";
    const separatorIndex = dedupeKey.indexOf(":");
    const explicitFamily = event.details.sourceFamily;
    const family = explicitFamily ?? (dedupeKey
      ? (separatorIndex > 0 ? dedupeKey.slice(0, separatorIndex) : dedupeKey)
      : event.category);
    const keyPrefix = !explicitFamily && dedupeKey
      ? (separatorIndex > 0 ? `${family}:` : dedupeKey)
      : null;
    const category = explicitFamily || dedupeKey ? null : event.category;
    const taskKey = event.taskState === "orphaned" ? `orphaned:${event.details.originalTaskId ?? event.id}` : event.taskId ?? "__global__";
    const sourceKey = explicitFamily ? `family:${explicitFamily}` : keyPrefix ?? `category:${category}`;
    const id = JSON.stringify([taskKey, sourceKey]);
    let digest = digestById.get(id);
    if (!digest) {
      digest = {
        id,
        family,
        keyPrefix,
        category,
        taskId: event.taskId,
        taskTitle: event.taskTitle,
        quiet: ["muted", "archived", "orphaned"].includes(event.taskState),
        sourceFamily: explicitFamily,
        originalTaskId: event.details.originalTaskId,
        orphaned: event.taskState === "orphaned",
        lastViewedAt: viewed?.get(id) ?? null,
        newCount: 0,
        count: 0,
        highPriorityCount: 0,
        latestUpdatedAt: event.details.lastMeaningfulChangeAt,
        samples: [],
      };
      digestById.set(id, digest);
    }
    digest.count += 1;
    if (!digest.lastViewedAt || event.details.lastMeaningfulChangeAt > digest.lastViewedAt) digest.newCount += 1;
    if (event.priority === "high") digest.highPriorityCount += 1;
    if (event.details.lastMeaningfulChangeAt > digest.latestUpdatedAt) digest.latestUpdatedAt = event.details.lastMeaningfulChangeAt;
    if (digest.samples.length < DIGEST_SAMPLE_LIMIT) {
      digest.samples.push({
        id: event.id,
        title: event.title,
        category: event.category,
        priority: event.priority,
        updatedAt: event.details.lastMeaningfulChangeAt,
      });
    }
  }

  const digests = [...digestById.values()].sort((left, right) => {
    if (left.quiet !== right.quiet) return left.quiet ? 1 : -1;
    const latestCompare = right.latestUpdatedAt.localeCompare(left.latestUpdatedAt);
    if (latestCompare !== 0) return latestCompare;
    if (right.count !== left.count) return right.count - left.count;
    return left.id.localeCompare(right.id);
  });

  const assertions = readDomain("coverage", () => coverageStore.all(startedAt));
  if (assertions?.length === 0) domainHealth.coverage = { status: "unknown", error: "No coverage assertions; absence of alerts is not proof of coverage" };
  const authorityConstraints = readDomain("authority", () => {
    const at = new Date(startedAt).toISOString();
    return createFocusAuthorityStore(db).list({ limit: 500 }).map((grant) => ({
      ...grant, currentlyActive: grant.status === "active" && !grant.orphanedAt && grant.validFrom <= at && grant.validUntil > at,
    }));
  }) ?? [];
  const auditExceptions = readDomain("audits", () => createFocusAuditStore(db).list({ status: "open", limit: 100 })) ?? [];
  const errors = readDomain("compatibility", compatibilityErrorCount) ?? null;
  if (errors && errors > 0) domainHealth.compatibility = { status: "error", error: `${errors} quarantined compatibility rows` };
  const attentionTotal = alertTotal === null || decisionTotal === null || actionTotal === null ? null : alertTotal + decisionTotal + actionTotal;
  const temporal = readDomain("telemetry", () => {
    const handedOffTotal = Number(db.prepare(`SELECT COUNT(*) AS count FROM focus_object_details d
      WHERE d.lifecycle='handed_off' AND NOT EXISTS (SELECT 1 FROM focus_legacy_reconciliation_issues q WHERE q.feedCardId=d.objectId)`).get()?.count ?? 0);
    const upcomingInterventions = db.prepare(`SELECT i.id AS objectId, i.objectType,
      COALESCE(d.title, a.title, e.title) AS title, details.interventionBy, details.lifecycle
      FROM focus_object_identities i JOIN focus_object_details details ON details.objectId = i.id
      LEFT JOIN decisions d ON d.id = i.id LEFT JOIN alerts a ON a.id = i.id LEFT JOIN focus_events e ON e.id = i.id
      LEFT JOIN tasks t ON t.id=COALESCE(d.taskId,a.taskId,e.taskId)
      WHERE details.lifecycle IN ('active','acknowledged','handed_off') AND details.interventionBy IS NOT NULL
        AND (i.objectType='alert' OR (details.orphanedAt IS NULL AND (
          COALESCE(d.taskId,e.taskId) IS NULL OR (t.status='active' AND t.muted=0))))
        AND NOT EXISTS (SELECT 1 FROM focus_legacy_reconciliation_issues q WHERE q.feedCardId=i.id)
      ORDER BY details.interventionBy, i.id LIMIT 100`).all() as unknown as FocusIntervention[];
    const hiddenDecisions = Number(db.prepare(`SELECT COUNT(*) AS count FROM decisions d
      JOIN focus_object_details details ON details.objectId=d.id LEFT JOIN tasks t ON t.id=d.taskId
      WHERE details.lifecycle IN ('active','acknowledged') AND (details.orphanedAt IS NOT NULL OR t.muted=1 OR t.status='archived')`).get()?.count ?? 0);
    if (hiddenDecisions > 0) attention.record({ eventType: "muted_attention_excluded", details: { count: hiddenDecisions } });
    attention.record({ eventType: "snapshot", details: {
      alertTotal, decisionTotal, actionTotal, handedOffTotal, digestCount: digests.filter((d) => !d.quiet).length,
      unresolvedHandoffTotal: unresolved?.total ?? null, overdueHandoffTotal: overdue?.total ?? null, quietConcernTotal: quiet?.total ?? null,
      quietDigestCount: digests.filter((d) => d.quiet).length, compatibilityErrorCount: errors, domainHealth,
    } });
    telemetryStore?.recordSpan({ name: "focus.snapshot", duration: Date.now() - startedAt, source: "server" });
    return { handedOffTotal, upcomingInterventions };
  });
  const summary = assertions ? coverageStore.summarize(assertions) : null;
  return {
    generatedAt: new Date().toISOString(),
    alertTotal, decisionTotal, actionTotal, attentionTotal,
    handedOffTotal: temporal?.handedOffTotal ?? null,
    unresolvedHandoffTotal: unresolved?.total ?? null,
    unresolvedHandoffs: (unresolved?.objects ?? []).map((object) => ({
      ...concernSummary(object), lifecycle: "handed_off",
    })),
    overdueHandoffTotal: overdue?.total ?? null,
    overdueHandoffs: (overdue?.objects ?? []).map((object) => ({
      ...concernSummary(object), lifecycle: "handed_off", interventionBy: object.details.interventionBy!, attentionVisible: true,
    })),
    quietConcernTotal: quiet?.total ?? null,
    quietConcerns: (quiet?.objects ?? []).map((object) => ({
      ...concernSummary(object), attentionVisible: false, suppressionReason: object.suppressionReason,
    })),
    digests: digests.filter((digest) => !digest.quiet),
    quietDigests: digests.filter((digest) => digest.quiet),
    domainHealth,
    allClear: attentionTotal === 0 && unresolved?.total === 0 && overdue?.total === 0
      && Object.values(domainHealth).every((health) => health.status === "ok")
      && summary !== null && summary.total > 0 && summary.counts.valid === summary.total && auditExceptions.length === 0,
    coverage: { summary, assertions: assertions ?? [] },
    upcomingInterventions: temporal?.upcomingInterventions ?? [], authorityConstraints, auditExceptions,
    compatibilityErrorCount: errors,
  };
}

export function listFocusDecisions(
  decisionStore: DecisionStore,
  options: { status?: FocusDecision["status"]; offset?: number; limit?: number } = {},
): FocusObjectPage<FocusDecision> {
  return options.status === undefined || options.status === "active"
    ? decisionStore.listAttentionPage(options)
    : decisionStore.listPage(options);
}

export function listFocusAlerts(
  alertStore: AlertStore,
  options: { status?: FocusAlert["status"]; offset?: number; limit?: number } = {},
): FocusObjectPage<FocusAlert> {
  return options.status === undefined || options.status === "active"
    ? alertStore.listAttentionPage(options)
    : alertStore.listPage(options);
}

export function listFocusCleared({
  db,
  decisionStore,
  alertStore,
  eventStore,
  offset = 0,
  limit = 20,
}: {
  db: DatabaseSync;
  decisionStore: DecisionStore;
  alertStore: AlertStore;
  eventStore: FocusEventStore;
  offset?: number;
  limit?: number;
}): FocusObjectPage<FocusObject> {
  if (!Number.isInteger(offset) || offset < 0) {
    throw new FeedCardValidationError("offset must be a non-negative integer");
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new FeedCardValidationError("limit must be an integer from 1 to 100");
  }
  const totalRow = db.prepare(`
    SELECT COUNT(*) AS count
    FROM (
      SELECT id FROM decisions WHERE status IN ('done', 'dismissed')
      UNION ALL
      SELECT id FROM alerts WHERE status IN ('done', 'dismissed')
      UNION ALL
      SELECT id FROM focus_events WHERE status IN ('done', 'dismissed')
    )
    WHERE id NOT IN (
      SELECT feedCardId FROM focus_legacy_reconciliation_issues WHERE feedCardId IS NOT NULL
    )
  `).get() as { count?: number };
  const rows = db.prepare(`
    SELECT id, objectType
    FROM (
      SELECT id, 'decision' AS objectType, statusChangedAt, updatedAt
      FROM decisions
      WHERE status IN ('done', 'dismissed')
      UNION ALL
      SELECT id, 'alert' AS objectType, statusChangedAt, updatedAt
      FROM alerts
      WHERE status IN ('done', 'dismissed')
      UNION ALL
      SELECT id, 'event' AS objectType, statusChangedAt, updatedAt
      FROM focus_events
      WHERE status IN ('done', 'dismissed')
    )
    WHERE id NOT IN (
      SELECT feedCardId FROM focus_legacy_reconciliation_issues WHERE feedCardId IS NOT NULL
    )
    ORDER BY statusChangedAt DESC, updatedAt DESC, id DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset) as Array<{ id: string; objectType: FocusObjectType }>;
  const objects = rows
    .map((row) => objectFromStores(row.objectType, row.id, {
      decisionStore,
      alertStore,
      eventStore,
    }))
    .filter((object): object is FocusObject => object !== undefined);
  const total = Number(totalRow.count) || 0;
  const nextOffset = offset + rows.length < total ? offset + rows.length : null;
  return { objects, total, nextOffset };
}

type TransitionRow = Omit<FocusTransition, "details"> & { detailsJson: string };
function hydrateTransition(row: TransitionRow): FocusTransition {
  const { detailsJson, ...transition } = row;
  return { ...transition, details: JSON.parse(detailsJson) as FocusTransitionDetails };
}

// Match individual historical states, not a mix of today's task/lifecycle and an
// older result. Keep the matched transition separate from the latest-100 window.
const HISTORY_SOURCE = `WITH live_focus AS (
  SELECT id, 'decision' AS objectType, title, body, updatedAt, activationId, taskId FROM decisions
  UNION ALL SELECT id, 'alert', title, body, updatedAt, activationId, taskId FROM alerts
  UNION ALL SELECT id, 'event', title, body, updatedAt, activationId, taskId FROM focus_events
), live AS (
  SELECT o.id, o.objectType, o.title, o.body, o.updatedAt, o.activationId, o.taskId,
    COALESCE(task.title, d.originalTaskTitle) AS taskTitle, d.originalTaskId, d.originalTaskTitle,
    d.lifecycle, d.sourceFamily, d.producer, d.outcome, d.resolutionReason
  FROM live_focus o LEFT JOIN focus_object_details d ON d.objectId=o.id LEFT JOIN tasks task ON task.id=o.taskId
  UNION ALL
  SELECT c.id, 'action', c.text, NULL, COALESCE(c.completedAt, c.createdAt), c.id, c.taskId,
    COALESCE(task.title, d.originalTaskTitle), d.originalTaskId, d.originalTaskTitle,
    CASE WHEN c.done=1 THEN 'resolved' ELSE 'active' END, NULL, NULL, NULL, NULL
  FROM checklist_items c LEFT JOIN focus_action_details d ON d.actionId=c.id LEFT JOIN tasks task ON task.id=c.taskId
), objects AS (
  SELECT live.id, live.objectType, live.title, MAX(live.updatedAt, COALESCE((
    SELECT MAX(createdAt) FROM focus_transitions WHERE objectId=live.id
  ), live.updatedAt)) AS updatedAt FROM live
  UNION ALL SELECT t.objectId, t.objectType, t.title, t.createdAt FROM focus_transitions t
  WHERE NOT EXISTS (SELECT 1 FROM live WHERE live.id=t.objectId)
    AND t.rowid = (SELECT latest.rowid FROM focus_transitions latest WHERE latest.objectId=t.objectId
      ORDER BY latest.createdAt DESC, latest.rowid DESC LIMIT 1)
), candidate AS (
  SELECT live.*, 'current' AS matchSource, NULL AS transitionId, 0 AS sourceRank, updatedAt AS matchedAt, 0 AS transitionOrder FROM live
  UNION ALL
  SELECT t.objectId, json_extract(t.detailsJson, '$.previousEpisode.objectType'),
    json_extract(t.detailsJson, '$.previousEpisode.title'), json_extract(t.detailsJson, '$.previousEpisode.body'),
    json_extract(t.detailsJson, '$.previousEpisode.updatedAt'), json_extract(t.detailsJson, '$.previousEpisode.activationId'),
    json_extract(t.detailsJson, '$.previousEpisode.taskId'), json_extract(t.detailsJson, '$.previousEpisode.taskTitle'),
    json_extract(t.detailsJson, '$.previousEpisode.originalTaskId'), json_extract(t.detailsJson, '$.previousEpisode.originalTaskTitle'),
    json_extract(t.detailsJson, '$.previousEpisode.lifecycle'), json_extract(t.detailsJson, '$.previousEpisode.sourceFamily'),
    json_extract(t.detailsJson, '$.previousEpisode.producer'), json_extract(t.detailsJson, '$.previousEpisode.outcome'),
    json_extract(t.detailsJson, '$.previousEpisode.resolutionReason'), 'previous_episode', t.id, 1, t.createdAt, t.rowid
  FROM focus_transitions t WHERE json_type(t.detailsJson, '$.previousEpisode')='object'
  UNION ALL
  SELECT t.objectId, t.objectType, t.title,
    COALESCE(json_extract(t.detailsJson, '$.object.body'), json_extract(t.detailsJson, '$.body')),
    t.createdAt, t.activationId,
    COALESCE(json_extract(t.detailsJson, '$.object.taskId'), json_extract(t.detailsJson, '$.taskId')),
    COALESCE(json_extract(t.detailsJson, '$.object.taskTitle'), json_extract(t.detailsJson, '$.taskTitle')),
    COALESCE(json_extract(t.detailsJson, '$.object.details.originalTaskId'), json_extract(t.detailsJson, '$.originalTaskId')),
    COALESCE(json_extract(t.detailsJson, '$.object.details.originalTaskTitle'), json_extract(t.detailsJson, '$.originalTaskTitle')),
    COALESCE(json_extract(t.detailsJson, '$.object.lifecycle'), t.toLifecycle, t.fromLifecycle),
    COALESCE(json_extract(t.detailsJson, '$.object.details.sourceFamily'), json_extract(t.detailsJson, '$.sourceFamily')),
    COALESCE(json_extract(t.detailsJson, '$.object.details.producer'), json_extract(t.detailsJson, '$.producer')),
    COALESCE(json_extract(t.detailsJson, '$.object.details.outcome'), json_extract(t.detailsJson, '$.outcome')),
    COALESCE(json_extract(t.detailsJson, '$.object.details.resolutionReason'), json_extract(t.detailsJson, '$.resolutionReason'), t.reason),
    'transition', t.id, 2, t.createdAt, t.rowid
  FROM focus_transitions t
)`;

export function createFocusProjectionService({
  db,
  taskStore,
  decisionStore,
  alertStore,
  eventStore,
  compatibilityErrorCount,
  telemetryStore,
}: {
  db: DatabaseSync;
  taskStore: TaskStore;
  decisionStore: DecisionStore;
  alertStore: AlertStore;
  eventStore: FocusEventStore;
  compatibilityErrorCount: () => number;
  telemetryStore?: TelemetryStore;
}) {
  const transitionStore = createFocusTransitionStore(db);
  const digestViews = createFocusDigestViewStore(db);
  function listHistory(options: FocusHistoryOptions = {}): FocusHistoryPage {
    const limit = focusInteger(options.limit ?? 20, "limit", 1, 100);
    const offset = focusInteger(options.offset ?? 0, "offset", 0, 1_000_000);
    const { predicates, values } = filterSql(normalizeFocusReadFilters(options));
    if (options.objectId !== undefined) { predicates.push("candidate.id = ?"); values.push(focusText(options.objectId, "objectId")!); }
    if (options.objectType !== undefined) {
      predicates.push("candidate.objectType = ?");
      values.push(focusEnum(options.objectType, "objectType", ["decision", "alert", "event", "action"] as const));
    }
    const source = `${HISTORY_SOURCE}, matches AS (
      SELECT id, matchSource, transitionId,
        ROW_NUMBER() OVER (PARTITION BY id ORDER BY sourceRank, matchedAt DESC, transitionOrder DESC) AS matchRank
      FROM candidate ${predicates.length ? `WHERE ${predicates.join(" AND ")}` : ""}
    )`;
    const selection = "FROM objects JOIN matches ON matches.id=objects.id AND matches.matchRank=1";
    const total = Number(db.prepare(`${source} SELECT COUNT(*) AS count ${selection}`).get(...values)?.count ?? 0);
    const rows = db.prepare(`${source} SELECT objects.*, matches.matchSource, matches.transitionId ${selection}
      ORDER BY objects.updatedAt DESC, objects.id DESC LIMIT ? OFFSET ?`)
      .all(...values, limit, offset) as Array<{
        id: string; objectType: FocusObjectType | "action"; title: string; updatedAt: string;
        matchSource: FocusHistoryEntry["matchSource"]; transitionId: string | null;
      }>;
    const actionStore = createChecklistStore(db, { emit() {}, subscribe() { return () => {}; } });
    const objects: FocusHistoryEntry[] = rows.map(({ transitionId, ...row }) => {
      const object = row.objectType === "action" ? actionStore.getChecklistItem(row.id)
        : objectFromStores(row.objectType, row.id, { decisionStore, alertStore, eventStore });
      const transitionTotal = Number(db.prepare("SELECT COUNT(*) AS count FROM focus_transitions WHERE objectId=?").get(row.id)?.count ?? 0);
      const quarantined = Boolean(db.prepare("SELECT 1 FROM focus_legacy_reconciliation_issues WHERE feedCardId=?").get(row.id));
      const matchedTransition = transitionId
        ? hydrateTransition(db.prepare("SELECT * FROM focus_transitions WHERE id=?").get(transitionId) as TransitionRow)
        : null;
      return {
        ...row, object: object ?? null, deleted: object === undefined && !quarantined, quarantined,
        transitions: transitionStore.list(row.id), transitionTotal, matchedTransition,
        matchedEpisode: row.matchSource === "previous_episode" ? matchedTransition?.details.previousEpisode ?? null : null,
      };
    });
    return { objects, total, nextOffset: offset + rows.length < total ? offset + rows.length : null };
  }

  function getEpisode(objectId: string, activationId: string, options: { limit?: number; offset?: number } = {}): FocusEpisodeRead {
    const id = focusText(objectId, "objectId")!;
    const episodeId = focusText(activationId, "activationId")!;
    const limit = focusInteger(options.limit ?? 100, "limit", 1, 100);
    const offset = focusInteger(options.offset ?? 0, "offset", 0, 1_000_000);
    const identity = db.prepare("SELECT objectType FROM focus_object_identities WHERE id=?").get(id) as { objectType: FocusObjectType } | undefined;
    const currentObject = identity ? objectFromStores(identity.objectType, id, { decisionStore, alertStore, eventStore }) ?? null : null;
    const isCurrentEpisode = currentObject?.activationId === episodeId;
    const predicate = `objectId=? AND objectType IN ('decision','alert','event')
      AND (activationId=? OR json_extract(detailsJson, '$.previousEpisode.activationId')=?)`;
    const values = [id, episodeId, episodeId];
    const transitionTotal = Number(db.prepare(`SELECT COUNT(*) AS count FROM focus_transitions WHERE ${predicate}`).get(...values)?.count ?? 0);
    if (!isCurrentEpisode && transitionTotal === 0) throw new FeedCardNotFoundError(`Focus episode ${episodeId} for ${id} not found`);
    const transitions = (db.prepare(`SELECT * FROM focus_transitions WHERE ${predicate}
      ORDER BY createdAt DESC, rowid DESC LIMIT ? OFFSET ?`).all(...values, limit, offset) as TransitionRow[]).map(hydrateTransition);
    const retained = db.prepare(`SELECT * FROM focus_transitions
      WHERE objectId=? AND json_extract(detailsJson, '$.previousEpisode.activationId')=?
      ORDER BY createdAt DESC, rowid DESC LIMIT 1`).get(id, episodeId) as TransitionRow | undefined;
    const previousEpisode = retained ? hydrateTransition(retained).details.previousEpisode ?? null : null;
    const quarantined = Boolean(db.prepare("SELECT 1 FROM focus_legacy_reconciliation_issues WHERE feedCardId=?").get(id));
    return {
      objectId: id, activationId: episodeId, currentObject, isCurrentEpisode, previousEpisode, transitions, transitionTotal,
      nextOffset: offset + transitions.length < transitionTotal ? offset + transitions.length : null,
      deleted: currentObject === null && !quarantined, quarantined,
      historyIncomplete: !isCurrentEpisode && previousEpisode === null,
    };
  }
  return {
    getSnapshot: () => buildFocusSnapshot({
      db,
      taskStore,
      decisionStore,
      alertStore,
      eventStore,
      compatibilityErrorCount,
      telemetryStore,
    }),
    listDecisions: (
      options: { status?: FocusDecision["status"]; offset?: number; limit?: number } = {},
    ) => listFocusDecisions(decisionStore, options),
    listAlerts: (
      options: { status?: FocusAlert["status"]; offset?: number; limit?: number } = {},
    ) => listFocusAlerts(alertStore, options),
    listEventDigest: (options: {
      taskId: string | null;
      keyPrefix?: string;
      category?: string;
      sourceFamily?: string;
      orphanedTaskId?: string;
      offset?: number;
      limit?: number;
    }) => eventStore.listDigestPage(options),
    listHistory,
    getEpisode,
    listQuietConcerns: (options: FocusConcernListOptions = {}) => listQuietConcerns(db, { decisionStore, alertStore }, options),
    listTransitions: transitionStore.list,
    markDigestViewed: (digestId: string, viewedAt?: string) => {
      const view = digestViews.markViewed(digestId, viewedAt);
      createFocusAttentionStore(db).record({ eventType: "digest_viewed", actor: "user", details: { digestId, lastViewedAt: view.lastViewedAt } });
      return view;
    },
    listCleared: (options: { offset?: number; limit?: number } = {}) => listFocusCleared({
      db,
      decisionStore,
      alertStore,
      eventStore,
      ...options,
    }),
  };
}

export interface FocusHistoryEntry {
  id: string; objectType: FocusObjectType | "action"; title: string; updatedAt: string;
  object: FocusObject | ChecklistItem | null; deleted: boolean; transitions: FocusTransition[]; transitionTotal: number;
  quarantined: boolean;
  matchSource: "current" | "previous_episode" | "transition";
  matchedEpisode: FocusEpisodeSnapshot | null;
  matchedTransition: FocusTransition | null;
}
export interface FocusHistoryPage { objects: FocusHistoryEntry[]; total: number; nextOffset: number | null }
export interface FocusEpisodeRead {
  objectId: string;
  activationId: string;
  currentObject: FocusObject | null;
  isCurrentEpisode: boolean;
  previousEpisode: FocusEpisodeSnapshot | null;
  transitions: FocusTransition[];
  transitionTotal: number;
  nextOffset: number | null;
  deleted: boolean;
  quarantined: boolean;
  historyIncomplete: boolean;
}
export type FocusProjectionService = ReturnType<typeof createFocusProjectionService>;
