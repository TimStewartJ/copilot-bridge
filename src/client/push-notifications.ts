import {
  API_BASE,
  deletePushSubscription,
  fetchPushStatus,
  savePushSubscription,
  sendTestPushNotification,
  type BrowserPushSubscription,
  type PushPublicStatus,
  type PushSendSummary,
} from "./api";

export interface BrowserPushSupport {
  supported: boolean;
  reasons: string[];
}

export interface ClientPushState {
  support: BrowserPushSupport;
  permission: NotificationPermission | "unsupported";
  server: PushPublicStatus | null;
  subscribed: boolean;
  endpoint?: string;
}

function serviceWorkerBasePath(): string {
  return API_BASE ? `${API_BASE}/` : "/";
}

function getServiceWorkerSupport(): BrowserPushSupport {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return { supported: false, reasons: ["Browser APIs are not available."] };
  }

  const reasons: string[] = [];
  if (!window.isSecureContext) reasons.push("The app must be served from a secure HTTPS origin.");
  if (!("serviceWorker" in navigator)) reasons.push("This browser does not support service workers.");
  return { supported: reasons.length === 0, reasons };
}

export function getBrowserPushSupport(): BrowserPushSupport {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return { supported: false, reasons: ["Browser APIs are not available."] };
  }

  const reasons: string[] = [];
  if (!window.isSecureContext) reasons.push("The app must be served from a secure HTTPS origin.");
  if (!("serviceWorker" in navigator)) reasons.push("This browser does not support service workers.");
  if (!("PushManager" in window)) reasons.push("This browser does not support Web Push.");
  if (!("Notification" in window)) reasons.push("This browser does not support notifications.");

  return { supported: reasons.length === 0, reasons };
}

export async function registerPushServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  const support = getServiceWorkerSupport();
  if (!support.supported) return null;

  const registration = await navigator.serviceWorker.register(
    `${serviceWorkerBasePath()}service-worker.js`,
    {
      scope: serviceWorkerBasePath(),
      updateViaCache: "none",
    },
  );
  await registration.update();
  return registration;
}

function hasPushManager(registration: ServiceWorkerRegistration): registration is ServiceWorkerRegistration & { pushManager: PushManager } {
  return "pushManager" in registration && !!registration.pushManager;
}

async function getExistingPushSubscription(registration: ServiceWorkerRegistration | null): Promise<PushSubscription | null> {
  if (!registration || !hasPushManager(registration)) return null;
  return registration.pushManager.getSubscription();
}

export async function getClientPushState(): Promise<ClientPushState> {
  const support = getBrowserPushSupport();
  const server = await fetchPushStatus();
  const permission = support.supported ? Notification.permission : "unsupported";
  let subscription: PushSubscription | null = null;

  if (support.supported) {
    const registration = await registerPushServiceWorker();
    subscription = await getExistingPushSubscription(registration);
    if (subscription && permission === "granted" && server.configured) {
      await savePushSubscription(serializePushSubscription(subscription));
    }
  }

  return {
    support,
    permission,
    server,
    subscribed: !!subscription,
    ...(subscription?.endpoint ? { endpoint: subscription.endpoint } : {}),
  };
}

export async function enablePushNotifications(serverStatus?: PushPublicStatus | null): Promise<ClientPushState> {
  const support = getBrowserPushSupport();
  if (!support.supported) {
    throw new Error(support.reasons.join(" "));
  }

  const permission = Notification.permission === "granted"
    ? "granted"
    : await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error(permission === "denied"
      ? "Notification permission is blocked for this site."
      : "Notification permission was not granted.");
  }

  const server = serverStatus ?? await fetchPushStatus();
  if (!server.configured || !server.publicKey) {
    throw new Error(`Push notifications are not configured on the server. Missing: ${server.missingEnv.join(", ")}`);
  }

  const registration = await registerPushServiceWorker();
  if (!registration || !hasPushManager(registration)) {
    throw new Error("Service worker registration is unavailable.");
  }

  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(server.publicKey),
    });
  }

  await savePushSubscription(serializePushSubscription(subscription));
  return getClientPushState();
}

export async function disablePushNotifications(): Promise<ClientPushState> {
  const registration = await registerPushServiceWorker();
  const subscription = await getExistingPushSubscription(registration);
  if (subscription) {
    const endpoint = subscription.endpoint;
    await subscription.unsubscribe();
    await deletePushSubscription(endpoint);
  }
  return getClientPushState();
}

export async function sendCurrentSubscriptionTestNotification(): Promise<PushSendSummary> {
  const registration = await registerPushServiceWorker();
  const subscription = await getExistingPushSubscription(registration);
  if (!subscription) {
    throw new Error("Enable notifications before sending a test notification.");
  }
  await savePushSubscription(serializePushSubscription(subscription));
  return sendTestPushNotification(subscription.endpoint);
}

let subscriptionReconciliationInitialized = false;

export function initPushSubscriptionReconciliation(): void {
  if (subscriptionReconciliationInitialized || typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return;
  }
  subscriptionReconciliationInitialized = true;
  navigator.serviceWorker.addEventListener("message", (event) => {
    const data = event.data as { type?: unknown } | undefined;
    if (data?.type !== "pushsubscriptionchange") return;
    void getClientPushState().catch((error) => {
      console.warn(`[push] Subscription reconciliation failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  });
}

function serializePushSubscription(subscription: PushSubscription): BrowserPushSubscription {
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) {
    throw new Error("Browser returned an incomplete push subscription.");
  }

  return {
    endpoint: json.endpoint,
    expirationTime: json.expirationTime ?? null,
    keys: {
      p256dh: json.keys.p256dh,
      auth: json.keys.auth,
    },
  };
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = "=".repeat((4 - base64String.length % 4) % 4);
  const base64 = `${base64String}${padding}`
    .replace(/-/g, "+")
    .replace(/_/g, "/");
  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let i = 0; i < rawData.length; i += 1) {
    outputArray[i] = rawData.charCodeAt(i);
  }

  return outputArray;
}
