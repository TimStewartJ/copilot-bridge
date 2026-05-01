import { afterEach, describe, expect, it, vi } from "vitest";
import { enablePushNotifications, getClientPushState, registerPushServiceWorker } from "./push-notifications";

const SERVER_STATUS = {
  configured: true,
  publicKey: "AQID",
  subject: "mailto:test@example.com",
  missingEnv: [],
  subscriptionCount: 0,
};

function jsonResponse(body: unknown): Response {
  return {
    ok: true,
    json: async () => body,
  } as Response;
}

describe("push notification client helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("registers the push-only service worker even when Web Push APIs are unavailable", async () => {
    const registration = { update: vi.fn(async () => {}) };
    const register = vi.fn(async () => registration);
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", { serviceWorker: { register } });

    await expect(registerPushServiceWorker()).resolves.toBe(registration);
    expect(register).toHaveBeenCalledWith("/service-worker.js", {
      scope: "/",
      updateViaCache: "none",
    });
    expect(registration.update).toHaveBeenCalled();
  });

  it("requests notification permission before awaiting server status on enable", async () => {
    const order: string[] = [];
    const subscription = {
      endpoint: "https://push.example.test/send/subscription-id",
      toJSON: () => ({
        endpoint: "https://push.example.test/send/subscription-id",
        expirationTime: null,
        keys: { p256dh: "p256dh", auth: "auth" },
      }),
    };
    const registration = {
      update: vi.fn(async () => {}),
      pushManager: {
        getSubscription: vi.fn(async () => null),
        subscribe: vi.fn(async () => subscription),
      },
    };
    const notification = {
      permission: "default",
      requestPermission: vi.fn(async () => {
        order.push("permission");
        notification.permission = "granted";
        return "granted";
      }),
    };
    const fetch = vi.fn(async (url: string) => {
      order.push(url.endsWith("/api/push/status") ? "status" : "save");
      return jsonResponse(url.endsWith("/api/push/status") ? SERVER_STATUS : { ok: true });
    });

    vi.stubGlobal("window", {
      isSecureContext: true,
      PushManager: function PushManager() {},
      Notification: notification,
    });
    vi.stubGlobal("navigator", {
      serviceWorker: {
        register: vi.fn(async () => registration),
      },
    });
    vi.stubGlobal("Notification", notification);
    vi.stubGlobal("fetch", fetch);

    await enablePushNotifications();

    expect(order[0]).toBe("permission");
    expect(order).toContain("status");
    expect(registration.pushManager.subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: new Uint8Array([1, 2, 3]),
    });
  });

  it("re-saves an existing subscription during status reconciliation", async () => {
    const subscription = {
      endpoint: "https://push.example.test/send/current-subscription",
      toJSON: () => ({
        endpoint: "https://push.example.test/send/current-subscription",
        expirationTime: null,
        keys: { p256dh: "p256dh", auth: "auth" },
      }),
    };
    const registration = {
      update: vi.fn(async () => {}),
      pushManager: {
        getSubscription: vi.fn(async () => subscription),
      },
    };
    const fetch = vi.fn(async (url: string) =>
      jsonResponse(url.endsWith("/api/push/status") ? SERVER_STATUS : { ok: true })
    );

    vi.stubGlobal("window", {
      isSecureContext: true,
      PushManager: function PushManager() {},
      Notification: { permission: "granted" },
    });
    vi.stubGlobal("navigator", {
      serviceWorker: {
        register: vi.fn(async () => registration),
      },
    });
    vi.stubGlobal("Notification", { permission: "granted" });
    vi.stubGlobal("fetch", fetch);

    await expect(getClientPushState()).resolves.toMatchObject({
      subscribed: true,
      endpoint: "https://push.example.test/send/current-subscription",
    });

    expect(fetch).toHaveBeenCalledWith("/api/push/subscriptions", expect.objectContaining({
      method: "POST",
      body: JSON.stringify({ subscription: subscription.toJSON() }),
    }));
  });
});
