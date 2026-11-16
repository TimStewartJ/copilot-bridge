// Trigger operations shared by the model tools and the HTTP API: validation, creation, editing and
// lifecycle changes, with the events and runner wake-ups each one needs.

import type { DeferredPromptStore } from "../deferred-prompt-store.js";
import type { GlobalBus } from "../global-bus.js";
import type { TaskStore } from "../task-store.js";
import { isModelPresetSlot, type ModelPresetSlot } from "../../shared/model-presets.js";
import { isPlaybookName } from "../../shared/workflow-vocabulary.js";
import { parseTriggerCheckSpec, type TriggerCheckSpec } from "./check.js";
import { triggerDeliverySourceIds } from "./messages.js";
import type { TriggerStore, TriggerUpdate } from "./store.js";
import {
  firstRunAt,
  hasTriggerWhenInput,
  parseTriggerWhen,
  TRIGGER_DEFAULT_CHAT_EXPIRY_SECONDS,
  type TriggerWhenInput,
} from "./timing.js";
import { isTerminalTriggerStatus, triggerLane, type Trigger, type TriggerAction, type TriggerWhen } from "./types.js";

export const TRIGGER_MAX_PROMPT_CHARS = 32 * 1024;
export const TRIGGER_MAX_RUNS = 10_000;
/** A trigger that creates tasks may make at most this many unless it has an end date instead. */
export const TRIGGER_MAX_NEW_TASK_RUNS = 20;
const TRIGGER_MAX_KEEP_CHATS = 1000;

export type TriggerThen = "worker" | "message" | "new_chat" | "new_task";
export const TRIGGER_THEN_VALUES: readonly TriggerThen[] = ["worker", "message", "new_chat", "new_task"];

/** What tools and the API accept to create a trigger. */
export interface TriggerCreateInput extends TriggerWhenInput {
  name?: unknown;
  prompt?: unknown;
  then?: unknown;
  /** Owning chat for worker/message triggers. */
  sessionId?: unknown;
  /** Owning task for new_chat/new_task triggers. */
  taskId?: unknown;
  /** Title of the tasks a new_task trigger creates. */
  title?: unknown;
  modelTier?: unknown;
  playbook?: unknown;
  keepChats?: unknown;
  check?: unknown;
  maxRuns?: unknown;
  expiresAt?: unknown;
}

export interface TriggerUpdateInput extends TriggerWhenInput {
  name?: unknown;
  prompt?: unknown;
  title?: unknown;
  modelTier?: unknown;
  playbook?: unknown;
  keepChats?: unknown;
  /** null removes the check. */
  check?: unknown;
  maxRuns?: unknown;
  expiresAt?: unknown;
  /** false pauses, true resumes a paused trigger or restarts a stopped one. */
  active?: unknown;
}

export type TriggerResult =
  | { ok: true; trigger: Trigger }
  | { ok: false; status: 400 | 404 | 409; error: string };

export interface TriggerServiceDeps {
  store: TriggerStore;
  taskStore: Pick<TaskStore, "getTask">;
  globalBus: GlobalBus;
  deferredPromptStore?: Pick<DeferredPromptStore, "retireUndeliveredFinalMessagesForSource" | "reactivateFailedDeliveryForSource">;
  chatRunner?: { poke(): void };
  taskRunner?: { poke(): void };
  outboxRunner?: { poke(): void };
}

/** Accepts a trigger id, or the once_/interval_ id a trigger had while it was a defer. */
export function normalizeTriggerId(id: string): string {
  return id.replace(/^(once|interval)_/, "");
}

function bad(error: string): TriggerResult {
  return { ok: false, status: 400, error };
}

function optionalString(value: unknown, field: string, max = 200): { value?: string } | { error: string } {
  if (value === undefined || value === null) return {};
  if (typeof value !== "string") return { error: `${field} must be a string.` };
  const trimmed = value.trim();
  if (trimmed.length > max) return { error: `${field} can be at most ${max} characters.` };
  return trimmed ? { value: trimmed } : {};
}

function parsePrompt(value: unknown): { prompt: string } | { error: string } {
  if (typeof value !== "string" || !value.trim()) return { error: "prompt must be a non-empty string." };
  if (value.length > TRIGGER_MAX_PROMPT_CHARS) return { error: `prompt can be at most ${TRIGGER_MAX_PROMPT_CHARS} characters.` };
  return { prompt: value };
}

function parseMaxRuns(value: unknown): { maxRuns?: number | null } | { error: string } {
  if (value === undefined) return {};
  if (value === null) return { maxRuns: null };
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > TRIGGER_MAX_RUNS) {
    return { error: `maxRuns must be a whole number from 1 to ${TRIGGER_MAX_RUNS}.` };
  }
  return { maxRuns: value };
}

function parseExpiresAt(value: unknown, now: Date): { expiresAt?: string | null } | { error: string } {
  if (value === undefined) return {};
  if (value === null) return { expiresAt: null };
  const time = Date.parse(String(value));
  if (!Number.isFinite(time)) return { error: `expiresAt is not a valid date: ${String(value)}` };
  if (time <= now.getTime()) return { error: "expiresAt must be in the future." };
  return { expiresAt: new Date(time).toISOString() };
}

function parseCheck(value: unknown): { check?: TriggerCheckSpec | null } | { error: string } {
  if (value === undefined) return {};
  if (value === null) return { check: null };
  const parsed = parseTriggerCheckSpec(value);
  return "error" in parsed ? parsed : { check: parsed.spec };
}

function parseActionOptions(input: { modelTier?: unknown; playbook?: unknown; keepChats?: unknown }) {
  const options: { modelTier?: ModelPresetSlot; playbook?: string; keepChats?: number } = {};
  if (input.modelTier !== undefined && input.modelTier !== null) {
    if (!isModelPresetSlot(input.modelTier)) return { error: "modelTier must be preset1, preset2 or preset3." } as const;
    options.modelTier = input.modelTier;
  }
  if (input.playbook !== undefined && input.playbook !== null) {
    if (!isPlaybookName(input.playbook)) return { error: `Unknown playbook: ${String(input.playbook)}` } as const;
    options.playbook = input.playbook;
  }
  if (input.keepChats !== undefined && input.keepChats !== null) {
    if (typeof input.keepChats !== "number" || !Number.isInteger(input.keepChats) || input.keepChats < 0 || input.keepChats > TRIGGER_MAX_KEEP_CHATS) {
      return { error: `keepChats must be a whole number from 0 to ${TRIGGER_MAX_KEEP_CHATS}.` } as const;
    }
    options.keepChats = input.keepChats;
  }
  return { options } as const;
}

/** Recurring chat triggers end after a week unless they set their own limit. */
function defaultExpiry(when: TriggerWhen, lane: "chat" | "task", maxRuns: number | undefined, expiresAt: string | undefined, now: Date) {
  if (lane !== "chat" || when.kind === "at" || maxRuns !== undefined || expiresAt !== undefined) return expiresAt;
  return new Date(now.getTime() + TRIGGER_DEFAULT_CHAT_EXPIRY_SECONDS * 1000).toISOString();
}

export function createTriggerService(deps: TriggerServiceDeps) {
  const { store, globalBus } = deps;

  function emitChatSummary(sessionId: string): void {
    globalBus.emit({ type: "session:trigger-summary", sessionId, triggerSummary: store.getSummaryForSession(sessionId) });
  }

  /** Tell clients and the right runner that a trigger changed. */
  function changed(trigger: Pick<Trigger, "id" | "sessionId" | "taskId" | "action">): void {
    globalBus.emit({
      type: "trigger:changed",
      triggerId: trigger.id,
      ...(trigger.sessionId ? { sessionId: trigger.sessionId } : {}),
      ...(trigger.taskId ? { taskId: trigger.taskId } : {}),
    });
    if (trigger.sessionId) emitChatSummary(trigger.sessionId);
    (triggerLane(trigger.action) === "chat" ? deps.chatRunner : deps.taskRunner)?.poke();
  }

  function get(id: string): Trigger | undefined {
    return store.get(normalizeTriggerId(id));
  }

  function create(
    input: TriggerCreateInput,
    caller: { sessionId?: string; taskId?: string } = {},
    now = new Date(),
  ): TriggerResult {
    const prompt = parsePrompt(input.prompt);
    if ("error" in prompt) return bad(prompt.error);
    const name = optionalString(input.name, "name");
    if ("error" in name) return bad(name.error);

    const sessionId = typeof input.sessionId === "string" ? input.sessionId : undefined;
    const taskId = typeof input.taskId === "string" ? input.taskId : undefined;
    const then = input.then ?? (taskId && !sessionId ? "new_chat" : "worker");
    if (!TRIGGER_THEN_VALUES.includes(then as TriggerThen)) return bad('then must be "worker", "message", "new_chat" or "new_task".');

    const check = parseCheck(input.check);
    if ("error" in check) return bad(check.error);
    if (!hasTriggerWhenInput(input)) return bad("Give the timing: delaySeconds, runAt, intervalSeconds or cron.");
    const when = parseTriggerWhen(input, { hasCheck: Boolean(check.check), now });
    if ("error" in when) return bad(when.error);
    const maxRuns = parseMaxRuns(input.maxRuns);
    if ("error" in maxRuns) return bad(maxRuns.error);
    const expiresAt = parseExpiresAt(input.expiresAt, now);
    if ("error" in expiresAt) return bad(expiresAt.error);

    let action: TriggerAction;
    let owner: { sessionId?: string; taskId?: string };
    if (then === "worker" || then === "message") {
      if (!sessionId) return bad("A worker or message trigger needs the chat it wakes (sessionId).");
      if (input.title !== undefined || input.modelTier !== undefined || input.playbook !== undefined || input.keepChats !== undefined) {
        return bad("title, modelTier, playbook and keepChats apply only to new_chat and new_task triggers.");
      }
      action = { kind: "chat", via: then };
      owner = { sessionId };
    } else {
      if (!taskId) return bad(`A ${then} trigger needs the task it belongs to (taskId).`);
      const task = deps.taskStore.getTask(taskId);
      if (!task) return { ok: false, status: 404, error: `Task ${taskId} not found.` };
      const parsedOptions = parseActionOptions(input);
      if ("error" in parsedOptions) return bad(parsedOptions.error!);
      const options = parsedOptions.options;
      if (then === "new_chat") {
        if (input.title !== undefined) return bad("title applies only to new_task triggers.");
        action = { kind: "new_chat", ...options };
      } else {
        const title = optionalString(input.title, "title");
        if ("error" in title) return bad(title.error);
        if (!title.value) return bad("A new_task trigger needs the title of the tasks it creates.");
        if (options.keepChats !== undefined) return bad("keepChats applies only to new_chat triggers.");
        if (maxRuns.maxRuns == null && expiresAt.expiresAt == null) {
          return bad(`A new_task trigger needs maxRuns (at most ${TRIGGER_MAX_NEW_TASK_RUNS}) or expiresAt, so it cannot create tasks without end.`);
        }
        if (maxRuns.maxRuns != null && maxRuns.maxRuns > TRIGGER_MAX_NEW_TASK_RUNS) {
          return bad(`A new_task trigger can have maxRuns of at most ${TRIGGER_MAX_NEW_TASK_RUNS}.`);
        }
        if (caller.taskId && store.isTriggerMadeTask(caller.taskId)) {
          return bad("A task created by a trigger cannot create task-making triggers.");
        }
        const { modelTier, playbook } = options;
        action = { kind: "new_task", title: title.value, ...(modelTier ? { modelTier } : {}), ...(playbook ? { playbook } : {}) };
      }
      owner = { taskId };
    }

    const nextRunAt = firstRunAt(when.when, now);
    if (!nextRunAt) return bad("This timing never runs.");
    const lane = triggerLane(action);
    const finalExpiry = defaultExpiry(when.when, lane, maxRuns.maxRuns ?? undefined, expiresAt.expiresAt ?? undefined, now);
    if (when.when.kind === "every" && finalExpiry && Date.parse(nextRunAt) >= Date.parse(finalExpiry)) {
      return bad("The trigger would expire before its first run. Set maxRuns or a later expiresAt.");
    }
    const trigger = store.create({
      ...(name.value ? { name: name.value } : {}),
      prompt: prompt.prompt,
      ...owner,
      when: when.when,
      ...(check.check ? { check: check.check } : {}),
      action,
      nextRunAt,
      ...(maxRuns.maxRuns != null ? { maxRuns: maxRuns.maxRuns } : {}),
      ...(finalExpiry ? { expiresAt: finalExpiry } : {}),
      ...(caller.sessionId ? { createdBySessionId: caller.sessionId } : {}),
    }, now.toISOString());
    changed(trigger);
    return { ok: true, trigger };
  }

  function update(id: string, input: TriggerUpdateInput, now = new Date()): TriggerResult {
    const existing = get(id);
    if (!existing) return { ok: false, status: 404, error: `Trigger ${id} not found.` };
    if (existing.status === "running") return { ok: false, status: 409, error: "The trigger is running now. Try again when this run ends." };

    const patch: TriggerUpdate = {};
    if (input.name !== undefined) {
      const name = optionalString(input.name, "name");
      if ("error" in name) return bad(name.error);
      patch.name = name.value ?? null;
    }
    if (input.prompt !== undefined) {
      const prompt = parsePrompt(input.prompt);
      if ("error" in prompt) return bad(prompt.error);
      patch.prompt = prompt.prompt;
    }
    const check = parseCheck(input.check);
    if ("error" in check) return bad(check.error);
    if (check.check !== undefined) patch.check = check.check;
    const hasCheck = check.check === undefined ? Boolean(existing.check) : Boolean(check.check);
    if (hasTriggerWhenInput(input)) {
      const when = parseTriggerWhen(input, { hasCheck, now });
      if ("error" in when) return bad(when.error);
      patch.when = when.when;
      if (existing.status === "active") patch.nextRunAt = firstRunAt(when.when, now);
    } else if (check.check !== undefined) {
      // A check added or removed changes the shortest allowed gap; the current timing must still fit.
      const current = existing.when;
      const recheck = parseTriggerWhen(
        current.kind === "at" ? { runAt: current.at } : current.kind === "every" ? { intervalSeconds: current.seconds } : { cron: current.cron, timezone: current.timezone },
        { hasCheck, now },
      );
      if ("error" in recheck && !(current.kind === "at" && Date.parse(current.at) <= now.getTime())) return bad(recheck.error);
    }
    const maxRuns = parseMaxRuns(input.maxRuns);
    if ("error" in maxRuns) return bad(maxRuns.error);
    if (maxRuns.maxRuns !== undefined) patch.maxRuns = maxRuns.maxRuns;
    const expiresAt = parseExpiresAt(input.expiresAt, now);
    if ("error" in expiresAt) return bad(expiresAt.error);
    if (expiresAt.expiresAt !== undefined) patch.expiresAt = expiresAt.expiresAt;

    if (input.title !== undefined || input.modelTier !== undefined || input.playbook !== undefined || input.keepChats !== undefined) {
      const action = existing.action;
      if (action.kind === "chat") return bad("title, modelTier, playbook and keepChats apply only to new_chat and new_task triggers.");
      const parsed = parseActionOptions({
        modelTier: input.modelTier === undefined ? action.modelTier : input.modelTier,
        playbook: input.playbook === undefined ? action.playbook : input.playbook,
        keepChats: action.kind === "new_chat" && input.keepChats === undefined ? action.keepChats : input.keepChats,
      });
      if ("error" in parsed) return bad(parsed.error!);
      if (action.kind === "new_chat") {
        if (input.title !== undefined) return bad("title applies only to new_task triggers.");
        patch.action = { kind: "new_chat", ...parsed.options };
      } else {
        if (input.keepChats !== undefined && input.keepChats !== null) return bad("keepChats applies only to new_chat triggers.");
        const title = input.title === undefined ? { value: action.title } : optionalString(input.title, "title");
        if ("error" in title) return bad(title.error);
        if (!title.value) return bad("A new_task trigger needs a title.");
        const { modelTier, playbook } = parsed.options;
        patch.action = { kind: "new_task", title: title.value, ...(modelTier ? { modelTier } : {}), ...(playbook ? { playbook } : {}) };
      }
    }
    if (existing.action.kind === "new_task") {
      const finalMax = patch.maxRuns === undefined ? existing.maxRuns ?? null : patch.maxRuns;
      const finalExpiry = patch.expiresAt === undefined ? existing.expiresAt ?? null : patch.expiresAt;
      if (finalMax == null && finalExpiry == null) return bad("A new_task trigger needs maxRuns or expiresAt.");
      if (finalMax != null && finalMax > TRIGGER_MAX_NEW_TASK_RUNS) return bad(`A new_task trigger can have maxRuns of at most ${TRIGGER_MAX_NEW_TASK_RUNS}.`);
    }

    // A chat trigger that becomes recurring gets the same default end as one created recurring.
    if (triggerLane(existing.action) === "chat") {
      const when = patch.when ?? existing.when;
      const finalMax = patch.maxRuns === undefined ? existing.maxRuns : patch.maxRuns ?? undefined;
      const finalExpiry = patch.expiresAt === undefined ? existing.expiresAt : patch.expiresAt ?? undefined;
      const expiry = defaultExpiry(when, "chat", finalMax, finalExpiry, now);
      if (expiry && expiry !== finalExpiry) patch.expiresAt = expiry;
    }

    let updated = store.update(existing.id, patch, now.toISOString());
    if (!updated) return { ok: false, status: 409, error: "The trigger is running now. Try again when this run ends." };

    if (input.active === false) {
      if (!store.pause(existing.id, now.toISOString()) && updated.status !== "paused") {
        return { ok: false, status: 409, error: `A ${updated.status} trigger cannot be paused.` };
      }
    } else if (input.active === true) {
      const resumed = resume(updated, now);
      if (!resumed.ok) return resumed;
    }
    updated = store.get(existing.id)!;
    changed(updated);
    return { ok: true, trigger: updated };
  }

  /** Resume a paused trigger, or restart a stopped one with a fresh failure budget. */
  function resume(trigger: Trigger, now: Date): TriggerResult {
    const nowIso = now.toISOString();
    if (trigger.status === "active" || trigger.status === "running") return { ok: true, trigger };
    if (trigger.status === "paused") {
      const next = trigger.when.kind === "at" ? new Date(Math.max(Date.parse(trigger.when.at), now.getTime())).toISOString() : firstRunAt(trigger.when, now);
      if (!next || !store.resume(trigger.id, next, nowIso)) return { ok: false, status: 409, error: "The trigger could not be resumed." };
      return { ok: true, trigger: store.get(trigger.id)! };
    }
    if (!isTerminalTriggerStatus(trigger.status)) return { ok: false, status: 409, error: `A ${trigger.status} trigger cannot be resumed.` };
    if (!store.reactivate(trigger.id, nowIso, nowIso)) return { ok: false, status: 409, error: "The trigger could not be restarted." };
    // A message that it stopped, not yet delivered, is now untrue.
    if (trigger.sessionId) {
      for (const source of triggerDeliverySourceIds(trigger.id)) {
        deps.deferredPromptStore?.retireUndeliveredFinalMessagesForSource(trigger.sessionId, source);
      }
    }
    return { ok: true, trigger: store.get(trigger.id)! };
  }

  /**
   * Restart a stopped trigger. One that is still running but whose last result never reached its
   * chat gets that result sent again instead.
   */
  function reactivate(id: string, now = new Date()): TriggerResult & { deliveryRetried?: boolean } {
    const existing = get(id);
    if (!existing) return { ok: false, status: 404, error: `Trigger ${id} not found.` };
    if (isTerminalTriggerStatus(existing.status) || existing.status === "paused") {
      const result = resume(existing, now);
      if (result.ok) changed(result.trigger);
      return result;
    }
    if (existing.sessionId) {
      let retried = 0;
      for (const source of triggerDeliverySourceIds(existing.id)) {
        retried += deps.deferredPromptStore?.reactivateFailedDeliveryForSource(existing.sessionId, source) ?? 0;
      }
      if (retried > 0) {
        deps.outboxRunner?.poke();
        return { ok: true, trigger: existing, deliveryRetried: true };
      }
    }
    return { ok: false, status: 409, error: `Trigger ${existing.id} is ${existing.status} and cannot be restarted.` };
  }

  function runNow(id: string, now = new Date()): TriggerResult {
    const existing = get(id);
    if (!existing) return { ok: false, status: 404, error: `Trigger ${id} not found.` };
    if (existing.status === "running") return { ok: false, status: 409, error: "The trigger is running now." };
    if (existing.status !== "active") return { ok: false, status: 409, error: `A ${existing.status} trigger cannot run. Resume it first.` };
    if (!store.requestRunNow(existing.id, now.toISOString())) return { ok: false, status: 409, error: "The trigger could not be started." };
    const updated = store.get(existing.id)!;
    changed(updated);
    return { ok: true, trigger: updated };
  }

  function cancel(id: string, now = new Date()): TriggerResult {
    const existing = get(id);
    if (!existing) return { ok: false, status: 404, error: `Trigger ${id} not found.` };
    if (!store.cancel(existing.id, now.toISOString())) {
      return { ok: false, status: 409, error: `Trigger ${existing.id} is ${existing.status} and cannot be cancelled.` };
    }
    const updated = store.get(existing.id)!;
    changed(updated);
    return { ok: true, trigger: updated };
  }

  /** Delete a trigger and its run history. A running one is cancelled first so its run cannot settle. */
  function remove(id: string): TriggerResult {
    const existing = get(id);
    if (!existing) return { ok: false, status: 404, error: `Trigger ${id} not found.` };
    store.cancel(existing.id);
    store.remove(existing.id);
    changed(existing);
    return { ok: true, trigger: existing };
  }

  return { get, create, update, reactivate, runNow, cancel, remove, emitChatSummary, changed };
}

export type TriggerService = ReturnType<typeof createTriggerService>;
