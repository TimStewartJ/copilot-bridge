// Settings store — JSON persistence in data/settings.json

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, "..", "..", "data");
const SETTINGS_FILE = join(DATA_DIR, "settings.json");

// ── Types ─────────────────────────────────────────────────────────

export interface McpServerConfig {
  command: string;
  args: string[];
  env?: Record<string, string>;
  tools?: string[];
}

export interface AppSettings {
  mcpServers: Record<string, McpServerConfig>;
}

// ── Defaults (bootstrapped from original hardcoded config) ────────

const DEFAULT_SETTINGS: AppSettings = {
  mcpServers: {
    ado: {
      command: "mcp-remote",
      args: [
        "mcp",
        "remote",
        "--url",
        "https://mcp.dev.azure.com/my-org",
        "--header",
        "X-MCP-Auth: true",
      ],
      tools: ["*"],
    },
  },
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

  if (updates.mcpServers !== undefined) {
    current.mcpServers = updates.mcpServers;
  }

  save(current);
  return current;
}

/** Get MCP servers config for session creation/resume */
export function getMcpServers(): Record<string, McpServerConfig> {
  return load().mcpServers;
}
