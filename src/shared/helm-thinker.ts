// Helm's looks over every Bridge: a careful run on Helm's model that reads every Bridge it covers,
// keeps the layered memory Helm's chat also uses, and writes the brief Home shows. Shared by the
// server and the client.

export type HelmMemoryKind = "priority" | "rule" | "thread" | "person" | "date" | "picture";
export type HelmMemoryAuthor = "user" | "helm";
export type HelmMemoryStatus = "active" | "proposed" | "forgotten";

export interface HelmMemoryEntry {
  id: string;
  kind: HelmMemoryKind;
  /** Identity for upserts: "<bridge>:<taskId>" for threads, a short name for people and dates. */
  key: string | null;
  text: string;
  source: string | null;
  author: HelmMemoryAuthor;
  status: HelmMemoryStatus;
  createdAt: string;
  updatedAt: string;
  /** When Helm last saw it was still true. */
  confirmedAt: string;
  uses: number;
}

/** Most active entries of each kind; publication beyond these is refused so memory stays small. */
export const HELM_MEMORY_LIMITS: Record<HelmMemoryKind, number> = {
  priority: 15,
  rule: 40,
  thread: 120,
  person: 50,
  date: 50,
  picture: 1,
};
export const HELM_PICTURE_MAX_WORDS = 4000;
export const HELM_ENTRY_MAX_CHARS = 600;
/** A fact not confirmed for this long is sent back to the thinker to re-check or drop. */
export const HELM_STALE_AFTER_DAYS = 30;

export type HelmRunTrigger = "schedule" | "manual";
export type HelmRunStatus = "running" | "done" | "failed";

export interface HelmRunView {
  id: string;
  sessionId: string;
  trigger: HelmRunTrigger;
  rebuild: boolean;
  status: HelmRunStatus;
  startedAt: string;
  finishedAt: string | null;
  error: string | null;
  model: string | null;
  effort: string | null;
  credits: number | null;
  /** How many changed tasks and conversations the run was given to look at. */
  changeCount: number | null;
  bridges: HelmBridgeStatus[];
  /** False once retention deleted the run's conversation. */
  transcriptAvailable: boolean;
}

export interface HelmBridgeStatus {
  id: string;
  label: string;
  ok: boolean;
  error?: string;
}

/** Where an item or link points: this Bridge or a peer. */
export interface HelmTarget {
  bridge: string;
  sessionId?: string;
  taskId?: string;
}

export type HelmActionDo =
  | { type: "answer"; bridge: string; sessionId: string; requestId: string; answer: string; wasFreeform: boolean }
  | { type: "send"; bridge: string; sessionId: string; message: string }
  | { type: "tick"; bridge: string; actionId: string }
  | { type: "close_tasks"; bridge: string; taskIds: string[] }
  | { type: "open"; bridge: string; sessionId?: string; taskId?: string };

export interface HelmAction {
  id: string;
  label: string;
  primary?: boolean;
  do: HelmActionDo;
  /** Where an open action goes, resolved by the server. */
  url?: string;
}

export type HelmItemKind = "question" | "decision" | "due" | "connects" | "fyi";

export interface HelmEvidence {
  label: string;
  target: HelmTarget;
  url?: string;
}

export interface HelmBriefItem {
  id: string;
  kind: HelmItemKind;
  bridge: string;
  title: string;
  recommendation: string;
  why?: string;
  evidence: HelmEvidence[];
  actions: HelmAction[];
  /** Where "Answer…" sends free text: a question waiting for a typed answer, or a conversation. */
  reply?: { bridge: string; sessionId: string; requestId?: string };
  /** Link to open, resolved by the server. */
  url?: string;
}

export interface HelmProposal {
  id: string;
  text: string;
  actions: HelmAction[];
}

export interface HelmWatching {
  text: string;
  bridge: string;
  taskId?: string;
  url?: string;
}

export interface HelmBrief {
  summary: string;
  items: HelmBriefItem[];
  proposals: HelmProposal[];
  watching: HelmWatching[];
}

/** "pending" while a clicked action is being carried out, so it can only run once. */
export type HelmItemStatus = "open" | "pending" | "done" | "dismissed";

export interface HelmItemState {
  itemId: string;
  status: HelmItemStatus;
  outcome: string | null;
  updatedAt: string;
}

export interface HelmHandledView {
  id: string;
  kind: "mark_read";
  bridge: string;
  sessionId: string;
  title: string;
  why: string;
  at: string;
  undoneAt: string | null;
  url?: string;
}

export interface HelmMemoryChange {
  op: "added" | "updated" | "removed" | "proposed" | "confirmed";
  kind: HelmMemoryKind;
  text: string;
}

export interface HelmBriefResponse {
  run: HelmRunView | null;
  brief: HelmBrief | null;
  itemStates: Record<string, HelmItemState>;
  handled: HelmHandledView[];
  changes: HelmMemoryChange[];
  /** Rules and priorities Helm proposed that Tim has not kept or forgotten yet. */
  proposed: HelmMemoryEntry[];
  running: HelmRunView | null;
  lastFailure: HelmRunView | null;
  nextRunAt: string | null;
  /** Things this Bridge noticed after the brief was written. */
  since: { questions: number; replies: number };
  settings: HelmThinkerSettings;
  /** True in a staged preview: no scheduled runs, no changes to peer Bridges. */
  preview: boolean;
}

export type HelmAutonomy = "propose" | "routine";

export interface HelmPeer {
  id: string;
  label: string;
  /** Base URL of the peer Bridge's API, e.g. http://100.x.y.z:3333 */
  apiUrl: string;
  /** Where links to the peer open, e.g. https://pc.example.ts.net */
  webUrl: string;
}

export interface HelmThinkerSettings {
  enabled: boolean;
  /** Local times, "HH:MM". */
  times: string[];
  autonomy: HelmAutonomy;
  peers: HelmPeer[];
  /** Day of the week (0 = Sunday) whose last scheduled run re-reads everything. */
  rebuildWeekday: number;
  /** This Bridge's name in briefs. */
  label: string;
}

export const HELM_THINKER_DEFAULTS: HelmThinkerSettings = {
  enabled: true,
  times: ["08:00", "18:00"],
  autonomy: "routine",
  peers: [],
  rebuildWeekday: 0,
  label: "This Bridge",
};

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const PEER_ID_RE = /^[a-z0-9][a-z0-9-]{0,30}$/;

function fail(message: string): never {
  throw new Error(message);
}

function validUrl(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length > 300) fail(`${field} must be a URL`);
  let url: URL;
  try { url = new URL(value); } catch { fail(`${field} must be a URL`); }
  if (url.protocol !== "http:" && url.protocol !== "https:") fail(`${field} must use http or https`);
  if (url.username || url.password) fail(`${field} must not contain credentials`);
  return url.origin + url.pathname.replace(/\/+$/, "");
}

/** Validates a settings patch. Throws with a user-facing message. */
export function validateHelmThinkerSettingsPatch(input: unknown): Partial<HelmThinkerSettings> {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("Settings must be an object");
  const raw = input as Record<string, unknown>;
  const patch: Partial<HelmThinkerSettings> = {};
  for (const key of Object.keys(raw)) {
    if (!(key in HELM_THINKER_DEFAULTS)) fail(`Unknown setting: ${key}`);
  }
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== "boolean") fail("enabled must be true or false");
    patch.enabled = raw.enabled;
  }
  if (raw.times !== undefined) {
    if (!Array.isArray(raw.times) || raw.times.length > 6) fail("times must be a list of up to 6 times");
    const times = [...new Set(raw.times.map((time) => {
      if (typeof time !== "string" || !TIME_RE.test(time.trim())) fail("Each time must look like 08:00");
      return time.trim();
    }))].sort();
    patch.times = times;
  }
  if (raw.autonomy !== undefined) {
    if (raw.autonomy !== "propose" && raw.autonomy !== "routine") fail("autonomy must be propose or routine");
    patch.autonomy = raw.autonomy;
  }
  if (raw.rebuildWeekday !== undefined) {
    if (typeof raw.rebuildWeekday !== "number" || !Number.isInteger(raw.rebuildWeekday) || raw.rebuildWeekday < -1 || raw.rebuildWeekday > 6) {
      fail("rebuildWeekday must be 0–6, or -1 for never");
    }
    patch.rebuildWeekday = raw.rebuildWeekday;
  }
  if (raw.label !== undefined) {
    if (typeof raw.label !== "string" || !raw.label.trim() || raw.label.length > 40) fail("label must be a short name");
    patch.label = raw.label.trim();
  }
  if (raw.peers !== undefined) {
    if (!Array.isArray(raw.peers) || raw.peers.length > 4) fail("peers must be a list of up to 4 Bridges");
    const seen = new Set<string>(["local"]);
    patch.peers = raw.peers.map((peer, index) => {
      if (!peer || typeof peer !== "object") fail(`Peer ${index + 1} must be an object`);
      const value = peer as Record<string, unknown>;
      const id = typeof value.id === "string" ? value.id.trim().toLowerCase() : "";
      if (!PEER_ID_RE.test(id)) fail(`Peer ${index + 1} needs a short id (letters, digits, dashes)`);
      if (seen.has(id)) fail(`Peer id ${id} is used twice`);
      seen.add(id);
      const label = typeof value.label === "string" && value.label.trim() ? value.label.trim().slice(0, 40) : id;
      return { id, label, apiUrl: validUrl(value.apiUrl, `Peer ${id} API URL`), webUrl: validUrl(value.webUrl ?? value.apiUrl, `Peer ${id} web URL`) };
    });
  }
  return patch;
}

/** The next scheduled time after `from`, in the server's local time. */
export function nextScheduledRun(times: readonly string[], from: Date): Date | null {
  let best: Date | null = null;
  for (const time of times) {
    const match = TIME_RE.exec(time);
    if (!match) continue;
    const candidate = new Date(from);
    candidate.setHours(Number(match[1]), Number(match[2]), 0, 0);
    if (candidate.getTime() <= from.getTime()) candidate.setDate(candidate.getDate() + 1);
    if (!best || candidate < best) best = candidate;
  }
  return best;
}

/** The latest scheduled time at or before `from`. */
export function previousScheduledRun(times: readonly string[], from: Date): Date | null {
  let best: Date | null = null;
  for (const time of times) {
    const match = TIME_RE.exec(time);
    if (!match) continue;
    const candidate = new Date(from);
    candidate.setHours(Number(match[1]), Number(match[2]), 0, 0);
    if (candidate.getTime() > from.getTime()) candidate.setDate(candidate.getDate() - 1);
    if (!best || candidate > best) best = candidate;
  }
  return best;
}

/** True when `at` is the last scheduled slot of the rebuild weekday. */
export function isRebuildSlot(times: readonly string[], at: Date, rebuildWeekday: number): boolean {
  if (rebuildWeekday < 0 || at.getDay() !== rebuildWeekday) return false;
  const last = [...times].filter((time) => TIME_RE.test(time)).sort().at(-1);
  if (!last) return false;
  const [hours, minutes] = last.split(":").map(Number);
  return at.getHours() === hours && at.getMinutes() === minutes;
}
