import { describe, expect, it } from "vitest";
import { AppliedPromptFingerprints, fingerprintPromptConfig, normalizePromptCacheBreak } from "../session-prompt-fingerprint.js";
import { readSessionLaunchContext, writeSessionLaunchContext } from "../session-launch-context.js";
import { makeTestDir } from "./helpers.js";

describe("Bridge prompt fingerprints", () => {
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
