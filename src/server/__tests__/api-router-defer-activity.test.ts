import { describe, expect, it } from "vitest";
import { parseDeferId } from "../defer-ids.js";
import { createReturnedDeferDelivery } from "../defer-result-message.js";
import { createTestApp } from "./test-app.js";
import request from "./test-http.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_SESSION_ID = "22222222-2222-4222-8222-222222222222";

describe("session deferred activity routes", () => {
  it("lists active and inactive defers with recent worker receipts", async () => {
    const { app, ctx } = createTestApp();
    const once = ctx.deferredPromptStore!.create(
      SESSION_ID,
      "Check a build once",
      "2030-01-01T00:10:00.000Z",
    );
    const loop = ctx.deferLoopStore!.create({
      sessionId: SESSION_ID,
      name: "Build monitor",
      prompt: "Watch build 123",
      intervalSeconds: 1_200,
      nextRunAt: "2030-01-01T00:05:00.000Z",
      maxRuns: 10,
    });
    ctx.deferLoopStore!.markFailedById(loop.id, "Build API unavailable");
    ctx.telemetryStore!.recordSpan({
      name: "defer.worker",
      sessionId: SESSION_ID,
      duration: 1_250,
      source: "server",
      metadata: {
        deferId: once.deferId,
        kind: "once",
        action: "return",
        deliveryId: "delivery-1",
        model: "small-model",
        reasoningEffort: "low",
        contextTier: "default",
        usageCaptured: true,
        totalTokens: 1_234,
        meteredAiCredits: 2.5,
        estimatedAiCredits: 1.25,
      },
    });
    ctx.deferredPromptStore!.enqueueDelivery(createReturnedDeferDelivery(
      { deferId: once.deferId, kind: "once", parentSessionId: SESSION_ID },
      "Returned result",
      { deliveryId: "delivery-1" },
    ));
    ctx.telemetryStore!.recordSpan({
      name: "defer.worker",
      sessionId: SESSION_ID,
      duration: 900,
      source: "server",
      metadata: {
        deferId: loop.deferId,
        kind: "interval",
        action: "error",
        runCount: 3,
        model: "small-model",
        error: "Build API unavailable",
      },
    });

    const response = await request(app).get(`/api/sessions/${SESSION_ID}/defers`);

    expect(response.status).toBe(200);
    expect(response.body.sessionId).toBe(SESSION_ID);
    expect(response.body.defers).toEqual([
      expect.objectContaining({
        deferId: once.deferId,
        kind: "once",
        status: "pending",
        canCancel: true,
        canReactivate: false,
      }),
      expect.objectContaining({
        deferId: loop.deferId,
        kind: "interval",
        name: "Build monitor",
        status: "failed",
        lastError: "Build API unavailable",
        canCancel: false,
        canReactivate: true,
      }),
    ]);
    expect(response.body.recentRuns).toEqual(expect.arrayContaining([
      expect.objectContaining({
        deferId: loop.deferId,
        action: "error",
        runCount: 3,
        error: "Build API unavailable",
      }),
      expect.objectContaining({
        deferId: once.deferId,
        action: "return",
        model: "small-model",
        deliveryStatus: "pending",
        usageCaptured: true,
        totalTokens: 1_234,
        meteredAiCredits: 2.5,
        estimatedAiCredits: 1.25,
      }),
    ]));
    expect(response.body.recentDeliveries).toEqual([
      expect.objectContaining({
        id: "delivery-1",
        deferId: once.deferId,
        status: "pending",
      }),
    ]);
  });

  it("returns per-defer runs and rejects another session's defer", async () => {
    const { app, ctx } = createTestApp();
    const loop = ctx.deferLoopStore!.create({
      sessionId: SESSION_ID,
      prompt: "Watch build 123",
      intervalSeconds: 300,
      nextRunAt: "2030-01-01T00:05:00.000Z",
    });
    ctx.telemetryStore!.recordSpan({
      name: "defer.worker",
      sessionId: SESSION_ID,
      duration: 500,
      source: "server",
      metadata: {
        deferId: loop.deferId,
        kind: "interval",
        action: "continue",
        runCount: 1,
      },
    });
    ctx.telemetryStore!.recordSpan({
      name: "defer.worker",
      sessionId: SESSION_ID,
      duration: 1,
      source: "client",
      metadata: {
        deferId: loop.deferId,
        kind: "interval",
        action: "return",
        runCount: 99,
      },
    });
    ctx.telemetryStore!.recordSpans(Array.from({ length: 510 }, (_, index) => ({
      name: "defer.worker",
      sessionId: SESSION_ID,
      duration: index,
      source: "server" as const,
      metadata: {
        deferId: "interval_other",
        kind: "interval",
        action: "continue",
        runCount: index + 1,
      },
    })));

    const response = await request(app)
      .get(`/api/sessions/${SESSION_ID}/defers/${loop.deferId}/runs`);
    expect(response.status).toBe(200);
    expect(response.body.runs).toEqual([
      expect.objectContaining({ action: "continue", runCount: 1 }),
    ]);

    const forbidden = await request(app)
      .get(`/api/sessions/${OTHER_SESSION_ID}/defers/${loop.deferId}/runs`);
    expect(forbidden.status).toBe(404);
  });

  it("cancels and reactivates defers from the session UI routes", async () => {
    const { app, ctx } = createTestApp();
    const loop = ctx.deferLoopStore!.create({
      sessionId: SESSION_ID,
      prompt: "Watch build 123",
      intervalSeconds: 300,
      nextRunAt: "2030-01-01T00:05:00.000Z",
    });

    const cancelled = await request(app)
      .post(`/api/sessions/${SESSION_ID}/defers/${loop.deferId}/cancel`);
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ status: "cancelled", kind: "interval" });
    expect(ctx.deferLoopStore!.get(parseDeferId(loop.deferId)!.id)?.status).toBe("cancelled");

    const reactivated = await request(app)
      .post(`/api/sessions/${SESSION_ID}/defers/${loop.deferId}/reactivate`);
    expect(reactivated.status).toBe(200);
    expect(reactivated.body).toMatchObject({ status: "active", kind: "interval" });
    expect(ctx.deferLoopStore!.get(parseDeferId(loop.deferId)!.id)?.status).toBe("active");
  });

  it("retries a failed parent delivery without rerunning completed work", async () => {
    const { app, ctx } = createTestApp();
    const loop = ctx.deferLoopStore!.create({
      sessionId: SESSION_ID,
      prompt: "Watch build 123",
      intervalSeconds: 300,
      nextRunAt: "2030-01-01T00:05:00.000Z",
    });
    ctx.deferLoopStore!.markCompleted(loop.id);
    const delivery = ctx.deferredPromptStore!.enqueueDelivery(createReturnedDeferDelivery(
      { deferId: loop.deferId, kind: "interval", parentSessionId: SESSION_ID },
      "Build completed",
      { deliveryId: "delivery-1" },
    ));
    const claimed = ctx.deferredPromptStore!.claimDue(delivery.id, 60_000)!;
    ctx.deferredPromptStore!.markFailed(
      delivery.id,
      claimed.claimToken,
      "Backend unavailable",
    );

    const list = await request(app).get(`/api/sessions/${SESSION_ID}/defers`);
    expect(list.body.defers[0]).toMatchObject({
      deferId: loop.deferId,
      failedDelivery: true,
      canReactivate: true,
    });
    expect(list.body.recentDeliveries[0]).toMatchObject({
      deferId: loop.deferId,
      status: "failed",
      error: "Backend unavailable",
    });

    const response = await request(app)
      .post(`/api/sessions/${SESSION_ID}/defers/${loop.deferId}/reactivate`);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      status: "completed",
      deliveryRetried: true,
    });
    expect(ctx.deferLoopStore!.get(loop.id)?.status).toBe("completed");
    expect(ctx.deferredPromptStore!.get(delivery.id)).toMatchObject({
      status: "pending",
      attempts: 0,
    });
  });

  it("does not claim to cancel an already running worker", async () => {
    const { app, ctx } = createTestApp();
    const loop = ctx.deferLoopStore!.create({
      sessionId: SESSION_ID,
      prompt: "Watch build 123",
      intervalSeconds: 300,
      nextRunAt: new Date(Date.now() - 1_000).toISOString(),
    });
    ctx.deferLoopStore!.claimDue(loop.id, 60_000);

    const response = await request(app)
      .post(`/api/sessions/${SESSION_ID}/defers/${loop.deferId}/cancel`);

    expect(response.status).toBe(409);
    expect(response.body.error).toContain("is running and cannot be cancelled");
    expect(ctx.deferLoopStore!.get(loop.id)?.status).toBe("running");
  });

  it("renews an elapsed expiry window when reactivating a recurring defer", async () => {
    const { app, ctx, db } = createTestApp();
    const createdAt = Date.now();
    const loop = ctx.deferLoopStore!.create({
      sessionId: SESSION_ID,
      prompt: "Watch build 123",
      intervalSeconds: 300,
      nextRunAt: new Date(createdAt - 60_000).toISOString(),
      expiresAt: new Date(createdAt - 1_000).toISOString(),
    });
    ctx.deferLoopStore!.markExpired(loop.id);

    const response = await request(app)
      .post(`/api/sessions/${SESSION_ID}/defers/${loop.deferId}/reactivate`);

    expect(response.status).toBe(200);
    const reactivated = ctx.deferLoopStore!.get(loop.id)!;
    expect(reactivated.status).toBe("active");
    expect(Date.parse(reactivated.expiresAt!)).toBeGreaterThan(Date.parse(reactivated.nextRunAt));

    const firstWindow = Date.parse(reactivated.expiresAt!) - Date.parse(reactivated.nextRunAt);
    db.prepare("UPDATE defer_loops SET expiresAt = ? WHERE id = ?").run(
      new Date(Date.now() - 1_000).toISOString(),
      loop.id,
    );
    ctx.deferLoopStore!.markExpired(loop.id);
    const second = await request(app)
      .post(`/api/sessions/${SESSION_ID}/defers/${loop.deferId}/reactivate`);
    expect(second.status).toBe(200);
    const reactivatedAgain = ctx.deferLoopStore!.get(loop.id)!;
    const secondWindow = Date.parse(reactivatedAgain.expiresAt!)
      - Date.parse(reactivatedAgain.nextRunAt);
    expect(secondWindow).toBe(firstWindow);
  });

  it("leaves worker-runtime slack beyond a long recurring interval after reactivation", async () => {
    const { app, ctx } = createTestApp();
    const loop = ctx.deferLoopStore!.create({
      sessionId: SESSION_ID,
      prompt: "Check weekly",
      intervalSeconds: 8 * 24 * 60 * 60,
      nextRunAt: new Date(Date.now() - 60_000).toISOString(),
      expiresAt: new Date(Date.now() - 1_000).toISOString(),
    });
    ctx.deferLoopStore!.markExpired(loop.id);

    const response = await request(app)
      .post(`/api/sessions/${SESSION_ID}/defers/${loop.deferId}/reactivate`);

    expect(response.status).toBe(200);
    const reactivated = ctx.deferLoopStore!.get(loop.id)!;
    const expiryWindow = Date.parse(reactivated.expiresAt!)
      - Date.parse(reactivated.nextRunAt);
    expect(expiryWindow).toBeGreaterThanOrEqual(
      reactivated.intervalSeconds * 1000 + 15 * 60 * 1000 - 10,
    );
  });

  it("keeps queued parent messages separate from scheduled defers", async () => {
    const { app, ctx } = createTestApp();
    ctx.deferredPromptStore!.enqueueDelivery(createReturnedDeferDelivery(
      { deferId: "interval_1", kind: "interval", parentSessionId: SESSION_ID },
      "secret returned result",
      { deliveryId: "delivery-1" },
    ));

    const response = await request(app).get(`/api/sessions/${SESSION_ID}/defers`);

    expect(response.status).toBe(200);
    expect(response.body.defers).toEqual([]);
    expect(JSON.stringify(response.body)).not.toContain("secret returned result");
  });
});
