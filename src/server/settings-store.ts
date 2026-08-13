// Settings store — SQLite persistence

import type { DatabaseSync } from "./db.js";

import type { ProvidersConfig } from "./providers/types.js";
import { assertMcpServerConfig, type McpServerConfig } from "./mcp-config.js";
import { createMcpServerStore } from "./mcp-server-store.js";
import { runTransaction } from "./db-transaction.js";
import {
  isCopilotContextTier,
  type CopilotContextTier,
} from "../shared/copilot-context.js";
import { isModelFamily, type ModelFamily } from "../shared/model-families.js";
import { isRecord } from "../shared/is-record.js";

export type ThemePreference = "light" | "dark" | "system";
// Reasoning-effort ids are fully SDK-driven (per-model `supportedReasoningEfforts`),
// so this is an open string alias rather than a fixed enumeration.
export type ReasoningEffort = string;

export interface BrowserSettings {
  executablePath?: string;
  masterProfileDirectory?: string;
  headed?: boolean;
}

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
  lastModelFamily?: ModelFamily;
  browser?: BrowserSettings;
}

export class SettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SettingsValidationError";
  }
}

export class SettingsReadError extends Error {
  constructor(reason: string) {
    super(
      `Persisted app settings are unreadable: ${reason}. `
      + 'The settings row was left unchanged; repair or remove key "app" in the Bridge database.',
    );
    this.name = "SettingsReadError";
  }
}

// ── Defaults (no hardcoded org — users configure their own) ───────

const DEFAULT_SETTINGS: AppSettings = {
  mcpServers: {},
};

function validationError(message: string): never {
  throw new SettingsValidationError(message);
}

function normalizeOptionalString(
  value: unknown,
  field: keyof AppSettings,
  options: { trim?: boolean; emptyAsUndefined?: boolean } = {},
): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") validationError(`${field} must be a string`);
  const normalized = options.trim ? value.trim() : value;
  return options.emptyAsUndefined && !normalized ? undefined : normalized;
}

function normalizeProviders(value: unknown): ProvidersConfig | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) validationError("providers must be an object");
  for (const key of Object.keys(value)) {
    if (key !== "ado" && key !== "github" && key !== "linear") {
      validationError(`providers key "${key}" is not supported`);
    }
  }

  const normalized: ProvidersConfig = {};
  if (value.ado !== undefined && value.ado !== null) {
    if (!isRecord(value.ado)) validationError("providers.ado must be an object");
    if (typeof value.ado.org !== "string") validationError("providers.ado.org must be a string");
    if (typeof value.ado.project !== "string") validationError("providers.ado.project must be a string");
    normalized.ado = { org: value.ado.org, project: value.ado.project };
  }
  if (value.github !== undefined && value.github !== null) {
    if (!isRecord(value.github)) validationError("providers.github must be an object");
    if (typeof value.github.owner !== "string") validationError("providers.github.owner must be a string");
    if (value.github.defaultRepo !== undefined && typeof value.github.defaultRepo !== "string") {
      validationError("providers.github.defaultRepo must be a string");
    }
    normalized.github = {
      owner: value.github.owner,
      ...(value.github.defaultRepo !== undefined ? { defaultRepo: value.github.defaultRepo } : {}),
    };
  }
  if (value.linear !== undefined && value.linear !== null) {
    if (!isRecord(value.linear)) validationError("providers.linear must be an object");
    if (typeof value.linear.apiKey !== "string") validationError("providers.linear.apiKey must be a string");
    if (typeof value.linear.workspace !== "string") validationError("providers.linear.workspace must be a string");
    normalized.linear = { apiKey: value.linear.apiKey, workspace: value.linear.workspace };
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeTheme(value: unknown): ThemePreference | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value !== "light" && value !== "dark" && value !== "system") {
    validationError("theme must be light, dark, or system");
  }
  return value;
}

function normalizeOptionalBrowserPath(value: unknown, field: keyof BrowserSettings): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    validationError(`browser.${field} must be a string`);
  }
  const trimmed = value.trim();
  return trimmed || undefined;
}

function normalizeOptionalBrowserHeaded(value: unknown): boolean | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "boolean") {
    validationError("browser.headed must be a boolean");
  }
  return value ? true : undefined;
}

function normalizeBrowserSettings(value: unknown): BrowserSettings | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) validationError("browser must be an object");
  const raw = value;
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
  if (!isRecord(value)) validationError(`familyDefaults.${family} must be an object`);
  const raw = value;

  if (raw.model !== undefined && raw.model !== null && typeof raw.model !== "string") {
    validationError(`familyDefaults.${family}.model must be a string`);
  }
  const model = typeof raw.model === "string" ? raw.model.trim() : "";
  if (!model) return undefined;

  if (
    raw.reasoningEffort !== undefined
    && raw.reasoningEffort !== null
    && typeof raw.reasoningEffort !== "string"
  ) {
    validationError(`familyDefaults.${family}.reasoningEffort must be a string`);
  }
  const reasoningEffort = typeof raw.reasoningEffort === "string"
    ? raw.reasoningEffort.trim()
    : "";

  const contextTier = raw.contextTier;
  if (
    contextTier !== undefined
    && contextTier !== null
    && contextTier !== ""
    && !isCopilotContextTier(contextTier)
  ) {
    validationError(`familyDefaults.${family}.contextTier must be default or long_context`);
  }

  return {
    model,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(isCopilotContextTier(contextTier) ? { contextTier } : {}),
  };
}

function normalizeModelFamilyDefaults(value: unknown): ModelFamilyDefaults | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) validationError("familyDefaults must be an object");
  const normalized: ModelFamilyDefaults = {};
  for (const [family, entry] of Object.entries(value)) {
    if (!isModelFamily(family)) {
      validationError(`familyDefaults key "${family}" is not a known model family`);
    }
    const normalizedEntry = normalizeModelFamilyDefault(entry, family);
    if (normalizedEntry) normalized[family] = normalizedEntry;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function normalizeContextTier(value: unknown): CopilotContextTier | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (!isCopilotContextTier(value)) validationError("contextTier must be default or long_context");
  return value;
}

function normalizeLastModelFamily(value: unknown): ModelFamily | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (!isModelFamily(value)) validationError("lastModelFamily must be gpt, claude, or other");
  return value;
}

function normalizeMcpServers(value: unknown): Record<string, McpServerConfig> {
  if (!isRecord(value)) validationError("mcpServers must be an object");
  const names = new Set<string>();
  const entries: Array<[string, McpServerConfig]> = [];
  for (const [name, config] of Object.entries(value)) {
    const normalizedName = name.trim();
    if (!normalizedName) validationError("MCP server name is required");
    const lowerName = normalizedName.toLocaleLowerCase();
    if (names.has(lowerName)) validationError(`MCP server name "${normalizedName}" already exists`);
    names.add(lowerName);
    try {
      assertMcpServerConfig(config);
    } catch (error) {
      validationError(
        `mcpServers.${normalizedName}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    entries.push([normalizedName, config]);
  }
  return Object.fromEntries(entries);
}

function normalizeAppSettings(base: AppSettings, value: unknown): AppSettings {
  if (!isRecord(value)) validationError("settings must be an object");
  const normalized = structuredClone(base);
  if ("providers" in value) normalized.providers = normalizeProviders(value.providers);
  if ("favicon" in value) normalized.favicon = normalizeOptionalString(value.favicon, "favicon");
  if ("theme" in value) normalized.theme = normalizeTheme(value.theme);
  if ("identity" in value) normalized.identity = normalizeOptionalString(value.identity, "identity");
  if ("customInstructions" in value) {
    normalized.customInstructions = normalizeOptionalString(value.customInstructions, "customInstructions");
  }
  if ("model" in value) {
    normalized.model = normalizeOptionalString(value.model, "model", { trim: true, emptyAsUndefined: true });
  }
  if ("reasoningEffort" in value) {
    normalized.reasoningEffort = normalizeOptionalString(
      value.reasoningEffort,
      "reasoningEffort",
      { trim: true, emptyAsUndefined: true },
    );
  }
  if ("contextTier" in value) normalized.contextTier = normalizeContextTier(value.contextTier);
  if ("familyDefaults" in value) normalized.familyDefaults = normalizeModelFamilyDefaults(value.familyDefaults);
  if ("lastModelFamily" in value) normalized.lastModelFamily = normalizeLastModelFamily(value.lastModelFamily);
  if ("browser" in value) normalized.browser = normalizeBrowserSettings(value.browser);
  return normalized;
}

// ── Factory ───────────────────────────────────────────────────────

export function createSettingsStore(db: DatabaseSync) {
  const mcpServerStore = createMcpServerStore(db);

  function getDefaultMcpServers(): Record<string, McpServerConfig> {
    return mcpServerStore.resolveMcpServers();
  }

  function persistSettings(settings: AppSettings): void {
    const { mcpServers: _mcpServers, ...persistable } = settings;
    const serialized = JSON.stringify(persistable);
    db.prepare(
      "INSERT INTO settings (key, value) VALUES ('app', ?) ON CONFLICT(key) DO UPDATE SET value = ?",
    ).run(serialized, serialized);
  }

  function syncDefaultMcpServers(nextServers: Record<string, McpServerConfig>): void {
    const nextNames = new Set(
      Object.keys(nextServers).map((name) => name.toLocaleLowerCase()),
    );
    for (const server of mcpServerStore.listMcpServers()) {
      if (server.enabledByDefault && !nextNames.has(server.name.toLocaleLowerCase())) {
        mcpServerStore.setMcpServerEnabledByDefault(server.id, false);
      }
    }

    for (const [name, config] of Object.entries(nextServers)) {
      const existing = mcpServerStore.getMcpServerByName(name);
      if (existing) {
        if (!existing.enabledByDefault) {
          validationError(
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
  }

  function getSettings(): AppSettings {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'app'").get() as { value?: unknown } | undefined;
    if (!row) return { ...structuredClone(DEFAULT_SETTINGS), mcpServers: getDefaultMcpServers() };
    let persisted: AppSettings;
    try {
      if (typeof row.value !== "string") validationError("settings value must be JSON text");
      persisted = normalizeAppSettings(DEFAULT_SETTINGS, JSON.parse(row.value) as unknown);
    } catch (error) {
      throw new SettingsReadError(error instanceof Error ? error.message : String(error));
    }
    return { ...persisted, mcpServers: getDefaultMcpServers() };
  }

  function updateSettings(updates: Partial<AppSettings>): AppSettings {
    const current = getSettings();
    const nextMcpServers = isRecord(updates) && "mcpServers" in updates
      ? normalizeMcpServers(updates.mcpServers)
      : undefined;
    const next = normalizeAppSettings(current, updates);

    runTransaction(db, () => {
      if (nextMcpServers) syncDefaultMcpServers(nextMcpServers);
      persistSettings(next);
    });

    if (nextMcpServers) next.mcpServers = getDefaultMcpServers();
    return next;
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
