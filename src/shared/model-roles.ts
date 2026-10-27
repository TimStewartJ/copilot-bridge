// Model tiers and roles: one place that says which model each kind of work runs on.
//
// Tiers are the three composer presets, given names: Fast, Standard and Deep. Each is a model with
// its effort and context size, edited only in Settings › Models. A role is a kind of work Bridge
// runs (your new chats, Helm, hands-free voice, chat titles, background checks, sub-agents); each
// points at a tier or at a model of its own ("custom"). A role nobody set runs on its recommended
// tier; New chats and Background checks instead keep their older setting, and Reviewers run on the
// chat's own model. Sub-agents are two roles: `subagents` (shown as Helpers)
// and `reviewers`; rubber-duck follows the tiers by itself (shared/subagent-settings.ts).
import type { CopilotContextTier } from "./copilot-context.js";
import type { ModelPresetSlot } from "./model-presets.js";

export type ModelRole = "chat" | "helm" | "handsFree" | "helper" | "background" | "subagents" | "reviewers";

export const MODEL_ROLES: readonly ModelRole[] = ["chat", "helm", "handsFree", "background", "subagents", "reviewers", "helper"];

export interface ModelRoleInfo {
  label: string;
  description: string;
  /** What the role runs on when its tier has no model yet or its model can't be used. */
  automatic: string;
  /** A real choice besides the tiers and Own, offered as its own option ("Same as chat"). */
  automaticLabel?: string;
  /** The tier the role runs on until you choose another, and what Use recommended picks. */
  recommended?: ModelPresetSlot;
  /** How this role's reasoning effort is decided when it uses a tier. */
  effortNote?: string;
}

export const MODEL_ROLE_INFO: Record<ModelRole, ModelRoleInfo> = {
  chat: {
    label: "New chats",
    description: "Chats you start, plus ones Helm, agents or schedules start for you.",
    automatic: "The Copilot default model",
    recommended: "preset2",
  },
  helm: {
    label: "Helm",
    description: "Helm's chat, and its looks at your Bridges that write the brief on Home.",
    automatic: "Your default chat model, or the most capable one when that is a router",
    recommended: "preset3",
  },
  handsFree: {
    label: "Hands-free",
    description: "Understands what you say and reads replies back. The chat keeps its own model.",
    automatic: "The Small jobs model",
    recommended: "preset1",
    effortNote: "Always low effort, even if the tier is set higher.",
  },
  background: {
    label: "Background checks",
    description: "Follow-ups and checks agents schedule for themselves.",
    automatic: "The cheapest model, at low effort",
    recommended: "preset1",
  },
  subagents: {
    label: "Helpers",
    description: "Sub-agents that run commands, read code and search the web.",
    automatic: "GPT-6 Luna at max effort (Bridge's built-in default)",
    recommended: "preset1",
  },
  reviewers: {
    label: "Reviewers and delegated work",
    description: "Code review, security review, and agents that take over a build.",
    automatic: "Runs on the chat's own model.",
    automaticLabel: "Same as chat",
  },
  helper: {
    label: "Small jobs",
    description: "Naming chats.",
    automatic: "The cheapest model that can answer without reasoning",
    recommended: "preset1",
    effortNote: "Always the lowest effort the model allows.",
  },
};

export interface ModelTierInfo {
  label: string;
  description: string;
}

export const MODEL_TIER_INFO: Record<ModelPresetSlot, ModelTierInfo> = {
  preset1: { label: "Fast", description: "Quick and cheap: replies in seconds." },
  preset2: { label: "Standard", description: "Everyday work." },
  preset3: { label: "Deep", description: "Careful thinking, when it matters." },
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

/** Roles that run on their recommended tier when nobody chose one. */
const DEFAULT_TIER_ROLES: ReadonlySet<ModelRole> = new Set(["helm", "handsFree", "helper", "subagents"]);

export function defaultRoleTier(role: ModelRole): ModelPresetSlot | undefined {
  return DEFAULT_TIER_ROLES.has(role) ? MODEL_ROLE_INFO[role].recommended : undefined;
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
  /** Nobody chose this role's tier: it runs on its default. */
  isDefault?: true;
  /** Set when the chosen tier or model can't be used and the role fell back to its built-in pick. */
  warning?: string;
}

export interface ModelRolesView {
  tiers: Partial<Record<ModelPresetSlot, ModelRoleCustom>>;
  roles: ResolvedModelRole[];
  /** Enabled schedules that choose their own model instead of following New chats. */
  scheduleOverrides: number;
}
