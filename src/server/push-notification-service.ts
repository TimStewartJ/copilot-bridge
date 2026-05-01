import webpush, { type PushSubscription, type RequestOptions, type SendResult } from "web-push";
import type { AppContext } from "./app-context.js";
import type { GlobalBus, StatusEvent } from "./global-bus.js";
import type { PushSubscriptionStore, StoredPushSubscription } from "./push-subscription-store.js";
import { toWebPushSubscription } from "./push-subscription-store.js";
import { buildPublicUrl } from "./tunnel.js";

const PUSH_TTL_SECONDS = 10 * 60;
const NOTIFICATION_NAME_MAX_LENGTH = 48;
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

export function initPushEventNotifications(
  ctx: Pick<AppContext, "globalBus" | "taskStore" | "sessionTitles" | "apiBasePath">,
  service: PushNotificationService,
): () => void {
  return subscribeToPushEvents(ctx.globalBus, async (event) => {
    if (event.type === "session:user-input" && event.sessionId && event.needsUserInput) {
      const target = buildSessionNotificationTarget(ctx, event.sessionId);
      await service.sendToAll({
        title: target.sessionName,
        body: withTaskContext(target.taskName, "Needs input - tap to respond in Bridge."),
        url: target.url,
        tag: `bridge-session-${event.sessionId}`,
        data: { eventType: "session:user-input", sessionId: event.sessionId },
      });
    }

    if (event.type === "session:idle" && event.sessionId) {
      const target = buildSessionNotificationTarget(ctx, event.sessionId);
      await service.sendToAll({
        title: target.sessionName,
        body: withTaskContext(target.taskName, event.assistantPreview ?? "Finished. Tap to review the latest result."),
        url: target.url,
        tag: `bridge-session-${event.sessionId}`,
        data: { eventType: "session:idle", sessionId: event.sessionId },
      });
    }
  });
}

function subscribeToPushEvents(
  globalBus: GlobalBus,
  notify: (event: StatusEvent) => Promise<void>,
): () => void {
  const busySessions = new Set<string>();
  return globalBus.subscribe((event) => {
    if (event.type === "session:busy" || event.type === "session:stalled") {
      if (event.sessionId) busySessions.add(event.sessionId);
      return;
    }

    if (event.type === "session:idle") {
      if (!event.sessionId || !busySessions.delete(event.sessionId)) return;
    }

    if (event.type !== "session:idle" && event.type !== "session:user-input") return;
    void notify(event).catch((error) => {
      console.warn(`[push] Event notification failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  });
}

function buildSessionNotificationTarget(
  ctx: Pick<AppContext, "taskStore" | "sessionTitles" | "apiBasePath">,
  sessionId: string,
): { sessionName: string; taskName?: string; url: string } {
  const task = ctx.taskStore.findTaskBySessionId(sessionId);
  const sessionTitle = ctx.sessionTitles.getTitle(sessionId);
  const sessionName = normalizeNotificationName(sessionTitle) ?? `Session ${sessionId.slice(0, 8)}`;
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
