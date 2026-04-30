import { describe, expect, it, vi } from "vitest";
import request from "supertest";
import { createMockSessionManager, createTestApp } from "./helpers.js";

describe("session list defer summaries", () => {
  it("materializes combined defer summaries without prompt text or defer identifiers", async () => {
    const sessionManager = {
      ...createMockSessionManager(),
      listSessionsFromDisk: vi.fn(async () => [{ sessionId: "session-1", summary: "Deferred session" }]),
    } as any;
    const { app, ctx } = createTestApp({ sessionManager });
    const once = ctx.deferredPromptStore!.create(
      "session-1",
      "private one-shot prompt",
      "2030-01-01T00:10:00.000Z",
    );
    const loop = ctx.deferLoopStore!.create({
      sessionId: "session-1",
      name: "private interval name",
      prompt: "private interval prompt",
      intervalSeconds: 60,
      nextRunAt: "2030-01-01T00:05:00.000Z",
    });

    const res = await request(app).get("/api/sessions");

    expect(res.status).toBe(200);
    expect(res.body.sessions).toEqual([
      expect.objectContaining({
        sessionId: "session-1",
        deferSummary: {
          count: 2,
          nextRunAt: "2030-01-01T00:05:00.000Z",
        },
      }),
    ]);

    const payload = JSON.stringify(res.body);
    expect(payload).not.toContain("private one-shot prompt");
    expect(payload).not.toContain("private interval prompt");
    expect(payload).not.toContain("private interval name");
    expect(payload).not.toContain(once.id);
    expect(payload).not.toContain(once.deferId);
    expect(payload).not.toContain(loop.id);
    expect(payload).not.toContain(loop.deferId);
  });

  it("keeps defer summaries fresh when the enriched session list is cached", async () => {
    const listSessionsFromDisk = vi.fn(async () => [{ sessionId: "session-1", summary: "Cached session" }]);
    const sessionManager = {
      ...createMockSessionManager(),
      listSessionsFromDisk,
    } as any;
    const { app, ctx } = createTestApp({ sessionManager });

    const firstRes = await request(app).get("/api/sessions");
    ctx.deferredPromptStore!.create(
      "session-1",
      "prompt added after session cache warmup",
      "2030-01-01T00:10:00.000Z",
    );
    const secondRes = await request(app).get("/api/sessions");

    expect(firstRes.status).toBe(200);
    expect(secondRes.status).toBe(200);
    expect(firstRes.body.sessions[0]).toMatchObject({
      sessionId: "session-1",
      deferSummary: { count: 0, nextRunAt: null },
    });
    expect(secondRes.body.sessions[0]).toMatchObject({
      sessionId: "session-1",
      deferSummary: { count: 1, nextRunAt: "2030-01-01T00:10:00.000Z" },
    });
    expect(JSON.stringify(secondRes.body)).not.toContain("prompt added after session cache warmup");
    expect(listSessionsFromDisk).toHaveBeenCalledTimes(1);
  });
});
