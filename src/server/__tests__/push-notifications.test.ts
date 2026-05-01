import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPushNotificationService } from "../push-notification-service.js";
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

  it("creates push storage from runtime paths when staging preview context has not injected it yet", async () => {
    await withTestEnv(PUSH_ENV, async () => {
      const { app } = createTestApp({
        pushSubscriptionStore: undefined,
        pushNotificationService: undefined,
      });

      const createRes = await request(app)
        .post("/api/push/subscriptions")
        .send({ subscription: TEST_SUBSCRIPTION });

      expect(createRes.status).toBe(201);

      const statusRes = await request(app).get("/api/push/status");
      expect(statusRes.status).toBe(200);
      expect(statusRes.body).toMatchObject({
        configured: true,
        subscriptionCount: 1,
      });
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
