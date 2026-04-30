import { describe, expect, it, vi, beforeEach } from "vitest";
import { SessionManager } from "../session-manager.js";
import { createEventBusRegistry } from "../event-bus.js";
import { createSessionTitlesStore } from "../session-titles.js";
import { createSettingsStore } from "../settings-store.js";
import { createTestBus, setupTestDb } from "./helpers.js";

/**
 * Tests for cross-family model switching via session.setModel().
 *
 * Background: when the user switches model in /settings (e.g. GPT -> Opus),
 * the SDK's resumeSession({ model }) silently overwrites _selectedModel
 * without sanitizing replayed chat history, which corrupts cross-family
 * tool_call shapes and produces a CAPI 400. The fix is to call
 * session.setModel() instead, which emits a session.model_change event the
 * SDK handles by rewriting tool_calls between Anthropic-`custom` and
 * OpenAI-`function` shapes.
 *
 * These tests verify the bridge's plumbing — the SDK owns the actual
 * sanitization logic.
 */
describe("SessionManager model switching", () => {
  let manager: any;
  let settingsStore: ReturnType<typeof createSettingsStore>;

  beforeEach(() => {
    const db = setupTestDb();
    settingsStore = createSettingsStore(db);
    manager = new SessionManager({
      tools: [],
      globalBus: createTestBus(),
      eventBusRegistry: createEventBusRegistry(),
      sessionTitles: createSessionTitlesStore(db),
      taskStore: { findTaskBySessionId: () => undefined } as any,
      config: { sessionMcpServers: {} },
      settingsStore,
    });
  });

  function createMockSession(currentModel: string | undefined) {
    const setModel = vi.fn(async () => {});
    const getCurrent = vi.fn(async () => ({ modelId: currentModel }));
    return {
      setModel,
      getCurrent,
      rpc: { model: { getCurrent } },
      disconnect: vi.fn(),
    };
  }

  describe("ensureSessionModelMatchesSettings", () => {
    it("no-ops when no model is configured in settings", async () => {
      const session = createMockSession("gpt-5.5");
      await manager.ensureSessionModelMatchesSettings(session, "abcd1234");
      expect(session.getCurrent).not.toHaveBeenCalled();
      expect(session.setModel).not.toHaveBeenCalled();
    });

    it("calls setModel when current matches desired and reasoningEffort is not configured", async () => {
      settingsStore.updateSettings({ model: "claude-opus-4.7" });
      const session = createMockSession("claude-opus-4.7");
      await manager.ensureSessionModelMatchesSettings(session, "abcd1234");
      expect(session.getCurrent).toHaveBeenCalledOnce();
      expect(session.setModel).toHaveBeenCalledWith("claude-opus-4.7", undefined);
    });

    it("calls setModel when current matches desired but reasoningEffort is configured", async () => {
      settingsStore.updateSettings({ model: "claude-opus-4.7", reasoningEffort: "high" });
      const session = createMockSession("claude-opus-4.7");
      await manager.ensureSessionModelMatchesSettings(session, "abcd1234");
      expect(session.setModel).toHaveBeenCalledWith("claude-opus-4.7", { reasoningEffort: "high" });
    });

    it("calls setModel when reasoningEffort was cleared", async () => {
      settingsStore.updateSettings({ model: "claude-opus-4.7", reasoningEffort: "high" });
      settingsStore.updateSettings({ reasoningEffort: undefined });
      const session = createMockSession("claude-opus-4.7");
      await manager.ensureSessionModelMatchesSettings(session, "abcd1234");
      expect(session.setModel).toHaveBeenCalledWith("claude-opus-4.7", undefined);
    });

    it("calls setModel when current differs from desired", async () => {
      settingsStore.updateSettings({ model: "claude-opus-4.7-1m-internal" });
      const session = createMockSession("gpt-5.5");
      await manager.ensureSessionModelMatchesSettings(session, "abcd1234");
      expect(session.setModel).toHaveBeenCalledWith("claude-opus-4.7-1m-internal", undefined);
    });

    it("forwards reasoningEffort when configured", async () => {
      settingsStore.updateSettings({ model: "claude-opus-4.7", reasoningEffort: "high" });
      const session = createMockSession("gpt-5.5");
      await manager.ensureSessionModelMatchesSettings(session, "abcd1234");
      expect(session.setModel).toHaveBeenCalledWith("claude-opus-4.7", { reasoningEffort: "high" });
    });

    it("calls setModel when getCurrent returns no modelId (defensive)", async () => {
      settingsStore.updateSettings({ model: "claude-opus-4.7" });
      const session = createMockSession(undefined);
      await manager.ensureSessionModelMatchesSettings(session, "abcd1234");
      expect(session.setModel).toHaveBeenCalledOnce();
    });

    it("swallows getCurrent failures without throwing", async () => {
      settingsStore.updateSettings({ model: "claude-opus-4.7" });
      const session = createMockSession("gpt-5.5");
      session.rpc.model.getCurrent = vi.fn(async () => {
        throw new Error("rpc disconnected");
      });
      await expect(
        manager.ensureSessionModelMatchesSettings(session, "abcd1234"),
      ).resolves.not.toThrow();
    });

    it("swallows setModel failures without throwing", async () => {
      settingsStore.updateSettings({ model: "claude-opus-4.7" });
      const session = createMockSession("gpt-5.5");
      session.setModel = vi.fn(async () => {
        throw new Error("model unavailable");
      });
      await expect(
        manager.ensureSessionModelMatchesSettings(session, "abcd1234"),
      ).resolves.not.toThrow();
    });
  });

  describe("applyModelToCachedSessions", () => {
    it("returns zero counts when no sessions are cached", async () => {
      const result = await manager.applyModelToCachedSessions("claude-opus-4.7");
      expect(result).toEqual({ updated: 0, failed: 0 });
    });

    it("calls setModel on each cached session", async () => {
      const a = createMockSession("gpt-5.5");
      const b = createMockSession("gpt-5.5");
      manager.sessionObjects.set("session-a", a);
      manager.sessionObjects.set("session-b", b);

      const result = await manager.applyModelToCachedSessions("claude-opus-4.7");

      expect(a.setModel).toHaveBeenCalledWith("claude-opus-4.7", undefined);
      expect(b.setModel).toHaveBeenCalledWith("claude-opus-4.7", undefined);
      expect(result.updated).toBe(2);
      expect(result.failed).toBe(0);
    });

    it("still calls setModel when target model matches (reasoning may differ)", async () => {
      // Regression guard: dropping the model-match short-circuit was the fix
      // for reasoningEffort-only changes never reaching the SDK.
      const a = createMockSession("claude-opus-4.7");
      manager.sessionObjects.set("session-a", a);

      const result = await manager.applyModelToCachedSessions("claude-opus-4.7", "high");

      expect(a.setModel).toHaveBeenCalledWith("claude-opus-4.7", { reasoningEffort: "high" });
      expect(result.updated).toBe(1);
    });

    it("forwards reasoningEffort to setModel", async () => {
      const a = createMockSession("gpt-5.5");
      manager.sessionObjects.set("session-a", a);

      await manager.applyModelToCachedSessions("claude-opus-4.7", "high");

      expect(a.setModel).toHaveBeenCalledWith("claude-opus-4.7", { reasoningEffort: "high" });
    });

    it("tolerates failures and continues with remaining sessions", async () => {
      const a = createMockSession("gpt-5.5");
      const b = createMockSession("gpt-5.5");
      a.setModel = vi.fn(async () => {
        throw new Error("RPC failure");
      });
      manager.sessionObjects.set("session-a", a);
      manager.sessionObjects.set("session-b", b);

      const result = await manager.applyModelToCachedSessions("claude-opus-4.7");

      expect(result.failed).toBe(1);
      expect(result.updated).toBe(1);
      expect(b.setModel).toHaveBeenCalledOnce();
    });
  });

  describe("buildSessionConfig with forResume", () => {
    it("includes model on createSession path (forResume=false)", () => {
      settingsStore.updateSettings({ model: "claude-opus-4.7", reasoningEffort: "high" });
      const cfg = manager.buildSessionConfig({});
      expect(cfg.model).toBe("claude-opus-4.7");
      expect(cfg.reasoningEffort).toBe("high");
    });

    it("omits model and reasoningEffort on resume path (forResume=true)", () => {
      settingsStore.updateSettings({ model: "claude-opus-4.7", reasoningEffort: "high" });
      const cfg = manager.buildSessionConfig({ sessionId: "abc", forResume: true });
      expect(cfg.model).toBeUndefined();
      expect(cfg.reasoningEffort).toBeUndefined();
    });
  });
});
