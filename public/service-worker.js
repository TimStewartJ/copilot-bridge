self.addEventListener("install", () => {
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    await self.clients.claim();
  })());
});

self.addEventListener("push", (event) => {
  event.waitUntil(handlePush(event));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(openNotificationTarget(event.notification.data?.url));
});

self.addEventListener("pushsubscriptionchange", (event) => {
  event.waitUntil(Promise.all([
    reconcilePushSubscription(event.newSubscription),
    notifyClients({ type: "pushsubscriptionchange" }),
  ]));
});

async function handlePush(event) {
  const payload = readPayload(event);
  if (payload.suppressIfFocused !== false && await hasFocusedWindowClient()) {
    await notifyClients({ type: "push", payload });
    return;
  }

  const title = typeof payload.title === "string" && payload.title.trim()
    ? payload.title
    : "Copilot Bridge";
  const options = {
    body: typeof payload.body === "string" ? payload.body : undefined,
    tag: typeof payload.tag === "string" ? payload.tag : undefined,
    icon: payload.icon || "./favicon.svg",
    badge: payload.badge || "./favicon.svg",
    data: {
      ...(payload.data && typeof payload.data === "object" ? payload.data : {}),
      url: payload.url || "./",
    },
  };

  await self.registration.showNotification(title, options);
}

function readPayload(event) {
  if (!event.data) return {};
  try {
    return event.data.json();
  } catch {
    return { title: "Copilot Bridge", body: event.data.text() };
  }
}

async function hasFocusedWindowClient() {
  const clients = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  return clients.some((client) => client.focused);
}

async function notifyClients(message) {
  const clients = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });
  for (const client of clients) {
    client.postMessage(message);
  }
}

async function reconcilePushSubscription(changedSubscription) {
  let subscription = changedSubscription || await self.registration.pushManager.getSubscription();
  if (!subscription) {
    const status = await fetchPushStatus();
    if (!status.configured || !status.publicKey) {
      console.warn(`[push] Cannot renew subscription; missing VAPID config: ${(status.missingEnv || []).join(", ")}`);
      return;
    }
    subscription = await self.registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(status.publicKey),
    });
  }

  await savePushSubscription(subscription);
}

async function fetchPushStatus() {
  const response = await fetch(new URL("api/push/status", self.registration.scope), {
    cache: "no-store",
    credentials: "same-origin",
  });
  if (!response.ok) {
    throw new Error(`Push status check failed: ${response.status}`);
  }
  return response.json();
}

async function savePushSubscription(subscription) {
  const response = await fetch(new URL("api/push/subscriptions", self.registration.scope), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    body: JSON.stringify({ subscription: serializePushSubscription(subscription) }),
  });
  if (!response.ok) {
    throw new Error(`Push subscription sync failed: ${response.status}`);
  }
}

function serializePushSubscription(subscription) {
  const json = subscription.toJSON();
  if (!json.endpoint || !json.keys?.p256dh || !json.keys.auth) {
    throw new Error("Browser returned an incomplete push subscription.");
  }
  return {
    endpoint: json.endpoint,
    expirationTime: json.expirationTime || null,
    keys: {
      p256dh: json.keys.p256dh,
      auth: json.keys.auth,
    },
  };
}

async function openNotificationTarget(url) {
  const target = normalizeTargetUrl(url);
  const clients = await self.clients.matchAll({
    type: "window",
    includeUncontrolled: true,
  });

  for (const client of clients) {
    if (client.url === target && "focus" in client) {
      return client.focus();
    }
  }

  if (self.clients.openWindow) {
    return self.clients.openWindow(target);
  }
}

function urlBase64ToUint8Array(base64String) {
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

function normalizeTargetUrl(url) {
  const scopeUrl = new URL(self.registration.scope);
  try {
    if (typeof url !== "string" || !url.trim()) {
      return scopeUrl.toString();
    }

    if (url.startsWith("/")) {
      const absolutePathTarget = new URL(url, self.location.origin);
      if (absolutePathTarget.pathname.startsWith(scopeUrl.pathname)) {
        return absolutePathTarget.toString();
      }
      return new URL(url.replace(/^\/+/, "") || "./", scopeUrl).toString();
    }

    return new URL(url, scopeUrl).toString();
  } catch {
    return scopeUrl.toString();
  }
}
