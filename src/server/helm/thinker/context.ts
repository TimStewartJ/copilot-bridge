// The packet a thinker run starts from: its memory, what Tim said about the last brief, and what
// each Bridge looks like now, with everything that changed since the last finished run marked.
// It also records exactly which conversations, questions, checklist items and tasks the run was
// shown, so a published action can only point at something real.
import type { HomeInputSummary, HomePage, HomeSection, HomeSnapshot } from "../../../shared/home.js";
import type { TaskOverviewRow } from "../../../shared/task-overview.js";
import { HELM_STALE_AFTER_DAYS, type HelmBridgeStatus, type HelmMemoryEntry } from "../../../shared/helm-thinker.js";
import type { HelmFeedbackRecord } from "./store.js";
import type { HelmSource, SourceSession } from "./sources.js";
import { mapWithConcurrency } from "../../map-with-concurrency.js";

export interface PacketQuestion {
  sessionId: string;
  requestId: string;
  kind: "user_input" | "elicitation";
  question: string;
  choices?: string[];
  allowFreeform?: boolean;
  /** Only native questions with known choices or free text can be answered from a card. */
  answerable: boolean;
  conversation: string;
  taskId?: string;
  task?: string;
  askedAt?: string;
  /** Further questions the same conversation is waiting on, after this one. */
  morePending?: number;
}

export interface PacketReply {
  sessionId: string;
  conversation: string;
  taskId?: string;
  task?: string;
  at?: string;
  /** The conversation's activity when the packet was made: marking it read never goes past this. */
  activityAt: string | null;
  excerpt?: string;
  automated?: boolean;
}

export interface PacketDue {
  actionId: string;
  text: string;
  deadline?: string;
  taskId?: string;
  task?: string;
}

export interface PacketTask {
  taskId: string;
  title: string;
  state?: string;
  reasons?: string[];
  nextAction?: string;
  waitingOn?: string;
  nextTouchAt?: string;
  lastEngagedAt?: string;
  idleDays?: number | null;
  group?: string;
  agentWorking?: boolean;
  changed: boolean;
  /** Helm's existing thread line for this task, if any. */
  thread?: string;
}

export interface PacketBridge {
  id: string;
  label: string;
  ok: boolean;
  error?: string;
  questions: PacketQuestion[];
  replies: PacketReply[];
  due: PacketDue[];
  tasks: PacketTask[];
  working: Array<{ sessionId: string; conversation: string; task?: string }>;
  /** What did not fit in the packet, so the run knows its view is partial. */
  omitted: { questions: number; replies: number; due: number; tasks: number };
  /** Conversations Helm may link to or message: everything listed plus every active conversation. */
  sessionIds: Set<string>;
}

/** An outside source the run may read through read_source, as the model sees it. */
export interface PacketSource {
  name: string;
  ok: boolean;
  error?: string;
  /** When a look that published last read it; null when none has. */
  lastReadAt: string | null;
  tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>;
}

export interface ThinkerPacket {
  now: string;
  timezone: string;
  trigger: string;
  rebuild: boolean;
  lastRunAt: string | null;
  bridges: PacketBridge[];
  memory: HelmMemoryEntry[];
  feedback: HelmFeedbackRecord[];
  previousItems: Array<{ title: string; status: string; outcome: string | null }>;
  outsideSources: PacketSource[];
}

const MAX_TASKS_PER_BRIDGE = 250;
/** Home pages hold 20; read up to this many of each kind. */
const MAX_SECTION_ITEMS = 100;
const MAX_PACKET_CHARS = 90_000;

function clip(text: string | undefined | null, max: number): string | undefined {
  if (!text) return undefined;
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function after(iso: string | null | undefined, watermark: string | null): boolean {
  if (!iso) return false;
  if (!watermark) return true;
  return Date.parse(iso) > Date.parse(watermark);
}

async function readBridge(source: HelmSource, options: { watermark: string | null; rebuild: boolean; threads: Map<string, string> }): Promise<PacketBridge> {
  async function pages<T>(section: HomeSection, pick: (snapshot: HomeSnapshot) => HomePage<T>): Promise<{ items: T[]; total: number }> {
    const items: T[] = [];
    let total = 0;
    for (let offset = 0; offset < MAX_SECTION_ITEMS; offset += 20) {
      const page = pick(await source.snapshot(section, offset));
      items.push(...page.items);
      total = page.total ?? items.length;
      if (!page.hasMore || page.items.length === 0) break;
    }
    return { items: items.slice(0, MAX_SECTION_ITEMS), total: Math.max(total, items.length) };
  }
  const [sessions, inputs, replies, actions, overview] = await Promise.all([
    source.sessions(),
    pages("inputs", (snapshot) => snapshot.inputs),
    pages("replies", (snapshot) => snapshot.replies),
    pages("actions", (snapshot) => snapshot.actions),
    source.overview(),
  ]);
  const active = sessions.filter((session) => !session.archived);
  const byId = new Map<string, SourceSession>(active.map((session) => [session.sessionId, session]));
  const taskActivity = new Map<string, string>();
  for (const session of active) {
    if (!session.lastActivityAt) continue;
    for (const taskId of session.linkedTaskIds) {
      const previous = taskActivity.get(taskId);
      if (!previous || Date.parse(session.lastActivityAt) > Date.parse(previous)) taskActivity.set(taskId, session.lastActivityAt);
    }
  }

  const questions = await mapWithConcurrency(inputs.items, 4, async (item: HomeInputSummary): Promise<PacketQuestion> => {
    const base = {
      sessionId: item.sessionId, requestId: item.requestId, kind: item.kind, conversation: item.title,
      ...(item.taskId ? { taskId: item.taskId, task: item.taskTitle } : {}), ...(item.requestedAt ? { askedAt: item.requestedAt } : {}),
      ...(item.pendingCount > 1 ? { morePending: item.pendingCount - 1 } : {}),
    };
    try {
      const detail = await source.input(item.sessionId, item.kind, item.requestId);
      if (detail?.kind === "user_input") {
        const request = detail.request as { question?: string; choices?: string[]; allowFreeform?: boolean };
        const choices = Array.isArray(request.choices) ? request.choices.filter((choice) => typeof choice === "string") : [];
        const allowFreeform = request.allowFreeform !== false;
        return { ...base, question: clip(request.question ?? item.question, 1500)!, ...(choices.length ? { choices } : {}), allowFreeform, answerable: choices.length > 0 || allowFreeform };
      }
    } catch {
      // Detail unavailable: show the question, but no answer button.
    }
    return { ...base, question: clip(item.question, 1500)!, answerable: false };
  });

  const packetReplies: PacketReply[] = replies.items.map((reply) => {
    const session = byId.get(reply.sessionId);
    return {
      sessionId: reply.sessionId, conversation: reply.title,
      ...(reply.taskId ? { taskId: reply.taskId, task: reply.taskTitle } : {}),
      ...(reply.timestamp ? { at: reply.timestamp } : {}),
      activityAt: session?.lastActivityAt ?? null,
      ...(reply.excerpt ? { excerpt: clip(reply.excerpt, 600) } : {}),
      ...(session?.triggeredBy ? { automated: true } : {}),
    };
  });

  const due: PacketDue[] = actions.items.map((action) => ({
    actionId: action.id, text: clip(action.text, 300)!, ...(action.deadline ? { deadline: action.deadline } : {}),
    ...(action.taskId ? { taskId: action.taskId, task: action.taskTitle } : {}),
  }));

  const rows: TaskOverviewRow[] = overview.tasks.filter((row) => !row.muted);
  const tasks: PacketTask[] = rows.slice(0, MAX_TASKS_PER_BRIDGE).map((row) => {
    const thread = options.threads.get(`${source.id}:${row.id}`);
    const changed = options.rebuild || !thread || row.state === "needs_you"
      || after(row.lastEngagedAt, options.watermark) || after(taskActivity.get(row.id), options.watermark);
    return changed
      ? {
        taskId: row.id, title: row.title, state: row.state, ...(row.reasons.length ? { reasons: row.reasons } : {}),
        ...(row.nextAction ? { nextAction: clip(row.nextAction, 300) } : {}), ...(row.waitingOn ? { waitingOn: clip(row.waitingOn, 200) } : {}),
        ...(row.nextTouchAt ? { nextTouchAt: row.nextTouchAt } : {}), ...(row.lastEngagedAt ? { lastEngagedAt: row.lastEngagedAt } : {}),
        idleDays: row.idleDays, ...(row.groupName ? { group: row.groupName } : {}), ...(row.busyCount > 0 ? { agentWorking: true } : {}),
        changed: true, ...(thread ? { thread } : {}),
      }
      : { taskId: row.id, title: row.title, state: row.state, changed: false, thread };
  });

  const working = active.filter((session) => session.runState !== "idle" && !session.needsUserInput).slice(0, 15).map((session) => ({
    sessionId: session.sessionId, conversation: session.title,
    ...(session.linkedTaskIds[0] ? { task: rows.find((row) => row.id === session.linkedTaskIds[0])?.title } : {}),
  }));

  const sessionIds = new Set<string>([
    ...active.map((session) => session.sessionId),
    ...questions.map((question) => question.sessionId),
    ...packetReplies.map((reply) => reply.sessionId),
  ]);
  const omitted = {
    questions: Math.max(0, inputs.total - questions.length),
    replies: Math.max(0, replies.total - packetReplies.length),
    due: Math.max(0, actions.total - due.length),
    tasks: Math.max(0, rows.length - tasks.length),
  };
  return { id: source.id, label: source.label, ok: true, questions, replies: packetReplies, due, tasks, working, omitted, sessionIds };
}

/** One Bridge as Helm's chat reads it: what waits on Tim, what is running, and every task, compactly. */
export interface ChatBridgeView {
  bridge: string;
  label: string;
  questions: Array<{ sessionId: string; conversation: string; question: string; choices?: string[]; task?: string; askedAt?: string }>;
  replies: Array<{ sessionId: string; conversation: string; excerpt?: string; task?: string; at?: string; automated?: boolean }>;
  due: Array<{ text: string; deadline?: string; task?: string }>;
  working: Array<{ sessionId: string; conversation: string; task?: string }>;
  tasks: Array<{ taskId: string; title: string; state?: string; nextAction?: string; waitingOn?: string; idleDays?: number | null }>;
  omitted?: { questions: number; replies: number; due: number; tasks: number };
}

const MAX_CHAT_TASKS = 150;
/** Keeps one read_bridge result to a size the chat can take in at once. */
const MAX_CHAT_BRIDGE_CHARS = 40_000;

export async function readBridgeForChat(source: HelmSource): Promise<ChatBridgeView> {
  const bridge = await readBridge(source, { watermark: null, rebuild: true, threads: new Map() });
  const omitted = { ...bridge.omitted, tasks: bridge.omitted.tasks + Math.max(0, bridge.tasks.length - MAX_CHAT_TASKS) };
  const view = chatBridgeView(bridge);
  // Over budget: drop tasks from the end of the list first, then the last replies, and say how many.
  while (JSON.stringify(view).length > MAX_CHAT_BRIDGE_CHARS && (view.tasks.length > 20 || view.replies.length > 10)) {
    if (view.tasks.length > 20) { view.tasks.pop(); omitted.tasks++; } else { view.replies.pop(); omitted.replies++; }
  }
  if (Object.values(omitted).some(Boolean)) view.omitted = omitted;
  return view;
}

function chatBridgeView(bridge: PacketBridge): ChatBridgeView {
  return {
    bridge: bridge.id,
    label: bridge.label,
    questions: bridge.questions.map((question) => ({
      sessionId: question.sessionId, conversation: question.conversation, question: question.question,
      ...(question.choices ? { choices: question.choices } : {}), ...(question.task ? { task: question.task } : {}), ...(question.askedAt ? { askedAt: question.askedAt } : {}),
    })),
    replies: bridge.replies.map((reply) => ({
      sessionId: reply.sessionId, conversation: reply.conversation,
      ...(reply.excerpt ? { excerpt: reply.excerpt } : {}), ...(reply.task ? { task: reply.task } : {}), ...(reply.at ? { at: reply.at } : {}), ...(reply.automated ? { automated: true } : {}),
    })),
    due: bridge.due.map((item) => ({ text: item.text, ...(item.deadline ? { deadline: item.deadline } : {}), ...(item.task ? { task: item.task } : {}) })),
    working: bridge.working,
    tasks: bridge.tasks.slice(0, MAX_CHAT_TASKS).map((task) => ({
      taskId: task.taskId, title: task.title, ...(task.state ? { state: task.state } : {}),
      ...(task.nextAction ? { nextAction: clip(task.nextAction, 160) } : {}), ...(task.waitingOn ? { waitingOn: clip(task.waitingOn, 120) } : {}),
      ...(task.idleDays !== undefined ? { idleDays: task.idleDays } : {}),
    })),
  };
}

export async function buildThinkerPacket(input: {
  sources: HelmSource[];
  now: Date;
  trigger: string;
  rebuild: boolean;
  lastRunAt: string | null;
  memory: HelmMemoryEntry[];
  feedback: HelmFeedbackRecord[];
  previousItems: ThinkerPacket["previousItems"];
  outsideSources?: PacketSource[];
}): Promise<ThinkerPacket> {
  const threads = new Map(input.memory.filter((entry) => entry.kind === "thread" && entry.key && entry.status === "active").map((entry) => [entry.key!, entry.text]));
  const bridges = await Promise.all(input.sources.map(async (source): Promise<PacketBridge> => {
    try {
      return await readBridge(source, { watermark: input.lastRunAt, rebuild: input.rebuild, threads });
    } catch (error) {
      return {
        id: source.id, label: source.label, ok: false, error: error instanceof Error ? error.message : String(error),
        questions: [], replies: [], due: [], tasks: [], working: [], omitted: { questions: 0, replies: 0, due: 0, tasks: 0 }, sessionIds: new Set(),
      };
    }
  }));
  return {
    now: input.now.toISOString(),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    trigger: input.trigger,
    rebuild: input.rebuild,
    lastRunAt: input.lastRunAt,
    bridges,
    memory: input.memory,
    feedback: input.feedback,
    previousItems: input.previousItems,
    outsideSources: input.outsideSources ?? [],
  };
}

export function bridgeStatuses(packet: ThinkerPacket): HelmBridgeStatus[] {
  return packet.bridges.map((bridge) => ({ id: bridge.id, label: bridge.label, ok: bridge.ok, ...(bridge.error ? { error: bridge.error } : {}) }));
}

export function countChanges(packet: ThinkerPacket): number {
  return packet.bridges.reduce((sum, bridge) => sum + bridge.tasks.filter((task) => task.changed).length + bridge.questions.length + bridge.replies.length, 0);
}

/** The packet as the model reads it. Unchanged tasks are one line; long packets lose unchanged tasks first. */
export function renderThinkerPacket(packet: ThinkerPacket): string {
  const nowMs = Date.parse(packet.now);
  const stale = (entry: HelmMemoryEntry) => nowMs - Date.parse(entry.confirmedAt) > HELM_STALE_AFTER_DAYS * 86_400_000;
  const memory = packet.memory.filter((entry) => entry.status !== "forgotten").map((entry) => ({
    id: entry.id, kind: entry.kind, ...(entry.key ? { key: entry.key } : {}), text: entry.text, author: entry.author,
    ...(entry.status === "proposed" ? { proposed: true } : {}), ...(stale(entry) ? { stale: true } : {}),
    confirmed: entry.confirmedAt.slice(0, 10),
  }));
  const view = (trimUnchanged: boolean) => ({
    now: packet.now,
    timezone: packet.timezone,
    trigger: packet.trigger,
    rebuild: packet.rebuild,
    lastRunAt: packet.lastRunAt,
    memory: memory.filter((entry) => entry.kind !== "thread"),
    feedbackSinceLastBrief: packet.feedback.map((feedback) => ({ item: feedback.itemTitle, kind: feedback.kind, ...(feedback.note ? { note: feedback.note } : {}), at: feedback.at })),
    lastBriefItems: packet.previousItems,
    ...(packet.outsideSources.length ? {
      outsideSources: packet.outsideSources.map((source) => source.ok
        ? { source: source.name, lastReadAt: source.lastReadAt, tools: source.tools, ...(source.error ? { note: source.error } : {}) }
        : { source: source.name, unavailable: source.error ?? "unavailable" }),
    } : {}),
    bridges: packet.bridges.map((bridge) => bridge.ok
      ? {
        bridge: bridge.id, label: bridge.label,
        questions: bridge.questions, unreadReplies: bridge.replies, checklistDue: bridge.due, agentsWorking: bridge.working,
        tasks: bridge.tasks.filter((task) => task.changed || !trimUnchanged).map((task) => task.changed ? task : { taskId: task.taskId, title: task.title, state: task.state, thread: task.thread }),
        ...(trimUnchanged ? { unchangedTasksOmitted: bridge.tasks.filter((task) => !task.changed).length } : {}),
        ...(Object.values(bridge.omitted).some((count) => count > 0) ? { notShownHere: bridge.omitted } : {}),
      }
      : { bridge: bridge.id, label: bridge.label, unavailable: bridge.error }),
    threadsForTasksNoLongerListed: memory.filter((entry) => entry.kind === "thread" && entry.key
      && packet.bridges.some((bridge) => bridge.ok && entry.key!.startsWith(`${bridge.id}:`))
      && !packet.bridges.some((bridge) => bridge.tasks.some((task) => `${bridge.id}:${task.taskId}` === entry.key))),
  });
  let text = JSON.stringify(view(false));
  if (text.length > MAX_PACKET_CHARS) text = JSON.stringify(view(true));
  return text;
}
