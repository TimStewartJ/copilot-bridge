// Settings store — JSON persistence in data/settings.json

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

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

export function createSettingsStore(dataDir: string) {
  const SETTINGS_FILE = join(dataDir, "settings.json");

  function load(): AppSettings {
    if (!existsSync(SETTINGS_FILE)) return structuredClone(DEFAULT_SETTINGS);
    try {
      const raw = JSON.parse(readFileSync(SETTINGS_FILE, "utf-8"));
      return { ...structuredClone(DEFAULT_SETTINGS), ...raw };
    } catch {
      return structuredClone(DEFAULT_SETTINGS);
    }
  }

  function save(settings: AppSettings): void {
    if (!existsSync(dataDir)) mkdirSync(dataDir, { recursive: true });
    writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
  }

  function getSettings(): AppSettings {
    return load();
  }

  function updateSettings(updates: Partial<AppSettings>): AppSettings {
    const current = load();

    if (updates.providers !== undefined) {
      current.providers = updates.providers;
    }

    if (updates.mcpServers !== undefined) {
      current.mcpServers = updates.mcpServers;
    }

    if (updates.favicon !== undefined) {
      current.favicon = updates.favicon;
    }

    if (updates.theme !== undefined) {
      current.theme = updates.theme;
    }

    save(current);
    return current;
  }

  /** Get MCP servers config for session creation/resume */
  function getMcpServers(): Record<string, McpServerConfig> {
    return load().mcpServers;
  }

  return { getSettings, updateSettings, getMcpServers };
}

export type SettingsStore = ReturnType<typeof createSettingsStore>;

// ── Default instance (backward compat) ────────────────────────────

const _defaultDataDir = process.env.BRIDGE_DATA_DIR || join(__dirname, "..", "..", "data");
const _default = createSettingsStore(_defaultDataDir);
export const getSettings = _default.getSettings;
export const updateSettings = _default.updateSettings;
export const getMcpServers = _default.getMcpServers;
