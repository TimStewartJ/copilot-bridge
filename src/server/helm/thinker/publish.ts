// Checks a thinker's publication against the packet it was given and turns it into a brief and
// memory changes. Nothing is accepted unless all of it is valid, so a run can fix its mistakes
// and publish again; the first valid publication is final. Every action must point at something
// the run was shown, an answer must fit the question, and Helm can never change Tim's own memory.
import {
  HELM_ENTRY_MAX_CHARS,
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
  type HelmWatching,
} from "../../../shared/helm-thinker.js";
import type { PacketBridge, ThinkerPacket } from "./context.js";

export const MAX_ITEMS = 6;
const MAX_PROPOSALS = 5;
const MAX_WATCHING = 10;
const MAX_HANDLED = 30;
const MAX_ACTIONS = 3;
const ITEM_KINDS: HelmItemKind[] = ["question", "decision", "due", "connects", "fyi"];

export type MemoryOp =
  | { op: "upsert"; kind: HelmMemoryKind; key: string; text: string; source: string | null }
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

export type PublicationResult =
  | { ok: true; brief: HelmBrief; handled: HandledPlan[]; memory: MemoryOp[] }
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

function words(value: string): number {
  return value.split(/\s+/).filter(Boolean).length;
}

export function validatePublication(raw: unknown, packet: ThinkerPacket, memory: readonly HelmMemoryEntry[]): PublicationResult {
  const errors: string[] = [];
  const input = raw && typeof raw === "object" ? raw as Record<string, any> : {};
  const bridges = new Map(packet.bridges.filter((bridge) => bridge.ok).map((bridge) => [bridge.id, bridge]));
  const bridgeOf = (id: unknown, where: string): PacketBridge | undefined => {
    const bridge = typeof id === "string" ? bridges.get(id) : undefined;
    if (!bridge) errors.push(`${where}: bridge must be one of ${[...bridges.keys()].join(", ") || "(none available)"}`);
    return bridge;
  };

  const summary = text(input.summary, 700);
  if (!summary) errors.push("summary is required (at most 700 characters)");

  const parseAction = (rawAction: any, bridge: PacketBridge, where: string, index: number): HelmAction | undefined => {
    const label = text(rawAction?.label, 60);
    if (!label) { errors.push(`${where}: label is required (at most 60 characters)`); return undefined; }
    const type = rawAction?.type;
    let action: HelmActionDo | undefined;
    if (type === "answer") {
      const question = bridge.questions.find((candidate) => candidate.sessionId === rawAction.sessionId && candidate.requestId === rawAction.requestId);
      const answer = text(rawAction.answer, 1500);
      if (!question) errors.push(`${where}: answer needs the sessionId and requestId of a question listed for ${bridge.id}`);
      else if (!question.answerable || question.kind !== "user_input") errors.push(`${where}: that question can't be answered from Home; use an open action instead`);
      else if (!answer) errors.push(`${where}: answer text is required`);
      else {
        const choice = question.choices?.find((candidate) => normalizeChoice(candidate) === normalizeChoice(answer));
        if (!choice && question.allowFreeform === false) errors.push(`${where}: the answer must be one of: ${question.choices?.join(" | ")}`);
        else action = { type: "answer", bridge: bridge.id, sessionId: question.sessionId, requestId: question.requestId, answer: choice ?? answer, wasFreeform: !choice };
      }
    } else if (type === "send") {
      const message = text(rawAction.message, 2000);
      if (typeof rawAction.sessionId !== "string" || !bridge.sessionIds.has(rawAction.sessionId)) errors.push(`${where}: send needs the sessionId of a conversation listed for ${bridge.id}`);
      else if (!message) errors.push(`${where}: message is required (at most 2000 characters)`);
      else action = { type: "send", bridge: bridge.id, sessionId: rawAction.sessionId, message };
    } else if (type === "tick") {
      if (!bridge.due.some((due) => due.actionId === rawAction.actionId)) errors.push(`${where}: tick needs the actionId of a checklist item listed for ${bridge.id}`);
      else action = { type: "tick", bridge: bridge.id, actionId: rawAction.actionId };
    } else if (type === "close_tasks") {
      const ids = Array.isArray(rawAction.taskIds) ? rawAction.taskIds.filter((id: unknown) => typeof id === "string") as string[] : [];
      if (bridge.id !== "local") errors.push(`${where}: close_tasks only works for tasks on bridge "local"; propose opening the task instead`);
      else if (ids.length === 0 || ids.length > 10 || ids.some((id) => !bridge.tasks.some((task) => task.taskId === id))) errors.push(`${where}: close_tasks needs 1–10 taskIds listed for local`);
      else action = { type: "close_tasks", bridge: bridge.id, taskIds: [...new Set(ids)] };
    } else if (type === "open") {
      const sessionOk = typeof rawAction.sessionId === "string" && bridge.sessionIds.has(rawAction.sessionId);
      const taskOk = typeof rawAction.taskId === "string" && bridge.tasks.some((task) => task.taskId === rawAction.taskId);
      if (!sessionOk && !taskOk) errors.push(`${where}: open needs a sessionId or taskId listed for ${bridge.id}`);
      else action = { type: "open", bridge: bridge.id, ...(sessionOk ? { sessionId: rawAction.sessionId } : { taskId: rawAction.taskId }) };
    } else {
      errors.push(`${where}: type must be answer, send, tick, close_tasks or open`);
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
    if (!Array.isArray(rawEvidence) || rawEvidence.length > 4) { errors.push(`${where}: evidence must be a list of at most 4`); return []; }
    return rawEvidence.flatMap((entry: any, index) => {
      const label = text(entry?.label, 120);
      const sessionOk = typeof entry?.sessionId === "string" && bridge.sessionIds.has(entry.sessionId);
      const taskOk = typeof entry?.taskId === "string" && bridge.tasks.some((task) => task.taskId === entry.taskId);
      if (!label || (!sessionOk && !taskOk)) {
        errors.push(`${where} evidence ${index + 1}: needs a label and a sessionId or taskId listed for ${bridge.id}`);
        return [];
      }
      return [{ label, target: { bridge: bridge.id, ...(sessionOk ? { sessionId: entry.sessionId } : { taskId: entry.taskId }) } }];
    });
  };

  const items: HelmBriefItem[] = [];
  if (!Array.isArray(input.items) || input.items.length > MAX_ITEMS) errors.push(`items must be a list of at most ${MAX_ITEMS}`);
  else input.items.forEach((rawItem: any, index: number) => {
    const where = `item ${index + 1}`;
    const bridge = bridgeOf(rawItem?.bridge, where);
    const title = text(rawItem?.title, 160);
    const recommendation = text(rawItem?.recommendation, 600);
    const kind = ITEM_KINDS.includes(rawItem?.kind) ? rawItem.kind as HelmItemKind : undefined;
    if (!title) errors.push(`${where}: title is required (at most 160 characters)`);
    if (!recommendation) errors.push(`${where}: recommendation is required (at most 600 characters)`);
    if (!kind) errors.push(`${where}: kind must be one of ${ITEM_KINDS.join(", ")}`);
    if (!bridge || !title || !recommendation || !kind) return;
    const why = rawItem.why === undefined ? undefined : text(rawItem.why, 400);
    if (rawItem.why !== undefined && !why) errors.push(`${where}: why must be at most 400 characters`);
    let reply: HelmBriefItem["reply"];
    if (rawItem.replyTo !== undefined) {
      const sessionId = rawItem.replyTo?.sessionId;
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
  else (input.proposals ?? []).forEach((rawProposal: any, index: number) => {
    const where = `proposal ${index + 1}`;
    const bridge = bridgeOf(rawProposal?.bridge, where);
    const proposalText = text(rawProposal?.text, 400);
    if (!proposalText) errors.push(`${where}: text is required (at most 400 characters)`);
    if (!bridge || !proposalText) return;
    proposals.push({ id: `p${index + 1}`, text: proposalText, actions: parseActions(rawProposal.actions, bridge, where) });
  });

  const watching: HelmWatching[] = [];
  if (input.watching !== undefined && (!Array.isArray(input.watching) || input.watching.length > MAX_WATCHING)) errors.push(`watching must be a list of at most ${MAX_WATCHING}`);
  else (input.watching ?? []).forEach((rawWatch: any, index: number) => {
    const where = `watching ${index + 1}`;
    const bridge = bridgeOf(rawWatch?.bridge, where);
    const watchText = text(rawWatch?.text, 300);
    if (!watchText) errors.push(`${where}: text is required (at most 300 characters)`);
    if (!bridge || !watchText) return;
    const taskOk = typeof rawWatch.taskId === "string" && bridge.tasks.some((task) => task.taskId === rawWatch.taskId);
    watching.push({ text: watchText, bridge: bridge.id, ...(taskOk ? { taskId: rawWatch.taskId } : {}) });
  });

  const handled: HandledPlan[] = [];
  if (input.handled !== undefined && (!Array.isArray(input.handled) || input.handled.length > MAX_HANDLED)) errors.push(`handled must be a list of at most ${MAX_HANDLED}`);
  else (input.handled ?? []).forEach((rawHandled: any, index: number) => {
    const where = `handled ${index + 1}`;
    const bridge = bridgeOf(rawHandled?.bridge, where);
    if (!bridge) return;
    const reply = bridge.replies.find((candidate) => candidate.sessionId === rawHandled.sessionId);
    const why = text(rawHandled.why, 200);
    if (!reply || !reply.activityAt) errors.push(`${where}: only an unread reply listed for ${bridge.id} can be marked read`);
    else if (!why) errors.push(`${where}: why is required (at most 200 characters)`);
    else if (bridge.questions.some((question) => question.sessionId === reply.sessionId)) errors.push(`${where}: that conversation is waiting on a question; it can't be marked read`);
    else handled.push({ bridge: bridge.id, sessionId: reply.sessionId, title: reply.task ? `${reply.task} · ${reply.conversation}` : reply.conversation, why, activityAt: reply.activityAt });
  });

  const memoryOps = validateMemory(input.memory, packet, memory, errors);
  if (errors.length > 0) return { ok: false, errors: errors.slice(0, 25) };
  return { ok: true, brief: { summary: summary!, items, proposals, watching }, handled, memory: memoryOps };
}

function validateMemory(raw: unknown, packet: ThinkerPacket, memory: readonly HelmMemoryEntry[], errors: string[]): MemoryOp[] {
  if (raw === undefined) return [];
  if (!raw || typeof raw !== "object") { errors.push("memory must be an object"); return []; }
  const input = raw as Record<string, any>;
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
    else if (entry.author === "user") errors.push(`memory.drop: "${entry.text.slice(0, 60)}" is Tim's; only he can change it`);
    else { ops.push({ op: "drop", id: entry.id }); dropped.add(entry.id); counts.set(entry.kind, (counts.get(entry.kind) ?? 1) - 1); if (entry.key) existingKeys.delete(`${entry.kind}:${entry.key}`); }
  }
  for (const key of Array.isArray(input.removeThreads) ? input.removeThreads : []) {
    const entry = live.find((candidate) => candidate.kind === "thread" && candidate.key === key);
    if (!entry || dropped.has(entry.id)) continue;
    if (entry.author === "user") { errors.push(`memory.removeThreads: ${key} is Tim's`); continue; }
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

  const bridgeTasks = new Map(packet.bridges.filter((bridge) => bridge.ok).map((bridge) => [bridge.id, new Map(bridge.tasks.map((task) => [task.taskId, task.title]))]));
  for (const [index, thread] of (Array.isArray(input.threads) ? input.threads : []).entries()) {
    const title = bridgeTasks.get(thread?.bridge)?.get(thread?.taskId);
    const threadText = text(thread?.text, HELM_ENTRY_MAX_CHARS);
    if (!title) errors.push(`memory.threads ${index + 1}: needs bridge and taskId of a task listed in the packet`);
    else if (!threadText) errors.push(`memory.threads ${index + 1}: text is required (at most ${HELM_ENTRY_MAX_CHARS} characters)`);
    else {
      const key = `${thread.bridge}:${thread.taskId}`;
      if (userKeys.has(`thread:${key}`)) continue;
      ops.push({ op: "upsert", kind: "thread", key, text: threadText, source: `${thread.bridge === "local" ? "" : `${thread.bridge} · `}${title}` });
      add("thread", key);
    }
  }

  for (const kind of ["person", "date"] as const) {
    const field = kind === "person" ? "people" : "dates";
    for (const [index, entry] of (Array.isArray(input[field]) ? input[field] : []).entries()) {
      const key = typeof entry?.key === "string" ? entry.key.trim().toLowerCase().slice(0, 60) : "";
      const entryText = text(entry?.text, HELM_ENTRY_MAX_CHARS);
      if (!key || !entryText) { errors.push(`memory.${field} ${index + 1}: key and text (at most ${HELM_ENTRY_MAX_CHARS} characters) are required`); continue; }
      if (userKeys.has(`${kind}:${key}`)) continue;
      ops.push({ op: "upsert", kind, key, text: entryText, source: text(entry?.source, 200) ?? null });
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
