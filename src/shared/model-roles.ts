// Model tiers and roles: one place that says which model each kind of work runs on.
//
// Tiers are the three composer presets, given names: Fast, Standard and Deep. Each is a model with
// its effort and context size, edited only in Settings › Models. A role is a kind of work Bridge
// runs (your new chats, Helm, chat titles, background checks, sub-agents); each
// points at a tier, at a model of its own ("custom"), or is left automatic, which keeps the
// behaviour it had before tiers existed.
import type { CopilotContextTier } from "./copilot-context.js";
import type { ModelPresetSlot } from "./model-presets.js";

export type ModelRole = "chat" | "helm" | "helper" | "background" | "subagents";

export const MODEL_ROLES: readonly ModelRole[] = ["chat", "helm", "background", "subagents", "helper"];

export interface ModelRoleInfo {
  label: string;
  description: string;
  /** What "Automatic" means for this role: the behaviour from before tiers. */
  automatic: string;
  /** The tier the recommended setup uses. */
  recommended: ModelPresetSlot;
  /** How this role's reasoning effort is decided when it uses a tier. */
  effortNote?: string;
}

export const MODEL_ROLE_INFO: Record<ModelRole, ModelRoleInfo> = {
  chat: {
    label: "New chats",
    description: "Chats you start, scheduled runs without their own model, and chats Helm or agents start for you.",
    automatic: "The Copilot default model",
    recommended: "preset2",
  },
  helm: {
    label: "Helm",
    description: "Talking to Helm, and its look at all your Bridges that writes the brief on Home.",
    automatic: "Your default chat model, or the most capable one when that is a router",
    recommended: "preset3",
    effortNote: "Chat effort comes from Helm's typed and spoken settings.",
  },
  background: {
    label: "Background checks",
    description: "Deferred checks and follow-ups agents set for themselves.",
    automatic: "The cheapest model, at low effort",
    recommended: "preset1",
  },
  subagents: {
    label: "Sub-agents",
    description: "Default for the task, explore and research helpers agents start. Per-agent choices below still win.",
    automatic: "GPT-6 Luna at max effort (Bridge's built-in default)",
    recommended: "preset1",
  },
  helper: {
    label: "Small jobs",
    description: "Naming chats, and the short \"Let me check…\" line in hands-free.",
    automatic: "The cheapest model that can answer without reasoning",
    recommended: "preset1",
    effortNote: "Runs at the lowest effort the model allows.",
  },
};

export interface ModelTierInfo {
  label: string;
  description: string;
}

export const MODEL_TIER_INFO: Record<ModelPresetSlot, ModelTierInfo> = {
  preset1: { label: "Fast", description: "Quick and cheap: replies in seconds." },
  preset2: { label: "Standard", description: "Everyday work." },
  preset3: { label: "Deep", description: "Careful thinking, when the answer matters more than the wait." },
};

export interface ModelRoleCustom {
  model: string;
  reasoningEffort?: string;
  contextTier?: CopilotContextTier;
}

export type ModelRoleChoice = { tier: ModelPresetSlot } | ModelRoleCustom;

export type ModelRoles = Partial<Record<ModelRole, ModelRoleChoice>>;

export function isModelRole(value: unknown): value is ModelRole {
  return typeof value === "string" && (MODEL_ROLES as readonly string[]).includes(value);
}

export function isTierChoice(choice: ModelRoleChoice | undefined): choice is { tier: ModelPresetSlot } {
  return !!choice && "tier" in choice;
}

/** How a role is set up, as the Models page and the role API describe it. */
export type ModelRoleSource = "tier" | "custom" | "automatic";

export interface ResolvedModelRole {
  role: ModelRole;
  source: ModelRoleSource;
  tier?: ModelPresetSlot;
  model?: string;
  reasoningEffort?: string;
  contextTier?: CopilotContextTier;
  /** Set when the chosen tier or model can't be used and the role fell back to Automatic. */
  warning?: string;
}

export interface ModelRolesView {
  tiers: Partial<Record<ModelPresetSlot, ModelRoleCustom>>;
  roles: ResolvedModelRole[];
  /** Enabled schedules that choose their own model instead of following New chats. */
  scheduleOverrides: number;
}
