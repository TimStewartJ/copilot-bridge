export interface UnifiedHelmSettings {
  model: string;
  typedReasoningEffort: string;
  spokenReasoningEffort: string;
  glossary: string;
  voice: string;
  speed: number;
  patience: number;
  bargeIn: boolean;
  announce: "watched" | "all" | "off";
  echoSafe: boolean;
  transport: "auto" | "websocket" | "http";
}

export const HELM_SETTINGS_DEFAULTS: UnifiedHelmSettings = {
  model: "",
  typedReasoningEffort: "max",
  spokenReasoningEffort: "none",
  glossary: "",
  voice: "af_heart",
  speed: 1.05,
  patience: 0.5,
  bargeIn: true,
  announce: "watched",
  echoSafe: true,
  transport: "auto",
};

export interface HelmSettingsResponse {
  schemaVersion: 1;
  settings: UnifiedHelmSettings;
  voices: { id: string; name: string }[];
  models?: { id: string; name: string }[];
  modelsError?: string;
}

/** Strict PATCH contract; no coercion, truncation, or unknown properties. */
export function validateHelmSettingsPatch(input: unknown): Partial<UnifiedHelmSettings> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Helm settings must be an object");
  const result: Partial<UnifiedHelmSettings> = {};
  for (const [key, value] of Object.entries(input)) {
    if (!Object.hasOwn(HELM_SETTINGS_DEFAULTS, key)) throw new Error(`Unknown Helm setting: ${key}`);
    let valid = false;
    switch (key) {
      case "model": valid = typeof value === "string" && value.length <= 200 && value === value.trim(); break;
      case "glossary": valid = typeof value === "string" && value.length <= 2000; break;
      case "typedReasoningEffort":
      case "spokenReasoningEffort": valid = typeof value === "string" && /^[a-z][a-z0-9_-]{0,31}$/.test(value); break;
      case "voice": valid = typeof value === "string" && /^[a-z][a-z0-9_]{0,99}$/.test(value); break;
      case "speed": valid = typeof value === "number" && Number.isFinite(value) && value >= 0.75 && value <= 1.4; break;
      case "patience": valid = typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1; break;
      case "bargeIn":
      case "echoSafe": valid = typeof value === "boolean"; break;
      case "announce": valid = value === "watched" || value === "all" || value === "off"; break;
      case "transport": valid = value === "auto" || value === "websocket" || value === "http"; break;
    }
    if (!valid) throw new Error(`Invalid Helm setting: ${key}`);
    Object.assign(result, { [key]: value });
  }
  return result;
}
