import type { VoiceState } from "./voice-api";

export interface VoiceCardLink {
  label: string;
  path: string;
}

export type VoiceItem =
  | { id: string; kind: "user"; text: string; handled?: string }
  | { id: string; kind: "assistant"; genId: number; text: string; interrupted: boolean; done: boolean }
  | { id: string; kind: "tool"; genId: number; toolCallId: string; name: string; label: string; status: "running" | "done" | "failed" }
  | { id: string; kind: "notice"; level: "info" | "warning" | "error"; text: string }
  | { id: string; kind: "card"; title: string; body: string; links: VoiceCardLink[] };

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

export interface VoiceViewState {
  voiceState: VoiceState | "idle";
  engine: { state: "stopped" | "starting" | "ready" | "failed"; detail?: string };
  transport?: "websocket" | "http";
  model?: string;
  items: VoiceItem[];
  caption: { speaker: "user" | "assistant"; text: string } | null;
  counts: { unread: number; running: number; waiting: number } | null;
  metrics?: VoiceTurnMetrics;
  turnProbability: number;
  userSpeaking: boolean;
  ended?: string;
}

export const initialVoiceViewState: VoiceViewState = {
  voiceState: "idle",
  engine: { state: "stopped" },
  items: [],
  caption: null,
  counts: null,
  turnProbability: 0,
  userSpeaking: false,
};

const MAX_ITEMS = 120;

const TOOL_LABELS: Record<string, string> = {
  bridge_overview: "Checking Bridge",
  list_sessions: "Looking through sessions",
  read_session: "Reading a reply",
  send_to_session: "Sending to a session",
  start_session: "Starting a session",
  stop_session: "Stopping a session",
  answer_session_question: "Answering a question",
  mark_sessions_read: "Marking replies read",
  list_models: "Checking models",
  show_on_screen: "Putting it on screen",
  voice_mode: "Adjusting voice mode",
  task_list: "Checking tasks",
  task_get_info: "Reading a task",
  task_create: "Creating a task",
  task_update_momentum: "Updating a task",
  action_add: "Adding an action",
  action_list: "Checking actions",
  action_update: "Updating an action",
  decision_list: "Checking decisions",
  alert_list: "Checking alerts",
  docs_search: "Searching your docs",
  docs_read: "Reading a doc",
  focus_protection_current: "Checking focus protection",
};

export function describeVoiceTool(name: string): string {
  return TOOL_LABELS[name] ?? name.replace(/_/g, " ");
}

function pushItem(items: VoiceItem[], item: VoiceItem): VoiceItem[] {
  const next = [...items, item];
  return next.length > MAX_ITEMS ? next.slice(next.length - MAX_ITEMS) : next;
}

function lastIndexWhere(items: VoiceItem[], predicate: (item: VoiceItem) => boolean): number {
  for (let index = items.length - 1; index >= 0; index--) {
    if (predicate(items[index]!)) return index;
  }
  return -1;
}

function updateAssistant(items: VoiceItem[], genId: number, update: (item: Extract<VoiceItem, { kind: "assistant" }>) => VoiceItem): VoiceItem[] {
  const index = lastIndexWhere(items, (item) => item.kind === "assistant" && item.genId === genId);
  if (index < 0) return items;
  const next = [...items];
  next[index] = update(items[index] as Extract<VoiceItem, { kind: "assistant" }>);
  return next;
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
        ...(event.state === "listening" || event.state === "asleep" ? { userSpeaking: false } : {}),
      };
    case "vad":
      return { ...state, userSpeaking: !!event.speech };
    case "engine":
      return { ...state, engine: { state: event.state, ...(event.detail ? { detail: event.detail } : {}) } };
    case "agent":
      return { ...state, model: event.model };
    case "smart_turn":
      return { ...state, turnProbability: Number(event.probability) || 0 };
    case "user":
      if (event.handled === "ignored") return state;
      return {
        ...state,
        items: pushItem(state.items, { id: `user-${event.turnId}-${state.items.length}`, kind: "user", text: event.text, ...(event.handled ? { handled: event.handled } : {}) }),
        caption: { speaker: "user", text: event.text },
      };
    case "assistant_delta": {
      const existing = state.items.some((item) => item.kind === "assistant" && item.genId === event.genId);
      const items = existing
        ? updateAssistant(state.items, event.genId, (item) => ({ ...item, text: item.text + event.text }))
        : pushItem(state.items, { id: `assistant-${event.genId}`, kind: "assistant", genId: event.genId, text: event.text, interrupted: false, done: false });
      return { ...state, items };
    }
    case "assistant_chunk":
      return { ...state, caption: { speaker: "assistant", text: event.text } };
    case "assistant_done":
      return {
        ...state,
        items: updateAssistant(state.items, event.genId, (item) => ({ ...item, text: event.text || item.text, done: true, interrupted: item.interrupted || !!event.interrupted })),
      };
    case "assistant_discarded":
      return {
        ...state,
        items: state.items.filter((item) => !(item.kind === "assistant" && item.genId === event.genId)),
      };
    case "stop_audio":
      return {
        ...state,
        items: updateAssistant(state.items, event.genId, (item) => ({ ...item, interrupted: true })),
      };
    case "tool": {
      const index = lastIndexWhere(state.items, (item) => item.kind === "tool" && item.toolCallId === event.toolCallId);
      if (index >= 0) {
        const next = [...state.items];
        next[index] = { ...(state.items[index] as Extract<VoiceItem, { kind: "tool" }>), status: event.status };
        return { ...state, items: next };
      }
      return {
        ...state,
        items: pushItem(state.items, {
          id: `tool-${event.toolCallId}`,
          kind: "tool",
          genId: event.genId,
          toolCallId: event.toolCallId,
          name: event.name,
          label: describeVoiceTool(event.name),
          status: event.status,
        }),
      };
    }
    case "card":
      return { ...state, items: pushItem(state.items, { id: `card-${event.id}`, kind: "card", title: event.title, body: event.body, links: event.links ?? [] }) };
    case "notice":
      return { ...state, items: pushItem(state.items, { id: `notice-${state.items.length}-${event.message}`, kind: "notice", level: event.level, text: event.message }) };
    case "metrics":
      return { ...state, metrics: event.metrics };
    case "bridge_counts":
      return { ...state, counts: { unread: event.unread, running: event.running, waiting: event.waiting } };
    case "ended":
      return { ...state, voiceState: "ended", ended: event.reason, userSpeaking: false };
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
  ended: "Voice mode ended",
};

export function formatBytes(bytes: number): string {
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MB`;
  return `${Math.round(bytes / 1024)} KB`;
}
