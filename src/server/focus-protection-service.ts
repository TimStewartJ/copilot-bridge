import type { DatabaseSync } from "./db.js";
import type { AppContext } from "./app-context.js";
import {
  FocusProtectionConflictError, normalizeFocusProtectionRequest, type FocusProtectionStore,
} from "./focus-protection-store.js";
import { focusBoolean, focusEnum, focusFingerprint, focusInteger, focusRecord, focusText, focusTimestamp } from "./focus-details-store.js";
import { createCronPreviewIterator, validateSupportedCronExpression } from "./cron-next-run.js";
import { areSessionUnreadBubblesMuted } from "./task-store.js";
import { isRestartRecoveryPrompt } from "./restart-resume.js";
import { parseReturnedDeferPrompt } from "./defer-result-message.js";
import type { Schedule } from "./schedule-store.js";
import type {
  FocusProtectionDeferImpact, FocusProtectionInFlight, FocusProtectionIntervention, FocusProtectionPage,
  FocusProtectionPreview, FocusProtectionRequest, FocusProtectionScheduleImpact, FocusProtectionSession,
  FocusProtectionSnapshot,
} from "../shared/focus-protection.js";

export class FocusProtectionUnavailableError extends Error {}

export const MAX_PROTECTION_CRON_PROBES = 8_192;
export const MAX_PROTECTION_CRON_PROBES_PER_SCHEDULE = 512;

type ProtectionContext = Pick<AppContext,
  "scheduleStore" | "deferredPromptStore" | "deferLoopStore" | "taskStore" | "sessionManager" | "sessionTitles"
  | "focusNotificationDeliveryStore">;
type PreviewSchedule = Pick<Schedule,
  "id" | "taskId" | "name" | "type" | "cron" | "runAt" | "timezone" | "maxRuns" | "expiresAt" | "runCount" | "lastRunAt" | "nextRunAt">;

export function readFocusProtectionSessions(ctx: ProtectionContext): FocusProtectionSession[] {
  if (ctx.sessionManager.getBackendCreatedAt() === null) {
    throw new FocusProtectionUnavailableError("Current session state is unavailable until the backend is ready");
  }
  const ids = new Set([...ctx.sessionManager.getActiveSessions(), ...ctx.sessionManager.getPendingInputSessionIds()]);
  if (ids.size === 0) return [];
  const tasks = ctx.taskStore.listTasks();
  return [...ids].sort().map((sessionId) => {
    const linked = tasks.filter((task) => task.sessionIds.includes(sessionId));
    return {
      sessionId, title: ctx.sessionTitles.getTitle(sessionId) ?? `Session ${sessionId.slice(0, 8)}`,
      taskId: linked[0]?.id ?? null, muted: linked.length > 0 && areSessionUnreadBubblesMuted(linked),
      busy: ctx.sessionManager.isSessionBusy(sessionId),
      pendingUserInputCount: ctx.sessionManager.getPendingUserInputCount(sessionId),
    };
  });
}

export function createFocusProtectionService(
  db: DatabaseSync, store: FocusProtectionStore, ctx: ProtectionContext,
) {
  const getSessions = () => readFocusProtectionSessions(ctx);

  function readSources(request: FocusProtectionRequest, now: number) {
    const sessions = getSessions();
    if (!ctx.deferredPromptStore || !ctx.deferLoopStore) {
      throw new FocusProtectionUnavailableError("Deferred work state is unavailable; impacts cannot be previewed");
    }
    const schedules: PreviewSchedule[] = ctx.scheduleStore.getEnabledSchedules().map((schedule) => {
      const { id, taskId, name, type, cron, runAt, timezone, maxRuns, expiresAt, runCount, lastRunAt, nextRunAt } = schedule;
      return { id, taskId, name, type, cron, runAt, timezone, maxRuns, expiresAt, runCount, lastRunAt, nextRunAt };
    }).sort((a, b) => a.id.localeCompare(b.id));
    const claims = ctx.scheduleStore.listInFlightRunClaims(new Date(now).toISOString())
      .sort((a, b) => a.scheduleId.localeCompare(b.scheduleId) || a.runKey.localeCompare(b.runKey));
    const claimNames = [...new Set(claims.map((claim) => claim.scheduleId))].map((id) => ({
      id, name: ctx.scheduleStore.getSchedule(id)?.name ?? `Schedule ${id}`,
    }));
    const holds = store.outstanding("schedule").map(({ id, workId, scheduledFor, windowId }) => ({ id, workId, scheduledFor, windowId }))
      .sort((a, b) => a.id.localeCompare(b.id));
    const coveredSlots = schedules.flatMap((schedule) => {
      const slot = schedule.type === "once" ? schedule.runAt : schedule.nextRunAt;
      if (!slot || Date.parse(slot) >= now) return [];
      const window = store.coveringSlot(slot, now);
      return window ? [`${schedule.id}:${slot}`] : [];
    });
    const prompts = ctx.deferredPromptStore.listDue(request.endsAt).map((item) => ({
      id: item.id, deferId: item.deferId, sessionId: item.sessionId, runAt: item.runAt,
      continuation: isRestartRecoveryPrompt(item.prompt) || parseReturnedDeferPrompt(item.prompt) !== undefined,
    })).sort((a, b) => a.id.localeCompare(b.id));
    const loops = ctx.deferLoopStore.listDue(request.endsAt).map((loop) => {
      const { id, deferId, sessionId, name, nextRunAt, expiresAt, maxRuns, runCount, intervalSeconds } = loop;
      return { id, deferId, sessionId, name, nextRunAt, expiresAt, maxRuns, runCount, intervalSeconds };
    }).sort((a, b) => a.id.localeCompare(b.id));
    const interventions: FocusProtectionIntervention[] = db.prepare(`SELECT o.id AS objectId, o.activationId, o.objectType, o.title,
      d.interventionBy, o.taskId, d.notificationMode, d.consequenceOfDelay,
      CASE WHEN d.orphanedAt IS NOT NULL OR (o.taskId IS NOT NULL AND t.id IS NULL) THEN 'orphaned'
        WHEN o.taskId IS NULL THEN 'global' WHEN t.status!='active' THEN 'archived'
        WHEN t.muted=1 THEN 'muted' ELSE 'active' END AS taskState
      FROM (
        SELECT id, activationId, 'alert' AS objectType, title, taskId FROM alerts
        UNION ALL SELECT id, activationId, 'decision' AS objectType, title, taskId FROM decisions
      ) o JOIN focus_object_details d ON d.objectId=o.id LEFT JOIN tasks t ON t.id=o.taskId
      WHERE d.lifecycle IN ('active','acknowledged','handed_off') AND d.interventionBy<?
      AND NOT EXISTS (SELECT 1 FROM focus_legacy_reconciliation_issues q WHERE q.feedCardId=o.id)
      ORDER BY d.interventionBy, o.id`).all(request.endsAt).map((row) => ({
        objectId: focusText(row.objectId, "objectId")!, activationId: focusText(row.activationId, "activationId")!,
        objectType: focusEnum(row.objectType, "objectType", ["alert", "decision"]),
        title: focusText(row.title, "title")!, interventionBy: focusTimestamp(row.interventionBy, "interventionBy")!,
        taskId: focusText(row.taskId, "taskId", true), taskState: focusText(row.taskState, "taskState")!,
        notificationMode: focusEnum(row.notificationMode, "notificationMode", ["focus", "summary", "immediate"]),
        consequenceOfDelay: focusText(row.consequenceOfDelay, "consequenceOfDelay", true),
      }));
    const inFlightDefers: FocusProtectionInFlight[] = [];
    for (const kind of ["defer", "defer-loop"] as const) {
      const table = kind === "defer" ? "deferred_prompts" : "defer_loops";
      const rows = db.prepare(`SELECT id, sessionId FROM ${table} WHERE status='running' AND leaseExpiresAt>? ORDER BY id`)
        .all(new Date(now).toISOString()) as Array<{ id: string; sessionId: string }>;
      for (const row of rows) inFlightDefers.push({ ...row, kind, name: `${kind === "defer" ? "One-shot" : "Recurring"} worker ${row.id}` });
    }
    const creations = ctx.sessionManager.getLifecycleBlockingSessionCount() - ctx.sessionManager.getActiveSessions().length;
    return { schedules, claims, claimNames, holds, coveredSlots, prompts, loops, sessions, interventions, inFlightDefers, creations };
  }
  type PreviewSources = ReturnType<typeof readSources>;

  function temporalPhases(request: FocusProtectionRequest, sources: PreviewSources, now: number) {
    const start = request.startsAt === undefined ? now : Date.parse(request.startsAt);
    return {
      minute: request.startsAt === undefined ? Math.floor(now / 60_000) : null,
      schedules: sources.schedules.map((schedule) => ({
        id: schedule.id, expired: schedule.expiresAt !== undefined && Date.parse(schedule.expiresAt) <= start,
        slots: [schedule.runAt, schedule.nextRunAt].map((slot) => slot === undefined ? null : [
          Date.parse(slot) >= start, Date.parse(slot) > now - 60 * 60_000,
        ]),
      })),
      loops: sources.loops.map((loop) => ({
        id: loop.id, expired: loop.expiresAt !== undefined && Date.parse(loop.expiresAt) <= start,
      })),
    };
  }

  function preparePreview(value: unknown, now = Date.now()) {
    const request = normalizeFocusProtectionRequest(value, now);
    const startsAt = request.startsAt ?? new Date(now).toISOString();
    const start = Date.parse(startsAt);
    const end = Date.parse(request.endsAt);
    const sources = readSources(request, now);
    const sourceVersion = focusFingerprint(sources);
    const guardVersion = focusFingerprint({ sourceVersion, phases: temporalPhases(request, sources, now) });
    const claimedSlots = new Set(sources.claims.map((row) => `${row.scheduleId}:${row.runKey}`));
    const claimedSchedules = new Set(sources.claims.map((row) => row.scheduleId));
    const heldSlots = new Set(sources.holds.map((hold) => `${hold.workId}:${hold.scheduledFor}`));
    const coveredSlots = new Set(sources.coveredSlots);
    const schedules: FocusProtectionScheduleImpact[] = [];
    let remainingProbes = MAX_PROTECTION_CRON_PROBES;
    let remainingCrons = sources.schedules.filter((schedule) => schedule.type === "cron").length;
    for (const schedule of sources.schedules) {
      const quota = schedule.type === "cron"
        ? Math.min(MAX_PROTECTION_CRON_PROBES_PER_SCHEDULE, Math.max(1, Math.floor(remainingProbes / remainingCrons--)))
        : 0;
      if (schedule.expiresAt && Date.parse(schedule.expiresAt) <= start) continue;
      const remaining = schedule.maxRuns === undefined ? Number.POSITIVE_INFINITY
        : Math.max(0, schedule.maxRuns - schedule.runCount - Number(claimedSchedules.has(schedule.id)));
      if (remaining === 0) continue;
      const slots = new Set<string>();
      let complete = true;
      const eligible = (slot: string): boolean => {
        const time = Date.parse(slot);
        if (!Number.isFinite(time)) throw new Error(`Schedule ${schedule.id} has an invalid slot`);
        const key = `${schedule.id}:${slot}`;
        if (time >= end || claimedSlots.has(key)) return false;
        if (schedule.expiresAt && time >= Date.parse(schedule.expiresAt)) return false;
        return time >= start || (request.startsAt === undefined && (
          time > now - 60 * 60_000 || heldSlots.has(key) || coveredSlots.has(key)
        ));
      };
      if (schedule.type === "once") {
        if (schedule.runAt && !claimedSchedules.has(schedule.id) && eligible(schedule.runAt)) slots.add(schedule.runAt);
      } else if (schedule.cron) {
        const validation = validateSupportedCronExpression(schedule.cron);
        if (!validation.ok) throw new Error(`Cannot preview schedule ${schedule.name}: ${validation.error}`);
        if (schedule.timezone) new Intl.DateTimeFormat("en-US", { timeZone: schedule.timezone });
        if (schedule.nextRunAt && Date.parse(schedule.nextRunAt) < start && eligible(schedule.nextRunAt)) slots.add(schedule.nextRunAt);
        let used = 0;
        const iterator = createCronPreviewIterator(schedule.cron, schedule.timezone, start,
          schedule.expiresAt ? Math.min(end, Date.parse(schedule.expiresAt)) : end, () => {
            if (used >= quota || remainingProbes === 0) return false;
            used++;
            remainingProbes--;
            return true;
          });
        while (slots.size < remaining) {
          const next = iterator.next();
          if (next.done) { complete = next.complete; break; }
          if (!claimedSlots.has(`${schedule.id}:${next.at}`)) slots.add(next.at);
        }
      }
      const times = [...slots].sort();
      if (times.length || !complete) schedules.push({
        id: schedule.id, name: schedule.name, taskId: schedule.taskId, type: schedule.type,
        slotsDue: times.length, slotCountComplete: complete,
        firstScheduledFor: times[0] ?? null, lastScheduledFor: times[times.length - 1] ?? null,
        expiresAt: schedule.expiresAt ?? null,
      });
    }
    const defers: FocusProtectionDeferImpact[] = [];
    let continuingRecoveryPrompts = 0;
    for (const item of sources.prompts) {
      if (Date.parse(item.runAt) >= end || (request.startsAt !== undefined && Date.parse(item.runAt) < start)) continue;
      if (item.continuation) { continuingRecoveryPrompts += 1; continue; }
      defers.push({
        id: item.id, deferId: item.deferId, kind: "defer", sessionId: item.sessionId,
        name: `One-shot ${item.deferId}`, scheduledFor: item.runAt, expiresAt: null, expiresDuringProtection: false,
      });
    }
    for (const loop of sources.loops) {
      if (loop.maxRuns !== undefined && loop.runCount >= loop.maxRuns) continue;
      if (loop.expiresAt && Date.parse(loop.expiresAt) <= start) continue;
      let due = Date.parse(loop.nextRunAt);
      if (request.startsAt !== undefined && due < start) {
        due += Math.ceil((start - due) / (loop.intervalSeconds * 1_000)) * loop.intervalSeconds * 1_000;
      }
      const expiresDuringProtection = loop.expiresAt !== undefined && Date.parse(loop.expiresAt) <= end;
      if (!expiresDuringProtection && (due >= end || (loop.expiresAt && due >= Date.parse(loop.expiresAt)))) continue;
      defers.push({
        id: loop.id, deferId: loop.deferId, kind: "defer-loop", sessionId: loop.sessionId,
        name: loop.name ?? `Recurring ${loop.deferId}`, scheduledFor: new Date(due).toISOString(),
        expiresAt: loop.expiresAt ?? null, expiresDuringProtection,
      });
    }
    const inFlight: FocusProtectionInFlight[] = sources.sessions.filter((session) => session.busy).map((session) => ({
      kind: "session", id: session.sessionId, name: session.title, sessionId: session.sessionId,
    }));
    for (const claim of sources.claimNames) inFlight.push({ ...claim, kind: "schedule" });
    inFlight.push(...sources.inFlightDefers);
    if (sources.creations > 0) inFlight.push({
      kind: "session-creation", id: "session-creations", name: `${sources.creations} session creation(s) in flight`,
    });
    schedules.sort((a, b) => a.id.localeCompare(b.id));
    defers.sort((a, b) => a.id.localeCompare(b.id));
    inFlight.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
    const costs = {
      request, schedules, defers, needsInput: sources.sessions.filter((session) => session.pendingUserInputCount > 0),
      interventions: sources.interventions, inFlight, continuingRecoveryPrompts,
    };
    const preview: FocusProtectionPreview = {
      ...costs, startsAt, endsAt: request.endsAt, generatedAt: new Date(now).toISOString(),
      confirmationToken: focusFingerprint({ ...costs, sourceVersion }),
    };
    return { preview, guardVersion };
  }

  function preview(value: unknown, now = Date.now()): FocusProtectionPreview { return preparePreview(value, now).preview; }

  function create(value: unknown) {
    const input = focusRecord(value, [
      "startsAt", "endsAt", "timezone", "reason", "allowNeedsInput", "allowAuthorizedDeadlineOverride",
      "confirmationToken", "confirmInterventionConflicts",
    ]);
    const { confirmationToken, confirmInterventionConflicts, ...request } = input;
    const token = focusText(confirmationToken, "confirmationToken")!;
    const confirmed = focusBoolean(confirmInterventionConflicts, "confirmInterventionConflicts");
    const prepared = preparePreview(request);
    if (prepared.preview.confirmationToken !== token) {
      throw new FocusProtectionConflictError("Impacts have changed. Refresh the preview and confirm again.");
    }
    if (prepared.preview.interventions.length && !confirmed) {
      throw new FocusProtectionConflictError("Review and explicitly confirm the intervention conflicts before protecting focus.");
    }
    return store.create(prepared.preview.request, (normalized) => {
      const now = Date.now();
      const sources = readSources(normalized, now);
      const guardVersion = focusFingerprint({
        sourceVersion: focusFingerprint(sources), phases: temporalPhases(normalized, sources, now),
      });
      if (guardVersion !== prepared.guardVersion) {
        throw new FocusProtectionConflictError("Impacts changed during preparation. Refresh the preview and confirm again.");
      }
    });
  }

  function current(): FocusProtectionSnapshot {
    ctx.focusNotificationDeliveryStore.reconcileStaleClaims();
    store.reconcile();
    const now = Date.now();
    const active = store.current(now);
    const upcoming = store.upcoming(now);
    const latest = store.list({ limit: 1 }, now)[0] ?? null;
    return {
      generatedAt: new Date(now).toISOString(), current: active, upcoming, latest,
      impacts: store.impacts((active ?? upcoming ?? latest)?.id),
    };
  }

  function list(options: { limit?: number; offset?: number } = {}): FocusProtectionPage {
    store.reconcile();
    const now = Date.now();
    const limit = focusInteger(options.limit ?? 50, "limit", 1, 100);
    const offset = focusInteger(options.offset ?? 0, "offset", 0, 1_000_000);
    const windows = store.list({ limit, offset }, now);
    return {
      generatedAt: new Date(now).toISOString(), windows,
      nextOffset: windows.length === limit && store.list({ limit: 1, offset: offset + limit }, now).length
        ? offset + limit : null,
    };
  }

  function cancel(id: string) { return store.cancel(focusText(id, "id")!); }
  return { preview, create, current, list, cancel, getSessions };
}

export type FocusProtectionService = ReturnType<typeof createFocusProtectionService>;
