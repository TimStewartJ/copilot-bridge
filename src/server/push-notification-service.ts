import webpush, { type PushSubscription, type RequestOptions, type SendResult } from "web-push";
import type { AppContext } from "./app-context.js";
import type { StatusEvent } from "./global-bus.js";
import { DEFAULT_FOCUS_NOTIFICATION_POLICY, getFocusNotificationClock } from "../shared/focus-notification-policy.js";
import type { FocusProtectionDisposition, FocusProtectionSession, FocusProtectionWindow } from "../shared/focus-protection.js";
import type { FocusDeliveryIdentity, FocusNotificationDeliveryStore } from "./focus-notification-delivery-store.js";
import type { FocusProtectionStore } from "./focus-protection-store.js";
import type { SettingsStore } from "./settings-store.js";
import type { PushSubscriptionStore, StoredPushSubscription } from "./push-subscription-store.js";
import { toWebPushSubscription } from "./push-subscription-store.js";
import { areSessionUnreadBubblesMuted } from "./task-store.js";
import { buildPublicUrl } from "./public-url.js";

const PUSH_TTL_SECONDS = 10 * 60;
const NOTIFICATION_NAME_MAX_LENGTH = 48;
const NEEDS_INPUT_SUMMARY_REASON = "protected-needs-input";
const PENDING_BATCH_SIZE = 500;
const PENDING_RECHECK_MS = 30_000;
const MAX_PENDING_TIMER_MS = 60 * 60_000;
const NOT_ATTEMPTED: PushSendSummary = { attempted: 0, sent: 0, failed: 0, pruned: 0 };
const PUSH_ENV = {
  publicKey: "BRIDGE_PUSH_VAPID_PUBLIC_KEY",
  privateKey: "BRIDGE_PUSH_VAPID_PRIVATE_KEY",
  subject: "BRIDGE_PUSH_VAPID_SUBJECT",
} as const;

export interface PushPublicStatus {
  configured: boolean;
  publicKey?: string;
  subject?: string;
  missingEnv: string[];
  subscriptionCount: number;
}

interface PushConfigDetails {
  configured: boolean;
  publicKey?: string;
  privateKey?: string;
  subject?: string;
  missingEnv: string[];
}

export interface BridgePushPayload {
  title: string;
  body?: string;
  url?: string;
  tag?: string;
  data?: Record<string, unknown>;
  icon?: string;
  badge?: string;
  suppressIfFocused?: boolean;
}

export interface PushSendSummary {
  attempted: number;
  sent: number;
  failed: number;
  pruned: number;
}

type SendNotification = (
  subscription: PushSubscription,
  payload?: string | Buffer | null,
  options?: RequestOptions,
) => Promise<SendResult>;

export function readPushConfig(env: NodeJS.ProcessEnv = process.env): PushConfigDetails {
  const publicKey = env[PUSH_ENV.publicKey]?.trim();
  const privateKey = env[PUSH_ENV.privateKey]?.trim();
  const subject = env[PUSH_ENV.subject]?.trim();
  const missingEnv: string[] = [];
  if (!publicKey) missingEnv.push(PUSH_ENV.publicKey);
  if (!privateKey) missingEnv.push(PUSH_ENV.privateKey);
  if (!subject) missingEnv.push(PUSH_ENV.subject);

  return {
    configured: missingEnv.length === 0,
    ...(publicKey ? { publicKey } : {}),
    ...(privateKey ? { privateKey } : {}),
    ...(subject ? { subject } : {}),
    missingEnv,
  };
}

export function getPushPublicStatus(
  subscriptionStore?: PushSubscriptionStore,
  env: NodeJS.ProcessEnv = process.env,
): PushPublicStatus {
  const config = readPushConfig(env);
  return {
    configured: config.configured,
    ...(config.publicKey ? { publicKey: config.publicKey } : {}),
    ...(config.subject ? { subject: config.subject } : {}),
    missingEnv: config.missingEnv,
    subscriptionCount: subscriptionStore?.countSubscriptions() ?? 0,
  };
}

export function isExpiredPushSubscriptionError(error: unknown): boolean {
  if (error && typeof error === "object" && "statusCode" in error) {
    const statusCode = (error as { statusCode?: unknown }).statusCode;
    return statusCode === 404 || statusCode === 410;
  }
  return false;
}

export function createPushNotificationService({
  subscriptionStore,
  env = process.env,
  sendNotification = webpush.sendNotification,
}: {
  subscriptionStore: PushSubscriptionStore;
  env?: NodeJS.ProcessEnv;
  sendNotification?: SendNotification;
}) {
  async function sendToStoredSubscription(
    subscription: StoredPushSubscription,
    payload: BridgePushPayload,
  ): Promise<"sent" | "pruned"> {
    const config = readPushConfig(env);
    if (!config.configured || !config.publicKey || !config.privateKey || !config.subject) {
      throw new Error(`Push notifications are not configured. Missing: ${config.missingEnv.join(", ")}`);
    }

    try {
      await sendNotification(
        toWebPushSubscription(subscription),
        JSON.stringify(payload),
        {
          TTL: PUSH_TTL_SECONDS,
          vapidDetails: {
            subject: config.subject,
            publicKey: config.publicKey,
            privateKey: config.privateKey,
          },
        },
      );
      subscriptionStore.touchSubscription(subscription.endpoint);
      return "sent";
    } catch (error) {
      if (isExpiredPushSubscriptionError(error)) {
        subscriptionStore.deleteSubscription(subscription.endpoint);
        return "pruned";
      }
      throw error;
    }
  }

  async function sendToEndpoint(endpoint: string, payload: BridgePushPayload): Promise<PushSendSummary> {
    const subscription = subscriptionStore.getSubscriptionByEndpoint(endpoint);
    if (!subscription) {
      return { attempted: 0, sent: 0, failed: 0, pruned: 0 };
    }
    const result = await sendToStoredSubscription(subscription, payload);
    return {
      attempted: 1,
      sent: result === "sent" ? 1 : 0,
      failed: 0,
      pruned: result === "pruned" ? 1 : 0,
    };
  }

  async function sendToAll(payload: BridgePushPayload): Promise<PushSendSummary> {
    const subscriptions = subscriptionStore.listSubscriptions();
    const summary: PushSendSummary = {
      attempted: subscriptions.length,
      sent: 0,
      failed: 0,
      pruned: 0,
    };

    const results = await Promise.allSettled(
      subscriptions.map((subscription) => sendToStoredSubscription(subscription, payload)),
    );
    for (const result of results) {
      if (result.status === "fulfilled") {
        if (result.value === "sent") summary.sent += 1;
        if (result.value === "pruned") summary.pruned += 1;
      } else {
        summary.failed += 1;
        console.warn(`[push] Notification failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`);
      }
    }

    return summary;
  }

  return { sendToEndpoint, sendToAll };
}

export type PushNotificationService = ReturnType<typeof createPushNotificationService>;

export interface PushEventNotificationOptions {
  protectionStore?: Pick<FocusProtectionStore, "current" | "get" | "hold" | "outstanding" | "settle">;
  getSessions?: () => FocusProtectionSession[];
  deliveryStore?: Pick<FocusNotificationDeliveryStore,
    "get" | "claim" | "suppress" | "finish" | "pending" | "reconcileSessionCoverage"
    | "reconcileStaleClaims" | "nextClaimInspectionAt">;
  settingsStore?: Pick<SettingsStore, "getSettings">;
  startImmediately?: boolean;
}

export type PushEventNotificationDisposer = (() => Promise<void>) & { flush(): Promise<void> };

export function initPushEventNotifications(
  ctx: Pick<AppContext, "globalBus" | "taskStore" | "cliSessionCatalog" | "apiBasePath">
    & Partial<Pick<AppContext, "decisionStore" | "focusAttentionStore">>,
  service: PushNotificationService,
  options: PushEventNotificationOptions = {},
): PushEventNotificationDisposer {
  const { protectionStore, deliveryStore, getSessions } = options;
  if (protectionStore && (!deliveryStore || !getSessions)) {
    throw new Error("Protected needs-input notifications require deliveryStore and getSessions");
  }
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timerFlushPending = false;
  let inspectionRetry = false;
  let flushing = Promise.resolve();
  const inFlight = new Set<Promise<void>>();
  const notifiedSessions = new Set<string>();
  const mutedSessions = new Set<string>();
  const inputEpisodes = new Map<string, number>();
  const sendingSessions = new Map<string, number>();
  let nextInputEpisode = 0;

  function warn(context: string, error: unknown): void {
    console.warn(`[push] ${context}: ${error instanceof Error ? error.message : String(error)}`);
  }

  function summaryIdentity(windowId: string): FocusDeliveryIdentity {
    return { objectId: windowId, activationId: windowId, reason: NEEDS_INPUT_SUMMARY_REASON };
  }

  function waitingSessions(sessions: FocusProtectionSession[]): FocusProtectionSession[] {
    return sessions.filter((session) => session.pendingUserInputCount > 0 && !session.muted
      && !isSessionLinkedToMutedTask(ctx, session.sessionId));
  }

  function inputEpisode(sessionId: string): number {
    let generation = inputEpisodes.get(sessionId);
    if (generation === undefined) {
      generation = ++nextInputEpisode;
      inputEpisodes.set(sessionId, generation);
    }
    return generation;
  }

  function clearInputEpisode(sessionId: string): void {
    inputEpisodes.delete(sessionId);
    notifiedSessions.delete(sessionId);
    mutedSessions.delete(sessionId);
  }

  function markDelivered(sessionId: string, generation: number): void {
    // A delivery for an answered input must not cover a later input episode.
    if (inputEpisodes.get(sessionId) === generation) notifiedSessions.add(sessionId);
  }

  function synchronizeCoverage(sessions: FocusProtectionSession[], claimedOnly = false): Set<string> {
    const waitingIds = sessions.filter((session) => session.pendingUserInputCount > 0).map((session) => session.sessionId);
    const waiting = new Set(waitingIds);
    for (const sessionId of inputEpisodes.keys()) if (!waiting.has(sessionId)) clearInputEpisode(sessionId);
    for (const sessionId of waitingIds) inputEpisode(sessionId);
    return new Set(deliveryStore?.reconcileSessionCoverage(NEEDS_INPUT_SUMMARY_REASON, waitingIds, { claimedOnly }) ?? []);
  }

  function queueSummary(window: FocusProtectionWindow, sessions: FocusProtectionSession[]): void {
    if (!protectionStore || !deliveryStore || !sessions.length) return;
    protectionStore.hold(window, {
      kind: "needs-input", workId: window.id, scheduledFor: window.startsAt, title: "Coalesced needs-input summary",
    });
    deliveryStore.suppress(summaryIdentity(window.id), "protected-focus", {
      pendingUntil: window.endsAt, context: { pendingSessionIds: sessions.map((session) => session.sessionId).sort() },
    });
  }

  function settleSummary(windowId: string, disposition: FocusProtectionDisposition,
    included?: Set<string>, reason?: string): void {
    for (const held of protectionStore?.outstanding("needs-input") ?? []) {
      if (held.windowId !== windowId) continue;
      protectionStore?.settle({ kind: "needs-input", workId: held.workId, scheduledFor: held.scheduledFor },
        included && held.sessionId && !included.has(held.sessionId) ? "no-longer-needed" : disposition,
        { ...(reason ? { reason } : {}), deliveryObjectId: windowId });
    }
  }

  function discardSummary(windowId: string, reason: "no-longer-needed" | "superseded"): void {
    deliveryStore?.suppress(summaryIdentity(windowId), reason, { terminal: true });
    const row = deliveryStore?.get(summaryIdentity(windowId));
    if (row?.status === "suppressed" && row.suppressionReason === reason) settleSummary(windowId, reason);
  }

  function pendingSummaries() {
    return deliveryStore?.pending(PENDING_BATCH_SIZE, NEEDS_INPUT_SUMMARY_REASON) ?? [];
  }

  function inspectClaims(): void {
    try {
      deliveryStore?.reconcileStaleClaims(Date.now(), PENDING_BATCH_SIZE, NEEDS_INPUT_SUMMARY_REASON);
      inspectionRetry = false;
    } catch (error) {
      inspectionRetry = true;
      warn("Protected needs-input claim inspection failed", error);
    }
  }

  function schedulePending(retry = false): void {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (disposed || !deliveryStore) return;
    retry ||= inspectionRetry;
    let remaining = Number.POSITIVE_INFINITY;
    try {
      const inspectionAt = deliveryStore.nextClaimInspectionAt(Date.now(), NEEDS_INPUT_SUMMARY_REASON);
      if (inspectionAt !== null) remaining = inspectionAt - Date.now();
      for (const row of pendingSummaries()) {
        remaining = Math.min(remaining, Date.parse(row.pendingUntil!) - Date.now());
      }
      const current = protectionStore?.current();
      if (current && !current.allowNeedsInput) {
        remaining = Math.min(remaining, Date.parse(current.endsAt) - Date.now());
      }
    } catch (error) {
      warn("Scheduling protected needs-input summaries failed", error);
      retry = true;
    }
    if (retry) remaining = Math.min(remaining, PENDING_RECHECK_MS);
    if (remaining === Number.POSITIVE_INFINITY) return;
    const delay = Number.isFinite(remaining) && remaining > 0 ? remaining : PENDING_RECHECK_MS;
    timer = setTimeout(() => {
      timer = undefined;
      if (timerFlushPending) {
        inspectClaims();
        schedulePending();
      } else {
        timerFlushPending = true;
        void flush().finally(() => { timerFlushPending = false; });
      }
    }, Math.min(delay, MAX_PENDING_TIMER_MS));
    timer.unref();
  }

  async function releaseSummary(window: FocusProtectionWindow): Promise<void> {
    if (disposed || !protectionStore || !deliveryStore || !getSessions) return;
    const sessions = getSessions();
    const covered = synchronizeCoverage(sessions, true);
    const waiting = waitingSessions(sessions).filter((session) => !covered.has(session.sessionId));
    if (!waiting.length) {
      discardSummary(window.id, "no-longer-needed");
      return;
    }
    const now = Date.now();
    const current = protectionStore.current(now);
    if (current && !current.allowNeedsInput) {
      queueSummary(current, waiting);
      if (current.id !== window.id) discardSummary(window.id, "superseded");
      return;
    }
    const policy = options.settingsStore?.getSettings().focusNotifications ?? DEFAULT_FOCUS_NOTIFICATION_POLICY;
    const clock = getFocusNotificationClock(policy, now, current);
    const identity = summaryIdentity(window.id);
    if (clock.quietHours) {
      deliveryStore.suppress(identity, "quiet-hours", {
        pendingUntil: clock.quietHoursEnd === null ? null : new Date(clock.quietHoursEnd).toISOString(),
      });
      return;
    }
    deliveryStore.suppress(identity, "summary-ready");
    const sessionIds = waiting.map((session) => session.sessionId);
    const episodes = new Map(sessionIds.map((sessionId) => [sessionId, inputEpisode(sessionId)]));
    const included = new Set(sessionIds);
    const claimed = deliveryStore.claim(identity, null, now, {
      protectionWindowId: window.id, sessionIds, pendingSessionIds: sessionIds,
    });
    if (!claimed) return;
    schedulePending();

    // Pin the selected current sessions in the durable claim before invoking
    // push. Never replay an ambiguous claim, including after a process crash.
    const fresh = waitingSessions(getSessions()).filter((session) => !covered.has(session.sessionId));
    const latestProtection = protectionStore.current();
    const latestPolicy = options.settingsStore?.getSettings().focusNotifications ?? DEFAULT_FOCUS_NOTIFICATION_POLICY;
    if ((latestProtection && !latestProtection.allowNeedsInput)
      || getFocusNotificationClock(latestPolicy).quietHours
      || sessionIds.some((sessionId) => inputEpisodes.get(sessionId) !== episodes.get(sessionId))
      || fresh.length !== waiting.length || fresh.some((session) => !included.has(session.sessionId))) {
      const includedSessionIds = fresh.map((session) => session.sessionId);
      if (deliveryStore.finish(claimed, NOT_ATTEMPTED, "Delivery cancelled: needs-input state or policy changed",
        { includedSessionIds, reason: "state-or-policy-changed" })) {
        settleSummary(window.id, "failed", new Set(includedSessionIds), "state-or-policy-changed");
      }
      return;
    }
    const apiBasePath = (ctx.apiBasePath ?? "/api").replace(/\/+$/, "");
    const appBasePath = apiBasePath.endsWith("/api") ? apiBasePath.slice(0, -4) : "";
    const path = `${appBasePath}/dashboard/focus`;
    const names = fresh.slice(0, 3).map((session) => normalizeNotificationName(session.title)
      ?? `Session ${session.sessionId.slice(0, 8)}`).join(", ");
    let summary: PushSendSummary;
    try {
      summary = await service.sendToAll({
        title: `${fresh.length} ${fresh.length === 1 ? "session needs" : "sessions need"} input`,
        body: `${names}${fresh.length > 3 ? ` and ${fresh.length - 3} more` : ""} — tap to respond in Bridge.`,
        url: fresh.length === 1 ? buildSessionNotificationTarget(ctx, fresh[0].sessionId).url : buildPublicUrl(path) ?? path,
        tag: `bridge-needs-input-${window.id}`,
        data: { eventType: "session:user-input", protectionWindowId: window.id,
          sessionIds: sessionIds.slice(0, 10), sessionCount: sessionIds.length, summary: true },
      });
    } catch (error) {
      if (deliveryStore.finish(claimed, NOT_ATTEMPTED, error instanceof Error ? error.message : String(error))) {
        settleSummary(window.id, "failed", included);
      }
      warn("Protected needs-input summary failed", error);
      return;
    }
    if (!deliveryStore.finish(claimed, summary)) return;
    const delivered = summary.sent > 0 && summary.failed === 0;
    if (delivered) for (const [sessionId, generation] of episodes) markDelivered(sessionId, generation);
    settleSummary(window.id, delivered ? "delivered" : "failed", included);
    if (!delivered) warn("Protected needs-input summary incomplete", JSON.stringify(summary));
  }

  async function reconcileSummaries(): Promise<void> {
    if (!protectionStore || !deliveryStore || !getSessions) return;
    const sessions = getSessions();
    const covered = synchronizeCoverage(sessions, true);
    const waiting = waitingSessions(sessions).filter((session) => !covered.has(session.sessionId));
    const current = protectionStore.current();
    if (current && !current.allowNeedsInput) queueSummary(current, waiting);
    const windowIds = new Set([
      ...pendingSummaries().map((row) => row.objectId),
      ...protectionStore.outstanding("needs-input").map((held) => held.windowId),
    ]);
    const releasable: FocusProtectionWindow[] = [];
    for (const windowId of windowIds) {
      const row = deliveryStore.get(summaryIdentity(windowId));
      if (row?.claimToken || row?.status === "sent" || row?.status === "failed") {
        if (row.status === "sent" || row.status === "failed") {
          const context = row.outcomeJson ? JSON.parse(row.outcomeJson) as { sessionIds?: string[] } : {};
          settleSummary(windowId, row.status === "sent" ? "delivered" : "failed", new Set(context.sessionIds ?? []));
        } else if (row.status === "suppressed") {
          settleSummary(windowId, row.suppressionReason === "superseded" ? "superseded" : "no-longer-needed");
        }
        continue;
      }
      const window = protectionStore.get(windowId);
      if (!window) {
        discardSummary(windowId, "no-longer-needed");
        continue;
      }
      if (!row) {
        // A hold may commit immediately before a crash prevented queue creation.
        deliveryStore.suppress(summaryIdentity(windowId), "protected-focus", {
          pendingUntil: window.endsAt, context: { pendingSessionIds: waiting.map((session) => session.sessionId).sort() },
        });
      }
      if (window.status === "active" || window.status === "scheduled") continue;
      if (current && !current.allowNeedsInput) {
        discardSummary(windowId, waiting.length ? "superseded" : "no-longer-needed");
      } else {
        releasable.push(window);
      }
    }
    // Several windows may have elapsed while offline or during standing quiet
    // hours. One current-state summary supersedes their event backlog.
    releasable.sort((a, b) => Date.parse(b.cancelledAt ?? b.endsAt) - Date.parse(a.cancelledAt ?? a.endsAt));
    const [latest, ...older] = releasable;
    for (const window of older) discardSummary(window.id, "superseded");
    if (latest && !disposed) await releaseSummary(latest);
  }

  function flush(): Promise<void> {
    if (disposed) return flushing;
    // Keep durable recovery independent of both session hydration and the
    // serialized summary sender, including a transport that never resolves.
    inspectClaims();
    schedulePending();
    flushing = flushing.then(async () => {
      if (disposed) return;
      let retry = false;
      try {
        await reconcileSummaries();
      } catch (error) {
        retry = true;
        warn("Protected needs-input reconciliation failed", error);
      } finally {
        schedulePending(retry);
      }
    });
    return flushing;
  }

  async function notify(event: StatusEvent): Promise<void> {
    const sessions = getSessions?.();
    const clearedSessionId = event.needsUserInput === false ? event.sessionId : undefined;
    const covered = sessions
      ? synchronizeCoverage(clearedSessionId ? sessions.filter((session) => session.sessionId !== clearedSessionId) : sessions)
      : new Set<string>();
    if (event.sessionId && event.needsUserInput === false) {
      clearInputEpisode(event.sessionId);
      return;
    }
    if (event.type === "session:user-input" && event.sessionId && event.needsUserInput) {
      const session = sessions?.find((entry) => entry.sessionId === event.sessionId);
      if (sessions && (!session || session.pendingUserInputCount <= 0)) return;
      const generation = inputEpisode(event.sessionId);
      const decision = ctx.decisionStore?.getBySessionId(event.sessionId);
      if (session?.muted || isSessionLinkedToMutedTask(ctx, event.sessionId)) {
        if (!mutedSessions.has(event.sessionId)) {
          ctx.focusAttentionStore?.record({
            eventType: "notification_suppression", objectId: decision?.id, objectType: decision ? "decision" : undefined,
            reason: "muted-needs-input", details: { sessionId: event.sessionId },
          });
          mutedSessions.add(event.sessionId);
        }
        return;
      }
      mutedSessions.delete(event.sessionId);
      const protection = protectionStore?.current();
      if (protection && !protection.allowNeedsInput) {
        queueSummary(protection, waitingSessions(sessions!));
        schedulePending();
        return;
      }
      if (protectionStore?.outstanding("needs-input").some((held) => {
        const row = deliveryStore?.get(summaryIdentity(held.windowId));
        return !row || (!row.claimToken && !row.pendingUntil);
      })) {
        void flush();
        return;
      }
      if (covered.has(event.sessionId)) {
        if (pendingSummaries().length) void flush();
        return;
      }
      if (notifiedSessions.has(event.sessionId) || sendingSessions.get(event.sessionId) === generation) return;
      const target = buildSessionNotificationTarget(ctx, event.sessionId);
      ctx.focusAttentionStore?.record({
        eventType: "notification_eligibility", objectId: decision?.id, objectType: decision ? "decision" : undefined,
        reason: "needs-input", details: { sessionId: event.sessionId },
      });
      sendingSessions.set(event.sessionId, generation);
      let summary: PushSendSummary;
      try {
        summary = await service.sendToAll({
          title: target.sessionName,
          body: withTaskContext(target.taskName, "Needs input - tap to respond in Bridge."),
          url: target.url,
          tag: `bridge-session-${event.sessionId}`,
          data: { eventType: "session:user-input", sessionId: event.sessionId, ...(decision ? { focusObjectId: decision.id } : {}) },
        });
      } catch (error) {
        ctx.focusAttentionStore?.record({
          eventType: "notification_delivery", objectId: decision?.id, objectType: decision ? "decision" : undefined,
          reason: "needs-input", details: { sessionId: event.sessionId, ...NOT_ATTEMPTED,
            error: error instanceof Error ? error.message : String(error) },
        });
        throw error;
      } finally {
        if (sendingSessions.get(event.sessionId) === generation) sendingSessions.delete(event.sessionId);
      }
      if (summary.sent > 0 && summary.failed === 0) markDelivered(event.sessionId, generation);
      ctx.focusAttentionStore?.record({
        eventType: "notification_delivery", objectId: decision?.id, objectType: decision ? "decision" : undefined,
        reason: "needs-input", details: { sessionId: event.sessionId, ...summary },
      });
      if (summary.sent === 0 || summary.failed > 0) warn("Needs-input delivery incomplete", JSON.stringify(summary));
    }
  }

  const unsubscribe = ctx.globalBus.subscribe((event) => {
    if (disposed) return;
    if (event.type === "session:user-input") {
      const pending = notify(event).catch((error) => warn("Event notification failed", error))
        .finally(() => inFlight.delete(pending));
      inFlight.add(pending);
    } else if (protectionStore && (event.type === "focus:protection-changed" || event.type === "focus:protection-cleared"
      || event.type === "task:changed" || event.type === "sessions:changed" || event.type === "session:archived")) {
      void flush();
    }
  });
  if ((protectionStore || deliveryStore) && options.startImmediately !== false) void flush();
  return Object.assign(async () => {
    disposed = true;
    unsubscribe();
    if (timer) clearTimeout(timer);
    timer = undefined;
    await Promise.all([flushing, ...inFlight]);
  }, { flush });
}

function isSessionLinkedToMutedTask(
  ctx: Pick<AppContext, "taskStore">,
  sessionId: string,
): boolean {
  const listedTasks = ctx.taskStore.listTasks().filter((task) => task.sessionIds.includes(sessionId));
  if (listedTasks.length > 0) return areSessionUnreadBubblesMuted(listedTasks);
  const fallbackTask = ctx.taskStore.findTaskBySessionId(sessionId);
  return fallbackTask ? areSessionUnreadBubblesMuted([fallbackTask]) : false;
}

function buildSessionNotificationTarget(
  ctx: Pick<AppContext, "taskStore" | "cliSessionCatalog" | "apiBasePath">,
  sessionId: string,
): { sessionName: string; taskName?: string; url: string } {
  const task = ctx.taskStore.findTaskBySessionId(sessionId);
  const cliName = ctx.cliSessionCatalog?.listSessions()
    ?.find((session) => session.sessionId === sessionId)
    ?.summary;
  const sessionName = normalizeNotificationName(cliName) ?? `Session ${sessionId.slice(0, 8)}`;
  const taskName = normalizeNotificationName(task?.title);
  const appPath = task
    ? `/tasks/${encodeURIComponent(task.id)}/sessions/${encodeURIComponent(sessionId)}`
    : `/sessions/${encodeURIComponent(sessionId)}`;
  const apiBasePath = ctx.apiBasePath ?? "/api";
  const appBasePath = apiBasePath.endsWith("/api") ? apiBasePath.slice(0, -4) : "";
  const routedPath = `${appBasePath}${appPath}`;
  return {
    sessionName,
    ...(taskName ? { taskName } : {}),
    url: buildPublicUrl(routedPath) ?? routedPath,
  };
}

function withTaskContext(taskName: string | undefined, body: string): string {
  return taskName ? `${taskName}: ${body}` : body;
}

function normalizeNotificationName(value: string | undefined): string | undefined {
  const normalized = value?.replace(/\s+/g, " ").trim();
  if (!normalized) return undefined;
  if (normalized.length <= NOTIFICATION_NAME_MAX_LENGTH) return normalized;
  return `${normalized.slice(0, NOTIFICATION_NAME_MAX_LENGTH - 3).trimEnd()}...`;
}
