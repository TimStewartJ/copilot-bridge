import { afterEach, describe, expect, it, vi } from "vitest";
import { createModelAbTestGrader } from "../server/model-ab-grading.js";
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

  it("PATCH /api/settings evicts cached sessions when the Fusion context limit changes, not when it stays", async () => {
    const sessionManager = createMockSessionManager();
    const evictSpy = vi.fn();
    sessionManager.evictAllCachedSessions = evictSpy;
    const local = createTestApp({ sessionManager });

    const set = await request(local.app).patch("/api/settings").send({ experimental: { fusionContextTokens: 600_000 } });
    expect(set.status).toBe(200);
    expect(set.body.experimental).toEqual({ fusionContextTokens: 600_000 });
    expect(evictSpy).toHaveBeenCalledOnce();

    await request(local.app).patch("/api/settings").send({ experimental: { fusionContextTokens: 600_000 } });
    expect(evictSpy).toHaveBeenCalledOnce();
    await request(local.app).patch("/api/settings").send({ experimental: null });
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

describe("Model A/B test routes", () => {
  it("GET /api/model-ab-test reports the current test's arms with their recorded cost", async () => {
    const readSummary = vi.fn(async () => ({ sessions: [{ sessionId: "chat-a", meteredAiCredits: 30, meteredTokens: 500 }] }));
    const local = createTestApp({ copilotUsageReader: { readSummary, invalidate: vi.fn(), shutdown: vi.fn(async () => {}) } as never });
    expect((await request(local.app).get("/api/model-ab-test")).body).toEqual({ startedAt: null, arms: [] });

    local.ctx.settingsStore.updateSettings({ modelPresets: { preset2: { model: "model-standard" }, preset3: { model: "model-deep" } } });
    const startedAt = local.ctx.settingsStore.updateSettings({ modelAbTest: { enabled: true, a: "preset2", b: "preset3" } }).modelAbTest!.startedAt!;
    local.ctx.modelAbTestStore!.record({ sessionId: "chat-a", testStartedAt: startedAt, arm: "a", tier: "preset2", model: "model-standard", source: "chat", assignedAt: startedAt });
    local.ctx.modelAbTestStore!.record({ sessionId: "run-b", testStartedAt: startedAt, arm: "b", tier: "preset3", model: "model-deep", source: "schedule", assignedAt: startedAt });

    const res = await request(local.app).get("/api/model-ab-test");
    expect(res.status).toBe(200);
    expect(readSummary).toHaveBeenCalledWith({ sessionIds: ["chat-a", "run-b"], range: "all" });
    expect(res.body).toMatchObject({
      startedAt,
      arms: [
        { arm: "a", chats: 1, scheduledRuns: 0, meteredSessions: 1, meteredAiCredits: 30 },
        { arm: "b", chats: 0, scheduledRuns: 1, meteredSessions: 0 },
      ],
    });
  });

  it("POST /api/model-ab-test/grade starts one grading run and GET reports it", async () => {
    const local = createTestApp();
    expect((await request(local.app).post("/api/model-ab-test/grade").send({})).status).toBe(503);
    let finish!: () => void;
    const held = new Promise<void>((resolve) => { finish = resolve; });
    const grader = createModelAbTestGrader({
      store: local.ctx.modelAbGradeStore!,
      listAssignments: (testStartedAt) => local.ctx.modelAbTestStore!.listForTest(testStartedAt),
      classify: async () => {
        await held;
        return { classifications: [], trajectoryFingerprint: "fp-1" };
      },
      readEvents: async () => ({ kind: "ok", events: [{ type: "user.message" }], malformedLines: 0 }),
      logger: { log: vi.fn(), warn: vi.fn() },
    });
    local.ctx.modelAbTestGrader = grader;
    expect((await request(local.app).post("/api/model-ab-test/grade").send({})).status).toBe(409);

    local.ctx.settingsStore.updateSettings({ modelPresets: { preset2: { model: "model-standard" }, preset3: { model: "model-deep" } } });
    const startedAt = local.ctx.settingsStore.updateSettings({ modelAbTest: { enabled: true, a: "preset2", b: "preset3" } }).modelAbTest!.startedAt!;
    local.ctx.modelAbTestStore!.record({ sessionId: "chat-a", testStartedAt: startedAt, arm: "a", tier: "preset2", model: "model-standard", source: "chat", assignedAt: startedAt });

    const started = await request(local.app).post("/api/model-ab-test/grade").send({});
    expect(started.status).toBe(202);
    expect(started.body).toMatchObject({ running: true, total: 1, done: 0 });
    expect((await request(local.app).post("/api/model-ab-test/grade").send({ regrade: true })).status).toBe(409);
    finish();
    await grader.settled();

    const report = await request(local.app).get("/api/model-ab-test");
    expect(report.body.grading).toMatchObject({ running: false, total: 1, done: 1, ungraded: 0 });
    expect(report.body.arms[0].grades).toMatchObject({ graded: 1 });
  });
});
