import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPushNotificationService, initPushEventNotifications } from "../push-notification-service.js";
import { createPushSubscriptionStore, type PushSubscriptionInput } from "../push-subscription-store.js";
import { createTestApp, setupTestDb, withTestEnv } from "./helpers.js";

const TEST_SUBSCRIPTION: PushSubscriptionInput = {
  endpoint: "https://push.example.test/send/subscription-id",
  expirationTime: null,
  keys: {
    p256dh: "test-p256dh",
    auth: "test-auth",
  },
};

const PUSH_ENV = {
  BRIDGE_PUSH_VAPID_PUBLIC_KEY: "test-public-key",
  BRIDGE_PUSH_VAPID_PRIVATE_KEY: "test-private-key",
  BRIDGE_PUSH_VAPID_SUBJECT: "mailto:test@example.com",
};

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function getSentPayload(sendNotification: ReturnType<typeof vi.fn>): Record<string, unknown> {
  const payload = sendNotification.mock.calls[0]?.[1];
  if (typeof payload !== "string") throw new Error("Expected push payload to be a string");
  return JSON.parse(payload) as Record<string, unknown>;
}

function createPushTestApp(sessionNames: Record<string, string> = {}) {
  return createTestApp({
    cliSessionCatalog: {
      listSessions: () => Object.entries(sessionNames).map(([sessionId, summary]) => ({ sessionId, summary })),
    } as any,
  });
}

describe("push service worker freshness", () => {
  it("does not intercept fetches or delete origin-wide caches", () => {
    const source = readFileSync(join(REPO_ROOT, "public", "service-worker.js"), "utf-8");

    expect(source).not.toMatch(/addEventListener\(["']fetch["']/);
    expect(source).not.toContain("caches.keys()");
    expect(source).not.toContain("caches.delete");
  });
});

describe("push subscription store", () => {
  it("upserts browser subscriptions by endpoint", () => {
    const db = setupTestDb();
    const store = createPushSubscriptionStore(db);

    const first = store.upsertSubscription(TEST_SUBSCRIPTION, "Test Agent");
    const second = store.upsertSubscription({
      ...TEST_SUBSCRIPTION,
      keys: {
        p256dh: "updated-p256dh",
        auth: "updated-auth",
      },
    }, "Updated Agent");

    expect(second.id).toBe(first.id);
    expect(second.p256dh).toBe("updated-p256dh");
    expect(second.auth).toBe("updated-auth");
    expect(second.userAgent).toBe("Updated Agent");
    expect(store.countSubscriptions()).toBe(1);
  });

  it("deletes subscriptions by endpoint", () => {
    const db = setupTestDb();
    const store = createPushSubscriptionStore(db);
    store.upsertSubscription(TEST_SUBSCRIPTION);

    expect(store.deleteSubscription(TEST_SUBSCRIPTION.endpoint)).toBe(true);
    expect(store.deleteSubscription(TEST_SUBSCRIPTION.endpoint)).toBe(false);
    expect(store.countSubscriptions()).toBe(0);
  });
});

describe("push notification service", () => {
  it("prunes subscriptions that the push provider reports as gone", async () => {
    const db = setupTestDb();
    const store = createPushSubscriptionStore(db);
    store.upsertSubscription(TEST_SUBSCRIPTION);
    const sendNotification = vi.fn().mockRejectedValue({ statusCode: 410 });
    const service = createPushNotificationService({
      subscriptionStore: store,
      env: PUSH_ENV,
      sendNotification,
    });

    const result = await service.sendToAll({ title: "Done" });

    expect(result).toEqual({ attempted: 1, sent: 0, failed: 0, pruned: 1 });
    expect(store.countSubscriptions()).toBe(0);
  });

  it("sends encrypted payloads with VAPID details", async () => {
    const db = setupTestDb();
    const store = createPushSubscriptionStore(db);
    store.upsertSubscription(TEST_SUBSCRIPTION);
    const sendNotification = vi.fn().mockResolvedValue({ statusCode: 201, body: "", headers: {} });
    const service = createPushNotificationService({
      subscriptionStore: store,
      env: PUSH_ENV,
      sendNotification,
    });

    const result = await service.sendToAll({ title: "Done", body: "Session finished" });

    expect(result).toEqual({ attempted: 1, sent: 1, failed: 0, pruned: 0 });
    expect(sendNotification).toHaveBeenCalledWith(
      expect.objectContaining({ endpoint: TEST_SUBSCRIPTION.endpoint }),
      JSON.stringify({ title: "Done", body: "Session finished" }),
      expect.objectContaining({
        TTL: 600,
        vapidDetails: {
          subject: PUSH_ENV.BRIDGE_PUSH_VAPID_SUBJECT,
          publicKey: PUSH_ENV.BRIDGE_PUSH_VAPID_PUBLIC_KEY,
          privateKey: PUSH_ENV.BRIDGE_PUSH_VAPID_PRIVATE_KEY,
        },
      }),
    );
  });
});

describe("push event notification copy", () => {
  it("uses the session title and puts linked task context in needs-input bodies", async () => {
    await withTestEnv(PUSH_ENV, async () => {
      const { ctx } = createPushTestApp({ "session-input": "Message-style push notifications" });
      ctx.pushSubscriptionStore!.upsertSubscription(TEST_SUBSCRIPTION);
      const sendNotification = vi.fn().mockResolvedValue({ statusCode: 201, body: "", headers: {} });
      const service = createPushNotificationService({
        subscriptionStore: ctx.pushSubscriptionStore!,
        env: PUSH_ENV,
        sendNotification,
      });
      const unsubscribe = initPushEventNotifications(ctx, service);
      const task = ctx.taskStore.createTask("Copilot Bridge Local Deployment");
      ctx.taskStore.linkSession(task.id, "session-input");

      ctx.globalBus.emit({ type: "session:user-input", sessionId: "session-input", needsUserInput: true });

      await vi.waitFor(() => expect(sendNotification).toHaveBeenCalled());
      const payload = getSentPayload(sendNotification);
      expect(payload).toMatchObject({
        title: "Message-style push notifications",
        body: "Copilot Bridge Local Deployment: Needs input - tap to respond in Bridge.",
        tag: "bridge-session-session-input",
        data: { eventType: "session:user-input", sessionId: "session-input" },
      });
      expect(String(payload.url)).toContain(`/tasks/${encodeURIComponent(task.id)}/sessions/session-input`);
      unsubscribe();
    });
  });

  it("uses the session title and prefixes linked task context to assistant previews", async () => {
    await withTestEnv(PUSH_ENV, async () => {
      const { ctx } = createPushTestApp({ "session-with-task": "Message-style push notifications" });
      ctx.pushSubscriptionStore!.upsertSubscription(TEST_SUBSCRIPTION);
      const sendNotification = vi.fn().mockResolvedValue({ statusCode: 201, body: "", headers: {} });
      const service = createPushNotificationService({
        subscriptionStore: ctx.pushSubscriptionStore!,
        env: PUSH_ENV,
        sendNotification,
      });
      const unsubscribe = initPushEventNotifications(ctx, service);
      const task = ctx.taskStore.createTask("Copilot Bridge Local Deployment");
      ctx.taskStore.linkSession(task.id, "session-with-task");

      ctx.globalBus.emit({ type: "session:busy", sessionId: "session-with-task" });
      ctx.globalBus.emit({
        type: "session:idle",
        sessionId: "session-with-task",
        assistantPreview: "Implemented the final notification copy change.",
      });

      await vi.waitFor(() => expect(sendNotification).toHaveBeenCalled());
      const payload = getSentPayload(sendNotification);
      expect(payload).toMatchObject({
        title: "Message-style push notifications",
        body: "Copilot Bridge Local Deployment: Implemented the final notification copy change.",
        tag: "bridge-session-session-with-task",
        data: { eventType: "session:idle", sessionId: "session-with-task" },
      });
      expect(String(payload.url)).toContain(`/tasks/${encodeURIComponent(task.id)}/sessions/session-with-task`);
      unsubscribe();
    });
  });

  it("puts the session title in finished notification titles", async () => {
    await withTestEnv(PUSH_ENV, async () => {
      const { ctx } = createPushTestApp({ "session-finished": "  Push   notification\ncopy polish  " });
      ctx.pushSubscriptionStore!.upsertSubscription(TEST_SUBSCRIPTION);
      const sendNotification = vi.fn().mockResolvedValue({ statusCode: 201, body: "", headers: {} });
      const service = createPushNotificationService({
        subscriptionStore: ctx.pushSubscriptionStore!,
        env: PUSH_ENV,
        sendNotification,
      });
      const unsubscribe = initPushEventNotifications(ctx, service);

      ctx.globalBus.emit({ type: "session:busy", sessionId: "session-finished" });
      ctx.globalBus.emit({
        type: "session:idle",
        sessionId: "session-finished",
        assistantPreview: "Implemented the notification copy updates and added coverage.",
      });

      await vi.waitFor(() => expect(sendNotification).toHaveBeenCalled());
      expect(getSentPayload(sendNotification)).toMatchObject({
        title: "Push notification copy polish",
        body: "Implemented the notification copy updates and added coverage.",
        tag: "bridge-session-session-finished",
        data: { eventType: "session:idle", sessionId: "session-finished" },
      });
      unsubscribe();
    });
  });

  it("falls back to a short session id when no task or title is available", async () => {
    await withTestEnv(PUSH_ENV, async () => {
      const { ctx } = createPushTestApp();
      ctx.pushSubscriptionStore!.upsertSubscription(TEST_SUBSCRIPTION);
      const sendNotification = vi.fn().mockResolvedValue({ statusCode: 201, body: "", headers: {} });
      const service = createPushNotificationService({
        subscriptionStore: ctx.pushSubscriptionStore!,
        env: PUSH_ENV,
        sendNotification,
      });
      const unsubscribe = initPushEventNotifications(ctx, service);

      ctx.globalBus.emit({ type: "session:user-input", sessionId: "abcdef123456", needsUserInput: true });

      await vi.waitFor(() => expect(sendNotification).toHaveBeenCalled());
      expect(getSentPayload(sendNotification)).toMatchObject({
        title: "Session abcdef12",
        body: "Needs input - tap to respond in Bridge.",
      });
      unsubscribe();
    });
  });

  it("truncates long notification names", async () => {
    await withTestEnv(PUSH_ENV, async () => {
      const { ctx } = createPushTestApp({
        "long-session": "This is a very long session title that should be shortened for notification displays",
      });
      ctx.pushSubscriptionStore!.upsertSubscription(TEST_SUBSCRIPTION);
      const sendNotification = vi.fn().mockResolvedValue({ statusCode: 201, body: "", headers: {} });
      const service = createPushNotificationService({
        subscriptionStore: ctx.pushSubscriptionStore!,
        env: PUSH_ENV,
        sendNotification,
      });
      const unsubscribe = initPushEventNotifications(ctx, service);

      ctx.globalBus.emit({ type: "session:busy", sessionId: "long-session" });
      ctx.globalBus.emit({ type: "session:idle", sessionId: "long-session", assistantPreview: "Done." });

      await vi.waitFor(() => expect(sendNotification).toHaveBeenCalled());
      expect(getSentPayload(sendNotification)).toMatchObject({
        title: "This is a very long session title that should...",
        body: "Done.",
      });
      unsubscribe();
    });
  });

  it("uses a fallback completion body when no assistant preview is available", async () => {
    await withTestEnv(PUSH_ENV, async () => {
      const { ctx } = createPushTestApp({ "no-preview": "No Preview Session" });
      ctx.pushSubscriptionStore!.upsertSubscription(TEST_SUBSCRIPTION);
      const sendNotification = vi.fn().mockResolvedValue({ statusCode: 201, body: "", headers: {} });
      const service = createPushNotificationService({
        subscriptionStore: ctx.pushSubscriptionStore!,
        env: PUSH_ENV,
        sendNotification,
      });
      const unsubscribe = initPushEventNotifications(ctx, service);

      ctx.globalBus.emit({ type: "session:busy", sessionId: "no-preview" });
      ctx.globalBus.emit({ type: "session:idle", sessionId: "no-preview" });

      await vi.waitFor(() => expect(sendNotification).toHaveBeenCalled());
      expect(getSentPayload(sendNotification)).toMatchObject({
        title: "No Preview Session",
        body: "Finished. Tap to review the latest result.",
      });
      unsubscribe();
    });
  });
});

describe("push notification API", () => {
  it("reports missing VAPID configuration", async () => {
    await withTestEnv({
      BRIDGE_PUSH_VAPID_PUBLIC_KEY: undefined,
      BRIDGE_PUSH_VAPID_PRIVATE_KEY: undefined,
      BRIDGE_PUSH_VAPID_SUBJECT: undefined,
    }, async () => {
      const { app } = createTestApp();

      const res = await request(app).get("/api/push/status");

      expect(res.status).toBe(200);
      expect(res.body.configured).toBe(false);
      expect(res.body.missingEnv).toEqual([
        "BRIDGE_PUSH_VAPID_PUBLIC_KEY",
        "BRIDGE_PUSH_VAPID_PRIVATE_KEY",
        "BRIDGE_PUSH_VAPID_SUBJECT",
      ]);
    });
  });

  it("registers and unregisters the current browser subscription", async () => {
    await withTestEnv(PUSH_ENV, async () => {
      const { app, ctx } = createTestApp();

      const createRes = await request(app)
        .post("/api/push/subscriptions")
        .set("user-agent", "Push Test")
        .send({ subscription: TEST_SUBSCRIPTION });

      expect(createRes.status).toBe(201);
      expect(createRes.body.subscription.endpoint).toBe(TEST_SUBSCRIPTION.endpoint);
      expect(ctx.pushSubscriptionStore?.countSubscriptions()).toBe(1);

      const deleteRes = await request(app)
        .delete("/api/push/subscriptions")
        .send({ endpoint: TEST_SUBSCRIPTION.endpoint });

      expect(deleteRes.status).toBe(200);
      expect(deleteRes.body).toEqual({ ok: true, deleted: true });
      expect(ctx.pushSubscriptionStore?.countSubscriptions()).toBe(0);
    });
  });

  it("fails clearly when push storage is not injected into the app context", async () => {
    await withTestEnv(PUSH_ENV, async () => {
      const { app } = createTestApp({
        pushSubscriptionStore: undefined,
        pushNotificationService: undefined,
      });

      const createRes = await request(app)
        .post("/api/push/subscriptions")
        .send({ subscription: TEST_SUBSCRIPTION });

      expect(createRes.status).toBe(500);
      expect(createRes.body.error).toContain("Push subscription store is not configured");
    });
  });

  it("rejects malformed subscriptions", async () => {
    const { app } = createTestApp();

    const res = await request(app)
      .post("/api/push/subscriptions")
      .send({ subscription: { endpoint: "http://not-secure.test" } });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain("Valid push subscription");
  });
});
