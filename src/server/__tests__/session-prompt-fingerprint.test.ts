import { describe, expect, it, vi } from "vitest";
import { AppliedPromptFingerprints, fingerprintPromptConfig, normalizePromptCacheBreak } from "../session-prompt-fingerprint.js";
import { readSessionLaunchContext, writeSessionLaunchContext } from "../session-launch-context.js";
import { makeTestDir, setupTestDb } from "./helpers.js";
import { createTelemetryStore } from "../telemetry-store.js";

describe("Bridge prompt fingerprints", () => {
  it("compares across tracker restart using the newest indexed retained applied span", () => {
    const db = setupTestDb();
    const store = createTelemetryStore(db);
    const config = { systemMessage: { content: "old" } };
    store.recordSpan({
      name: "session.prompt.applied", sessionId: "restart", source: "server", duration: 0,
      metadata: { scope: "bridge_config_only", hashes: fingerprintPromptConfig(config) },
    });
    const querySpans = vi.fn(store.querySpans);
    const restarted = new AppliedPromptFingerprints({ querySpans });
    expect(restarted.record("restart", { systemMessage: { content: "new" } })).toMatchObject({
      comparison: "previous_applied", previousRead: "persisted",
      cacheBreakCandidate: true, changedCategories: ["systemMessage", "content"],
    });
    restarted.record("restart", config);
    expect(querySpans).toHaveBeenCalledTimes(1);
    expect(querySpans).toHaveBeenCalledWith({ sessionId: "restart", name: "session.prompt.applied", source: "server", limit: 1 });
    const plan = db.prepare("EXPLAIN QUERY PLAN SELECT * FROM telemetry_spans WHERE sessionId = ? AND name = ? AND source = 'server' ORDER BY createdAt DESC, id DESC LIMIT 1")
      .all("restart", "session.prompt.applied");
    expect(JSON.stringify(plan)).toContain("idx_telemetry_session_name_latest");
    expect(JSON.stringify(plan)).not.toContain("TEMP B-TREE");
  });

  it("accepts legacy hashes but rejects malformed metadata and reports read failures without failing", () => {
    const store = createTelemetryStore(setupTestDb());
    for (const metadata of [
      { scope: "bridge_config_only", hashes: { ...fingerprintPromptConfig({}), tools: "secret" } },
      { hashes: fingerprintPromptConfig({}) },
    ]) {
      store.recordSpan({ name: "session.prompt.applied", sessionId: "bad", source: "server", duration: 0, metadata });
      expect(new AppliedPromptFingerprints(store).record("bad", {})).toMatchObject({
        comparison: "baseline", previousRead: "invalid_metadata",
      });
    }
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const tracker = new AppliedPromptFingerprints({ querySpans: () => { throw new Error("private detail"); } });
      expect(tracker.record("bad", {})).toMatchObject({ comparison: "baseline", previousRead: "unavailable" });
      expect(warning).toHaveBeenCalledWith("[telemetry] Failed to read previous applied prompt fingerprint");
    } finally {
      warning.mockRestore();
    }
  });

  it("only exposes verified envelope correlation and hashes open-ended reasons and model names", () => {
    const result = normalizePromptCacheBreak({ type: "prompt_cache_break", id: "event-1", agentId: "child-1", data: {
      primaryReason: "sensitive arbitrary text", modelTo: "private model", agentName: "private agent",
      apiCallId: "not-in-break-schema", requestId: "not-in-break-schema",
      cacheConfigChangedFields: ["sensitive field"], beforeRequest: "secret",
    } });
    expect(result).toMatchObject({
      providerEventId: "event-1", agentId: "child-1", primaryReasonCategory: "unknown",
      cacheConfigChangedFieldsCount: 1, modelToHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(JSON.stringify(result)).not.toMatch(/sensitive|private|secret|not-in-break-schema/);
    expect(normalizePromptCacheBreak({ type: "prompt_cache_break", agentId: "a".repeat(129), data: {} })).toEqual({});
  });

  it("hashes tool names descriptions and schemas, but not handlers or MCP transport/auth", () => {
    const config = {
      systemMessage: { mode: "customize", content: "private prompt", sections: { identity: { content: "identity" } } },
      tools: [{ name: "lookup", description: "Look up", parameters: { type: "object" }, handler: () => 1 }],
      mcpServers: { remote: { type: "http" as const, url: "https://one.test", headers: { Authorization: "secret" }, tools: ["lookup"] } },
    };
    const original = fingerprintPromptConfig(config);
    expect(fingerprintPromptConfig({
      ...config,
      tools: [{ ...config.tools[0], handler: () => 2 }],
      mcpServers: { remote: { ...config.mcpServers.remote, url: "https://two.test", headers: { Authorization: "new secret" } } },
    })).toEqual(original);
    for (const tool of [
      { ...config.tools[0], name: "other" },
      { ...config.tools[0], description: "Changed" },
      { ...config.tools[0], parameters: { type: "string" } },
    ]) expect(fingerprintPromptConfig({ ...config, tools: [tool] }).tools).not.toBe(original.tools);
    expect(JSON.stringify(original)).not.toMatch(/private prompt|secret|identity/);
    const tracker = new AppliedPromptFingerprints();
    expect(tracker.record("s", config)).toMatchObject({ comparison: "baseline", cacheBreakCandidate: false });
    expect(tracker.record("s", config)).toMatchObject({ changedCategories: [], cacheBreakCandidate: false });
  });

  it("persists only prompt-relevant launch fields and reads legacy sessions without a sidecar", () => {
    const directory = makeTestDir("launch-context");
    expect(readSessionLaunchContext(directory)).toEqual({});
    writeSessionLaunchContext(directory, { isNewTask: true, scheduleContext: { name: "Daily", type: "cron", runCount: 5 } });
    expect(readSessionLaunchContext(directory)).toEqual({
      isNewTask: true, scheduleContext: { name: "Daily", type: "cron", runCount: 5 },
    });
  });

  it("allowlists cache-break diagnostics without leaking opaque requests or raw strings", () => {
    const result = normalizePromptCacheBreak({ type: "prompt_cache_break", data: {
      primaryReason: "system_changed", contributingReasons: ["system_changed"],
      survivedTokens: 5, frontierTokens: 10, shortfallTokens: 5, retentionRatio: 0.5,
      beforeRequest: { headers: "secret" }, afterRequest: "private prompt", modelFrom: "private model",
      toolsAddedRaw: ["private tool"], toolsAdded: ["safe tool"], toolsReordered: true,
    } });
    expect(result).toMatchObject({ survivedTokens: 5, shortfallTokens: 5, retentionRatio: 0.5, toolsAddedCount: 1 });
    expect(JSON.stringify(result)).not.toMatch(/secret|private|safe tool|system_changed/);
    expect(normalizePromptCacheBreak({ type: "assistant.usage", data: {} })).toBeUndefined();
    expect(normalizePromptCacheBreak({ type: "prompt_cache_break", data: { survivedTokens: -1, retentionRatio: Infinity } })).toEqual({});
  });
});
