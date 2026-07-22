import express from "express";
import request from "supertest";
import { describe, expect, it, vi } from "vitest";
import { join } from "node:path";
import type { AppContext } from "../app-context.js";
import { createApiRouter } from "../api-router.js";
import { createEventBusRegistry } from "../event-bus.js";
import { createGlobalBus } from "../global-bus.js";
import { createSessionContextStore } from "../session-context-store.js";
import { createTelemetryStore } from "../telemetry-store.js";
import { createCopilotUsageStore } from "../copilot-usage-store.js";
import { setupTestDb } from "./helpers.js";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";

function createContextApp() {
  const db = setupTestDb();
  const sessionContextStore = createSessionContextStore(db);
  const root = join(process.cwd(), ".test-session-context-api");
  const ctx = {
    sessionContextStore,
    telemetryStore: createTelemetryStore(db),
    copilotUsageStore: createCopilotUsageStore(db),
    globalBus: createGlobalBus(),
    eventBusRegistry: createEventBusRegistry(),
    sessionManager: {
      getSessionRunState: () => "idle",
      getPendingUserInputCount: () => 0,
      listModels: async () => [],
    },
    voiceJobManager: {},
    copilotHome: join(root, "copilot-home"),
    runtimePaths: {
      dataDir: join(root, "data"),
      docsDir: join(root, "docs"),
      docsSnapshotsDir: join(root, "docs-snapshots"),
      copilotHome: join(root, "copilot-home"),
      env: process.env,
    },
  } as unknown as AppContext;
  const app = express();
  app.use("/api", createApiRouter(ctx));
  return { app, sessionContextStore };
}

describe("session context routes", () => {
  it("GET /api/sessions/:id/context returns bounded provider-neutral telemetry", async () => {
    const { app, sessionContextStore } = createContextApp();
    sessionContextStore.recordContextEvent({
      sessionId: SESSION_ID,
      provider: "copilot",
      providerSessionId: SESSION_ID,
      bridgeTurnId: "turn-1",
      providerEventId: "usage-1",
      attribution: "turn",
      type: "context_snapshot",
      occurredAt: "2026-05-01T10:00:00.000Z",
      contextWindow: 100_000,
      tokensUsed: 40_000,
      tokensRemaining: 60_000,
      usageRatio: 0.4,
      modelUsage: { inputTokens: 39_000, outputTokens: 1_000, totalTokens: 40_000 },
      contextWindowCapability: "exact",
      modelUsageCapability: "exact",
    });
    sessionContextStore.recordContextEvent({
      sessionId: SESSION_ID,
      provider: "copilot",
      providerSessionId: SESSION_ID,
      attribution: "session_overhead",
      type: "truncation",
      occurredAt: "2026-05-01T10:01:00.000Z",
      metadata: { eventsRemoved: 2 },
    });

    const res = await request(app).get(`/api/sessions/${SESSION_ID}/context?limit=1`);

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      provider: "copilot",
      summary: {
        sessionId: SESSION_ID,
        provider: "copilot",
        contextWindow: 100_000,
        tokensUsed: 40_000,
        truncationCount: 1,
      },
      capabilities: {
        contextWindow: "exact",
        modelUsage: "exact",
        truncation: "marker",
      },
    });
    expect(res.body.events).toHaveLength(1);
    expect(res.body.events[0]).toMatchObject({
      type: "truncation",
      attribution: "session_overhead",
      bridgeTurnId: null,
    });
  });

  it("GET /api/sessions/:id/context rejects non-canonical session ids", async () => {
    const { app } = createContextApp();
    const res = await request(app).get("/api/sessions/not-a-session/context");
    expect(res.status).toBe(400);
  });

  it("GET /api/sessions/:id/context returns cached context when lazy backfill fails", async () => {
    const { app, sessionContextStore } = createContextApp();
    sessionContextStore.recordContextEvent({
      sessionId: SESSION_ID,
      provider: "codex",
      providerSessionId: "codex-session",
      providerEventId: "codex-usage",
      bridgeTurnId: "turn-1",
      attribution: "turn",
      type: "context_snapshot",
      occurredAt: "2026-05-01T10:00:00.000Z",
      contextWindow: 100_000,
      tokensUsed: 25_000,
      contextWindowCapability: "exact",
    });
    const backfill = vi.spyOn(sessionContextStore, "backfillSessionContextFromEventsFile")
      .mockRejectedValueOnce(new Error("backfill failed"));

    const res = await request(app).get(`/api/sessions/${SESSION_ID}/context`);

    expect(res.status).toBe(200);
    expect(backfill).toHaveBeenCalled();
    expect(res.body).toMatchObject({
      provider: "codex",
      summary: {
        provider: "codex",
        providerSessionId: "codex-session",
        contextWindow: 100_000,
        tokensUsed: 25_000,
      },
    });
  });
});
