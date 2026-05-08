// Settings store — SQLite persistence

import type { DatabaseSync } from "./db.js";

import type { ProvidersConfig } from "./providers/types.js";
import { assertMcpServerConfig, type McpServerConfig } from "./mcp-config.js";
import { createMcpServerStore } from "./mcp-server-store.js";

export type ThemePreference = "light" | "dark" | "system";
export type ReasoningEffort = "low" | "medium" | "high" | "xhigh";

export interface AppSettings {
  providers?: ProvidersConfig;
  mcpServers: Record<string, McpServerConfig>;
  favicon?: string;
  theme?: ThemePreference;
  identity?: string;
  customInstructions?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
}

// ── Defaults (no hardcoded org — users configure their own) ───────

const DEFAULT_SETTINGS: AppSettings = {
  mcpServers: {},
};

// ── Factory ───────────────────────────────────────────────────────

export function createSettingsStore(db: DatabaseSync) {
  const mcpServerStore = createMcpServerStore(db);

  function getDefaultMcpServers(): Record<string, McpServerConfig> {
    return mcpServerStore.resolveMcpServers();
  }

  function persistSettings(settings: AppSettings): void {
    const { mcpServers: _mcpServers, ...persistable } = settings;
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('app', ?) ON CONFLICT(key) DO UPDATE SET value = ?",
    ).run(JSON.stringify(persistable), JSON.stringify(persistable));
  }

  function syncDefaultMcpServers(nextServers: Record<string, McpServerConfig>): void {
    const nextNames = new Set<string>();
    for (const [name, config] of Object.entries(nextServers)) {
      const normalizedName = name.trim();
      if (!normalizedName) throw new Error("MCP server name is required");
      const lowerName = normalizedName.toLocaleLowerCase();
      if (nextNames.has(lowerName)) throw new Error(`MCP server name "${normalizedName}" already exists`);
      nextNames.add(lowerName);
      assertMcpServerConfig(config);
    }

    db.exec("BEGIN");
    try {
      for (const server of mcpServerStore.listMcpServers()) {
        if (server.enabledByDefault && !nextNames.has(server.name.toLocaleLowerCase())) {
          mcpServerStore.setMcpServerEnabledByDefault(server.id, false);
        }
      }

      for (const [name, config] of Object.entries(nextServers)) {
        const existing = mcpServerStore.getMcpServerByName(name);
        if (existing) {
          if (!existing.enabledByDefault) {
            throw new Error(
              `MCP server name "${name}" is already used by a non-default registry server; manage it from MCP Servers settings`,
            );
          }
          mcpServerStore.updateMcpServer(existing.id, {
            name,
            config,
            enabledByDefault: true,
          });
        } else {
          mcpServerStore.createMcpServer({ name, config, enabledByDefault: true });
        }
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function getSettings(): AppSettings {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'app'").get() as any;
    if (!row) return { ...structuredClone(DEFAULT_SETTINGS), mcpServers: getDefaultMcpServers() };
    try {
      const raw = JSON.parse(row.value);
      return { ...structuredClone(DEFAULT_SETTINGS), ...raw, mcpServers: getDefaultMcpServers() };
    } catch {
      return { ...structuredClone(DEFAULT_SETTINGS), mcpServers: getDefaultMcpServers() };
    }
  }

  function updateSettings(updates: Partial<AppSettings>): AppSettings {
    const current = getSettings();

    if (updates.providers !== undefined) current.providers = updates.providers;
    if (updates.mcpServers !== undefined) {
      syncDefaultMcpServers(updates.mcpServers);
      current.mcpServers = getDefaultMcpServers();
    }
    if (updates.favicon !== undefined) current.favicon = updates.favicon;
    if (updates.theme !== undefined) current.theme = updates.theme;
    if (updates.identity !== undefined) current.identity = updates.identity;
    if (updates.customInstructions !== undefined) current.customInstructions = updates.customInstructions;
    if ("model" in updates) current.model = updates.model || undefined;
    if ("reasoningEffort" in updates) current.reasoningEffort = updates.reasoningEffort || undefined;

    persistSettings(current);

    return current;
  }

  /** Get MCP servers config for session creation/resume */
  function getMcpServers(): Record<string, McpServerConfig> {
    return getDefaultMcpServers();
  }

  function getMcpServerStore() {
    return mcpServerStore;
  }

  return { getSettings, updateSettings, getMcpServers, getMcpServerStore };
}

export type SettingsStore = ReturnType<typeof createSettingsStore>;
