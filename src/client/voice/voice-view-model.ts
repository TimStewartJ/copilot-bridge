// Live state of a hands-free conversation. The words themselves are not kept here: voice
// turns run through the Helm session, so the chat transcript is the single record of what
// was said. This tracks only what the dock shows while you talk.
import type { VoiceState } from "./voice-api";

export interface VoiceTurnMetrics {
  turnId: number;
  reason: string;
  smartTurn: number[];
  endpointMs?: number;
  sttMs?: number;
  llmFirstTextMs?: number;
  ttsFirstMs?: number;
  speechEndToFirstAudioMs?: number;
}

export interface VoiceNotice {
  level: "info" | "warning" | "error";
  text: string;
}

export interface VoiceViewState {
  voiceState: VoiceState | "idle";
  engine: { state: "stopped" | "starting" | "ready" | "failed"; detail?: string };
  transport?: "websocket" | "http";
  /** The sentence being spoken, or what was just heard. */
  caption: { speaker: "user" | "assistant"; text: string } | null;
  /** Tools running for the current reply, newest last. */
  activity: Array<{ toolCallId: string; label: string }>;
  notice: VoiceNotice | null;
  counts: { unread: number; running: number; waiting: number } | null;
  metrics?: VoiceTurnMetrics;
  turnProbability: number;
  userSpeaking: boolean;
  ended?: string;
}

export const initialVoiceViewState: VoiceViewState = {
  voiceState: "idle",
  engine: { state: "stopped" },
  caption: null,
  activity: [],
  notice: null,
  counts: null,
  turnProbability: 0,
  userSpeaking: false,
};

const TOOL_LABELS: Record<string, string> = {
  bridge_overview: "Checking Bridge",
  list_sessions: "Looking through sessions",
  read_session: "Reading a reply",
  send_to_session: "Sending to a session",
  start_session: "Starting a session",
  stop_session: "Stopping a session",
  answer_session_question: "Answering a question",
  mark_sessions_read: "Marking replies read",
  archive_sessions: "Tidying sessions",
  list_models: "Checking models",
  hands_free: "Adjusting hands-free",
  session_rename: "Renaming a session",
  task_list: "Checking tasks",
  task_get_info: "Reading a task",
  task_create: "Creating a task",
  task_update: "Updating a task",
  task_update_momentum: "Updating a task",
  action_add: "Adding an action",
  action_list: "Checking actions",
  action_update: "Updating an action",
  decision_list: "Checking decisions",
  alert_list: "Checking alerts",
  event_list: "Checking events",
  schedule_list: "Checking schedules",
  schedule_create: "Creating a schedule",
  docs_search: "Searching your docs",
  docs_read: "Reading a doc",
  docs_write: "Writing a doc",
  focus_protection_current: "Checking focus protection",
};

export function describeVoiceTool(name: string): string {
  return TOOL_LABELS[name] ?? name.replace(/_/g, " ");
}

export function reduceVoiceEvent(state: VoiceViewState, event: Record<string, any>): VoiceViewState {
  switch (event.type) {
    case "hello":
      return { ...state, transport: event.transport, voiceState: event.state === "starting" ? state.voiceState : event.state, ended: undefined };
    case "state":
      return {
        ...state,
        voiceState: event.state,
        ...(event.state === "hearing" ? { turnProbability: 0 } : {}),
        ...(event.state === "listening" || event.state === "asleep" ? { userSpeaking: false, activity: [] } : {}),
      };
    case "vad":
      return { ...state, userSpeaking: !!event.speech };
    case "engine":
      return { ...state, engine: { state: event.state, ...(event.detail ? { detail: event.detail } : {}) } };
    case "smart_turn":
      return { ...state, turnProbability: Number(event.probability) || 0 };
    case "user":
      if (event.handled === "ignored") return state;
      return { ...state, caption: { speaker: "user", text: event.text }, notice: null, activity: [] };
    case "assistant_chunk":
      return { ...state, caption: { speaker: "assistant", text: event.text } };
    case "tool": {
      const others = state.activity.filter((entry) => entry.toolCallId !== event.toolCallId);
      return {
        ...state,
        activity: event.status === "running"
          ? [...others, { toolCallId: event.toolCallId, label: describeVoiceTool(event.name) }]
          : others,
      };
    }
    case "notice":
      return { ...state, notice: { level: event.level, text: event.message } };
    case "metrics":
      return { ...state, metrics: event.metrics };
    case "bridge_counts":
      return { ...state, counts: { unread: event.unread, running: event.running, waiting: event.waiting } };
    case "ended":
      return { ...state, voiceState: "ended", ended: event.reason, userSpeaking: false, activity: [] };
    default:
      return state;
  }
}

export const VOICE_STATE_LABELS: Record<VoiceState | "idle", string> = {
  idle: "Ready when you are",
  starting: "Waking up…",
  listening: "Listening",
  hearing: "Hearing you",
  endpointing: "Deciding if you're done…",
  thinking: "Thinking",
  speaking: "Speaking",
  asleep: "Asleep · say “Hey Bridge”",
  ended: "Hands-free ended",
};

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}
