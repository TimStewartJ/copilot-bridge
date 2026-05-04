import { describe, it, expect, beforeEach } from "vitest";
import { setupTestDb } from "./helpers.js";
import { isLocalMcpServerConfig } from "../mcp-config.js";
import { createSettingsStore } from "../settings-store.js";
import type { SettingsStore } from "../settings-store.js";
import type { DatabaseSync } from "../db.js";

let db: DatabaseSync;
let store: SettingsStore;

beforeEach(() => {
  db = setupTestDb();
  store = createSettingsStore(db);
});

describe("settings-store", () => {
  it("getSettings returns defaults when no file exists", () => {
    const settings = store.getSettings();
    expect(settings.mcpServers).toBeDefined();
    expect(settings.mcpServers).toEqual({});
  });

  it("updateSettings persists and returns updated settings", () => {
    const updated = store.updateSettings({
      mcpServers: {
        custom: { command: "test", args: ["--flag"] },
      },
    });
    expect(updated.mcpServers.custom).toBeDefined();
    expect(isLocalMcpServerConfig(updated.mcpServers.custom)).toBe(true);
    if (isLocalMcpServerConfig(updated.mcpServers.custom)) {
      expect(updated.mcpServers.custom.command).toBe("test");
    }

    // Verify persistence
    const reloaded = store.getSettings();
    expect(reloaded.mcpServers.custom).toBeDefined();
    const raw = JSON.parse((db.prepare("SELECT value FROM settings WHERE key = 'app'").get() as any).value);
    expect(raw.mcpServers).toBeUndefined();
  });

  it("getMcpServers returns current config", () => {
    store.updateSettings({ mcpServers: { test: { command: "echo", args: [] } } });
    const servers = store.getMcpServers();
    expect(servers.test).toBeDefined();
    expect(isLocalMcpServerConfig(servers.test)).toBe(true);
    if (isLocalMcpServerConfig(servers.test)) {
      expect(servers.test.command).toBe("echo");
    }
  });

  it("persists remote MCP server configs", () => {
    const remoteConfig = {
      type: "http" as const,
      url: "https://mcp.linear.app/mcp",
      headers: { Authorization: "Bearer test-token" },
      tools: ["linear_search"],
    };

    store.updateSettings({ mcpServers: { linear: remoteConfig } });

    const reloaded = store.getSettings();
    expect(reloaded.mcpServers.linear).toEqual(remoteConfig);
    expect(store.getMcpServers().linear).toEqual(remoteConfig);
  });

  it("updateSettings replaces mcpServers entirely", () => {
    store.updateSettings({ mcpServers: { only: { command: "x", args: [] } } });
    const servers = store.getMcpServers();
    expect(servers.only).toBeDefined();
    // Default 'ado' should be gone since mcpServers was replaced
    expect(servers.ado).toBeUndefined();
  });

  it("updateSettings persists and clears reasoningEffort", () => {
    // Set a value
    const updated = store.updateSettings({ reasoningEffort: "high" });
    expect(updated.reasoningEffort).toBe("high");

    // Verify persistence
    const reloaded = store.getSettings();
    expect(reloaded.reasoningEffort).toBe("high");

    // Clear by explicitly setting undefined
    const cleared = store.updateSettings({ reasoningEffort: undefined });
    expect(cleared.reasoningEffort).toBeUndefined();

    // Verify cleared
    const reloadedAgain = store.getSettings();
    expect(reloadedAgain.reasoningEffort).toBeUndefined();
  });

  it("updateSettings persists and clears model", () => {
    const updated = store.updateSettings({ model: "gpt-5.4" });
    expect(updated.model).toBe("gpt-5.4");

    const reloaded = store.getSettings();
    expect(reloaded.model).toBe("gpt-5.4");

    const cleared = store.updateSettings({ model: undefined });
    expect(cleared.model).toBeUndefined();

    const reloadedAgain = store.getSettings();
    expect(reloadedAgain.model).toBeUndefined();
  });
});
