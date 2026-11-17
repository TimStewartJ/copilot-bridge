// Validates a thinker publication all-or-nothing; the first valid one is final.
import {
  HELM_ENTRY_MAX_CHARS,
  HELM_THREAD_OWNERS,
  HELM_REMOVED_SOURCE,
  HELM_MEMORY_LIMITS,
  HELM_PICTURE_MAX_WORDS,
  type HelmAction,
  type HelmActionDo,
  type HelmBrief,
  type HelmBriefItem,
  type HelmEvidence,
  type HelmItemKind,
  type HelmMemoryEntry,
  type HelmMemoryKind,
  type HelmProposal,
  type HelmThreadOwner,
  type HelmWatching,
} from "../../../shared/helm-thinker.js";
import { validateTaskStarters, type TaskStarterDraft } from "../../../shared/task-starters.js";
import type { PacketBridge, ThinkerPacket } from "./context.js";
import { formatDay, localDateKey } from "../attention.js";
import { isRecord } from "../../../shared/is-record.js";

// helm_publish states these limits in its tool descriptions, so a run sees them before it writes.
export const MAX_ITEMS = 6;
export const MAX_EVIDENCE = 4;
export const MAX_PROPOSALS = 5;
export const MAX_WATCHING = 10;
export const MAX_HANDLED = 30;
export const MAX_ACTIONS = 3;
/** Tasks one look may write suggested chats for. */
export const MAX_STARTER_TASKS = 12;
export const MAX_CHARS = {
  summary: 700,
  title: 160,
  recommendation: 600,
  why: 400,
  evidenceLabel: 120,
  actionLabel: 60,
  answer: 1500,
  message: 2000,
  proposal: 400,
  watching: 300,
  handledWhy: 200,
} as const;
const ITEM_KINDS: HelmItemKind[] = ["question", "decision", "due", "connects", "fyi"];

export type MemoryOp =
  /** from: names of the outside sources the entry cites (threads, people and dates). */
  | {
    op: "upsert"; kind: HelmMemoryKind; key: string; text: string; source: string | null; from?: string[];
    /** Threads: whose move it is, how long Helm holds off, and the fields it was written from. */
    owner?: HelmThreadOwner; holdUntil?: string | null; basis?: string;
  }
  | { op: "propose"; kind: "rule" | "priority"; text: string; source: string | null }
  | { op: "confirm"; id: string }
  | { op: "drop"; id: string };

export interface HandledPlan {
  bridge: string;
  sessionId: string;
  title: string;
  why: string;
  activityAt: string;
}

export interface StarterPlan {
  taskId: string;
  chats: TaskStarterDraft[];
}

export type PublicationResult =
  | { ok: true; brief: HelmBrief; handled: HandledPlan[]; memory: MemoryOp[]; starters: StarterPlan[] }
  | { ok: false; errors: string[] };

function text(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? undefined : trimmed;
}

export function normalizeChoice(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

/** The fields of a published object; anything else reads as having none. */
function fieldsOf(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function words(value: string): number {
  return value.split(/\s+/).filter(Boolean).length;
}

export function validatePublication(raw: unknown, packet: ThinkerPacket, memory: readonly HelmMemoryEntry[]): PublicationResult {
  const errors: string[] = [];
  const input = raw && typeof raw === "object" ? raw as Record<string, unknown> : {};
  const bridges = new Map(packet.bridges.filter((bridge) => bridge.ok).map((bridge) => [bridge.id, bridge]));
  const bridgeOf = (id: unknown, where: string): PacketBridge | undefined => {
    const bridge = typeof id === "string" ? bridges.get(id) : undefined;
    if (!bridge) errors.push(`${where}: bridge must be one of ${[...bridges.keys()].join(", ") || "(none available)"}`);
    return bridge;
  };

  const summary = text(input.summary, MAX_CHARS.summary);
  if (!summary) errors.push(`summary is required (at most ${MAX_CHARS.summary} characters)`);

  const parseAction = (value: unknown, bridge: PacketBridge, where: string, index: number): HelmAction | undefined => {
    const rawAction = fieldsOf(value);
    const label = text(rawAction.label, MAX_CHARS.actionLabel);
    if (!label) { errors.push(`${where}: label is required (at most ${MAX_CHARS.actionLabel} characters)`); return undefined; }
    const type = rawAction.type;
    let action: HelmActionDo | undefined;
    if (type === "answer") {
      const question = bridge.questions.find((candidate) => candidate.sessionId === rawAction.sessionId && candidate.requestId === rawAction.requestId);
      const answer = text(rawAction.answer, MAX_CHARS.answer);
      if (!question) errors.push(`${where}: answer needs the sessionId and requestId of a question listed for ${bridge.id}`);
      else if (!question.answerable || question.kind !== "user_input") errors.push(`${where}: that question can't be answered from Home; use an open action instead`);
      else if (!answer) errors.push(`${where}: answer text is required`);
      else {
        const choice = question.choices?.find((candidate) => normalizeChoice(candidate) === normalizeChoice(answer));
        if (!choice && question.allowFreeform === false) errors.push(`${where}: the answer must be one of: ${question.choices?.join(" | ")}`);
        else action = { type: "answer", bridge: bridge.id, sessionId: question.sessionId, requestId: question.requestId, answer: choice ?? answer, wasFreeform: !choice };
      }
    } else if (type === "send") {
      const message = text(rawAction.message, MAX_CHARS.message);
      if (typeof rawAction.sessionId !== "string" || !bridge.sessionIds.has(rawAction.sessionId)) errors.push(`${where}: send needs the sessionId of a conversation listed for ${bridge.id}`);
      else if (!message) errors.push(`${where}: message is required (at most ${MAX_CHARS.message} characters)`);
      else action = { type: "send", bridge: bridge.id, sessionId: rawAction.sessionId, message };
    } else if (type === "tick") {
      const due = bridge.due.find((candidate) => candidate.actionId === rawAction.actionId);
      if (!due) errors.push(`${where}: tick needs the actionId of a checklist item listed for ${bridge.id}`);
      else action = { type: "tick", bridge: bridge.id, actionId: due.actionId };
    } else if (type === "close_tasks") {
      const ids = Array.isArray(rawAction.taskIds) ? rawAction.taskIds.filter((id: unknown): id is string => typeof id === "string") : [];
      if (bridge.id !== "local") errors.push(`${where}: close_tasks only works for tasks on bridge "local"; propose opening the task instead`);
      else if (ids.length === 0 || ids.length > 10 || ids.some((id) => !bridge.tasks.some((task) => task.taskId === id))) errors.push(`${where}: close_tasks needs 1–10 taskIds listed for local`);
      else action = { type: "close_tasks", bridge: bridge.id, taskIds: [...new Set(ids)] };
    } else if (type === "tidy_task") {
      const task = bridge.tasks.find((candidate) => candidate.taskId === rawAction.taskId);
      if (bridge.id !== "local") errors.push(`${where}: tidy_task only works for tasks on bridge "local"`);
      else if (!task?.tidy?.length) errors.push(`${where}: tidy_task needs the taskId of a local task listed with tidy signs`);
      else action = { type: "tidy_task", bridge: bridge.id, taskId: task.taskId };
    } else if (type === "open") {
      const sessionId = typeof rawAction.sessionId === "string" && bridge.sessionIds.has(rawAction.sessionId) ? rawAction.sessionId : undefined;
      const taskId = typeof rawAction.taskId === "string" && bridge.tasks.some((task) => task.taskId === rawAction.taskId) ? rawAction.taskId : undefined;
      if (sessionId === undefined && taskId === undefined) errors.push(`${where}: open needs a sessionId or taskId listed for ${bridge.id}`);
      else action = { type: "open", bridge: bridge.id, ...(sessionId !== undefined ? { sessionId } : { taskId }) };
    } else {
      errors.push(`${where}: type must be answer, send, tick, close_tasks, tidy_task or open`);
    }
    return action ? { id: `a${index + 1}`, label, ...(rawAction.primary === true ? { primary: true } : {}), do: action } : undefined;
  };

  const parseActions = (rawActions: unknown, bridge: PacketBridge, where: string): HelmAction[] => {
    if (rawActions === undefined) return [];
    if (!Array.isArray(rawActions) || rawActions.length > MAX_ACTIONS) { errors.push(`${where}: actions must be a list of at most ${MAX_ACTIONS}`); return []; }
    const actions = rawActions.flatMap((rawAction, index) => parseAction(rawAction, bridge, `${where} action ${index + 1}`, index) ?? []);
    if (actions.filter((action) => action.primary).length > 1) errors.push(`${where}: at most one action can be primary`);
    return actions;
  };

  const parseEvidence = (rawEvidence: unknown, bridge: PacketBridge, where: string): HelmEvidence[] => {
    if (rawEvidence === undefined) return [];
    if (!Array.isArray(rawEvidence) || rawEvidence.length > MAX_EVIDENCE) { errors.push(`${where}: evidence must be a list of at most ${MAX_EVIDENCE}`); return []; }
    return rawEvidence.flatMap((value: unknown, index) => {
      const entry = fieldsOf(value);
      const label = text(entry.label, MAX_CHARS.evidenceLabel);
      const sessionId = typeof entry.sessionId === "string" && bridge.sessionIds.has(entry.sessionId) ? entry.sessionId : undefined;
      const taskId = typeof entry.taskId === "string" && bridge.tasks.some((task) => task.taskId === entry.taskId) ? entry.taskId : undefined;
      if (!label || (sessionId === undefined && taskId === undefined)) {
        errors.push(`${where} evidence ${index + 1}: needs a label and a sessionId or taskId listed for ${bridge.id}`);
        return [];
      }
      return [{ label, target: { bridge: bridge.id, ...(sessionId !== undefined ? { sessionId } : { taskId }) } }];
    });
  };

  const items: HelmBriefItem[] = [];
  if (!Array.isArray(input.items) || input.items.length > MAX_ITEMS) errors.push(`items must be a list of at most ${MAX_ITEMS}`);
  else input.items.forEach((value: unknown, index: number) => {
    const rawItem = fieldsOf(value);
    const where = `item ${index + 1}`;
    const bridge = bridgeOf(rawItem.bridge, where);
    const title = text(rawItem.title, MAX_CHARS.title);
    const recommendation = text(rawItem.recommendation, MAX_CHARS.recommendation);
    const kind = ITEM_KINDS.find((candidate) => candidate === rawItem.kind);
    if (!title) errors.push(`${where}: title is required (at most ${MAX_CHARS.title} characters)`);
    if (!recommendation) errors.push(`${where}: recommendation is required (at most ${MAX_CHARS.recommendation} characters)`);
    if (!kind) errors.push(`${where}: kind must be one of ${ITEM_KINDS.join(", ")}`);
    if (!bridge || !title || !recommendation || !kind) return;
    const why = rawItem.why === undefined ? undefined : text(rawItem.why, MAX_CHARS.why);
    if (rawItem.why !== undefined && !why) errors.push(`${where}: why must be at most ${MAX_CHARS.why} characters`);
    let reply: HelmBriefItem["reply"];
    if (rawItem.replyTo !== undefined) {
      const sessionId = isRecord(rawItem.replyTo) ? rawItem.replyTo.sessionId : undefined;
      if (typeof sessionId !== "string" || !bridge.sessionIds.has(sessionId)) errors.push(`${where}: replyTo needs a sessionId listed for ${bridge.id}`);
      else {
        const question = bridge.questions.find((candidate) => candidate.sessionId === sessionId && candidate.answerable && candidate.kind === "user_input" && candidate.allowFreeform !== false);
        reply = { bridge: bridge.id, sessionId, ...(question ? { requestId: question.requestId } : {}) };
      }
    }
    let source: string | undefined;
    if (rawItem.source !== undefined) {
      if (typeof rawItem.source === "string" && packet.outsideSources.some((candidate) => candidate.ok && candidate.name === rawItem.source)) source = rawItem.source;
      else errors.push(`${where}: source must be the name of a source listed under outsideSources, or left out`);
    }
    items.push({
      id: `i${index + 1}`, kind, bridge: bridge.id, title, recommendation, ...(why ? { why } : {}), ...(source ? { source } : {}),
      evidence: parseEvidence(rawItem.evidence, bridge, where),
      actions: parseActions(rawItem.actions, bridge, where),
      ...(reply ? { reply } : {}),
    });
  });

  const proposals: HelmProposal[] = [];
  if (input.proposals !== undefined && (!Array.isArray(input.proposals) || input.proposals.length > MAX_PROPOSALS)) errors.push(`proposals must be a list of at most ${MAX_PROPOSALS}`);
  else (input.proposals ?? []).forEach((value: unknown, index: number) => {
    const rawProposal = fieldsOf(value);
    const where = `proposal ${index + 1}`;
    const bridge = bridgeOf(rawProposal.bridge, where);
    const proposalText = text(rawProposal.text, MAX_CHARS.proposal);
    if (!proposalText) errors.push(`${where}: text is required (at most ${MAX_CHARS.proposal} characters)`);
    if (!bridge || !proposalText) return;
    proposals.push({ id: `p${index + 1}`, text: proposalText, actions: parseActions(rawProposal.actions, bridge, where) });
  });

  const watching: HelmWatching[] = [];
  if (input.watching !== undefined && (!Array.isArray(input.watching) || input.watching.length > MAX_WATCHING)) errors.push(`watching must be a list of at most ${MAX_WATCHING}`);
  else (input.watching ?? []).forEach((value: unknown, index: number) => {
    const rawWatch = fieldsOf(value);
    const where = `watching ${index + 1}`;
    const bridge = bridgeOf(rawWatch.bridge, where);
    const watchText = text(rawWatch.text, MAX_CHARS.watching);
    if (!watchText) errors.push(`${where}: text is required (at most ${MAX_CHARS.watching} characters)`);
    if (!bridge || !watchText) return;
    const task = typeof rawWatch.taskId === "string" ? bridge.tasks.find((candidate) => candidate.taskId === rawWatch.taskId) : undefined;
    // Watching is for what waits on others; live fields decide that, not Helm's thread line.
    if (task?.onUser === "fields") {
      errors.push(`${where}: "${task.title}" waits on no one but the user: no agent is working on it and it is not waiting on anyone else${task.needsUser?.length ? ` (${task.needsUser.join("; ")})` : ""}. Don't watch it; raise it as an item, or leave it out and Home lists it under On you.`);
      return;
    }
    watching.push({ text: watchText, bridge: bridge.id, ...(task ? { taskId: task.taskId } : {}) });
  });

  const handled: HandledPlan[] = [];
  if (input.handled !== undefined && (!Array.isArray(input.handled) || input.handled.length > MAX_HANDLED)) errors.push(`handled must be a list of at most ${MAX_HANDLED}`);
  else (input.handled ?? []).forEach((value: unknown, index: number) => {
    const rawHandled = fieldsOf(value);
    const where = `handled ${index + 1}`;
    const bridge = bridgeOf(rawHandled.bridge, where);
    if (!bridge) return;
    const reply = bridge.replies.find((candidate) => candidate.sessionId === rawHandled.sessionId);
    const why = text(rawHandled.why, MAX_CHARS.handledWhy);
    if (!reply || !reply.activityAt) errors.push(`${where}: only an unread reply listed for ${bridge.id} can be marked read`);
    else if (!why) errors.push(`${where}: why is required (at most ${MAX_CHARS.handledWhy} characters)`);
    else if (bridge.questions.some((question) => question.sessionId === reply.sessionId)) errors.push(`${where}: that conversation is waiting on a question; it can't be marked read`);
    else handled.push({ bridge: bridge.id, sessionId: reply.sessionId, title: reply.task ? `${reply.task} · ${reply.conversation}` : reply.conversation, why, activityAt: reply.activityAt });
  });

  const starters: StarterPlan[] = [];
  if (input.starters !== undefined && (!Array.isArray(input.starters) || input.starters.length > MAX_STARTER_TASKS)) errors.push(`starters must be a list of at most ${MAX_STARTER_TASKS} tasks`);
  else (input.starters ?? []).forEach((value: unknown, index: number) => {
    const rawStarter = fieldsOf(value);
    const where = `starters ${index + 1}`;
    const local = bridges.get("local");
    if (rawStarter.bridge !== undefined && rawStarter.bridge !== "local") { errors.push(`${where}: starters only work for tasks on bridge "local"`); return; }
    if (!local || typeof rawStarter.taskId !== "string" || !local.tasks.some((task) => task.taskId === rawStarter.taskId)) { errors.push(`${where}: needs the taskId of a task listed for local`); return; }
    if (starters.some((plan) => plan.taskId === rawStarter.taskId)) { errors.push(`${where}: that task is listed twice`); return; }
    const checked = validateTaskStarters(rawStarter.chats, `${where} chats`);
    if (!checked.ok) errors.push(...checked.errors);
    else starters.push({ taskId: rawStarter.taskId, chats: checked.starters });
  });

  const memoryOps = validateMemory(input.memory, packet, memory, errors);
  if (errors.length > 0) return { ok: false, errors: errors.slice(0, 25) };
  return { ok: true, brief: { summary: summary!, items, proposals, watching }, handled, memory: memoryOps, starters };
}

/** Outside sources an entry cites: its from list, or a source note such as "mail: Nov 3". */
function citedSources(rawFrom: unknown, sourceNote: string | null, packet: ThinkerPacket, where: string, errors: string[]): string[] {
  // This run's sources, and those memory already cites, so a line can keep what it rests on.
  const known = new Set([...packet.outsideSources.map((source) => source.name), ...Object.values(packet.sourceNames ?? {}).filter((name) => name !== HELM_REMOVED_SOURCE)]);
  const cited = new Set<string>();
  if (rawFrom !== undefined) {
    const list = Array.isArray(rawFrom) ? rawFrom : [rawFrom];
    for (const name of list) {
      if (typeof name === "string" && known.has(name)) cited.add(name);
      else errors.push(`${where}: from must list names from outsideSources (${[...known].join(", ") || "none this run"})`);
    }
  }
  if (sourceNote) {
    const lead = sourceNote.split(":")[0]!.trim();
    if (known.has(lead)) cited.add(lead);
  }
  return [...cited];
}

function validateMemory(raw: unknown, packet: ThinkerPacket, memory: readonly HelmMemoryEntry[], errors: string[]): MemoryOp[] {
  if (raw === undefined) return [];
  if (!raw || typeof raw !== "object") { errors.push("memory must be an object"); return []; }
  const input = raw as Record<string, unknown>;
  const ops: MemoryOp[] = [];
  const live = memory.filter((entry) => entry.status !== "forgotten");
  const byId = new Map(live.map((entry) => [entry.id, entry]));
  const counts = new Map<HelmMemoryKind, number>();
  for (const entry of live) counts.set(entry.kind, (counts.get(entry.kind) ?? 0) + 1);
  const userKeys = new Set(live.filter((entry) => entry.author === "user" && entry.key).map((entry) => `${entry.kind}:${entry.key}`));
  const existingKeys = new Set(live.filter((entry) => entry.key).map((entry) => `${entry.kind}:${entry.key}`));
  const add = (kind: HelmMemoryKind, key: string | null) => {
    if (key && existingKeys.has(`${kind}:${key}`)) return;
    counts.set(kind, (counts.get(kind) ?? 0) + 1);
    if (key) existingKeys.add(`${kind}:${key}`);
  };

  const dropped = new Set<string>();
  for (const id of Array.isArray(input.drop) ? input.drop : []) {
    const entry = typeof id === "string" ? byId.get(id) : undefined;
    if (!entry) errors.push(`memory.drop: ${String(id)} is not a memory id`);
    else if (entry.author === "user") errors.push(`memory.drop: "${entry.text.slice(0, 60)}" is the user's; only they can change it`);
    else { ops.push({ op: "drop", id: entry.id }); dropped.add(entry.id); counts.set(entry.kind, (counts.get(entry.kind) ?? 1) - 1); if (entry.key) existingKeys.delete(`${entry.kind}:${entry.key}`); }
  }
  for (const key of Array.isArray(input.removeThreads) ? input.removeThreads : []) {
    const entry = live.find((candidate) => candidate.kind === "thread" && candidate.key === key);
    if (!entry || dropped.has(entry.id)) continue;
    if (entry.author === "user") { errors.push(`memory.removeThreads: ${key} is the user's`); continue; }
    ops.push({ op: "drop", id: entry.id }); dropped.add(entry.id); counts.set("thread", (counts.get("thread") ?? 1) - 1); existingKeys.delete(`thread:${key}`);
  }
  for (const id of Array.isArray(input.confirm) ? input.confirm : []) {
    if (typeof id === "string" && byId.has(id) && !dropped.has(id)) ops.push({ op: "confirm", id });
  }

  if (input.picture !== undefined) {
    const picture = typeof input.picture === "string" ? input.picture.trim() : "";
    if (!picture) errors.push("memory.picture must be text");
    else if (words(picture) > HELM_PICTURE_MAX_WORDS) errors.push(`memory.picture has ${words(picture)} words; keep it under ${HELM_PICTURE_MAX_WORDS}`);
    else { ops.push({ op: "upsert", kind: "picture", key: "picture", text: picture, source: null }); add("picture", "picture"); }
  }

  const bridgeTasks = new Map(packet.bridges.filter((bridge) => bridge.ok).map((bridge) => [bridge.id, new Map(bridge.tasks.map((task) => [task.taskId, task]))]));
  const today = localDateKey(packet.now, packet.timezone);
  // A pause on the user's own work ends before they go away, so it comes up while they can act.
  const nextAway = (packet.away ?? []).filter((away) => away.start > today).sort((a, b) => a.start.localeCompare(b.start))[0];
  for (const [index, thread] of (Array.isArray(input.threads) ? input.threads : []).entries()) {
    const where = `memory.threads ${index + 1}`;
    const task = bridgeTasks.get(thread?.bridge)?.get(thread?.taskId);
    const threadText = text(thread?.text, HELM_ENTRY_MAX_CHARS);
    const owner = HELM_THREAD_OWNERS.find((candidate) => candidate === thread?.owner);
    const holdUntil = thread?.holdUntil === undefined || thread?.holdUntil === null ? null : typeof thread.holdUntil === "string" ? thread.holdUntil.trim() : "";
    if (!task) { errors.push(`${where}: needs bridge and taskId of a task listed in the packet`); continue; }
    if (!threadText) { errors.push(`${where}: text is required (at most ${HELM_ENTRY_MAX_CHARS} characters)`); continue; }
    if (!owner) { errors.push(`${where}: owner is required: ${HELM_THREAD_OWNERS.join(", ")}`); continue; }
    if (task.onUser === "fields" && owner !== "user") {
      errors.push(`${where}: "${task.title}" is the user's move: no agent is working on it and it waits on no one else${task.needsUser?.length ? ` (${task.needsUser.join("; ")})` : ""}. Its owner must be user.`);
      continue;
    }
    if (holdUntil !== null && (!/^\d{4}-\d{2}-\d{2}$/.test(holdUntil) || Number.isNaN(Date.parse(`${holdUntil}T00:00:00Z`)))) {
      errors.push(`${where}: holdUntil must be a date like 2026-11-20, or left out`);
      continue;
    }
    if (owner === "user" && holdUntil && nextAway && holdUntil >= nextAway.start) {
      const latest = new Date(Date.parse(`${nextAway.start}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
      errors.push(`${where}: The user is away from ${formatDay(nextAway.start)} (${nextAway.title}); a pause on their own work must end by ${latest}.`);
      continue;
    }
    const key = `${thread.bridge}:${thread.taskId}`;
    if (userKeys.has(`thread:${key}`)) continue;
    const from = citedSources(thread.from, null, packet, where, errors);
    ops.push({
      op: "upsert", kind: "thread", key, text: threadText, source: `${thread.bridge === "local" ? "" : `${thread.bridge} · `}${task.title}`,
      ...(from.length ? { from } : {}), owner, holdUntil, ...(task.basis ? { basis: task.basis } : {}),
    });
    add("thread", key);
  }

  for (const kind of ["person", "date"] as const) {
    const field = kind === "person" ? "people" : "dates";
    for (const [index, entry] of (Array.isArray(input[field]) ? input[field] : []).entries()) {
      const key = typeof entry?.key === "string" ? entry.key.trim().toLowerCase().slice(0, 60) : "";
      const entryText = text(entry?.text, HELM_ENTRY_MAX_CHARS);
      if (!key || !entryText) { errors.push(`memory.${field} ${index + 1}: key and text (at most ${HELM_ENTRY_MAX_CHARS} characters) are required`); continue; }
      if (userKeys.has(`${kind}:${key}`)) continue;
      const source = text(entry?.source, 200) ?? null;
      const from = citedSources(entry?.from, source, packet, `memory.${field} ${index + 1}`, errors);
      ops.push({ op: "upsert", kind, key, text: entryText, source, ...(from.length ? { from } : {}) });
      add(kind, key);
    }
  }

  for (const [field, kind] of [["proposeRules", "rule"], ["proposePriorities", "priority"]] as const) {
    for (const [index, entry] of (Array.isArray(input[field]) ? input[field] : []).entries()) {
      const entryText = text(entry?.text, HELM_ENTRY_MAX_CHARS);
      if (!entryText) { errors.push(`memory.${field} ${index + 1}: text is required (at most ${HELM_ENTRY_MAX_CHARS} characters)`); continue; }
      if (live.some((existing) => existing.kind === kind && normalizeChoice(existing.text) === normalizeChoice(entryText))) continue;
      ops.push({ op: "propose", kind, text: entryText, source: text(entry?.source, 200) ?? null });
      add(kind, null);
    }
  }

  for (const [kind, count] of counts) {
    if (count > HELM_MEMORY_LIMITS[kind]) errors.push(`memory would hold ${count} ${kind} entries; the limit is ${HELM_MEMORY_LIMITS[kind]}. Drop or merge some (memory.drop, memory.removeThreads).`);
  }
  return ops;
}
