import { API_BASE } from "../api";

export type VoiceState = "starting" | "listening" | "hearing" | "endpointing" | "thinking" | "speaking" | "asleep" | "ended";
export type VoiceAnnounceMode = "watched" | "all" | "off";

export interface VoiceSettings {
  voice: string;
  speed: number;
  patience: number;
  bargeIn: boolean;
  announce: VoiceAnnounceMode;
}

export interface KokoroVoice {
  sid: number;
  id: string;
  name: string;
  accent: "American" | "British";
  gender: "female" | "male";
}

export interface VoiceInstallAsset {
  id: string;
  label: string;
  kind: "npm" | "model";
  sizeBytes: number;
  installed: boolean;
}

export interface VoiceInstallStatus {
  supported: boolean;
  target: string;
  installed: boolean;
  installing: boolean;
  progress?: {
    assetId: string;
    label: string;
    phase: "downloading" | "verifying" | "extracting";
    receivedBytes: number;
    totalBytes: number;
    overallFraction: number;
  };
  error?: string;
  totalBytes: number;
  remainingBytes: number;
  assets?: VoiceInstallAsset[];
}

export type VoiceEngineCapability = "asr" | "turn" | "tts";

export interface VoiceStatus {
  install: VoiceInstallStatus;
  engine: { state: "stopped" | "starting" | "ready" | "failed"; detail?: string; loaded?: VoiceEngineCapability[] };
  voices: KokoroVoice[];
  defaults: VoiceSettings;
  activeConversations: number;
}

export interface VoiceConversationTicket {
  conversationId: string;
  token: string;
}

async function readError(res: Response): Promise<string> {
  const body = await res.json().catch(() => undefined) as { error?: string } | undefined;
  return body?.error ?? res.statusText ?? `HTTP ${res.status}`;
}

export async function fetchVoiceStatus(): Promise<VoiceStatus> {
  const res = await fetch(`${API_BASE}/api/voice/status`, { cache: "no-store" });
  if (!res.ok) throw new Error(await readError(res));
  return res.json() as Promise<VoiceStatus>;
}

export async function startVoiceInstall(): Promise<VoiceInstallStatus> {
  const res = await fetch(`${API_BASE}/api/voice/install`, { method: "POST" });
  if (!res.ok) throw new Error(await readError(res));
  return res.json() as Promise<VoiceInstallStatus>;
}

/** Starts hands-free for a Helm conversation; the voice side holds no context of its own. */
export async function createVoiceConversation(helmSessionId: string, settings: VoiceSettings): Promise<VoiceConversationTicket> {
  const res = await fetch(`${API_BASE}/api/voice/conversations`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ helmSessionId, settings }),
  });
  if (!res.ok) throw new Error(await readError(res));
  return res.json() as Promise<VoiceConversationTicket>;
}

export function voiceConversationPath(conversationId: string, suffix: string): string {
  return `${API_BASE}/api/voice/conversations/${encodeURIComponent(conversationId)}/${suffix}`;
}

export function buildVoiceWebSocketUrl(ticket: VoiceConversationTicket, location: Pick<Location, "protocol" | "host"> = window.location): string {
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  const params = new URLSearchParams({ conversationId: ticket.conversationId, token: ticket.token });
  return `${protocol}//${location.host}${API_BASE}/api/voice/ws?${params.toString()}`;
}

const SETTINGS_STORAGE_KEY = "bridge.voice.settings";

export function loadStoredVoiceSettings(defaults: VoiceSettings): VoiceSettings {
  try {
    const raw = window.localStorage.getItem(SETTINGS_STORAGE_KEY);
    if (!raw) return defaults;
    const { model: _legacyModel, ...parsed } = JSON.parse(raw) as Partial<VoiceSettings> & { model?: unknown };
    return { ...defaults, ...parsed };
  } catch {
    return defaults;
  }
}

export function storeVoiceSettings(settings: VoiceSettings): void {
  try {
    window.localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Private browsing or quota errors should not break hands-free.
  }
}

export type VoiceTransportPreference = "auto" | "websocket" | "http";
const TRANSPORT_STORAGE_KEY = "bridge.voice.transport";

export function loadTransportPreference(): VoiceTransportPreference {
  try {
    const value = window.localStorage.getItem(TRANSPORT_STORAGE_KEY);
    return value === "websocket" || value === "http" ? value : "auto";
  } catch {
    return "auto";
  }
}

export function storeTransportPreference(value: VoiceTransportPreference): void {
  try {
    window.localStorage.setItem(TRANSPORT_STORAGE_KEY, value);
  } catch {
    // Ignore storage failures.
  }
}
