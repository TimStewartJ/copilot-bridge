// Settings store — JSON persistence in data/settings.json

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = process.env.BRIDGE_DATA_DIR || join(__dirname, "..", "..", "data");
const SETTINGS_FILE = join(DATA_DIR, "settings.json");

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

// ── Persistence ───────────────────────────────────────────────────

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
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2));
}

// ── Public API ────────────────────────────────────────────────────

export function getSettings(): AppSettings {
  return load();
}

export function updateSettings(updates: Partial<AppSettings>): AppSettings {
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
export function getMcpServers(): Record<string, McpServerConfig> {
  return load().mcpServers;
}
