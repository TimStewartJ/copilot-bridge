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

  it("updateSettings persists and clears reasoningEffort and model", () => {
    // reasoningEffort
    const updated = store.updateSettings({ reasoningEffort: "high" });
    expect(updated.reasoningEffort).toBe("high");
    expect(store.getSettings().reasoningEffort).toBe("high");
    const cleared = store.updateSettings({ reasoningEffort: undefined });
    expect(cleared.reasoningEffort).toBeUndefined();
    expect(store.getSettings().reasoningEffort).toBeUndefined();

    // model
    const updated2 = store.updateSettings({ model: "gpt-5.4" });
    expect(updated2.model).toBe("gpt-5.4");
    expect(store.getSettings().model).toBe("gpt-5.4");
    const cleared2 = store.updateSettings({ model: undefined });
    expect(cleared2.model).toBeUndefined();
    expect(store.getSettings().model).toBeUndefined();
  });

  it("updateSettings persists and clears browser diagnostics settings", () => {
    const updated = store.updateSettings({
      browser: {
        executablePath: " C:\\Browsers\\chrome.exe ",
        masterProfileDirectory: " C:\\Bridge\\browser-profile ",
        headed: true,
      },
    });
    expect(updated.browser).toEqual({
      executablePath: "C:\\Browsers\\chrome.exe",
      masterProfileDirectory: "C:\\Bridge\\browser-profile",
      headed: true,
    });

    const reloaded = store.getSettings();
    expect(reloaded.browser).toEqual(updated.browser);

    const pathOnly = store.updateSettings({
      browser: {
        executablePath: " C:\\Browsers\\chrome.exe ",
        headed: false,
      },
    });
    expect(pathOnly.browser).toEqual({
      executablePath: "C:\\Browsers\\chrome.exe",
    });

    const headedOnly = store.updateSettings({ browser: { headed: true } });
    expect(headedOnly.browser).toEqual({ headed: true });

    const cleared = store.updateSettings({ browser: {} });
    expect(cleared.browser).toBeUndefined();
    expect(store.getSettings().browser).toBeUndefined();
  });

  it("rejects non-boolean browser headed settings", () => {
    expect(() => store.updateSettings({
      browser: { headed: "true" } as any,
    })).toThrow("browser.headed must be a boolean");
  });

});
