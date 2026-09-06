import type { DatabaseSync } from "./db.js";
import { runImmediateTransaction } from "./db-transaction.js";
import type { GlobalBus } from "./global-bus.js";
import type { ChecklistItem, ChecklistStore } from "./checklist-store.js";
import {
  FeedCardNotFoundError,
  FeedCardValidationError,
  hydrateFeedCardRow,
  normalizeFeedCreateId,
  normalizeFeedCreateInput,
  normalizeFeedDedupeKey,
  normalizeFeedUpdateInput,
  normalizeTrustedFeedVisual,
  type FeedCard,
  type FeedCardMutationInput,
  type FeedCardMutationOptions,
  type FeedCardSaveResult,
  type FeedCardStatus,
  type FeedCardVisual,
  type NormalizedFeedCreateFields,
  type NormalizedFeedUpdateFields,
} from "./feed-store.js";
import type {
  AlertStore,
  DecisionStore,
  FocusAlert,
  FocusDecision,
  FocusEvent,
  FocusEventStore,
  FocusIdentityStore,
  FocusObject,
  FocusObjectType,
} from "./focus-domain-store.js";
import {
  createFocusDetailsStore, defaultFocusDetails, FOCUS_DETAIL_FIELDS, focusBoolean, focusFingerprint,
  focusText, isOpenLifecycle, legacyStatusToLifecycle, lifecycleToLegacyStatus, normalizeFocusDetailUpdates,
  type FocusActor, type FocusDetailsStore, type FocusMutationInput, type FocusObjectDetails,
} from "./focus-details-store.js";
import {
  createFocusAttentionStore, createFocusTransitionStore,
  type FocusAttentionStore, type FocusEpisodeActionLink, type FocusEpisodeSnapshot,
  type FocusTransition, type FocusTransitionStore,
} from "./focus-attention-store.js";
import { createFocusAuthorityStore, type FocusAuthorityStore } from "./focus-governance-store.js";
import { backfillFocusDetails } from "./focus-schema.js";
import {
  createFocusLegacyProjectionStore, initializeFocusLegacyProjectionSchema, type LegacyProjectionRow,
} from "./focus-legacy-projection-store.js";

export interface FocusMutationCoordinatorOptions {
  onVisualUnreferenced?: (visual: FeedCardVisual, object: FocusObject) => void;
}

interface CanonicalFields extends NormalizedFeedCreateFields {
  id: string;
  objectType: FocusObjectType;
  category?: string;
  activationId: string;
  statusChangedAt: string;
  createdAt: string;
  updatedAt: string;
}

interface SaveOptions extends FeedCardMutationOptions {
  id?: string;
  forceType?: FocusObjectType;
  eventCategory?: string;
  actor?: FocusActor;
  relatedActionId?: string;
}

const RESERVED_EVENT_CATEGORIES = new Set(["decision", "alert"]);

function hasOwn(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function assertUpdateFields(
  input: FocusMutationInput,
  options: { visualMutation?: boolean; categoryChanged?: boolean } = {},
): void {
  if (input.key !== undefined || input.dedupeKey !== undefined) {
    throw new FeedCardValidationError("Focus keys cannot be changed by an ID update; use keyed upsert");
  }
  const fields = Object.keys(input as Record<string, unknown>)
    .filter((field) => field !== "key" && field !== "dedupeKey" && field !== "kind");
  if (fields.length === 0 && !options.visualMutation && !options.categoryChanged) {
    throw new FeedCardValidationError("No fields to update");
  }
}

function mapLegacyKind(kind: string): { objectType: FocusObjectType; category?: string } {
  if (kind === "decision") return { objectType: "decision" };
  if (kind === "alert") return { objectType: "alert" };
  return { objectType: "event", category: kind };
}

function assertEventCategory(category: string): void {
  if (RESERVED_EVENT_CATEGORIES.has(category)) {
    throw new FeedCardValidationError(`event category cannot be ${category}`);
  }
}

function objectToCreateFields(object: FeedCard): NormalizedFeedCreateFields {
  return {
    dedupeKey: object.dedupeKey,
    title: object.title,
    body: object.body,
    kind: object.kind,
    priority: object.priority,
    status: object.status,
    taskId: object.taskId,
    sessionId: object.sessionId,
    url: object.url,
    linksJson: JSON.stringify(object.links),
    metadataJson: object.metadata === null ? null : JSON.stringify(object.metadata),
    visualJson: object.visual === null ? null : JSON.stringify(object.visual),
    actionJson: object.action === null ? null : JSON.stringify(object.action),
    pinned: object.pinned,
  };
}

function applyUpdates(
  existing: FocusObject,
  updates: NormalizedFeedUpdateFields,
  visualJson: string | null | undefined,
): NormalizedFeedCreateFields {
  const current = objectToCreateFields(existing);
  return {
    dedupeKey: current.dedupeKey,
    title: typeof updates.title === "string" ? updates.title : current.title,
    body: updates.body === undefined ? current.body : updates.body as string | null,
    kind: typeof updates.kind === "string" ? updates.kind : current.kind,
    priority: updates.priority === "low" || updates.priority === "normal" || updates.priority === "high"
      ? updates.priority
      : current.priority,
    status: updates.status === "active" || updates.status === "done" || updates.status === "dismissed"
      ? updates.status
      : current.status,
    taskId: updates.taskId === undefined ? current.taskId : updates.taskId as string | null,
    sessionId: updates.sessionId === undefined ? current.sessionId : updates.sessionId as string | null,
    url: updates.url === undefined ? current.url : updates.url as string | null,
    linksJson: typeof updates.linksJson === "string" ? updates.linksJson : current.linksJson,
    metadataJson: updates.metadataJson === undefined
      ? current.metadataJson
      : updates.metadataJson as string | null,
    visualJson: visualJson !== undefined
      ? visualJson
      : updates.visualJson === undefined
        ? current.visualJson
        : updates.visualJson as string | null,
    actionJson: updates.actionJson === undefined
      ? current.actionJson
      : updates.actionJson as string | null,
    pinned: updates.pinned === undefined ? current.pinned : updates.pinned === 1,
  };
}

function rowToCanonicalFields(
  card: FeedCard,
  existing: FocusObject | undefined,
): CanonicalFields {
  const mapped = mapLegacyKind(card.kind);
  const activationId = existing
    && existing.objectType === mapped.objectType
    && !(existing.status !== "active" && card.status === "active")
      ? existing.activationId
      : crypto.randomUUID();
  return {
    id: card.id,
    objectType: mapped.objectType,
    ...(mapped.category ? { category: mapped.category } : {}),
    dedupeKey: card.dedupeKey,
    title: card.title,
    body: card.body,
    kind: card.kind,
    priority: card.priority,
    status: card.status,
    taskId: card.taskId,
    sessionId: card.sessionId,
    url: card.url,
    linksJson: JSON.stringify(card.links),
    metadataJson: card.metadata === null ? null : JSON.stringify(card.metadata),
    visualJson: card.visual === null ? null : JSON.stringify(card.visual),
    actionJson: card.action === null ? null : JSON.stringify(card.action),
    pinned: card.pinned,
    activationId,
    statusChangedAt: card.statusChangedAt,
    createdAt: card.createdAt,
    updatedAt: card.updatedAt,
  };
}

function semanticFingerprint(fields: NormalizedFeedCreateFields, details: FocusObjectDetails): string {
  const attentionObject = fields.kind === "decision" || fields.kind === "alert";
  return focusFingerprint({
    ...fields,
    linksJson: JSON.parse(fields.linksJson),
    metadataJson: fields.metadataJson === null ? null : JSON.parse(fields.metadataJson),
    visualJson: fields.visualJson === null ? null : JSON.parse(fields.visualJson),
    actionJson: fields.actionJson === null ? null : JSON.parse(fields.actionJson),
    details: Object.fromEntries(FOCUS_DETAIL_FIELDS
      .filter((key) => key !== "observedAt" && (key !== "validUntil" || !attentionObject))
      .map((key) => [key, details[key]])),
    provenance: { originalTaskId: details.originalTaskId, originalTaskTitle: details.originalTaskTitle, orphanedAt: details.orphanedAt },
  });
}

function stripDetailInput(input: FocusMutationInput): FeedCardMutationInput {
  const result: Record<string, unknown> = { ...input };
  for (const key of [...FOCUS_DETAIL_FIELDS, "lifecycleReason", "newEpisode", "expectedActivationId", "recurring", "question"]) delete result[key];
  if (input.question !== undefined) {
    const question = focusText(input.question, "question")!;
    if (input.title === undefined) result.title = question;
  }
  return result;
}

interface MutationResult {
  object: FocusObject;
  card: FeedCard;
  created: boolean;
  meaningful: boolean;
  transition?: FocusTransition;
  previous?: FocusObject;
  observationRefreshed?: boolean;
}

export interface FocusReconciliationStats {
  scanned: number;
  hydrated: number;
  unchanged: number;
  imported: number;
  deleted: number;
  quarantined: number;
}

export function createFocusMutationCoordinator({
  db,
  bus,
  decisionStore,
  alertStore,
  eventStore,
  identityStore,
  detailsStore = createFocusDetailsStore(db),
  transitionStore = createFocusTransitionStore(db),
  attentionStore = createFocusAttentionStore(db),
  authorityStore = createFocusAuthorityStore(db),
  options = {},
}: {
  db: DatabaseSync;
  bus: GlobalBus;
  decisionStore: DecisionStore;
  alertStore: AlertStore;
  eventStore: FocusEventStore;
  identityStore: FocusIdentityStore;
  detailsStore?: FocusDetailsStore;
  transitionStore?: FocusTransitionStore;
  attentionStore?: FocusAttentionStore;
  authorityStore?: FocusAuthorityStore;
  options?: FocusMutationCoordinatorOptions;
}) {
  const legacyProjectionStore = createFocusLegacyProjectionStore(db);
  let reconciliationStats: FocusReconciliationStats | null = null;
  function getAny(id: string, includeQuarantined = false): FocusObject | undefined {
    const objectType = identityStore.getType(id);
    if (objectType === "decision") {
      return includeQuarantined
        ? decisionStore.getIncludingQuarantined(id)
        : decisionStore.get(id);
    }
    if (objectType === "alert") {
      return includeQuarantined
        ? alertStore.getIncludingQuarantined(id)
        : alertStore.get(id);
    }
    if (objectType === "event") {
      return includeQuarantined
        ? eventStore.getIncludingQuarantined(id)
        : eventStore.get(id);
    }
    return undefined;
  }

  function snapshotPreviousEpisode(object: FocusObject): FocusEpisodeSnapshot {
    const references = transitionStore.getEpisodeReferences(object.id, object.activationId);
    const linkedActions = db.prepare(`SELECT sourceId, sourceType, activationId, actionId, createdAt
      FROM focus_action_links WHERE sourceId=? ORDER BY createdAt DESC, activationId, actionId`)
      .all(object.id) as unknown as FocusEpisodeActionLink[];
    const legacyPromotion = db.prepare("SELECT checklistItemId FROM feed_card_checklist_promotions WHERE feedCardId=?")
      .get(object.id) as { checklistItemId: string } | undefined;
    return {
      ...structuredClone(object.details),
      schemaVersion: 1,
      objectType: object.objectType,
      title: object.title,
      body: object.body,
      category: object.objectType === "event" ? object.category : null,
      activationId: object.activationId,
      taskId: object.taskId,
      taskTitle: object.taskTitle,
      sessionId: object.sessionId,
      sessionIds: [...new Set([...references.sessionIds, ...(object.sessionId ? [object.sessionId] : [])])].sort(),
      linkedActionIds: [...new Set([
        ...references.actionIds, ...linkedActions.map((link) => link.actionId),
        ...(legacyPromotion ? [legacyPromotion.checklistItemId] : []),
      ])].sort(),
      linkedActions,
      createdAt: object.createdAt,
      updatedAt: object.updatedAt,
      statusChangedAt: object.statusChangedAt,
    };
  }

  function deleteSubtypeRows(id: string): void {
    db.prepare("DELETE FROM decisions WHERE id = ?").run(id);
    db.prepare("DELETE FROM alerts WHERE id = ?").run(id);
    db.prepare("DELETE FROM focus_events WHERE id = ?").run(id);
  }

  function persistCanonical(fields: CanonicalFields): void {
    db.prepare(`
      INSERT INTO focus_object_identities (id, objectType, dedupeKey)
      VALUES (?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        objectType = excluded.objectType,
        dedupeKey = excluded.dedupeKey
    `).run(fields.id, fields.objectType, fields.dedupeKey);
    deleteSubtypeRows(fields.id);
    const values = [
      fields.id,
      fields.title,
      fields.body,
      fields.priority,
      fields.status,
      fields.taskId,
      fields.sessionId,
      fields.url,
      fields.linksJson,
      fields.metadataJson,
      fields.visualJson,
      fields.actionJson,
      fields.pinned ? 1 : 0,
      fields.activationId,
      fields.statusChangedAt,
      fields.createdAt,
      fields.updatedAt,
    ];
    if (fields.objectType === "event") {
      assertEventCategory(fields.category ?? fields.kind);
      db.prepare(`
        INSERT INTO focus_events (
          id, category, title, body, priority, status, taskId, sessionId, url,
          linksJson, metadataJson, visualJson, launchPromptJson, pinned,
          activationId, statusChangedAt, createdAt, updatedAt
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(fields.id, fields.category ?? fields.kind, ...values.slice(1));
    } else {
      const table = fields.objectType === "decision" ? "decisions" : "alerts";
      db.prepare(`
        INSERT INTO ${table} (
          id, title, body, priority, status, taskId, sessionId, url,
          linksJson, metadataJson, visualJson, launchPromptJson, pinned,
          activationId, statusChangedAt, createdAt, updatedAt
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(...values);
    }
    db.prepare("DELETE FROM focus_legacy_reconciliation_issues WHERE feedCardId = ?").run(fields.id);
  }

  function persistFeedProjection(fields: CanonicalFields): FeedCard {
    db.prepare(`
      INSERT INTO feed_cards (
        id, dedupeKey, title, body, kind, priority, status, taskId, sessionId, url,
        linksJson, metadataJson, visualJson, actionJson, pinned,
        statusChangedAt, createdAt, updatedAt
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        dedupeKey = excluded.dedupeKey,
        title = excluded.title,
        body = excluded.body,
        kind = excluded.kind,
        priority = excluded.priority,
        status = excluded.status,
        taskId = excluded.taskId,
        sessionId = excluded.sessionId,
        url = excluded.url,
        linksJson = excluded.linksJson,
        metadataJson = excluded.metadataJson,
        visualJson = excluded.visualJson,
        actionJson = excluded.actionJson,
        pinned = excluded.pinned,
        statusChangedAt = excluded.statusChangedAt,
        createdAt = excluded.createdAt,
        updatedAt = excluded.updatedAt
    `).run(
      fields.id,
      fields.dedupeKey,
      fields.title,
      fields.body,
      fields.kind,
      fields.priority,
      fields.status,
      fields.taskId,
      fields.sessionId,
      fields.url,
      fields.linksJson,
      fields.metadataJson,
      fields.visualJson,
      fields.actionJson,
      fields.pinned ? 1 : 0,
      fields.statusChangedAt,
      fields.createdAt,
      fields.updatedAt,
    );
    const row = db.prepare("SELECT rowid AS feedRowId, * FROM feed_cards WHERE id = ?").get(fields.id) as LegacyProjectionRow;
    legacyProjectionStore.remember(row, "imported");
    return hydrateFeedCardRow(row);
  }

  function emitChanged(object: FocusObject, card: FeedCard, transition?: FocusTransition): void {
    bus.emit({
      type: "focus:changed",
      focusObjectType: object.objectType,
      focusObjectId: object.id,
      taskId: object.taskId ?? undefined,
      activationId: object.activationId,
      transitionId: transition?.id,
      lifecycle: object.lifecycle,
      previousLifecycle: transition?.fromLifecycle ?? undefined,
      reason: transition?.reason,
      meaningful: true,
    });
    bus.emit({
      type: "feed:changed",
      cardId: card.id,
      dedupeKey: card.dedupeKey ?? undefined,
      taskId: card.taskId ?? undefined,
      sessionId: card.sessionId ?? undefined,
    });
  }

  function saveInTransaction(input: FocusMutationInput, saveOptions: SaveOptions = {}): MutationResult {
    const firstClass = saveOptions.forceType !== undefined;
    const actor = saveOptions.actor ?? (firstClass ? "agent" : "legacy");
    const feedInput = firstClass ? stripDetailInput(input) : input;
    const dedupeKey = normalizeFeedDedupeKey(feedInput);
    const requestedId = saveOptions.id ?? saveOptions.createId;
    const existingId = saveOptions.id
      ?? (dedupeKey ? identityStore.getIdByKey(dedupeKey) : undefined)
      ?? saveOptions.createId;
    const existing = existingId ? getAny(existingId, true) : undefined;
    if (requestedId && !existing && saveOptions.id) {
      throw new FeedCardNotFoundError(`Focus object ${requestedId} not found`);
    }
    if (saveOptions.forceType && existing && existing.objectType !== saveOptions.forceType) {
      throw new FeedCardValidationError(
        `dedupeKey belongs to ${existing.objectType}, not ${saveOptions.forceType}`,
      );
    }
    if (input.expectedActivationId !== undefined) {
      const expected = focusText(input.expectedActivationId, "expectedActivationId");
      if (existing?.activationId !== expected) throw new FeedCardValidationError("Focus activation changed; reload before mutating");
    }

    let normalized: NormalizedFeedCreateFields;
    if (existing) {
      const updates = normalizeFeedUpdateInput(feedInput, { allowIdentityFields: true });
      if (Object.keys(updates).length === 0 && !Object.prototype.hasOwnProperty.call(saveOptions, "visual")
        && !FOCUS_DETAIL_FIELDS.some((field) => Object.prototype.hasOwnProperty.call(input, field)) && input.newEpisode === undefined) {
        throw new FeedCardValidationError("No fields to update");
      }
      const visualJson = Object.prototype.hasOwnProperty.call(saveOptions, "visual")
        ? normalizeTrustedFeedVisual(saveOptions.visual ?? null, existing.id)
        : undefined;
      normalized = applyUpdates(existing, updates, visualJson);
      normalized.dedupeKey = dedupeKey ?? existing.dedupeKey;
    } else {
      const visualJson = Object.prototype.hasOwnProperty.call(saveOptions, "visual")
        ? normalizeTrustedFeedVisual(saveOptions.visual ?? null, requestedId)
        : null;
      normalized = {
        ...normalizeFeedCreateInput(feedInput),
        visualJson,
      };
    }

    const mapped = saveOptions.forceType
      ? {
          objectType: saveOptions.forceType,
          ...(saveOptions.forceType === "event"
            ? { category: saveOptions.eventCategory ?? normalized.kind }
            : {}),
        }
      : mapLegacyKind(normalized.kind);
    if (!existing && mapped.objectType === "alert" && !hasOwn(input as Record<string, unknown>, "priority")) {
      normalized.priority = "high";
    }
    if (mapped.objectType === "event") assertEventCategory(mapped.category ?? normalized.kind);
    normalized.kind = mapped.objectType === "event" ? mapped.category ?? normalized.kind : mapped.objectType;
    const now = new Date().toISOString();
    const typeChanged = Boolean(existing && existing.objectType !== mapped.objectType);
    let details = existing ? { ...existing.details } : defaultFocusDetails(existingId ?? "", now);
    if (!firstClass && !existing) {
      const key = normalized.dedupeKey;
      details.sourceFamily = key ? key.split(":")[0] : mapped.category ?? mapped.objectType;
      details.producer = "legacy";
      details.observedAt = now;
    }
    if (typeChanged) {
      details = {
        ...details, evidence: [], impact: null, consequenceOfDelay: null, alternatives: [],
        recommendation: null, fallback: null, outcome: null, resolutionReason: null,
        notificationMode: "focus", authorizationGrantId: null, interventionBy: null,
      };
    }
    if (firstClass) {
      const updates = normalizeFocusDetailUpdates(input);
      if (updates.producer === "legacy" && existing?.details.producer !== "legacy") {
        throw new FeedCardValidationError("producer legacy is reserved for compatibility imports");
      }
      details = { ...details, ...updates };
    }
    const legacyStatusChanged = !existing || existing.status !== normalized.status;
    let reason = firstClass && input.lifecycleReason !== undefined
      ? focusText(input.lifecycleReason, "lifecycleReason")!
      : !existing ? "created" : typeChanged ? "reclassified" : "meaningful-update";
    if ((!firstClass || input.lifecycle === undefined) && legacyStatusChanged) {
      details.lifecycle = legacyStatusToLifecycle(normalized.status);
      if (existing) reason = "legacy-status-change";
      if (!firstClass && (details.lifecycle === "resolved" || details.lifecycle === "dismissed")) details.resolutionReason = "legacy-status-change";
    }
    // Older clients launch a prompt and patch status=done. Session creation is
    // acknowledgement, never evidence that the underlying concern was resolved.
    const launching = Boolean(existing?.action && normalized.sessionId && normalized.sessionId !== existing.sessionId);
    if (launching) {
      details.lifecycle = existing!.lifecycle === "handed_off" ? "handed_off"
        : existing!.lifecycle === "active" ? "acknowledged" : existing!.lifecycle;
      reason = "session-launched";
      details.resolutionReason = existing!.details.resolutionReason;
    }
    const newEpisode = firstClass && input.newEpisode !== undefined ? focusBoolean(input.newEpisode, "newEpisode") : false;
    const reactivated = Boolean(existing && !isOpenLifecycle(existing.lifecycle) && isOpenLifecycle(details.lifecycle));
    if (firstClass && (reactivated || newEpisode) && (!newEpisode || !details.episodeReason || input.episodeReason === undefined)) {
      throw new FeedCardValidationError("Reactivation requires newEpisode: true and a non-empty episodeReason");
    }
    if (newEpisode && !isOpenLifecycle(details.lifecycle)) throw new FeedCardValidationError("A new episode must have an open lifecycle");
    if (newEpisode || reactivated) {
      reason = firstClass ? "new-episode" : "legacy-status-change";
      details.acknowledgedAt = null;
      details.handedOffAt = null;
      details.resolvedAt = null;
      details.outcome = null;
      details.resolutionReason = null;
    }
    if (firstClass && !isOpenLifecycle(details.lifecycle) && existing?.lifecycle !== details.lifecycle
      && !launching && input.lifecycleReason === undefined
      && !(input.resolutionReason !== undefined && details.resolutionReason)
      && !(input.outcome !== undefined && details.outcome)) {
      throw new FeedCardValidationError("Clearing a concern requires lifecycleReason, resolutionReason or outcome");
    }
    if (firstClass && input.lifecycleReason !== undefined && !isOpenLifecycle(details.lifecycle)) {
      details.resolutionReason = focusText(input.lifecycleReason, "lifecycleReason")!;
    }
    normalized.status = lifecycleToLegacyStatus(details.lifecycle);
    if (normalized.taskId !== null) {
      const task = db.prepare("SELECT title FROM tasks WHERE id = ?").get(normalized.taskId);
      if (!task) throw new FeedCardValidationError(`Task ${normalized.taskId} not found`);
      if (!existing || existing.taskId !== normalized.taskId) {
        details.originalTaskId = normalized.taskId;
        details.originalTaskTitle = String(task.title);
        details.orphanedAt = null;
      }
    } else if (firstClass && input.taskId === null && existing?.details.orphanedAt) {
      // Explicit reassignment is distinct from FK SET NULL after task deletion.
      details.orphanedAt = null;
    }
    if (firstClass) validateAdmission(mapped.objectType, normalized, details, !existing, input.recurring,
      !existing || newEpisode || details.notificationMode !== existing.details.notificationMode
        || details.authorizationGrantId !== existing.details.authorizationGrantId);
    const currentFingerprint = existing ? semanticFingerprint(objectToCreateFields(existing), existing.details) : null;
    const fingerprint = semanticFingerprint(normalized, details);
    if (existing && currentFingerprint === fingerprint && !newEpisode && !typeChanged) {
      const row = db.prepare("SELECT * FROM feed_cards WHERE id = ?").get(existing.id);
      if (!row) throw new FeedCardNotFoundError(`Feed projection for Focus object ${existing.id} not found`);
      const card = hydrateFeedCardRow(row);
      if (existing.objectType !== "event" && (details.observedAt !== existing.details.observedAt || details.validUntil !== existing.details.validUntil)) {
        detailsStore.refreshObservation(existing.id, details.observedAt, details.validUntil, fingerprint);
        attentionStore.record({
          eventType: "observation_refresh", objectId: existing.id, objectType: existing.objectType,
          activationId: existing.activationId, actor,
          details: { observedAt: details.observedAt, validUntil: details.validUntil },
        });
        return { object: getAny(existing.id)!, card, created: false, meaningful: false, observationRefreshed: true };
      }
      attentionStore.record({ eventType: "no_op", objectId: existing.id, objectType: existing.objectType, activationId: existing.activationId, actor });
      return { object: existing, card, created: false, meaningful: false };
    }
    const lifecycleChanged = !existing || existing.lifecycle !== details.lifecycle;
    if (lifecycleChanged || newEpisode) {
      if (details.lifecycle === "acknowledged") details.acknowledgedAt = now;
      if (details.lifecycle === "handed_off") details.handedOffAt = now;
      if (!isOpenLifecycle(details.lifecycle)) details.resolvedAt = now;
    }
    const statusChanged = !existing || existing.status !== normalized.status;
    const fields: CanonicalFields = {
      ...normalized,
      id: existing?.id ?? normalizeFeedCreateId(requestedId),
      objectType: mapped.objectType,
      ...(mapped.category ? { category: mapped.category } : {}),
      activationId: existing && !reactivated && !typeChanged && !newEpisode
        ? existing.activationId
        : crypto.randomUUID(),
      statusChangedAt: statusChanged ? now : existing!.statusChangedAt,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    details.objectId = fields.id;
    details.contentFingerprint = fingerprint;
    details.lastMeaningfulChangeAt = now;
    const transition = transitionStore.append({
      objectId: fields.id, objectType: fields.objectType, title: fields.title, activationId: fields.activationId,
      fromLifecycle: existing?.lifecycle ?? null, toLifecycle: details.lifecycle, reason, actor,
      sessionId: fields.sessionId, relatedActionId: saveOptions.relatedActionId,
      details: {
        previousType: existing?.objectType ?? null, fingerprint,
        ...(existing ? { previousEpisode: snapshotPreviousEpisode(existing) } : {}),
      },
    });
    if (reactivated || typeChanged || newEpisode) db.prepare("DELETE FROM feed_card_checklist_promotions WHERE feedCardId = ?").run(fields.id);
    persistCanonical(fields);
    detailsStore.save(details);
    const card = persistFeedProjection(fields);
    const object = getAny(fields.id)!;
    const telemetry = { objectId: object.id, objectType: object.objectType, activationId: object.activationId, transitionId: transition.id, actor, reason };
    attentionStore.record({ ...telemetry, eventType: !existing ? "create" : "meaningful_update" });
    if (lifecycleChanged && existing) attentionStore.record({ ...telemetry, eventType: "lifecycle_transition" });
    if (newEpisode || reactivated) attentionStore.record({ ...telemetry, eventType: "reactivation" });
    if (typeChanged || !existing) attentionStore.record({ ...telemetry, eventType: "classification" });
    return { object, card, created: !existing, meaningful: true, transition, previous: existing };
  }

  function validateAdmission(objectType: FocusObjectType, fields: NormalizedFeedCreateFields, details: FocusObjectDetails, creating: boolean, recurring?: unknown, authorizeImmediate = false): void {
    if (recurring !== undefined) focusBoolean(recurring, "recurring");
    // Relaxed imported objects remain editable, but cannot enable immediate delivery
    // until they satisfy the full verified-Alert contract.
    const strict = creating || details.producer !== "legacy" || details.notificationMode === "immediate";
    if (!strict) return;
    if (details.observedAt && Date.parse(details.observedAt) > Date.now()) throw new FeedCardValidationError("observedAt cannot be in the future");
    if (details.validUntil && details.observedAt && details.validUntil <= details.observedAt) throw new FeedCardValidationError("validUntil must be after observedAt");
    if (objectType === "decision") {
      if (details.alternatives.length < 2 || new Set(details.alternatives).size < 2) throw new FeedCardValidationError("A Decision requires at least two distinct alternatives");
      if (!details.recommendation && !details.fallback) throw new FeedCardValidationError("A Decision requires a recommendation or fallback");
      if (details.interventionBy && !details.consequenceOfDelay) throw new FeedCardValidationError("A Decision with interventionBy requires consequenceOfDelay");
      if (details.notificationMode === "immediate") throw new FeedCardValidationError("Only verified Alerts may request immediate notification");
    } else if (objectType === "alert") {
      if (!details.evidence.length || !details.impact || !details.observedAt || !details.sourceFamily || !details.producer || !details.interventionBy) {
        throw new FeedCardValidationError("An Alert requires evidence, impact, observedAt, sourceFamily, producer and interventionBy");
      }
      if (details.notificationMode === "immediate" && authorizeImmediate && isOpenLifecycle(details.lifecycle)) {
        const grant = authorityStore.resolve({
          taskId: fields.taskId, sourceFamily: details.sourceFamily, producer: details.producer,
          authorizationGrantId: details.authorizationGrantId, immediate: true,
        });
        if (!grant) throw new FeedCardValidationError("Immediate Alerts require a currently active matching authority grant permitting immediate notification");
        details.authorizationGrantId = grant.id;
      }
    } else {
      if (!details.sourceFamily || !details.producer || !details.observedAt) throw new FeedCardValidationError("An Event requires sourceFamily, producer and observedAt");
      if ((details.producer || recurring === true) && !fields.dedupeKey) throw new FeedCardValidationError("Producer/recurring Events require a stable key");
      if (details.notificationMode === "immediate") throw new FeedCardValidationError("Events cannot request immediate notification");
    }
  }

  function publishResult(result: MutationResult): void {
    if (!result.meaningful) {
      if (result.observationRefreshed) {
        bus.emit({
          type: "focus:changed", focusObjectType: result.object.objectType, focusObjectId: result.object.id,
          activationId: result.object.activationId, taskId: result.object.taskId ?? undefined,
          lifecycle: result.object.lifecycle, previousLifecycle: result.object.lifecycle,
          reason: "observation-refresh", meaningful: false,
        });
      }
      return;
    }
    emitChanged(result.object, result.card, result.transition);
    if (result.previous?.visual && result.previous.visual.artifactId !== result.object.visual?.artifactId) {
      options.onVisualUnreferenced?.(result.previous.visual, result.previous);
    }
  }

  function save(input: FocusMutationInput, saveOptions: SaveOptions = {}): MutationResult {
    const result = runImmediateTransaction(db, () => saveInTransaction(input, saveOptions));
    publishResult(result);
    return result;
  }

  function saveLegacy(
    input: FeedCardMutationInput,
    mutationOptions: FeedCardMutationOptions = {},
  ): FeedCardSaveResult {
    const result = save(input, mutationOptions);
    return { card: result.card, created: result.created };
  }

  function updateLegacyById(
    id: string,
    input: FeedCardMutationInput,
    mutationOptions: FeedCardMutationOptions = {},
  ): FeedCard {
    const record = input as Record<string, unknown>;
    const attempted = ["key", "dedupeKey"].filter((field) => hasOwn(record, field));
    if (attempted.length > 0) {
      throw new FeedCardValidationError(`Feed card key fields cannot be updated (${attempted.join(", ")})`);
    }
    return save(input, { ...mutationOptions, id }).card;
  }

  function updateLegacyByKey(
    dedupeKey: string,
    input: FeedCardMutationInput,
    mutationOptions: FeedCardMutationOptions = {},
  ): FeedCard {
    const record = input as Record<string, unknown>;
    const attempted = ["key", "dedupeKey"].filter((field) => hasOwn(record, field));
    if (attempted.length > 0) {
      throw new FeedCardValidationError(`Feed card key fields cannot be updated (${attempted.join(", ")})`);
    }
    const id = identityStore.getIdByKey(dedupeKey);
    if (!id) throw new FeedCardNotFoundError(`Feed card with key ${dedupeKey} not found`);
    return save(input, { ...mutationOptions, id }).card;
  }

  function saveDecision(
    input: FocusMutationInput,
    mutationOptions: FeedCardMutationOptions & { actor?: FocusActor } = {},
  ): { decision: FocusDecision; created: boolean } {
    const result = save({ ...input, kind: "decision" }, { ...mutationOptions, forceType: "decision" });
    return { decision: result.object as FocusDecision, created: result.created };
  }

  function updateDecision(
    id: string,
    input: FocusMutationInput,
    mutationOptions: FeedCardMutationOptions & { actor?: FocusActor } = {},
  ): FocusDecision {
    assertUpdateFields(input, {
      visualMutation: hasOwn(mutationOptions as Record<string, unknown>, "visual"),
    });
    return save(
      { ...input, kind: "decision" },
      { ...mutationOptions, id, forceType: "decision" },
    ).object as FocusDecision;
  }

  function saveAlert(
    input: FocusMutationInput,
    mutationOptions: FeedCardMutationOptions & { actor?: FocusActor } = {},
  ): { alert: FocusAlert; created: boolean } {
    const result = save({ ...input, kind: "alert" }, { ...mutationOptions, forceType: "alert" });
    return { alert: result.object as FocusAlert, created: result.created };
  }

  function updateAlert(
    id: string,
    input: FocusMutationInput,
    mutationOptions: FeedCardMutationOptions & { actor?: FocusActor } = {},
  ): FocusAlert {
    assertUpdateFields(input, {
      visualMutation: hasOwn(mutationOptions as Record<string, unknown>, "visual"),
    });
    return save(
      { ...input, kind: "alert" },
      { ...mutationOptions, id, forceType: "alert" },
    ).object as FocusAlert;
  }

  function saveEvent(
    category: string,
    input: FocusMutationInput,
    mutationOptions: FeedCardMutationOptions & { actor?: FocusActor } = {},
  ): { event: FocusEvent; created: boolean } {
    assertEventCategory(category);
    const result = save(
      { ...input, kind: category },
      { ...mutationOptions, forceType: "event", eventCategory: category },
    );
    return { event: result.object as FocusEvent, created: result.created };
  }

  function updateEvent(
    id: string,
    category: string,
    input: FocusMutationInput,
    mutationOptions: FeedCardMutationOptions & { actor?: FocusActor } = {},
  ): FocusEvent {
    const existing = getAny(id, true);
    assertUpdateFields(input, {
      visualMutation: hasOwn(mutationOptions as Record<string, unknown>, "visual"),
      categoryChanged: existing?.objectType === "event" && existing.category !== category,
    });
    assertEventCategory(category);
    return save(
      { ...input, kind: category },
      { ...mutationOptions, id, forceType: "event", eventCategory: category },
    ).object as FocusEvent;
  }

  function deleteById(id: string): boolean {
    const result = runImmediateTransaction(db, () => {
      const existing = getAny(id, true);
      if (!existing) return undefined;
      const transition = recordDeletion(existing, "deleted", "user");
      db.prepare("DELETE FROM feed_card_checklist_promotions WHERE feedCardId = ?").run(id);
      db.prepare("DELETE FROM focus_object_identities WHERE id = ?").run(id);
      db.prepare("DELETE FROM feed_cards WHERE id = ?").run(id);
      db.prepare("DELETE FROM focus_legacy_reconciliation_issues WHERE feedCardId = ?").run(id);
      return { existing, transition };
    });
    if (!result) return false;
    const { existing, transition } = result;
    bus.emit({
      type: "focus:changed",
      focusObjectType: existing.objectType,
      focusObjectId: id,
      taskId: existing.taskId ?? undefined,
      lifecycle: existing.lifecycle,
      previousLifecycle: existing.lifecycle,
      activationId: existing.activationId,
      transitionId: transition.id,
      reason: "deleted",
      meaningful: true,
    });
    bus.emit({
      type: "feed:changed", cardId: id, dedupeKey: existing.dedupeKey ?? undefined,
      taskId: existing.taskId ?? undefined, sessionId: existing.sessionId ?? undefined,
    });
    if (existing.visual) options.onVisualUnreferenced?.(existing.visual, existing);
    return true;
  }

  function deleteByKey(dedupeKey: string): boolean {
    const id = identityStore.getIdByKey(dedupeKey);
    return id ? deleteById(id) : false;
  }

  function recordDeletion(object: FocusObject, reason: string, actor: FocusActor): FocusTransition {
    const transition = transitionStore.append({
      objectId: object.id, objectType: object.objectType, title: object.title, activationId: object.activationId,
      fromLifecycle: object.lifecycle, toLifecycle: null, reason, actor,
      details: { object, previousEpisode: snapshotPreviousEpisode(object) }, sessionId: object.sessionId,
    });
    attentionStore.record({
      eventType: "deleted", objectId: object.id, objectType: object.objectType, activationId: object.activationId,
      transitionId: transition.id, reason, actor,
    });
    return transition;
  }

  function importLegacyCard(card: FeedCard, feedRowId: number): { activationChanged: boolean; initialImport: boolean; changed: boolean } {
    const existing = getAny(card.id, true);
    const fields = rowToCanonicalFields(card, existing);
    const typeChanged = existing !== undefined && existing.objectType !== fields.objectType;
    const statusChanged = existing !== undefined && existing.status !== card.status;
    const details: FocusObjectDetails = existing
      ? { ...existing.details }
      : {
          ...defaultFocusDetails(card.id, card.updatedAt || card.statusChangedAt || card.createdAt),
          lifecycle: legacyStatusToLifecycle(card.status),
          sourceFamily: card.dedupeKey?.split(":")[0] ?? (fields.category ?? fields.objectType),
          producer: "legacy", observedAt: card.createdAt,
        };
    if (typeChanged) {
      Object.assign(details, {
        evidence: [], impact: null, consequenceOfDelay: null, alternatives: [],
        recommendation: null, fallback: null, outcome: null, resolutionReason: null,
        notificationMode: "focus", authorizationGrantId: null, interventionBy: null, producer: "legacy",
      });
    }
    if (statusChanged) {
      details.lifecycle = legacyStatusToLifecycle(card.status);
      details.resolutionReason = card.status === "active" ? null : "legacy-status-change";
      if (card.status === "active") {
        details.acknowledgedAt = null;
        details.handedOffAt = null;
        details.resolvedAt = null;
        details.outcome = null;
      } else details.resolvedAt = card.statusChangedAt;
    }
    const launching = Boolean(existing?.action && card.sessionId && card.sessionId !== existing.sessionId);
    if (launching) {
      details.lifecycle = existing!.lifecycle === "active" ? "acknowledged" : existing!.lifecycle;
      details.resolutionReason = existing!.details.resolutionReason;
      details.resolvedAt = existing!.details.resolvedAt;
      if (details.lifecycle === "acknowledged" && !details.acknowledgedAt) details.acknowledgedAt = card.updatedAt;
      fields.status = lifecycleToLegacyStatus(details.lifecycle);
      fields.activationId = existing!.activationId;
      fields.statusChangedAt = existing!.statusChangedAt;
    }
    if (card.taskId && (!existing || card.taskId !== existing.taskId)) {
      const task = db.prepare("SELECT title FROM tasks WHERE id = ?").get(card.taskId);
      details.originalTaskId = card.taskId;
      details.originalTaskTitle = typeof task?.title === "string" ? task.title : null;
      details.orphanedAt = null;
    }
    const normalized: NormalizedFeedCreateFields = {
      ...objectToCreateFields(card),
      status: fields.status,
    };
    const fingerprint = semanticFingerprint(normalized, details);
    if (existing && !typeChanged && semanticFingerprint(objectToCreateFields(existing), existing.details) === fingerprint) {
      if (!existing.details.contentFingerprint) detailsStore.save({ ...details, contentFingerprint: fingerprint });
      legacyProjectionStore.rememberCurrent(feedRowId);
      return { activationChanged: false, initialImport: false, changed: false };
    }
    const activationChanged = Boolean(existing && existing.activationId !== fields.activationId);
    const reason = launching ? "session-launched" : statusChanged ? "legacy-status-change" : !existing ? "legacy-import" : typeChanged ? "reclassified" : "legacy-update";
    const transition = transitionStore.append({
      objectId: card.id, objectType: fields.objectType, title: card.title, activationId: fields.activationId,
      fromLifecycle: existing?.lifecycle ?? null, toLifecycle: details.lifecycle, reason, actor: "legacy",
      sessionId: card.sessionId,
      details: { fingerprint, ...(existing ? { previousEpisode: snapshotPreviousEpisode(existing) } : {}) },
    });
    if (activationChanged) {
      db.prepare("DELETE FROM feed_card_checklist_promotions WHERE feedCardId = ?").run(card.id);
    }
    persistCanonical(fields);
    if (launching && card.status !== fields.status) persistFeedProjection(fields);
    details.contentFingerprint = fingerprint;
    details.lastMeaningfulChangeAt = card.updatedAt || card.statusChangedAt || card.createdAt;
    detailsStore.save(details);
    legacyProjectionStore.rememberCurrent(feedRowId);
    const event = {
      objectId: card.id, objectType: fields.objectType, activationId: fields.activationId,
      transitionId: transition.id, reason, actor: "legacy" as const,
    };
    attentionStore.record({ ...event, eventType: existing ? "meaningful_update" : "create" });
    if (statusChanged) attentionStore.record({ ...event, eventType: "lifecycle_transition" });
    if (activationChanged) attentionStore.record({ ...event, eventType: "reactivation" });
    if (typeChanged || !existing) attentionStore.record({ ...event, eventType: "classification" });
    return { activationChanged, initialImport: !existing, changed: true };
  }

  function hydrateLegacyReconciliationRow(row: any): FeedCard {
    if (typeof row.id !== "string" || !row.id.trim()) {
      throw new Error("Stored feed card id is invalid");
    }
    return hydrateFeedCardRow(row);
  }

  function reconcileLegacyPromotionLinks(changedActivationIds: ReadonlySet<string> = new Set()): void {
    const missingLinks = db.prepare(`SELECT p.feedCardId, p.checklistItemId, p.createdAt, i.objectType,
      COALESCE(d.activationId, a.activationId, e.activationId) AS activationId
      FROM feed_card_checklist_promotions p
      JOIN focus_object_identities i ON i.id=p.feedCardId
      LEFT JOIN decisions d ON d.id=i.id AND i.objectType='decision'
      LEFT JOIN alerts a ON a.id=i.id AND i.objectType='alert'
      LEFT JOIN focus_events e ON e.id=i.id AND i.objectType='event'
      WHERE COALESCE(d.activationId, a.activationId, e.activationId) IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM focus_legacy_reconciliation_issues q WHERE q.feedCardId=i.id)
        AND NOT EXISTS (SELECT 1 FROM focus_action_links links WHERE links.sourceId=i.id AND links.actionId=p.checklistItemId)`)
      .all() as Array<{ feedCardId: string; checklistItemId: string; createdAt: string; objectType: FocusObjectType; activationId: string }>;
    const insert = db.prepare(`INSERT OR IGNORE INTO focus_action_links
      (sourceType, sourceId, activationId, actionId, createdAt) VALUES (?, ?, ?, ?, ?)`);
    for (const link of missingLinks) {
      if (changedActivationIds.has(link.feedCardId)) continue;
      insert.run(link.objectType, link.feedCardId, link.activationId, link.checklistItemId, link.createdAt);
    }
  }

  function reconcileLegacyFeed(): {
    imported: number;
    deleted: number;
    quarantined: number;
  } {
    const result = runImmediateTransaction(db, () => {
      initializeFocusLegacyProjectionSchema(db);
      backfillFocusDetails(db);
      const scanned = Number(db.prepare("SELECT COUNT(*) AS count FROM feed_cards").get()?.count ?? 0);
      db.prepare(`DELETE FROM focus_legacy_reconciliation_issues
        WHERE feedRowId NOT IN (SELECT rowid FROM feed_cards)
          OR EXISTS (SELECT 1 FROM feed_cards f WHERE f.rowid=feedRowId AND (
            (typeof(f.id)='text' AND feedCardId IS NOT NULLIF(f.id, ''))
            OR (f.id IS NULL AND feedCardId IS NOT NULL)
          ))`).run();
      const changedActivationIds = new Set<string>();
      let imported = 0;
      let deleted = 0;
      const staleIdentities = db.prepare(`SELECT i.id FROM focus_object_identities i WHERE NOT EXISTS (
        SELECT 1 FROM feed_cards f WHERE f.id=i.id AND typeof(f.id)='text' AND length(f.id)>0
      )`).all() as Array<{ id: string }>;
      for (const { id } of staleIdentities) {
        const object = getAny(id, true);
        if (object) recordDeletion(object, "legacy-deleted", "legacy");
        db.prepare("DELETE FROM focus_object_identities WHERE id = ?").run(id);
        deleted += 1;
      }
      const rawRows = legacyProjectionStore.listDirty();
      for (const row of rawRows) {
        const id = String(row.id ?? "");
        const feedRowId = Number(row.feedRowId);
        const issueId = id || `rowid:${feedRowId}`;
        let card: FeedCard;
        try {
          card = hydrateLegacyReconciliationRow(row);
        } catch (error) {
          db.prepare(`
            INSERT INTO focus_legacy_reconciliation_issues (
              id, feedCardId, feedRowId, error, rawRowJson, detectedAt
            )
            VALUES (?, ?, ?, ?, ?, ?)
            ON CONFLICT(feedRowId) DO UPDATE SET
              id = excluded.id,
              feedCardId = excluded.feedCardId,
              error = excluded.error,
              rawRowJson = excluded.rawRowJson,
              detectedAt = excluded.detectedAt
            WHERE focus_legacy_reconciliation_issues.rawRowJson != excluded.rawRowJson
              OR focus_legacy_reconciliation_issues.error != excluded.error
          `).run(
            issueId,
            id || null,
            feedRowId,
            error instanceof Error ? error.message : String(error),
            JSON.stringify(row),
            new Date().toISOString(),
          );
          legacyProjectionStore.remember(row, "quarantined");
          continue;
        }
        const importedCard = importLegacyCard(card, feedRowId);
        if (importedCard.activationChanged) changedActivationIds.add(card.id);
        db.prepare("DELETE FROM focus_legacy_reconciliation_issues WHERE feedRowId = ?").run(feedRowId);
        if (importedCard.changed) imported += 1;
      }

      legacyProjectionStore.pruneMissing();
      reconcileLegacyPromotionLinks(changedActivationIds);
      const quarantined = Number(db.prepare("SELECT COUNT(*) AS count FROM focus_legacy_reconciliation_issues").get()?.count ?? 0);
      return { scanned, hydrated: rawRows.length, unchanged: scanned - rawRows.length, imported, deleted, quarantined };
    });
    reconciliationStats = result;
    return { imported: result.imported, deleted: result.deleted, quarantined: result.quarantined };
  }

  function retryQuarantined(id: string): FocusObject {
    const result = runImmediateTransaction(db, () => {
      const issue = db.prepare(`
        SELECT feedCardId, feedRowId
        FROM focus_legacy_reconciliation_issues
        WHERE id = ?
      `).get(id) as { feedCardId?: string | null; feedRowId?: number } | undefined;
      if (!issue?.feedRowId) throw new FeedCardNotFoundError(`Reconciliation issue ${id} not found`);
      const row = db.prepare("SELECT rowid AS feedRowId, * FROM feed_cards WHERE rowid = ?")
        .get(issue.feedRowId) as any;
      if (!row) throw new FeedCardNotFoundError(`Legacy feed row ${issue.feedRowId} not found`);
      const card = hydrateLegacyReconciliationRow(row);
      importLegacyCard(card, issue.feedRowId);
      db.prepare("DELETE FROM focus_legacy_reconciliation_issues WHERE id = ?").run(id);
      reconcileLegacyPromotionLinks();
      return {
        object: getAny(card.id)!,
        card,
      };
    });
    emitChanged(result.object, result.card, transitionStore.list(result.object.id, { limit: 1 })[0]);
    return result.object;
  }

  function deleteQuarantined(id: string): boolean {
    const issue = db.prepare(`
      SELECT feedCardId, feedRowId
      FROM focus_legacy_reconciliation_issues
      WHERE id = ?
    `).get(id) as { feedCardId?: string | null; feedRowId?: number } | undefined;
    if (!issue?.feedRowId) return false;
    const feedRowId = issue.feedRowId;
    runImmediateTransaction(db, () => {
      if (issue.feedCardId) {
        const object = getAny(issue.feedCardId, true);
        if (object) recordDeletion(object, "quarantine-deleted", "user");
        db.prepare("DELETE FROM focus_object_identities WHERE id = ?").run(issue.feedCardId);
      }
      db.prepare("DELETE FROM feed_cards WHERE rowid = ?").run(feedRowId);
      db.prepare("DELETE FROM focus_legacy_reconciliation_issues WHERE id = ?").run(id);
    });
    bus.emit({ type: "focus:changed", focusObjectId: issue.feedCardId ?? undefined });
    bus.emit({ type: "feed:changed", cardId: issue.feedCardId ?? undefined });
    return true;
  }

  function promoteToAction(
    id: string,
    checklistStore: ChecklistStore,
    input: { text?: unknown; taskId?: unknown; expectedActivationId?: unknown } = {},
    actor: FocusActor = "user",
  ): { created: boolean; object: FocusObject; action: ChecklistItem } {
    const unknown = Object.keys(input).filter((key) => !["text", "taskId", "expectedActivationId"].includes(key));
    if (unknown.length) throw new FeedCardValidationError(`Unknown promotion field(s): ${unknown.join(", ")}`);
    const result = runImmediateTransaction(db, () => {
      const source = getAny(id);
      if (!source) throw new FeedCardNotFoundError(`Focus object ${id} not found`);
      if (input.expectedActivationId !== undefined && focusText(input.expectedActivationId, "expectedActivationId") !== source.activationId) {
        throw new FeedCardValidationError("Focus activation changed; reload before promoting");
      }
      const text = input.text === undefined ? source.title : focusText(input.text, "text")!;
      let taskId: string | null;
      if (Object.prototype.hasOwnProperty.call(input, "taskId")) {
        taskId = focusText(input.taskId, "taskId", true);
      } else if (source.taskId && source.taskState === "active") {
        taskId = source.taskId;
      } else {
        throw new FeedCardValidationError("Supply an active, unmuted taskId or explicit taskId:null; this source has no visible default destination");
      }
      if (taskId) {
        const task = db.prepare("SELECT status, muted FROM tasks WHERE id = ?").get(taskId);
        if (!task || task.status !== "active" || task.muted === 1) throw new FeedCardValidationError("Promotion destination must be an active, unmuted task");
      }
      if (!isOpenLifecycle(source.lifecycle)) throw new FeedCardValidationError("Reactivate this concern with a new episode before promoting");
      const existingLink = db.prepare(`
        SELECT links.actionId FROM focus_action_links links
        JOIN checklist_items actions ON actions.id = links.actionId
        WHERE links.sourceId = ? AND actions.done = 0
        ORDER BY links.createdAt DESC, links.activationId LIMIT 1
      `).get(source.id) as { actionId: string } | undefined;
      let action = existingLink ? checklistStore.getChecklistItem(existingLink.actionId) : undefined;
      const previousActionTaskId = action?.taskId;
      const moved = action !== undefined && action.taskId !== taskId;
      if (action && moved) {
        const maxOrder = Number(db.prepare('SELECT MAX("order") AS maxOrder FROM checklist_items WHERE taskId IS ?').get(taskId)?.maxOrder ?? -1);
        db.prepare('UPDATE checklist_items SET taskId=?, "order"=? WHERE id=?').run(taskId, maxOrder + 1, action.id);
        db.prepare(`UPDATE focus_action_details SET orphanedAt=NULL WHERE actionId=?`).run(action.id);
        const transition = transitionStore.append({
          objectId: action.id, objectType: "action", title: action.text, activationId: action.id,
          fromLifecycle: "active", toLifecycle: "active", reason: "promotion-destination-changed", actor,
          relatedActionId: action.id, details: { previousTaskId: previousActionTaskId ?? null, taskId, sourceId: id },
        });
        attentionStore.record({ eventType: "meaningful_update", objectId: action.id, objectType: "action", activationId: action.id, actor, transitionId: transition.id, reason: transition.reason });
        action = checklistStore.getChecklistItem(action.id)!;
      }
      let created = false;
      if (!action) {
        const actionId = crypto.randomUUID();
        const now = new Date().toISOString();
        const maxOrder = db.prepare('SELECT MAX("order") AS maxOrder FROM checklist_items WHERE taskId IS ?')
          .get(taskId)?.maxOrder;
        db.prepare(`INSERT INTO checklist_items (id, taskId, text, done, "order", createdAt, deadline)
          VALUES (?, ?, ?, 0, ?, ?, NULL)`).run(actionId, taskId, text, Number(maxOrder ?? -1) + 1, now);
        db.prepare(`INSERT INTO focus_action_details (actionId, originalTaskId, originalTaskTitle)
          VALUES (?, ?, (SELECT title FROM tasks WHERE id = ?))`).run(actionId, taskId, taskId);
        db.prepare(`INSERT INTO focus_action_links (sourceType, sourceId, activationId, actionId, createdAt)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(sourceType, sourceId, activationId, actionId) DO NOTHING`)
          .run(source.objectType, source.id, source.activationId, actionId, now);
        // A completed action's relationship must remain visible in History even
        // when a second accepted action is created in the same episode.
        transitionStore.append({
          objectId: actionId, objectType: "action", title: text, activationId: actionId,
          fromLifecycle: null, toLifecycle: "active", reason: "promoted", actor,
          relatedActionId: actionId, details: { sourceId: source.id, taskId },
        });
        attentionStore.record({ eventType: "create", objectId: actionId, objectType: "action", activationId: actionId, actor, reason: "promoted" });
        action = checklistStore.getChecklistItem(actionId);
        if (!action) throw new Error(`Created action ${actionId} could not be reloaded`);
        created = true;
      }
      const now = new Date().toISOString();
      db.prepare(`INSERT INTO focus_action_links (sourceType, sourceId, activationId, actionId, createdAt)
        VALUES (?, ?, ?, ?, ?) ON CONFLICT(sourceType, sourceId, activationId, actionId) DO NOTHING`)
        .run(source.objectType, source.id, source.activationId, action.id, now);
      db.prepare(`
        INSERT INTO feed_card_checklist_promotions (feedCardId, checklistItemId, createdAt)
        VALUES (?, ?, ?)
        ON CONFLICT(feedCardId) DO UPDATE SET
          checklistItemId = excluded.checklistItemId,
          createdAt = excluded.createdAt
        WHERE feed_card_checklist_promotions.checklistItemId != excluded.checklistItemId
      `).run(source.id, action.id, now);
      const mutation = isOpenLifecycle(source.lifecycle)
        ? saveInTransaction({ lifecycle: "handed_off", lifecycleReason: "promoted-to-action" }, {
            id: source.id, forceType: source.objectType, eventCategory: source.objectType === "event" ? source.category : undefined, actor,
            relatedActionId: action.id,
          })
        : undefined;
      attentionStore.record({ eventType: "promotion", objectId: source.id, objectType: source.objectType, activationId: source.activationId, actor, details: { actionId: action.id, created } });
      return { created, action, mutation, moved, previousActionTaskId };
    });
    const object = getAny(id)!;
    if (result.mutation) publishResult(result.mutation);
    if (result.created || result.moved) bus.emit({ type: "task:changed", taskId: result.action.taskId ?? undefined });
    if (result.moved) bus.emit({ type: "task:changed", taskId: result.previousActionTaskId ?? undefined });
    return { created: result.created, object, action: checklistStore.getChecklistItem(result.action.id)! };
  }

  function linkLaunchedSession(id: string, sessionId: string, expectedActivationId?: string, actor: FocusActor = "user"): FocusObject {
    const result = runImmediateTransaction(db, () => {
      const source = getAny(id);
      if (!source) throw new FeedCardNotFoundError(`Focus object ${id} not found`);
      if (!isOpenLifecycle(source.lifecycle)) throw new FeedCardValidationError("Cannot launch/link a cleared Focus episode");
      return saveInTransaction({
        sessionId: focusText(sessionId, "sessionId"), expectedActivationId,
        lifecycle: source.lifecycle === "active" ? "acknowledged" : source.lifecycle,
        lifecycleReason: "session-launched",
      }, { id, forceType: source.objectType, eventCategory: source.objectType === "event" ? source.category : undefined, actor });
    });
    publishResult(result);
    return result.object;
  }

  return {
    getAny,
    saveLegacy,
    updateLegacyById,
    updateLegacyByKey,
    saveDecision,
    updateDecision,
    saveAlert,
    updateAlert,
    saveEvent,
    updateEvent,
    deleteById,
    deleteByKey,
    reconcileLegacyFeed,
    getLastReconciliationStats: () => reconciliationStats ? { ...reconciliationStats } : null,
    retryQuarantined,
    deleteQuarantined,
    promoteToAction,
    linkLaunchedSession,
  };
}

export type FocusMutationCoordinator = ReturnType<typeof createFocusMutationCoordinator>;
