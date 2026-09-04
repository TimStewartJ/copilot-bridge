import { describe, expect, it, vi } from "vitest";
import request from "./test-http.js";
import { createTestApp } from "./test-app.js";

describe("api router defer reactivation", () => {
  it("reactivates a cancelled one-shot defer", async () => {
    const { app, ctx } = createTestApp();
    const prompt = ctx.deferredPromptStore!.create(
      "session-1",
      "retry this later",
      "2030-01-01T00:00:00.000Z",
    );
    expect(ctx.deferredPromptStore!.cancelById(prompt.id)).toBe(true);
    const poke = vi.fn();
    ctx.deferredPromptRunner = {
      poke,
      start: vi.fn(),
      shutdown: vi.fn(),
    } as NonNullable<typeof ctx.deferredPromptRunner>;
    const events: unknown[] = [];
    ctx.globalBus.subscribe((event) => events.push(event));

    const response = await request(app)
      .post(`/api/sessions/session-1/defers/${prompt.deferId}/reactivate`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      deferId: prompt.deferId,
      kind: "once",
      status: "pending",
      nextRunAt: expect.any(String),
    });
    expect(ctx.deferredPromptStore!.get(prompt.id)).toMatchObject({
      status: "pending",
      runAt: response.body.nextRunAt,
    });
    expect(poke).toHaveBeenCalledOnce();
    expect(events).toContainEqual({
      type: "session:defer-summary",
      sessionId: "session-1",
      deferSummary: { count: 1, runningCount: 0, nextRunAt: response.body.nextRunAt },
    });
  });

  it("reactivates a failed interval defer", async () => {
    const { app, ctx } = createTestApp();
    const loop = ctx.deferLoopStore!.create({
      sessionId: "session-1",
      prompt: "poll later",
      intervalSeconds: 300,
      nextRunAt: "2030-01-01T00:00:00.000Z",
    });
    expect(ctx.deferLoopStore!.markFailedById(loop.id, "backend disconnected")).toBe(true);
    const poke = vi.fn();
    ctx.deferLoopRunner = {
      poke,
      start: vi.fn(),
      shutdown: vi.fn(),
    } as NonNullable<typeof ctx.deferLoopRunner>;
    const events: unknown[] = [];
    ctx.globalBus.subscribe((event) => events.push(event));

    const response = await request(app)
      .post(`/api/sessions/session-1/defers/${loop.deferId}/reactivate`);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      deferId: loop.deferId,
      kind: "interval",
      status: "active",
      nextRunAt: expect.any(String),
    });
    expect(ctx.deferLoopStore!.get(loop.id)).toMatchObject({
      status: "active",
      nextRunAt: response.body.nextRunAt,
    });
    expect(poke).toHaveBeenCalledOnce();
    expect(events).toContainEqual({
      type: "session:defer-summary",
      sessionId: "session-1",
      deferSummary: { count: 1, runningCount: 0, nextRunAt: response.body.nextRunAt },
    });
  });

  it("returns 409 when the defer status cannot be reactivated", async () => {
    const { app, ctx } = createTestApp();
    const prompt = ctx.deferredPromptStore!.create(
      "session-1",
      "already pending",
      "2030-01-01T00:00:00.000Z",
    );

    const response = await request(app)
      .post(`/api/sessions/session-1/defers/${prompt.deferId}/reactivate`);

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      error: `Defer ${prompt.deferId} is pending and cannot be reactivated.`,
    });
  });

  it("returns 404 when the defer does not belong to the session", async () => {
    const { app, ctx } = createTestApp();
    const prompt = ctx.deferredPromptStore!.create(
      "session-2",
      "belongs elsewhere",
      "2030-01-01T00:00:00.000Z",
    );
    expect(ctx.deferredPromptStore!.cancelById(prompt.id)).toBe(true);

    const response = await request(app)
      .post(`/api/sessions/session-1/defers/${prompt.deferId}/reactivate`);

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: `Defer ${prompt.deferId} not found.` });
  });
});
