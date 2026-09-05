import { describe, expect, it } from "vitest";
import { createTestApp, request } from "../test-support/api-routes.js";
import { TEST_PUSH_ENV, TEST_PUSH_SUBSCRIPTION } from "../test-support/push-notifications.js";
import { withTestEnv } from "../server/__tests__/helpers.js";

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
    await withTestEnv(TEST_PUSH_ENV, async () => {
      const { app, ctx } = createTestApp();

      const createRes = await request(app)
        .post("/api/push/subscriptions")
        .set("user-agent", "Push Test")
        .send({ subscription: TEST_PUSH_SUBSCRIPTION });

      expect(createRes.status).toBe(201);
      expect(createRes.body.subscription.endpoint).toBe(TEST_PUSH_SUBSCRIPTION.endpoint);
      expect(ctx.pushSubscriptionStore?.countSubscriptions()).toBe(1);

      const deleteRes = await request(app)
        .delete("/api/push/subscriptions")
        .send({ endpoint: TEST_PUSH_SUBSCRIPTION.endpoint });

      expect(deleteRes.status).toBe(200);
      expect(deleteRes.body).toEqual({ ok: true, deleted: true });
      expect(ctx.pushSubscriptionStore?.countSubscriptions()).toBe(0);
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
