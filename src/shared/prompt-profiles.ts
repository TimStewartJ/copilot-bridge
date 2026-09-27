/**
 * System prompt profiles: what kind of work a chat is for. A profile shapes the agent's role,
 * communication and working approach; it never changes tools or permissions.
 */
export const PROMPT_PROFILE_IDS = ["engineer", "assistant", "monitor"] as const;

export type PromptProfileId = typeof PROMPT_PROFILE_IDS[number];

/** The global default: a profile, or "auto" to pick from whether the chat has a project folder. */
export type PromptProfileSetting = "auto" | PromptProfileId;

export const DEFAULT_PROMPT_PROFILE_SETTING: PromptProfileSetting = "auto";

export interface PromptProfileInfo {
  id: PromptProfileId;
  label: string;
  description: string;
}

export const PROMPT_PROFILES: readonly PromptProfileInfo[] = [
  {
    id: "engineer",
    label: "Engineer",
    description: "Software work in a project: coding rules, verification, and change reports.",
  },
  {
    id: "assistant",
    label: "Assistant",
    description: "Everyday work and questions: research, writing, planning, and documents, in conversational prose.",
  },
  {
    id: "monitor",
    label: "Monitor",
    description: "Recurring checks: compares with the last run and reports only what changed.",
  },
];

export const AUTO_PROMPT_PROFILE_DESCRIPTION = "Engineer when the chat has a project folder, Assistant otherwise.";

export function isPromptProfileId(value: unknown): value is PromptProfileId {
  return typeof value === "string" && (PROMPT_PROFILE_IDS as readonly string[]).includes(value);
}

export function isPromptProfileSetting(value: unknown): value is PromptProfileSetting {
  return value === "auto" || isPromptProfileId(value);
}

export function getPromptProfileInfo(id: PromptProfileId): PromptProfileInfo {
  return PROMPT_PROFILES.find((profile) => profile.id === id) ?? PROMPT_PROFILES[0]!;
}

/** "session": chosen for this chat. "default": the settings default. "automatic": picked by the auto rule. */
export type PromptProfileSource = "session" | "default" | "automatic";

export interface ResolvedPromptProfile {
  id: PromptProfileId;
  source: PromptProfileSource;
}

export function resolvePromptProfile({
  sessionProfile,
  defaultSetting,
  hasProjectFolder,
}: {
  sessionProfile?: PromptProfileId;
  defaultSetting?: PromptProfileSetting;
  hasProjectFolder: boolean;
}): ResolvedPromptProfile {
  if (sessionProfile) return { id: sessionProfile, source: "session" };
  const setting = defaultSetting ?? DEFAULT_PROMPT_PROFILE_SETTING;
  if (setting !== "auto") return { id: setting, source: "default" };
  return { id: hasProjectFolder ? "engineer" : "assistant", source: "automatic" };
}
