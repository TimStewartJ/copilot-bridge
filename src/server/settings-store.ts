// Settings store — SQLite persistence

import type { DatabaseSync } from "./db.js";

import type { ProvidersConfig } from "./providers/types.js";
import { assertMcpServerConfig, type McpServerConfig } from "./mcp-config.js";
import { createMcpServerStore } from "./mcp-server-store.js";
import {
  isCopilotContextTier,
  type CopilotContextTier,
} from "../shared/copilot-context.js";
import { isModelFamily, type ModelFamily } from "../shared/model-families.js";

export type ThemePreference = "light" | "dark" | "system";
// Reasoning-effort ids are fully SDK-driven (per-model `supportedReasoningEfforts`),
// so this is an open string alias rather than a fixed enumeration.
export type ReasoningEffort = string;

export interface BrowserSettings {
  executablePath?: string;
  masterProfileDirectory?: string;
  headed?: boolean;
}

/**
 * Sticky per-family launch defaults. The model picker remembers the last model
 * used in each family along with the effort/context that went with it, so
 * switching families restores a complete working configuration.
 */
export interface ModelFamilyDefault {
  model: string;
  reasoningEffort?: ReasoningEffort;
  contextTier?: CopilotContextTier;
}

export type ModelFamilyDefaults = Partial<Record<ModelFamily, ModelFamilyDefault>>;

export interface AppSettings {
  providers?: ProvidersConfig;
  mcpServers: Record<string, McpServerConfig>;
  favicon?: string;
  theme?: ThemePreference;
  identity?: string;
  customInstructions?: string;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  contextTier?: CopilotContextTier;
  familyDefaults?: ModelFamilyDefaults;
  browser?: BrowserSettings;
}

// ── Defaults (no hardcoded org — users configure their own) ───────

const DEFAULT_SETTINGS: AppSettings = {
  mcpServers: {},
};

function normalizeOptionalBrowserPath(value: unknown, field: keyof BrowserSettings): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new Error(`browser.${field} must be a string`);
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeOptionalBrowserHeaded(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    throw new Error("browser.headed must be a boolean");
  }
  return value ? true : undefined;
}

function normalizeBrowserSettings(value: unknown): BrowserSettings | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("browser must be an object");
  }
  const raw = value as Record<string, unknown>;
  const executablePath = normalizeOptionalBrowserPath(raw.executablePath, "executablePath");
  const masterProfileDirectory = normalizeOptionalBrowserPath(raw.masterProfileDirectory, "masterProfileDirectory");
  const headed = normalizeOptionalBrowserHeaded(raw.headed);
  if (!executablePath && !masterProfileDirectory && !headed) return undefined;
  return {
    ...(executablePath ? { executablePath } : {}),
    ...(masterProfileDirectory ? { masterProfileDirectory } : {}),
    ...(headed ? { headed } : {}),
  };
}

function normalizeModelFamilyDefault(
  value: unknown,
  family: ModelFamily,
): ModelFamilyDefault | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`familyDefaults.${family} must be an object`);
  }
  const raw = value as Record<string, unknown>;

  if (raw.model !== undefined && raw.model !== null && typeof raw.model !== "string") {
    throw new Error(`familyDefaults.${family}.model must be a string`);
  }
  const model = typeof raw.model === "string" ? raw.model.trim() : "";
  // A family entry only exists to remember a model, so drop it when empty
  // rather than persisting a config that points at nothing.
  if (!model) return undefined;

  if (
    raw.reasoningEffort !== undefined
    && raw.reasoningEffort !== null
    && typeof raw.reasoningEffort !== "string"
  ) {
    throw new Error(`familyDefaults.${family}.reasoningEffort must be a string`);
  }
  const reasoningEffort = typeof raw.reasoningEffort === "string"
    ? raw.reasoningEffort.trim()
    : "";

  const contextTier = raw.contextTier;
  if (contextTier !== undefined && contextTier !== null && contextTier !== "" && !isCopilotContextTier(contextTier)) {
    throw new Error(`familyDefaults.${family}.contextTier must be default or long_context`);
  }

  return {
    model,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(isCopilotContextTier(contextTier) ? { contextTier } : {}),
  };
}

function normalizeModelFamilyDefaults(value: unknown): ModelFamilyDefaults | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new Error("familyDefaults must be an object");
  }
  const normalized: ModelFamilyDefaults = {};
  for (const [family, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!isModelFamily(family)) {
      throw new Error(`familyDefaults key "${family}" is not a known model family`);
    }
    const normalizedEntry = normalizeModelFamilyDefault(entry, family);
    if (normalizedEntry) normalized[family] = normalizedEntry;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

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
    if ("contextTier" in updates) {
      const contextTier = updates.contextTier as unknown;
      if (contextTier !== undefined && contextTier !== "" && !isCopilotContextTier(contextTier)) {
        throw new Error("contextTier must be default or long_context");
      }
      current.contextTier = isCopilotContextTier(contextTier) ? contextTier : undefined;
    }
    if ("familyDefaults" in updates) {
      current.familyDefaults = normalizeModelFamilyDefaults(updates.familyDefaults);
    }
    if ("browser" in updates) current.browser = normalizeBrowserSettings(updates.browser);

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
