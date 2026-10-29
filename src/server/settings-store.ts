// Settings store — SQLite persistence

import type { DatabaseSync } from "./db.js";
import { validateHelmSettingsPatch, type HelmLegacySettings, type HelmLegacySettingKey, type UnifiedHelmSettings } from "../shared/helm-settings.js";

import type { ProvidersConfig } from "./providers/types.js";
import type { McpServerConfig } from "./mcp-config.js";
import { createMcpServerStore } from "./mcp-server-store.js";
import {
  isCopilotContextTier,
  type CopilotContextTier,
} from "../shared/copilot-context.js";
import { isModelFamily, type ModelFamily } from "../shared/model-families.js";
import {
  getModelPresetSlotForFamily,
  isModelPresetSlot,
  type ModelPresetSlot,
} from "../shared/model-presets.js";
import { isRecord } from "../shared/is-record.js";
import { isModelRole, isTierChoice, type ModelRoleChoice, type ModelRoles } from "../shared/model-roles.js";
import { isPromptProfileSetting, type PromptProfileSetting } from "../shared/prompt-profiles.js";
import {
  IMAGE_BUDGET_MAX_CEILING_MB,
  IMAGE_BUDGET_MODEL_PATTERN,
  type ImageBudgetSettings,
} from "../shared/image-budget.js";
import {
  FUSION_CONTEXT_TOKENS_MAX,
  FUSION_CONTEXT_TOKENS_MIN,
  type ExperimentalSettings,
} from "../shared/experimental-settings.js";

import {
  DEFAULT_RESPONSE_STYLE_GUIDANCE,
  MAX_RESPONSE_STYLE_GUIDANCE_LENGTH,
  isResponseDetail,
  resolveResponseStyle,
  type ResponseStyleSettings,
} from "../shared/response-style.js";

export type ThemePreference = "light" | "dark" | "system";
export type MotionPreference = "system" | "reduce" | "full";
// Reasoning-effort ids are fully SDK-driven (per-model `supportedReasoningEfforts`),
// so this is an open string alias rather than a fixed enumeration.
export type ReasoningEffort = string;

export interface BrowserSettings {
  executablePath?: string;
  masterProfileDirectory?: string;
  headed?: boolean;
}

export interface DeferWorkerSettings {
  model?: string;
  reasoningEffort?: ReasoningEffort;
  contextTier?: CopilotContextTier;
}

export interface ComputerUseSettings {
  enabled?: boolean;
}

/** Hands-free voice settings and Helm's names list. Helm's model and effort are its role in `modelRoles`. */
export interface HelmSettings extends Partial<Omit<UnifiedHelmSettings, HelmLegacySettingKey>> {
  /**
   * Names the user says that speech recognition mishears or Helm can't know (machine, project and app
   * names), given to Helm with its instructions and to the hands-free layer.
   */
  glossary?: string;
  /** What Tether last wrote for the retired model and effort settings, returned as written. Nothing reads them. */
  legacy?: HelmLegacySettings;
}

export const HELM_GLOSSARY_MAX_LENGTH = 2_000;

export interface ModelFamilyDefault {
  model: string;
  reasoningEffort?: ReasoningEffort;
  contextTier?: CopilotContextTier;
}

export type ModelFamilyDefaults = Partial<Record<ModelFamily, ModelFamilyDefault>>;

export interface ModelPreset {
  model: string;
  reasoningEffort?: ReasoningEffort;
  contextTier?: CopilotContextTier;
}

export type ModelPresets = Partial<Record<ModelPresetSlot, ModelPreset>>;

export interface AppSettings {
  providers?: ProvidersConfig;
  mcpServers: Record<string, McpServerConfig>;
  favicon?: string;
  theme?: ThemePreference;
  /** Overrides the device prefers-reduced-motion setting when not "system". */
  motion?: MotionPreference;
  identity?: string;
  customInstructions?: string;
  responseStyle?: ResponseStyleSettings;
  /** Default profile for new chats; unset is "auto". */
  promptProfile?: PromptProfileSetting;
  model?: string;
  reasoningEffort?: ReasoningEffort;
  contextTier?: CopilotContextTier;
  modelPresets?: ModelPresets;
  lastModelPreset?: ModelPresetSlot;
  /**
   * Which model each kind of work runs on (Settings › Models). A missing role is "Automatic": the
   * behaviour from before roles. New chats, Helm chat and background checks keep their older
   * fields (model…, helm.model, deferWorker) in step with a tier, so every reader of those still
   * works; changing one of those fields directly makes that role follow the field again.
   * Present (even empty) once the roles have been set up or inferred.
   */
  modelRoles?: ModelRoles;
  /** Legacy input fields migrated into modelPresets. */
  familyDefaults?: ModelFamilyDefaults;
  lastModelFamily?: ModelFamily;
  browser?: BrowserSettings;
  deferWorker?: DeferWorkerSettings;
  computerUse?: ComputerUseSettings;
  helm?: HelmSettings;
  /** Early compaction for models whose provider rejects large requests; unset uses the defaults. */
  imageBudget?: ImageBudgetSettings;
  /** Opt-in features that may change or go away; unset is all off. */
  experimental?: ExperimentalSettings;
}

export type AppSettingsUpdates = Partial<AppSettings>;

export interface PreparedSettingsUpdate {
  current: AppSettings;
  next: AppSettings;
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

function normalizeMotion(value: unknown): MotionPreference | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (value !== "system" && value !== "reduce" && value !== "full") {
    validationError("motion must be system, reduce, or full");
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

function normalizeDeferWorkerSettings(value: unknown): DeferWorkerSettings | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) validationError("deferWorker must be an object");
  const model = normalizeOptionalString(value.model, "model", {
    trim: true,
    emptyAsUndefined: true,
  });
  const reasoningEffort = normalizeOptionalString(value.reasoningEffort, "reasoningEffort", {
    trim: true,
    emptyAsUndefined: true,
  });
  const contextTier = value.contextTier;
  if (
    contextTier !== undefined
    && contextTier !== null
    && contextTier !== ""
    && !isCopilotContextTier(contextTier)
  ) {
    validationError("deferWorker.contextTier must be default or long_context");
  }
  if (!model && !reasoningEffort && !isCopilotContextTier(contextTier)) return undefined;
  return {
    ...(model ? { model } : {}),
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(isCopilotContextTier(contextTier) ? { contextTier } : {}),
  };
}

function normalizeComputerUseSettings(value: unknown): ComputerUseSettings | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) validationError("computerUse must be an object");
  const enabled = value.enabled;
  if (enabled !== undefined && enabled !== null && typeof enabled !== "boolean") {
    validationError("computerUse.enabled must be a boolean");
  }
  return enabled === true ? { enabled: true } : undefined;
}

function normalizeImageBudgetSettings(value: unknown): ImageBudgetSettings | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) validationError("imageBudget must be an object");
  const result: ImageBudgetSettings = {};
  if (value.enabled !== undefined && value.enabled !== null) {
    if (typeof value.enabled !== "boolean") validationError("imageBudget.enabled must be a boolean");
    if (value.enabled === false) result.enabled = false;
  }
  if (value.ceilingsMb !== undefined && value.ceilingsMb !== null) {
    if (!isRecord(value.ceilingsMb)) validationError("imageBudget.ceilingsMb must be an object");
    const ceilings: Record<string, number> = {};
    for (const [pattern, mb] of Object.entries(value.ceilingsMb)) {
      if (!IMAGE_BUDGET_MODEL_PATTERN.test(pattern)) validationError(`imageBudget.ceilingsMb has an invalid model pattern: ${pattern}`);
      if (typeof mb !== "number" || !Number.isFinite(mb) || mb <= 0 || mb > IMAGE_BUDGET_MAX_CEILING_MB) {
        validationError(`imageBudget.ceilingsMb.${pattern} must be a number of MB above 0 and at most ${IMAGE_BUDGET_MAX_CEILING_MB}`);
      }
      ceilings[pattern] = mb;
    }
    result.ceilingsMb = ceilings;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeExperimentalSettings(value: unknown): ExperimentalSettings | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) validationError("experimental must be an object");
  const result: ExperimentalSettings = {};
  const tokens = value.fusionContextTokens;
  if (tokens !== undefined && tokens !== null) {
    if (!Number.isInteger(tokens) || (tokens as number) < FUSION_CONTEXT_TOKENS_MIN || (tokens as number) > FUSION_CONTEXT_TOKENS_MAX) {
      validationError(`experimental.fusionContextTokens must be a whole number from ${FUSION_CONTEXT_TOKENS_MIN} to ${FUSION_CONTEXT_TOKENS_MAX}`);
    }
    result.fusionContextTokens = tokens as number;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeHelmSettings(value: unknown): HelmSettings | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) validationError("helm must be an object");
  const { voice, speed, patience, bargeIn, announce, echoSafe, transport } = value;
  let extra: Partial<UnifiedHelmSettings>;
  try {
    extra = validateHelmSettingsPatch(Object.fromEntries(Object.entries({ voice, speed, patience, bargeIn, announce, echoSafe, transport })
      .filter(([, item]) => item !== undefined)));
  } catch (error) {
    validationError(error instanceof Error ? error.message : String(error));
  }
  const rawGlossary = value.glossary;
  if (rawGlossary !== undefined && rawGlossary !== null
    && (typeof rawGlossary !== "string" || rawGlossary.length > HELM_GLOSSARY_MAX_LENGTH)) {
    validationError(`helm.glossary must be text of at most ${HELM_GLOSSARY_MAX_LENGTH} characters`);
  }
  const glossary = typeof rawGlossary === "string" ? rawGlossary.trim() || undefined : undefined;
  // Settings saved before these were retired kept the efforts at the top level.
  const legacySource = isRecord(value.legacy) ? value.legacy : {
    ...(value.typedReasoningEffort !== undefined ? { typedReasoningEffort: value.typedReasoningEffort } : {}),
    ...(value.spokenReasoningEffort !== undefined ? { spokenReasoningEffort: value.spokenReasoningEffort } : {}),
  };
  const legacy: HelmLegacySettings = {};
  for (const key of ["model", "typedReasoningEffort", "spokenReasoningEffort"] as const) {
    const raw = legacySource[key];
    if (raw === undefined || raw === null) continue;
    if (typeof raw !== "string" || raw.length > (key === "model" ? 200 : 32)) validationError(`helm.legacy.${key} must be text`);
    legacy[key] = raw.trim();
  }
  const hasLegacy = Object.keys(legacy).length > 0;
  if (!glossary && !hasLegacy && !Object.keys(extra).length) return undefined;
  return {
    ...extra,
    ...(glossary ? { glossary } : {}),
    ...(hasLegacy ? { legacy } : {}),
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

function normalizeModelPreset(
  value: unknown,
  slot: ModelPresetSlot,
): ModelPreset | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) validationError(`modelPresets.${slot} must be an object`);
  const raw = value;

  if (raw.model !== undefined && raw.model !== null && typeof raw.model !== "string") {
    validationError(`modelPresets.${slot}.model must be a string`);
  }
  const model = typeof raw.model === "string" ? raw.model.trim() : "";
  if (!model) return undefined;

  if (
    raw.reasoningEffort !== undefined
    && raw.reasoningEffort !== null
    && typeof raw.reasoningEffort !== "string"
  ) {
    validationError(`modelPresets.${slot}.reasoningEffort must be a string`);
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
    validationError(`modelPresets.${slot}.contextTier must be default or long_context`);
  }

  return {
    model,
    ...(reasoningEffort ? { reasoningEffort } : {}),
    ...(isCopilotContextTier(contextTier) ? { contextTier } : {}),
  };
}

function normalizeModelPresets(value: unknown): ModelPresets | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) validationError("modelPresets must be an object");
  const normalized: ModelPresets = {};
  for (const [slot, entry] of Object.entries(value)) {
    if (!isModelPresetSlot(slot)) {
      validationError(`modelPresets key "${slot}" is not a known preset slot`);
    }
    const normalizedEntry = normalizeModelPreset(entry, slot);
    if (normalizedEntry) normalized[slot] = normalizedEntry;
  }
  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function migrateFamilyDefaults(familyDefaults: ModelFamilyDefaults | undefined): ModelPresets | undefined {
  if (!familyDefaults) return undefined;
  const presets: ModelPresets = {};
  for (const [family, value] of Object.entries(familyDefaults)) {
    if (value) presets[getModelPresetSlotForFamily(family as ModelFamily)] = value;
  }
  return Object.keys(presets).length > 0 ? presets : undefined;
}

function normalizeModelRoleChoice(value: unknown, role: string): ModelRoleChoice | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) validationError(`modelRoles.${role} must be an object`);
  if ("tier" in value) {
    if (!isModelPresetSlot(value.tier)) validationError(`modelRoles.${role}.tier must be preset1, preset2 or preset3`);
    return { tier: value.tier };
  }
  if (typeof value.model !== "string" || !value.model.trim() || value.model.length > 200) {
    validationError(`modelRoles.${role} needs a tier or a model`);
  }
  if (value.reasoningEffort !== undefined && value.reasoningEffort !== null
    && (typeof value.reasoningEffort !== "string" || value.reasoningEffort.length > 32)) {
    validationError(`modelRoles.${role}.reasoningEffort must be a reasoning effort name`);
  }
  const effort = typeof value.reasoningEffort === "string" ? value.reasoningEffort.trim() : "";
  const contextTier = value.contextTier;
  if (contextTier !== undefined && contextTier !== null && contextTier !== "" && !isCopilotContextTier(contextTier)) {
    validationError(`modelRoles.${role}.contextTier must be default or long_context`);
  }
  return {
    model: value.model.trim(),
    ...(effort ? { reasoningEffort: effort } : {}),
    ...(isCopilotContextTier(contextTier) ? { contextTier } : {}),
  };
}

function normalizeModelRoles(value: unknown): ModelRoles | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) validationError("modelRoles must be an object");
  const roles: ModelRoles = {};
  for (const [role, choice] of Object.entries(value)) {
    if (!isModelRole(role)) validationError(`modelRoles key "${role}" is not a known role`);
    const normalized = normalizeModelRoleChoice(choice, role);
    // New chats and background checks keep a custom model in their older fields.
    if (normalized && !isTierChoice(normalized) && (role === "chat" || role === "background")) {
      validationError(`modelRoles.${role} takes a tier; its own model is set with the matching setting`);
    }
    if (normalized && !isTierChoice(normalized) && role === "reviewers") {
      validationError("modelRoles.reviewers takes a tier; leave it unset to use the chat's model");
    }
    if (normalized) roles[role] = normalized;
  }
  return roles;
}

function sameChoice(a: { model?: string; reasoningEffort?: string; contextTier?: string } | undefined, b: { model?: string; reasoningEffort?: string; contextTier?: string } | undefined): boolean {
  return !!a?.model && !!b?.model && a.model === b.model
    && (a.reasoningEffort ?? "") === (b.reasoningEffort ?? "")
    && (a.contextTier ?? "default") === (b.contextTier ?? "default");
}

/**
 * Keeps the role map and the older per-feature fields in step:
 * - a direct change to a role's older field (model/effort/context, deferWorker) in this
 *   update, without a change to that role, makes the role follow the field again ("custom");
 * - a role on a tier writes the tier into its older field, so existing readers use it;
 * - settings from before roles get them inferred once, only where the current setup already
 *   equals a tier exactly, so nothing changes behaviour.
 */
function reconcileModelRoles(base: AppSettings, normalized: AppSettings, value: Record<string, unknown>): void {
  const baseRoles = base === DEFAULT_SETTINGS ? undefined : base.modelRoles;
  // A role counts as set by this write only when the write changes it.
  const roleTouched = (role: keyof ModelRoles) => "modelRoles" in value
    && JSON.stringify(normalized.modelRoles?.[role]) !== JSON.stringify(baseRoles?.[role]);
  const presets = normalized.modelPresets ?? {};
  if (!normalized.modelRoles) {
    const inferred: ModelRoles = {};
    const slots = Object.keys(presets) as ModelPresetSlot[];
    const chatSlot = slots.find((slot) => sameChoice(presets[slot], normalized));
    if (chatSlot) inferred.chat = { tier: chatSlot };
    const backgroundSlot = slots.find((slot) => sameChoice(presets[slot], normalized.deferWorker));
    if (backgroundSlot) inferred.background = { tier: backgroundSlot };
    // Nothing to infer leaves no map, so settings rows stay as they were until a role is chosen.
    if (Object.keys(inferred).length) normalized.modelRoles = inferred;
    return;
  }
  const roles = { ...normalized.modelRoles };
  const triple = (entry: { model?: string; reasoningEffort?: string; contextTier?: string } | undefined) =>
    `${entry?.model ?? ""}|${entry?.reasoningEffort ?? ""}|${entry?.contextTier ?? ""}`;
  // Only a real change counts: clients that send unchanged values back leave the role alone.
  const fieldChanged = {
    chat: base !== DEFAULT_SETTINGS && ("model" in value || "reasoningEffort" in value || "contextTier" in value)
      && triple(normalized) !== triple(base),
    background: base !== DEFAULT_SETTINGS && "deferWorker" in value && triple(normalized.deferWorker) !== triple(base.deferWorker),
  };
  for (const role of ["chat", "background"] as const) {
    if (fieldChanged[role] && !roleTouched(role)) delete roles[role];
  }
  // A role can't stay on a tier that has no model: it keeps what it last ran on (its older field) or goes back to Automatic.
  for (const role of Object.keys(roles) as Array<keyof ModelRoles>) {
    const choice = roles[role];
    if (isTierChoice(choice) && !presets[choice.tier]?.model) delete roles[role];
  }
  normalized.modelRoles = roles;
  const tierOf = (role: "chat" | "background") => {
    const choice = roles[role];
    return isTierChoice(choice) ? presets[choice.tier] : undefined;
  };
  const chat = tierOf("chat");
  if (chat) {
    normalized.model = chat.model;
    if (chat.reasoningEffort) normalized.reasoningEffort = chat.reasoningEffort; else delete normalized.reasoningEffort;
    if (chat.contextTier) normalized.contextTier = chat.contextTier; else delete normalized.contextTier;
  }
  const background = tierOf("background");
  if (background) normalized.deferWorker = { ...background };
}

/**
 * Helm's model used to be kept in `helm.model` (with `helm.typedReasoningEffort` for its chat). A Helm
 * role that was Automatic but had a model there becomes a custom role with that model and effort.
 */
function migrateHelmModel(normalized: AppSettings, value: Record<string, unknown>): void {
  const helm = isRecord(value.helm) ? value.helm : undefined;
  const model = typeof helm?.model === "string" ? helm.model.trim() : "";
  if (!model || normalized.modelRoles?.helm) return;
  const effort = typeof helm?.typedReasoningEffort === "string" ? helm.typedReasoningEffort.trim() : "";
  normalized.modelRoles = { ...normalized.modelRoles, helm: { model, ...(effort ? { reasoningEffort: effort } : {}) } };
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

function normalizeLastModelPreset(value: unknown): ModelPresetSlot | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (!isModelPresetSlot(value)) validationError("lastModelPreset must be preset1, preset2, or preset3");
  return value;
}

function normalizeResponseStyle(value: unknown): ResponseStyleSettings | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) validationError("responseStyle must be an object");
  for (const key of Object.keys(value)) {
    if (key !== "detail" && key !== "guidance") validationError(`responseStyle key "${key}" is not supported`);
  }
  const detail = value.detail === undefined ? "adaptive" : value.detail;
  if (!isResponseDetail(detail)) validationError("responseStyle.detail must be adaptive, concise, or detailed");
  const guidance = value.guidance === undefined ? DEFAULT_RESPONSE_STYLE_GUIDANCE : value.guidance;
  if (typeof guidance !== "string") validationError("responseStyle.guidance must be a string");
  const trimmed = guidance.trim();
  if (trimmed.length > MAX_RESPONSE_STYLE_GUIDANCE_LENGTH) {
    validationError(`responseStyle.guidance must be at most ${MAX_RESPONSE_STYLE_GUIDANCE_LENGTH} characters`);
  }
  return resolveResponseStyle({ detail, guidance: trimmed });
}

function normalizeAppSettings(base: AppSettings, value: unknown): AppSettings {
  if (!isRecord(value)) validationError("settings must be an object");
  const normalized = structuredClone(base);
  if ("providers" in value) normalized.providers = normalizeProviders(value.providers);
  if ("favicon" in value) normalized.favicon = normalizeOptionalString(value.favicon, "favicon");
  if ("theme" in value) normalized.theme = normalizeTheme(value.theme);
  if ("motion" in value) normalized.motion = normalizeMotion(value.motion);
  if ("identity" in value) normalized.identity = normalizeOptionalString(value.identity, "identity");
  if ("customInstructions" in value) {
    normalized.customInstructions = normalizeOptionalString(value.customInstructions, "customInstructions");
  }
  if ("responseStyle" in value) normalized.responseStyle = normalizeResponseStyle(value.responseStyle);
  if ("promptProfile" in value) {
    const promptProfile = value.promptProfile;
    if (promptProfile === undefined || promptProfile === null || promptProfile === "") {
      delete normalized.promptProfile;
    } else if (isPromptProfileSetting(promptProfile)) {
      normalized.promptProfile = promptProfile;
    } else {
      validationError("promptProfile must be auto, engineer, assistant, or monitor");
    }
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
  if ("modelPresets" in value) {
    normalized.modelPresets = normalizeModelPresets(value.modelPresets);
  } else if ("familyDefaults" in value) {
    normalized.modelPresets = migrateFamilyDefaults(normalizeModelFamilyDefaults(value.familyDefaults));
  }
  if ("lastModelPreset" in value) {
    normalized.lastModelPreset = normalizeLastModelPreset(value.lastModelPreset);
  } else if ("lastModelFamily" in value) {
    const family = normalizeLastModelFamily(value.lastModelFamily);
    normalized.lastModelPreset = family ? getModelPresetSlotForFamily(family) : undefined;
  }
  delete normalized.familyDefaults;
  delete normalized.lastModelFamily;
  if ("browser" in value) normalized.browser = normalizeBrowserSettings(value.browser);
  if ("deferWorker" in value) {
    normalized.deferWorker = normalizeDeferWorkerSettings(value.deferWorker);
  }
  if ("computerUse" in value) normalized.computerUse = normalizeComputerUseSettings(value.computerUse);
  if ("helm" in value) normalized.helm = normalizeHelmSettings(value.helm);
  if ("imageBudget" in value) normalized.imageBudget = normalizeImageBudgetSettings(value.imageBudget);
  if ("experimental" in value) normalized.experimental = normalizeExperimentalSettings(value.experimental);
  // Like every other settings object, a write sends the whole role map; a missing role is Automatic.
  if ("modelRoles" in value) normalized.modelRoles = normalizeModelRoles(value.modelRoles) ?? {};
  reconcileModelRoles(base, normalized, value);
  migrateHelmModel(normalized, value);
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

  function prepareSettingsUpdate(updates: AppSettingsUpdates): PreparedSettingsUpdate {
    if (isRecord(updates) && "focusNotifications" in updates) {
      validationError("Focus delivery policy is retired. Native session notification subscriptions remain available.");
    }
    const current = getSettings();
    return { current, next: normalizeAppSettings(current, updates) };
  }

  function commitPreparedSettingsUpdate(prepared: PreparedSettingsUpdate): AppSettings {
    persistSettings(prepared.next);
    return prepared.next;
  }

  function updateSettings(updates: AppSettingsUpdates): AppSettings {
    return commitPreparedSettingsUpdate(prepareSettingsUpdate(updates));
  }

  /** Get MCP servers config for session creation/resume */
  function getMcpServers(): Record<string, McpServerConfig> {
    return getDefaultMcpServers();
  }

  function getMcpServerStore() {
    return mcpServerStore;
  }

  return {
    getSettings,
    prepareSettingsUpdate,
    commitPreparedSettingsUpdate,
    updateSettings,
    getMcpServers,
    getMcpServerStore,
  };
}

export type SettingsStore = ReturnType<typeof createSettingsStore>;
