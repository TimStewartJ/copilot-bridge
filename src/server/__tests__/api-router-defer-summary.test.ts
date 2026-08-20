import { describe, expect, it, vi } from "vitest";
import request from "./test-http.js";
import { createMockSessionManager } from "./helpers.js";
import { createTestApp } from "./test-app.js";

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
    ctx.sessionTitles.setTitle("session-1", "Cached session");

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

  it("resolves defer summaries with one bulk query per store instead of a query per session", async () => {
    const sessions = Array.from({ length: 25 }, (_, index) => ({
      sessionId: `session-${index}`,
      summary: `Session ${index}`,
    }));
    const sessionManager = {
      ...createMockSessionManager(),
      listSessionsFromDisk: vi.fn(async () => sessions),
    } as any;
    const { app, ctx } = createTestApp({ sessionManager });
    ctx.deferredPromptStore!.create("session-3", "one-shot", "2030-01-01T00:10:00.000Z");
    ctx.deferLoopStore!.create({
      sessionId: "session-7",
      prompt: "loop",
      intervalSeconds: 60,
      nextRunAt: "2030-01-01T00:05:00.000Z",
    });
    const perSessionPromptSpy = vi.spyOn(ctx.deferredPromptStore!, "getSummaryForSession");
    const perSessionLoopSpy = vi.spyOn(ctx.deferLoopStore!, "getSummaryForSession");
    const bulkPromptSpy = vi.spyOn(ctx.deferredPromptStore!, "listSummariesBySession");
    const bulkLoopSpy = vi.spyOn(ctx.deferLoopStore!, "listSummariesBySession");

    const res = await request(app).get("/api/sessions");

    expect(res.status).toBe(200);
    const bySessionId = new Map(res.body.sessions.map((s: any) => [s.sessionId, s]));
    expect(bySessionId.get("session-3")).toMatchObject({ deferSummary: { count: 1, nextRunAt: "2030-01-01T00:10:00.000Z" } });
    expect(bySessionId.get("session-7")).toMatchObject({ deferSummary: { count: 1, nextRunAt: "2030-01-01T00:05:00.000Z" } });
    expect(bySessionId.get("session-0")).toMatchObject({ deferSummary: { count: 0, nextRunAt: null } });
    expect(perSessionPromptSpy).not.toHaveBeenCalled();
    expect(perSessionLoopSpy).not.toHaveBeenCalled();
    // One snapshot for the enriched build plus one for materialization; never per session.
    expect(bulkPromptSpy.mock.calls.length).toBeGreaterThan(0);
    expect(bulkPromptSpy.mock.calls.length).toBeLessThanOrEqual(2);
    expect(bulkLoopSpy.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
