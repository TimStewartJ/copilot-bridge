import { describe, it, expect, beforeEach } from "vitest";
import { setupTestDb } from "./helpers.js";
import { isLocalMcpServerConfig } from "../mcp-config.js";
import { createSettingsStore } from "../settings-store.js";
import type { SettingsStore } from "../settings-store.js";
import type { DatabaseSync } from "../db.js";
import { testExecutablePath } from "./test-paths.js";

let db: DatabaseSync;
let store: SettingsStore;

beforeEach(() => {
  db = setupTestDb();
  store = createSettingsStore(db);
});

function writeRawSettings(value: string): void {
  db.prepare(
    "INSERT INTO settings (key, value) VALUES ('app', ?) ON CONFLICT(key) DO UPDATE SET value = ?",
  ).run(value, value);
}

function readRawSettings(): string {
  return (db.prepare("SELECT value FROM settings WHERE key = 'app'").get() as { value: string }).value;
}

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

  it("persists and validates remembered model presets", () => {
    const updated = store.updateSettings({
      modelPresets: {
        preset1: { model: "gpt-5.6-sol", reasoningEffort: "high" },
        preset2: { model: "claude-opus-5", contextTier: "long_context" },
      },
      lastModelPreset: "preset2",
    });
    expect(updated.modelPresets).toEqual({
      preset1: { model: "gpt-5.6-sol", reasoningEffort: "high" },
      preset2: { model: "claude-opus-5", contextTier: "long_context" },
    });
    expect(store.getSettings().lastModelPreset).toBe("preset2");

    expect(() => store.updateSettings({
      modelPresets: { preset4: { model: "gemini-3.1-pro" } } as any,
    })).toThrow('modelPresets key "preset4" is not a known preset slot');
    expect(() => store.updateSettings({
      lastModelPreset: "preset4" as any,
    })).toThrow("lastModelPreset must be preset1, preset2, or preset3");
  });

  it("migrates remembered model-family defaults into preset slots", () => {
    const updated = store.updateSettings({
      familyDefaults: {
        gpt: { model: "gpt-5.6-sol", reasoningEffort: "high" },
        claude: { model: "claude-opus-5", contextTier: "long_context" },
      },
      lastModelFamily: "claude",
    });

    expect(updated.modelPresets).toEqual({
      preset1: { model: "gpt-5.6-sol", reasoningEffort: "high" },
      preset2: { model: "claude-opus-5", contextTier: "long_context" },
    });
    expect(updated.lastModelPreset).toBe("preset2");
    expect(updated.familyDefaults).toBeUndefined();
    expect(updated.lastModelFamily).toBeUndefined();
  });

  it("validates the full update before changing MCP registry rows", () => {
    store.updateSettings({
      mcpServers: { before: { command: "before", args: [] } },
      theme: "dark",
    });

    expect(() => store.updateSettings({
      mcpServers: { after: { command: "after", args: [] } },
      contextTier: "invalid" as any,
    })).toThrow("contextTier must be default or long_context");

    expect(store.getMcpServers()).toEqual({
      before: { command: "before", args: [] },
    });
    expect(store.getSettings().theme).toBe("dark");
  });

  it("rolls back MCP registry changes when the settings row write fails", () => {
    store.updateSettings({
      mcpServers: { before: { command: "before", args: [] } },
      theme: "dark",
    });
    db.exec(`
      CREATE TRIGGER block_app_settings_update
      BEFORE UPDATE ON settings
      WHEN NEW.key = 'app'
      BEGIN
        SELECT RAISE(ABORT, 'settings write blocked');
      END;
    `);

    expect(() => store.updateSettings({
      mcpServers: { after: { command: "after", args: [] } },
      theme: "light",
    })).toThrow("settings write blocked");

    expect(store.getMcpServers()).toEqual({
      before: { command: "before", args: [] },
    });
    expect(store.getSettings().theme).toBe("dark");
  });

  it.each([
    ["malformed JSON", "{"],
    ["null", "null"],
    ["an array", "[]"],
    ["a string", '"settings"'],
    ["a number", "42"],
  ])("fails visibly when the persisted row contains %s", (_label, raw) => {
    writeRawSettings(raw);

    expect(() => store.getSettings()).toThrow("Persisted app settings are unreadable");
    expect(readRawSettings()).toBe(raw);
  });

  it.each([
    ["browser settings", { browser: { headed: "true" } }],
    ["model preset settings", { modelPresets: { preset1: { model: "gpt-5.6-sol", contextTier: "invalid" } } }],
  ])("rejects invalid nested persisted %s", (_label, raw) => {
    writeRawSettings(JSON.stringify(raw));

    expect(() => store.getSettings()).toThrow("Persisted app settings are unreadable");
  });

  it("hydrates and normalizes valid legacy app settings", () => {
    const executablePath = testExecutablePath("chromium");
    writeRawSettings(JSON.stringify({
      providers: { github: { owner: "octo", defaultRepo: "bridge" } },
      theme: "dark",
      identity: "Bridge operator",
      model: " gpt-5.6-sol ",
      reasoningEffort: " high ",
      contextTier: "long_context",
      familyDefaults: {
        gpt: { model: " gpt-5.6-sol ", reasoningEffort: " high " },
      },
      browser: {
        executablePath: ` ${executablePath} `,
        headed: true,
      },
      mcpServers: {
        legacy: { command: "legacy", args: [] },
      },
      obsoleteSetting: true,
    }));

    expect(store.getSettings()).toEqual({
      providers: { github: { owner: "octo", defaultRepo: "bridge" } },
      mcpServers: {},
      theme: "dark",
      identity: "Bridge operator",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      contextTier: "long_context",
      modelPresets: {
        preset1: { model: "gpt-5.6-sol", reasoningEffort: "high" },
      },
      browser: {
        executablePath,
        headed: true,
      },
    });
  });

  it("does not overwrite an unreadable row when a later update is attempted", () => {
    const raw = "{broken";
    writeRawSettings(raw);

    expect(() => store.updateSettings({ theme: "light" }))
      .toThrow("Persisted app settings are unreadable");
    expect(readRawSettings()).toBe(raw);
  });

});
