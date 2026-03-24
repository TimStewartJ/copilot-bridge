// Settings store — SQLite persistence

import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { DatabaseSync } from "./db.js";
import { getSharedDatabase } from "./db.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Types ─────────────────────────────────────────────────────────

import type { ProvidersConfig } from "./providers/types.js";

export interface McpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
  tools?: string[];
}

export type ThemePreference = "light" | "dark" | "system";

export interface AppSettings {
  providers?: ProvidersConfig;
  mcpServers: Record<string, McpServerConfig>;
  favicon?: string;
  theme?: ThemePreference;
}

// ── Defaults (no hardcoded org — users configure their own) ───────

const DEFAULT_SETTINGS: AppSettings = {
  mcpServers: {},
};

// ── Factory ───────────────────────────────────────────────────────

export function createSettingsStore(db: DatabaseSync) {
  function getSettings(): AppSettings {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'app'").get() as any;
    if (!row) return structuredClone(DEFAULT_SETTINGS);
    try {
      const raw = JSON.parse(row.value);
      return { ...structuredClone(DEFAULT_SETTINGS), ...raw };
    } catch {
      return structuredClone(DEFAULT_SETTINGS);
    }
  }

  function updateSettings(updates: Partial<AppSettings>): AppSettings {
    const current = getSettings();

    if (updates.providers !== undefined) current.providers = updates.providers;
    if (updates.mcpServers !== undefined) current.mcpServers = updates.mcpServers;
    if (updates.favicon !== undefined) current.favicon = updates.favicon;
    if (updates.theme !== undefined) current.theme = updates.theme;

    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('app', ?) ON CONFLICT(key) DO UPDATE SET value = ?",
    ).run(JSON.stringify(current), JSON.stringify(current));

    return current;
  }

  /** Get MCP servers config for session creation/resume */
  function getMcpServers(): Record<string, McpServerConfig> {
    return getSettings().mcpServers;
  }

  return { getSettings, updateSettings, getMcpServers };
}

export type SettingsStore = ReturnType<typeof createSettingsStore>;

// ── Default instance (backward compat) ────────────────────────────

const _defaultDataDir = process.env.BRIDGE_DATA_DIR || join(__dirname, "..", "..", "data");
const _defaultDb = getSharedDatabase();
const _default = createSettingsStore(_defaultDb);
export const getSettings = _default.getSettings;
export const updateSettings = _default.updateSettings;
export const getMcpServers = _default.getMcpServers;
