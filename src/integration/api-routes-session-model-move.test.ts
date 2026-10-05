import { describe, expect, it, vi } from "vitest";
import { createMockSessionManager, createTestApp, makeTestDir, request } from "../test-support/api-routes.js";

const OLD = "model-old";
const NEW = "model-new";
const SESSIONS = {
  first: "11111111-1111-4111-8111-111111111111",
  second: "22222222-2222-4222-8222-222222222222",
  other: "33333333-3333-4333-8333-333333333333",
  archived: "44444444-4444-4444-8444-444444444444",
};

function createMoveApp(overrides: Record<string, unknown> = {}) {
  const models = new Map<string, string>([
    [SESSIONS.first, OLD],
    [SESSIONS.second, OLD],
    [SESSIONS.other, "model-other"],
    [SESSIONS.archived, OLD],
  ]);
  const setSessionModel = vi.fn(async (sessionId: string, model: string) => {
    models.set(sessionId, model);
    return { status: "applied" as const, model };
  });
  const unloadIdleSession = vi.fn(async (_sessionId: string, _reason: string) => true);
  const sessionManager = {
    ...createMockSessionManager(),
    listSessionsFromDisk: async (opts?: { includeArchived?: boolean }) => Object.entries(SESSIONS)
      .filter(([name]) => opts?.includeArchived || name !== "archived")
      .map(([name, sessionId]) => ({ sessionId, summary: `Chat ${name}` })),
    getSessionModelState: async (sessionId: string) => ({ model: models.get(sessionId), source: "events" as const }),
    listModels: async () => [{ id: NEW, name: "New" }],
    setSessionModel,
    unloadIdleSession,
    ...overrides,
  } as any;
  const testApp = createTestApp({ copilotHome: makeTestDir("model-move-api"), sessionManager });
  testApp.ctx.sessionMetaStore.setArchived(SESSIONS.archived, true);
  return { ...testApp, models, setSessionModel, unloadIdleSession };
}

async function waitForMoveToFinish(app: ReturnType<typeof createMoveApp>["app"]) {
  return vi.waitFor(async () => {
    const res = await request(app).get("/api/session-model-move");
    expect(res.body.job?.status).not.toBe("running");
    return res.body.job;
  });
}

describe("session model move routes", () => {
  it("counts the chats that are not archived by model", async () => {
    const { app } = createMoveApp();

    const res = await request(app).get("/api/session-model-move/models");

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      sessionCount: 3,
      unknownCount: 0,
      models: [
        { model: OLD, sessionCount: 2, busyCount: 0 },
        { model: "model-other", sessionCount: 1, busyCount: 0 },
      ],
    });
  });

  it("reports no move before one has run", async () => {
    const { app } = createMoveApp();

    const res = await request(app).get("/api/session-model-move");

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ job: null });
  });

  it("answers a dry run with the chats that would move and changes nothing", async () => {
    const { app, setSessionModel } = createMoveApp();

    const res = await request(app).post("/api/session-model-move").send({ fromModel: OLD, toModel: NEW, dryRun: true });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      dryRun: true,
      fromModel: OLD,
      toModel: NEW,
      sessions: [
        { sessionId: SESSIONS.first, title: "Chat first", busy: false },
        { sessionId: SESSIONS.second, title: "Chat second", busy: false },
      ],
    });
    expect(setSessionModel).not.toHaveBeenCalled();
  });

  it("moves the chats on the old model, leaves archived and other chats, and unloads what it loaded", async () => {
    const { app, models, setSessionModel, unloadIdleSession } = createMoveApp();

    const started = await request(app).post("/api/session-model-move").send({ fromModel: OLD, toModel: NEW });
    expect(started.status).toBe(202);
    expect(started.body.job).toMatchObject({ status: "running", fromModel: OLD, toModel: NEW, total: 2 });

    const job = await waitForMoveToFinish(app);

    expect(job).toMatchObject({ status: "completed", processed: 2, counts: { moved: 2, failed: 0 } });
    expect(setSessionModel.mock.calls.map(([sessionId, model]) => [sessionId, model])).toEqual([
      [SESSIONS.first, NEW],
      [SESSIONS.second, NEW],
    ]);
    expect(unloadIdleSession.mock.calls.map(([sessionId]) => sessionId)).toEqual([SESSIONS.first, SESSIONS.second]);
    expect(models.get(SESSIONS.archived)).toBe(OLD);
    expect(models.get(SESSIONS.other)).toBe("model-other");

    const after = await request(app).get("/api/session-model-move/models");
    expect(after.body.models).toEqual([
      { model: NEW, sessionCount: 2, busyCount: 0 },
      { model: "model-other", sessionCount: 1, busyCount: 0 },
    ]);
  });

  it("refuses a second move while one runs, and stops the running one on cancel", async () => {
    let releaseFirst!: () => void;
    const firstSwitch = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const setSessionModel = vi.fn(async (_sessionId: string, model: string) => {
      await firstSwitch;
      return { status: "applied" as const, model };
    });
    const { app } = createMoveApp({ setSessionModel });

    const started = await request(app).post("/api/session-model-move").send({ fromModel: OLD, toModel: NEW });
    expect(started.status).toBe(202);
    await vi.waitFor(() => expect(setSessionModel).toHaveBeenCalledTimes(1));

    const second = await request(app).post("/api/session-model-move").send({ fromModel: "model-other", toModel: NEW });
    expect(second.status).toBe(409);
    expect(second.body.error).toMatch(/already running/);
    expect(second.body.job).toMatchObject({ id: started.body.job.id, status: "running" });

    const cancelled = await request(app).post("/api/session-model-move/cancel");
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.job).toMatchObject({ status: "running", cancelRequested: true });

    releaseFirst();
    const job = await waitForMoveToFinish(app);
    expect(job).toMatchObject({ status: "cancelled", total: 2, processed: 1, counts: { moved: 1 } });
    expect(setSessionModel).toHaveBeenCalledTimes(1);
  });

  it("rejects a request body it cannot use", async () => {
    const { app, setSessionModel } = createMoveApp();

    const missing = await request(app).post("/api/session-model-move").send({ fromModel: OLD });
    expect(missing.status).toBe(400);
    expect(missing.body.error).toMatch(/toModel/);

    const same = await request(app).post("/api/session-model-move").send({ fromModel: OLD, toModel: OLD });
    expect(same.status).toBe(400);
    expect(same.body.error).toMatch(/must differ/);
    expect(setSessionModel).not.toHaveBeenCalled();
  });

  it("rejects a new model the runtime does not offer before touching any chat", async () => {
    const validateModelSelection = vi.fn(async () => ({ ok: false as const, error: `Model is not available: ${NEW}` }));
    const { app, setSessionModel } = createMoveApp({ validateModelSelection });

    const res = await request(app)
      .post("/api/session-model-move")
      .send({ fromModel: OLD, toModel: NEW, reasoningEffort: "high" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(`Model is not available: ${NEW}`);
    expect(validateModelSelection).toHaveBeenCalledWith({ model: NEW, reasoningEffort: "high" });
    expect(setSessionModel).not.toHaveBeenCalled();
    expect((await request(app).get("/api/session-model-move")).body).toEqual({ job: null });
  });

  it("refuses to start or stop a move for another site's page", async () => {
    const { app, setSessionModel } = createMoveApp();

    const start = await request(app)
      .post("/api/session-model-move")
      .set("Sec-Fetch-Site", "cross-site")
      .send({ fromModel: OLD, toModel: NEW });
    const cancel = await request(app).post("/api/session-model-move/cancel").set("Sec-Fetch-Site", "cross-site");

    expect(start.status).toBe(403);
    expect(cancel.status).toBe(403);
    expect(setSessionModel).not.toHaveBeenCalled();
  });
});
