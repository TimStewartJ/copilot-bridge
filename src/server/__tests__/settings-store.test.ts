import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { setupDataDir, cleanupDataDir } from "./helpers.js";

let store: typeof import("../settings-store.js");
let dataDir: string;

beforeEach(async () => {
  vi.resetModules();
  dataDir = setupDataDir();
  store = await import("../settings-store.js");
});

afterEach(() => {
  cleanupDataDir(dataDir);
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
    expect(updated.mcpServers.custom.command).toBe("test");

    // Verify persistence
    const reloaded = store.getSettings();
    expect(reloaded.mcpServers.custom).toBeDefined();
  });

  it("getMcpServers returns current config", () => {
    store.updateSettings({ mcpServers: { test: { command: "echo", args: [] } } });
    const servers = store.getMcpServers();
    expect(servers.test).toBeDefined();
    expect(servers.test.command).toBe("echo");
  });

  it("updateSettings replaces mcpServers entirely", () => {
    store.updateSettings({ mcpServers: { only: { command: "x", args: [] } } });
    const servers = store.getMcpServers();
    expect(servers.only).toBeDefined();
    // Default 'ado' should be gone since mcpServers was replaced
    expect(servers.ado).toBeUndefined();
  });
});
