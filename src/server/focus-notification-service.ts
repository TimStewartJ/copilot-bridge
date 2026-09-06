import {
  DEFAULT_FOCUS_NOTIFICATION_POLICY,
  getFocusNotificationClock,
  type FocusNotificationClock,
  type FocusNotificationPolicy,
} from "../shared/focus-notification-policy.js";
import type { FocusProtectionDisposition, FocusProtectionWindow } from "../shared/focus-protection.js";
import type { AlertStore, FocusAlert } from "./focus-domain-store.js";
import type { FocusEvidence } from "./focus-details-store.js";
import type { createFocusAuthorityStore, FocusAuthorityGrant } from "./focus-governance-store.js";
import type {
  FocusDeliveryIdentity,
  FocusNotificationDeliveryStore,
} from "./focus-notification-delivery-store.js";
import type { FocusProtectionStore } from "./focus-protection-store.js";
import type { GlobalBus } from "./global-bus.js";
import type { BridgePushPayload, PushNotificationService, PushSendSummary } from "./push-notification-service.js";
import type { SettingsStore } from "./settings-store.js";
import { buildPublicUrl } from "./public-url.js";

const DELIVERY_REASON = "immediate-alert";
const PENDING_BATCH_SIZE = 500;
const MAX_TIMER_DELAY_MS = 60 * 60_000;
const OVERDUE_RECHECK_MS = 30_000;
const DEADLINE_HEADROOM_MS = 1_000;
const NOT_ATTEMPTED: PushSendSummary = { attempted: 0, sent: 0, failed: 0, pruned: 0 };

export interface FocusNotificationServiceDependencies {
  globalBus: Pick<GlobalBus, "subscribe">;
  alertStore: Pick<AlertStore, "get">;
  authorityStore: Pick<ReturnType<typeof createFocusAuthorityStore>, "resolve">;
  deliveryStore: Pick<FocusNotificationDeliveryStore,
    "get" | "claim" | "suppress" | "finish" | "pending" | "reconcileStaleClaims" | "nextClaimInspectionAt">;
  settingsStore: Pick<SettingsStore, "getSettings">;
  pushService: Pick<PushNotificationService, "sendToAll">;
  protectionStore?: Pick<FocusProtectionStore, "current" | "get" | "hold" | "outstanding" | "settle">;
  apiBasePath?: string;
}

export interface FocusNotificationController {
  flush(): Promise<void>;
  dispose(): Promise<void>;
}

type Eligibility =
  | {
    eligible: false; reason: string; pendingUntil?: number; resolvedGrantId?: string;
    protection?: FocusProtectionWindow; alert?: FocusAlert;
  }
  | {
    eligible: true;
    alert: FocusAlert;
    policy: FocusNotificationPolicy;
    grant: FocusAuthorityGrant;
    deadline: number;
    validUntil: number;
  };

function verifiedEvidence(evidence: FocusEvidence[], now: number): boolean {
  return evidence.length > 0 && evidence.every((entry) => {
    if (typeof entry === "string") return Boolean(entry.trim());
    if (!entry.summary.trim()) return false;
    return entry.observedAt === undefined
      || (Number.isFinite(Date.parse(entry.observedAt)) && Date.parse(entry.observedAt) <= now);
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function initFocusNotificationService(
  deps: FocusNotificationServiceDependencies,
): FocusNotificationController {
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timerFlushPending = false;
  let inspectionRetry = false;
  let inFlight = Promise.resolve();
  let cachedClock: { minute: number; signature: string; value: FocusNotificationClock } | undefined;

  function warn(context: string, error: unknown): void {
    console.warn(`[focus-notifications] ${context}: ${errorMessage(error)}`);
  }

  function clock(policy: FocusNotificationPolicy, now: number): FocusNotificationClock {
    const minute = Math.floor(now / 60_000);
    const protection = deps.protectionStore?.current(now);
    const signature = JSON.stringify([policy, protection]);
    if (!cachedClock || cachedClock.minute !== minute || cachedClock.signature !== signature) {
      cachedClock = { minute, signature, value: getFocusNotificationClock(policy, now, protection) };
    }
    return cachedClock.value;
  }

  function evaluate(identity: FocusDeliveryIdentity, now: number, pinnedGrantId?: string): Eligibility {
    const alert = deps.alertStore.get(identity.objectId);
    if (!alert || alert.objectType !== "alert" || alert.activationId !== identity.activationId) {
      return { eligible: false, reason: "stale-activation" };
    }
    if (alert.lifecycle !== "active" || alert.details.lifecycle !== "active" || alert.status !== "active") {
      return { eligible: false, reason: "inactive-alert" };
    }
    if (alert.details.orphanedAt || alert.taskState === "orphaned" || alert.taskState === "archived") {
      return { eligible: false, reason: "inactive-source" };
    }
    if (alert.taskState === "muted") {
      return { eligible: false, reason: "muted-source" };
    }
    const { details } = alert;
    if (details.notificationMode !== "immediate") return { eligible: false, reason: "not-immediate" };
    const policy = deps.settingsStore.getSettings().focusNotifications ?? DEFAULT_FOCUS_NOTIFICATION_POLICY;
    if (!policy.enableAuthorizedImmediate) return { eligible: false, reason: "policy-disabled" };
    if (!details.sourceFamily?.trim() || !details.producer?.trim() || !details.impact?.trim()
      || !verifiedEvidence(details.evidence, now)) {
      return { eligible: false, reason: "unverified-alert" };
    }
    const observedAt = Date.parse(details.observedAt ?? "");
    const validUntil = details.validUntil === null ? Number.POSITIVE_INFINITY : Date.parse(details.validUntil);
    if (!Number.isFinite(observedAt) || observedAt > now || Number.isNaN(validUntil)
      || validUntil <= now || validUntil <= observedAt) {
      return { eligible: false, reason: "stale-observation" };
    }
    const deadline = Date.parse(details.interventionBy ?? "");
    if (!Number.isFinite(deadline) || deadline <= now) return { eligible: false, reason: "intervention-expired" };
    const window = clock(policy, now);
    if (window.nextReviewAt === null || deadline >= window.nextReviewAt) {
      return { eligible: false, reason: "can-wait-for-review" };
    }
    if (pinnedGrantId && details.authorizationGrantId && details.authorizationGrantId !== pinnedGrantId) {
      return { eligible: false, reason: "authority-changed" };
    }
    const match = {
      taskId: alert.taskId,
      sourceFamily: details.sourceFamily,
      producer: details.producer,
      authorizationGrantId: pinnedGrantId ?? details.authorizationGrantId,
      immediate: true,
    };
    let grant = deps.authorityStore.resolve(match, now);
    if (!grant?.allowImmediate) return { eligible: false, reason: "not-authorized" };
    if (window.quietHours && policy.allowGrantQuietHoursOverride && !grant.allowQuietHoursOverride) {
      grant = deps.authorityStore.resolve({ ...match, quietHoursOverride: true }, now) ?? grant;
    }
    if (window.quietHours && !(policy.allowGrantQuietHoursOverride && grant.allowQuietHoursOverride)) {
      return {
        eligible: false,
        reason: "quiet-hours",
        resolvedGrantId: grant.id,
        ...(window.quietHoursEnd !== null ? { pendingUntil: window.quietHoursEnd } : {}),
      };
    }
    if (window.protection && !(window.protection.allowAuthorizedDeadlineOverride
      && deadline < Date.parse(window.protection.endsAt))) {
      return {
        eligible: false, reason: "protected-focus", resolvedGrantId: grant.id,
        pendingUntil: Date.parse(window.protection.endsAt), protection: window.protection, alert,
      };
    }
    return { eligible: true, alert, policy, grant, deadline, validUntil };
  }

  function workId(identity: FocusDeliveryIdentity): string {
    return JSON.stringify([identity.objectId, identity.activationId]);
  }

  function settle(identity: FocusDeliveryIdentity, disposition: FocusProtectionDisposition, reason?: string): void {
    deps.protectionStore?.settle({ kind: "notification", workId: workId(identity) }, disposition,
      reason ? { reason } : {});
  }

  function settleSuppression(identity: FocusDeliveryIdentity, reason: string): void {
    const disposition = reason === "stale-activation" ? "superseded"
      : reason === "stale-observation" || reason === "intervention-expired" ? "expired" : "no-longer-needed";
    settle(identity, disposition, reason);
  }

  function payload(alert: FocusAlert, identity: FocusDeliveryIdentity): BridgePushPayload {
    const apiBasePath = (deps.apiBasePath ?? "/api").replace(/\/+$/, "");
    const appBasePath = apiBasePath.endsWith("/api") ? apiBasePath.slice(0, -4) : "";
    const routedPath = `${appBasePath}/dashboard/focus?focus=${encodeURIComponent(alert.id)}&episode=${encodeURIComponent(alert.activationId)}`;
    return {
      title: alert.title,
      body: alert.details.impact ?? undefined,
      url: buildPublicUrl(routedPath) ?? routedPath,
      tag: `bridge-focus-${alert.id}-${alert.activationId}`,
      suppressIfFocused: true,
      data: {
        eventType: "focus:changed",
        focusObjectType: "alert",
        focusObjectId: alert.id,
        activationId: alert.activationId,
        ...(identity.transitionId ? { transitionId: identity.transitionId } : {}),
        ...(alert.taskId ? { taskId: alert.taskId } : {}),
        ...(alert.details.originalTaskId ? { originalTaskId: alert.details.originalTaskId } : {}),
        ...(alert.sessionId ? { sessionId: alert.sessionId } : {}),
      },
    };
  }

  async function deliver(identity: FocusDeliveryIdentity): Promise<void> {
    if (disposed) return;
    const existing = deps.deliveryStore.get(identity);
    if (existing?.claimToken || existing?.status === "sent" || existing?.status === "failed") {
      if (existing.status === "sent" || existing.status === "failed") {
        settle(identity, existing.status === "sent" ? "delivered" : "failed");
      }
      return;
    }
    const now = Date.now();
    const eligibility = evaluate(identity, now);
    if (!eligibility.eligible) {
      if (eligibility.protection) {
        deps.protectionStore?.hold(eligibility.protection, {
          kind: "notification", workId: workId(identity),
          scheduledFor: eligibility.alert?.createdAt ?? existing?.createdAt ?? new Date(now).toISOString(),
          title: eligibility.alert?.title,
          ...(eligibility.alert?.sessionId ? { sessionId: eligibility.alert.sessionId } : {}),
        });
      }
      deps.deliveryStore.suppress(identity, eligibility.reason, {
        resolvedGrantId: eligibility.resolvedGrantId,
        pendingUntil: eligibility.pendingUntil !== undefined && eligibility.pendingUntil > now
          ? new Date(eligibility.pendingUntil).toISOString() : null,
      });
      if (eligibility.pendingUntil === undefined) settleSuppression(identity, eligibility.reason);
      return;
    }

    // Anchor coalescing to the first durable episode row, never to a repeated
    // update or process restart. Leave headroom to act before freshness/deadline.
    const createdAt = existing ? Date.parse(existing.createdAt) : now;
    const anchor = Number.isFinite(createdAt) ? Math.min(createdAt, now) : now;
    const previousCoalesceUntil = existing?.suppressionReason === "coalescing" && existing.pendingUntil
      ? Date.parse(existing.pendingUntil) : Number.POSITIVE_INFINITY;
    const coalesceUntil = Math.min(
      anchor + eligibility.policy.coalesceMinutes * 60_000,
      Number.isNaN(previousCoalesceUntil) ? Number.POSITIVE_INFINITY : previousCoalesceUntil,
      eligibility.deadline - DEADLINE_HEADROOM_MS,
      eligibility.validUntil - DEADLINE_HEADROOM_MS,
    );
    if (coalesceUntil > now) {
      deps.deliveryStore.suppress(identity, "coalescing", {
        resolvedGrantId: eligibility.grant.id,
        pendingUntil: new Date(coalesceUntil).toISOString(),
      });
      return;
    }
    if (existing?.pendingUntil && Date.parse(existing.pendingUntil) > now) {
      deps.deliveryStore.suppress(identity, "pending-rechecked", { resolvedGrantId: eligibility.grant.id });
    }
    const claimed = deps.deliveryStore.claim(identity, eligibility.grant.id, Date.now());
    if (!claimed) return;
    schedulePending();

    // No await separates current policy/object/authority resolution, the durable
    // claim, and invocation of sendToAll. Recheck the exact claimed grant too.
    const current = evaluate(identity, Date.now(), eligibility.grant.id);
    if (!current.eligible) {
      if (deps.deliveryStore.finish(claimed, NOT_ATTEMPTED, `Delivery cancelled: ${current.reason}`)) {
        settle(identity, "failed", current.reason);
      }
      return;
    }
    let summary: PushSendSummary;
    try {
      summary = await deps.pushService.sendToAll(payload(current.alert, identity));
    } catch (error) {
      warn(`Push failed for ${identity.objectId}`, error);
      if (deps.deliveryStore.finish(claimed, NOT_ATTEMPTED, errorMessage(error))) {
        settle(identity, "failed", errorMessage(error));
      }
      return;
    }
    if (!deps.deliveryStore.finish(claimed, summary)) return;
    settle(identity, summary.sent > 0 && summary.failed === 0 ? "delivered" : "failed");
    if (summary.failed > 0 || summary.sent === 0) {
      warn(`Delivery incomplete for ${identity.objectId}`, JSON.stringify(summary));
    }
  }

  function pending() {
    return deps.deliveryStore.pending(PENDING_BATCH_SIZE, DELIVERY_REASON);
  }

  function pendingIdentities(): FocusDeliveryIdentity[] {
    const identities = new Map(pending().map((row) => [workId(row), row as FocusDeliveryIdentity]));
    // Holds cover a crash between recording the postponement and creating its
    // delivery row, as well as early cancellation beyond a bounded queue page.
    for (const held of deps.protectionStore?.outstanding("notification") ?? []) {
      const [objectId, activationId] = JSON.parse(held.workId) as [string, string];
      if (!identities.has(held.workId)) {
        identities.set(held.workId, { objectId, activationId, reason: DELIVERY_REASON });
      }
    }
    return [...identities.values()];
  }

  function inspectClaims(): void {
    try {
      deps.deliveryStore.reconcileStaleClaims(Date.now(), PENDING_BATCH_SIZE, DELIVERY_REASON);
      inspectionRetry = false;
    } catch (error) {
      inspectionRetry = true;
      warn("Claim inspection failed", error);
    }
  }

  function schedulePending(retry = false): void {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (disposed) return;
    retry ||= inspectionRetry;
    let delay: number;
    try {
      const rows = pending();
      const inspectionAt = deps.deliveryStore.nextClaimInspectionAt(Date.now(), DELIVERY_REASON);
      if (!rows.length && inspectionAt === null && !retry) return;
      const earliest = Math.min(inspectionAt ?? Number.POSITIVE_INFINITY,
        ...rows.map((row) => Date.parse(row.pendingUntil ?? "")));
      const remaining = earliest - Date.now();
      // An overdue or malformed row must not spin the event loop if a store
      // error or repeated suppression leaves it due after this bounded batch.
      delay = Number.isFinite(remaining) && remaining > 0 ? remaining : OVERDUE_RECHECK_MS;
      if (retry) delay = Math.min(delay, OVERDUE_RECHECK_MS);
    } catch (error) {
      warn("Scheduling pending notifications failed", error);
      delay = OVERDUE_RECHECK_MS;
    }
    timer = setTimeout(() => {
      timer = undefined;
      if (timerFlushPending) {
        inspectClaims();
        schedulePending();
      } else {
        timerFlushPending = true;
        void flush().finally(() => { timerFlushPending = false; });
      }
    }, Math.min(delay, MAX_TIMER_DELAY_MS));
    timer.unref();
  }

  function enqueue(context: string, operation: () => Promise<void | boolean>): Promise<void> {
    if (disposed) return inFlight;
    inFlight = inFlight.then(async () => {
      if (disposed) return;
      let retry = false;
      try {
        retry = await operation() === true;
      } catch (error) {
        retry = true;
        warn(context, error);
      } finally {
        schedulePending(retry);
      }
    });
    return inFlight;
  }

  function flush(): Promise<void> {
    if (disposed) return inFlight;
    // Recovery must not queue behind sendToAll: a transport promise may never
    // settle. Re-arm even when only claimed rows remain after a restart.
    inspectClaims();
    schedulePending();
    return enqueue("Pending notification flush failed", async () => {
      let retry = false;
      for (const row of pendingIdentities()) {
        if (disposed) break;
        try {
          await deliver(row);
        } catch (error) {
          retry = true;
          warn(`Pending notification failed for ${row.objectId}`, error);
        }
      }
      return retry;
    });
  }

  const unsubscribe = deps.globalBus.subscribe((event) => {
    if (event.type === "focus:protection-changed" || event.type === "focus:protection-cleared") {
      void flush();
      return;
    }
    if (disposed || event.type !== "focus:changed" || event.meaningful !== true
      || event.focusObjectType !== "alert" || event.lifecycle !== "active"
      || !event.focusObjectId || !event.activationId) return;
    const identity: FocusDeliveryIdentity = {
      objectId: event.focusObjectId,
      activationId: event.activationId,
      transitionId: event.transitionId,
      reason: DELIVERY_REASON,
    };
    void enqueue("Focus transition notification failed", () => deliver(identity));
  });
  void flush();

  return {
    flush,
    async dispose() {
      disposed = true;
      unsubscribe();
      if (timer) clearTimeout(timer);
      timer = undefined;
      await inFlight;
    },
  };
}
