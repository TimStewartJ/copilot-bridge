import { afterEach, describe, expect, it, vi } from "vitest";
import { createChatGrader, createChatGradesService } from "../server/chat-grading.js";
import type { ApiRouteTestState } from "../test-support/api-routes.js";
import {
  createMockSessionManager,
  createTestApp,
  installApiRouteTestHooks,
  providers,
  request,
} from "../test-support/api-routes.js";

let app: ApiRouteTestState["app"];
let ctx: ApiRouteTestState["ctx"];
let db: ApiRouteTestState["db"];

installApiRouteTestHooks((state) => {
  ({ app, ctx, db } = state);
});

afterEach(() => {
  providers.clearProviderCache();
});

describe("Settings routes", () => {
  it("PATCH /api/settings model change does NOT evict cached sessions", async () => {
    const sessionManager = createMockSessionManager();
    const evictSpy = vi.fn();
    const validateModelSelection = vi.fn().mockResolvedValue({ ok: true });
    sessionManager.evictAllCachedSessions = evictSpy;
    sessionManager.validateModelSelection = validateModelSelection;
    const local = createTestApp({ sessionManager });
    local.ctx.settingsStore.updateSettings({ model: "previous-model", reasoningEffort: "high" });

    const res = await request(local.app)
      .patch("/api/settings")
      .send({ model: "claude-opus-4.7", reasoningEffort: "high" });

    expect(res.status).toBe(200);
    // Model changes are future-only — no eviction, no setModel on cached sessions.
    expect(evictSpy).not.toHaveBeenCalled();
    expect(validateModelSelection).toHaveBeenCalledWith({ model: "claude-opus-4.7" });
  });

  it("PATCH /api/settings rejects known-invalid global models without persisting mixed changes", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.validateModelSelection = vi.fn().mockResolvedValue({
      ok: false,
      error: "Model is not available: invented-model",
    });
    const local = createTestApp({ sessionManager });

    const res = await request(local.app)
      .patch("/api/settings")
      .send({ model: "invented-model", theme: "dark" });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe("Model is not available: invented-model");
    expect(local.ctx.settingsStore.getSettings()).not.toMatchObject({
      model: "invented-model",
      theme: "dark",
    });
  });

  it("PATCH /api/settings skips unchanged stale presets during sticky writes", async () => {
    const sessionManager = createMockSessionManager();
    const validateModelSelection = vi.fn(async ({ model }: { model: string }) => (
      model === "retired-gpt"
        ? { ok: false as const, error: "Model is not available: retired-gpt" }
        : { ok: true as const }
    ));
    sessionManager.validateModelSelection = validateModelSelection;
    const local = createTestApp({ sessionManager });
    local.ctx.settingsStore.updateSettings({
      modelPresets: {
        preset1: { model: "retired-gpt" },
        preset2: { model: "claude-opus-4.7" },
      },
    });

    const res = await request(local.app)
      .patch("/api/settings")
      .send({
        modelPresets: {
          preset1: { model: "retired-gpt", reasoningEffort: "low" },
          preset2: { model: "claude-opus-5", reasoningEffort: "high" },
        },
      });

    expect(res.status).toBe(200);
    expect(res.body.modelPresets).toEqual({
      preset1: { model: "retired-gpt", reasoningEffort: "low" },
      preset2: { model: "claude-opus-5", reasoningEffort: "high" },
    });
    expect(validateModelSelection).toHaveBeenCalledOnce();
    expect(validateModelSelection).toHaveBeenCalledWith({ model: "claude-opus-5" });
  });

  it("PATCH /api/settings validates changed preset and legacy family-default models", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.validateModelSelection = vi.fn().mockResolvedValue({
      ok: false,
      error: "Model is disabled by policy: disabled-model",
    });
    const local = createTestApp({ sessionManager });

    const preset = await request(local.app)
      .patch("/api/settings")
      .send({ modelPresets: { preset2: { model: "disabled-model" } } });
    const legacy = await request(local.app)
      .patch("/api/settings")
      .send({ familyDefaults: { claude: { model: "disabled-model" } } });

    expect(preset.status).toBe(400);
    expect(legacy.status).toBe(400);
    expect(local.ctx.settingsStore.getSettings().modelPresets).toBeUndefined();
  });

  it("PATCH /api/settings allows effort and context changes when no global model exists", async () => {
    const sessionManager = createMockSessionManager();
    const validateModelSelection = vi.fn().mockResolvedValue({ ok: true });
    sessionManager.validateModelSelection = validateModelSelection;
    const local = createTestApp({ sessionManager });

    const res = await request(local.app)
      .patch("/api/settings")
      .send({ reasoningEffort: "high", contextTier: "long_context" });

    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      reasoningEffort: "high",
      contextTier: "long_context",
    });
    expect(validateModelSelection).not.toHaveBeenCalled();
  });

  it("PATCH /api/settings does not revalidate unchanged effort when only context changes", async () => {
    const sessionManager = createMockSessionManager();
    const validateModelSelection = vi.fn().mockResolvedValue({ ok: true });
    sessionManager.validateModelSelection = validateModelSelection;
    const local = createTestApp({ sessionManager });
    local.ctx.settingsStore.updateSettings({
      model: "small-model",
      reasoningEffort: "stale-effort",
      contextTier: "default",
    });

    const res = await request(local.app)
      .patch("/api/settings")
      .send({ contextTier: "long_context" });

    expect(res.status).toBe(200);
    expect(validateModelSelection).not.toHaveBeenCalled();
  });

  it("PATCH /api/settings returns 409 when model settings change during validation", async () => {
    const sessionManager = createMockSessionManager();
    sessionManager.validateModelSelection = vi.fn().mockResolvedValue({ ok: true });
    const local = createTestApp({ sessionManager });
    const prepare = local.ctx.settingsStore.prepareSettingsUpdate.bind(local.ctx.settingsStore);
    let callCount = 0;
    vi.spyOn(local.ctx.settingsStore, "prepareSettingsUpdate").mockImplementation((updates) => {
      const prepared = prepare(updates);
      callCount += 1;
      return {
        ...prepared,
        current: {
          ...prepared.current,
          model: callCount % 2 === 0 ? "concurrent-a" : "concurrent-b",
        },
      };
    });

    const res = await request(local.app)
      .patch("/api/settings")
      .send({ model: "new-model" });

    expect(res.status).toBe(409);
    expect(res.body.error).toContain("changed concurrently");
    expect(local.ctx.settingsStore.getSettings().model).toBeUndefined();
  });

  it.each([
    ["the Fusion context limit", { experimental: { fusionContextTokens: 600_000 } }, { experimental: null }],
    ["the user's name", { userName: "Alex Example" }, { userName: "" }],
  ])("PATCH /api/settings evicts cached sessions when %s changes, not when it stays", async (_name, set, clear) => {
    const sessionManager = createMockSessionManager();
    const evictSpy = vi.fn();
    sessionManager.evictAllCachedSessions = evictSpy;
    const local = createTestApp({ sessionManager });

    const res = await request(local.app).patch("/api/settings").send(set);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject(set);
    expect(evictSpy).toHaveBeenCalledOnce();

    await request(local.app).patch("/api/settings").send(set);
    expect(evictSpy).toHaveBeenCalledOnce();
    await request(local.app).patch("/api/settings").send(clear);
    expect(evictSpy).toHaveBeenCalledTimes(2);
  });

  it("PATCH /api/settings clears the provider cache without evicting cached sessions", async () => {
    const sessionManager = createMockSessionManager();
    const evictSpy = vi.fn();
    sessionManager.evictAllCachedSessions = evictSpy;
    const local = createTestApp({ sessionManager });
    const cachedProvider = providers.getProvider("github");

    const res = await request(local.app)
      .patch("/api/settings")
      .send({ providers: { github: { owner: "octo" } } });

    expect(res.status).toBe(200);
    expect(evictSpy).not.toHaveBeenCalled();
    expect(providers.getProvider("github")).not.toBe(cachedProvider);
  });

  it("GET /api/settings surfaces an unreadable persisted row", async () => {
    db.prepare("INSERT INTO settings (key, value) VALUES ('app', ?)").run("{broken");

    const res = await request(app).get("/api/settings");

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("Persisted app settings are unreadable");
    expect(res.body.error).toContain('repair or remove key "app"');
  });

  it("PATCH /api/settings preserves unreadable settings without clearing caches or sessions", async () => {
    const sessionManager = createMockSessionManager();
    const evictSpy = vi.fn();
    sessionManager.evictAllCachedSessions = evictSpy;
    const local = createTestApp({ sessionManager });
    const cachedProvider = providers.getProvider("github");
    const raw = "{broken";
    local.db.prepare("INSERT INTO settings (key, value) VALUES ('app', ?)").run(raw);

    const res = await request(local.app)
      .patch("/api/settings")
      .send({ theme: "dark" });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("Persisted app settings are unreadable");
    expect(evictSpy).not.toHaveBeenCalled();
    expect(providers.getProvider("github")).toBe(cachedProvider);
    expect(
      (local.db.prepare("SELECT value FROM settings WHERE key = 'app'").get() as { value: string }).value,
    ).toBe(raw);
  });

  it("PATCH /api/settings reports storage failures without runtime side effects", async () => {
    const sessionManager = createMockSessionManager();
    const evictSpy = vi.fn();
    sessionManager.evictAllCachedSessions = evictSpy;
    const local = createTestApp({ sessionManager });
    local.ctx.settingsStore.updateSettings({ theme: "dark" });
    local.db.exec(`
      CREATE TRIGGER block_app_settings_update
      BEFORE UPDATE ON settings
      WHEN NEW.key = 'app'
      BEGIN
        SELECT RAISE(ABORT, 'settings write blocked');
      END;
    `);
    const cachedProvider = providers.getProvider("github");

    const res = await request(local.app)
      .patch("/api/settings")
      .send({ theme: "light" });

    expect(res.status).toBe(500);
    expect(res.body.error).toContain("settings write blocked");
    expect(local.ctx.settingsStore.getSettings().theme).toBe("dark");
    expect(evictSpy).not.toHaveBeenCalled();
    expect(providers.getProvider("github")).toBe(cachedProvider);
  });
});

// ── Read State ───────────────────────────────────────────────────

describe("Read state routes", () => {

  it("POST /api/read-state/:sessionId clamps explicit cursors to server-known activity", async () => {
    ctx.sessionMetaStore.setLastVisibleActivityAt("sess-1", "2026-05-07T21:00:00.000Z");
    ctx.sessionMetaStore.setLastAttentionAt("sess-1", "2026-05-07T21:03:00.000Z");

    const res = await request(app)
      .post("/api/read-state/sess-1")
      .send({ readThroughActivityAt: "2026-05-07T21:05:00.000Z" });

    expect(res.status).toBe(200);
    expect(res.body.lastReadAt).toBe("2026-05-07T21:03:00.000Z");
    expect(res.body.readThroughActivityAt).toBe("2026-05-07T21:03:00.000Z");
  });

});

// ── Model A/B test ───────────────────────────────────────────────

describe("Model comparison routes", () => {
  it("report, a chat's pair and votes validate their input", async () => {
    const local = createTestApp();
    expect((await request(local.app).get("/api/model-ab-test")).body)
      .toEqual({ startedAt: null, pairs: 0, pending: 0, unusable: 0, arms: [], recent: [], judges: [], agreement: [] });
    // Re-judging needs a running test.
    expect((await request(local.app).post("/api/model-ab-test/rejudge").send({})).status).toBe(409);
    expect((await request(local.app).get("/api/model-comparisons/by-session/not-an-id")).status).toBe(400);
    const sessionId = "11111111-2222-4333-8444-555555555555";
    expect((await request(local.app).get(`/api/model-comparisons/by-session/${sessionId}`)).body).toEqual({ comparison: null });
    expect((await request(local.app).post("/api/model-comparisons/pair-1/vote").send({ sessionId, winner: "a" })).status).toBe(400);
    expect((await request(local.app).post("/api/model-comparisons/pair-1/vote").send({ sessionId, winner: "x" })).status).toBe(404);
  });
});

describe("Chat grades routes", () => {
  it("GET /api/chat-grades validates filters, and POST /api/chat-grades/runs starts one run at a time", async () => {
    const local = createTestApp();
    expect((await request(local.app).get("/api/chat-grades").query({ from: "March" })).status).toBe(400);
    expect((await request(local.app).post("/api/chat-grades/runs").send({})).status).toBe(503);

    let finish!: () => void;
    const held = new Promise<void>((resolve) => { finish = resolve; });
    const store = local.ctx.chatGradeStore!;
    const grader = createChatGrader({
      store,
      classify: async () => {
        await held;
        return { classifications: [], trajectoryFingerprint: "fp-1" };
      },
      readEvents: async () => ({ kind: "ok", events: [{ type: "user.message" }], malformedLines: 0 }),
      logger: { log: vi.fn(), warn: vi.fn() },
    });
    local.ctx.chatGrades = createChatGradesService({
      store,
      grader,
      readUsageSessions: async () => [
        { sessionId: "chat-a", models: [{ model: "model-a", outputTokens: 10, totalTokens: 100 }], days: [{ date: "2026-03-02" }] },
        { sessionId: "chat-b", models: [{ model: "model-b", outputTokens: 10, totalTokens: 100 }], days: [{ date: "2026-03-02" }] },
      ],
      scheduledSessionIds: () => new Set(),
      hasEventsLog: async () => true,
      chatTitles: async (sessionIds) => new Map(sessionIds.map((sessionId) => [sessionId, `Title ${sessionId}`])),
      modelNames: async () => new Map([["model-a", "Model A"]]),
      chatContext: (sessionIds) => new Map(sessionIds.map((sessionId) => [sessionId, { playbook: "feature" }])),
      readEvents: async () => ({ kind: "missing" }),
    });

    const started = await request(local.app).post("/api/chat-grades/runs").send({ from: "2026-03-01", models: ["model-a"] });
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({ running: true, total: 1, done: 0 });
    expect((await request(local.app).post("/api/chat-grades/runs").send({ regrade: true })).status).toBe(409);
    finish();
    await grader.settled();

    const view = await request(local.app).get("/api/chat-grades").query({ from: "2026-03-01", models: "model-a" });
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({
      matching: 1,
      graded: 1,
      ungraded: 0,
      models: [{ id: "model-a", name: "Model A", chats: 1 }, { id: "model-b", name: "model-b", chats: 1 }],
      run: { running: false, total: 1, done: 1 },
      report: { classifiers: [], chats: [{ sessionId: "chat-a", title: "Title chat-a", model: "model-a" }] },
    });

    const units = await request(local.app).get("/api/chat-grades/units").query({ from: "2026-03-01" });
    expect(units.status).toBe(200);
    expect(units.headers["cache-control"]).toBe("no-store");
    expect(units.body).toEqual({
      chats: [{ sessionId: "chat-a", title: "Title chat-a", model: "model-a", date: "2026-03-02", scheduled: false, playbook: "feature" }],
      units: [],
    });
    expect((await request(local.app).get("/api/chat-grades/units").query({ excerpts: "1" })).status).toBe(400);
    expect((await request(local.app).get("/api/chat-grades/units").query({ sessionIds: "chat-a" })).status).toBe(400);
    expect((await request(local.app).post("/api/chat-grades/runs").send({ sessionIds: [] })).status).toBe(400);
  });
});
