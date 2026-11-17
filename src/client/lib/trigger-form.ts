// The task trigger form: its state, how it starts from a trigger, and the request body it builds.

import type {
  TriggerCheckFireOn,
  TriggerCheckSpec,
  TriggerCreateInput,
  TriggerTimingInput,
  TriggerUpdateInput,
  TriggerView,
} from "../api";
import { isModelPresetSlot, type ModelPresetSlot } from "../../shared/model-presets.js";

export type TriggerTimingMode = "once" | "every" | "cron";
export type TriggerEveryUnit = "minutes" | "hours";
export type TaskTriggerThen = "new_chat" | "new_task";

/** A trigger that creates tasks needs a run limit at most this high, or an end date. */
export const MAX_NEW_TASK_RUNS = 20;
export const DEFAULT_CHECK_TIMEOUT_SECONDS = 60;
export const DEFAULT_TRIGGER_CRON = "0 8 * * 1-5";

export interface TriggerFormState {
  name: string;
  prompt: string;
  then: TaskTriggerThen;
  timing: TriggerTimingMode;
  /** `datetime-local` value, local time. */
  runAt: string;
  everyCount: string;
  everyUnit: TriggerEveryUnit;
  cron: string;
  timezone: string;
  checkEnabled: boolean;
  /** One argument per line, the executable first. */
  checkCommand: string;
  checkCwd: string;
  checkFireOn: TriggerCheckFireOn;
  checkTimeoutSeconds: string;
  title: string;
  modelTier: "" | ModelPresetSlot;
  playbook: string;
  keepChats: string;
  maxRuns: string;
  /** `datetime-local` value, local time; empty means no end date. */
  expiresAt: string;
}

export type TriggerFormResult<T> = { ok: true; input: T } | { ok: false; error: string };

/** A minute-precision `datetime-local` value in local time. */
export function toDatetimeLocalValue(date: Date): string {
  const offsetMs = date.getTimezoneOffset() * 60_000;
  return new Date(date.getTime() - offsetMs).toISOString().slice(0, 16);
}

function everyFields(seconds: number): Pick<TriggerFormState, "everyCount" | "everyUnit"> {
  return seconds % 3600 === 0
    ? { everyCount: String(seconds / 3600), everyUnit: "hours" }
    : { everyCount: String(Math.max(1, Math.round(seconds / 60))), everyUnit: "minutes" };
}

export function triggerFormState(trigger: TriggerView | null, defaults: { timezone: string }): TriggerFormState {
  const when = trigger?.when;
  const check = trigger?.check;
  return {
    name: trigger?.name ?? "",
    prompt: trigger?.prompt ?? "",
    then: trigger?.then === "new_task" ? "new_task" : "new_chat",
    timing: when?.kind === "at" ? "once" : when?.kind ?? "cron",
    runAt: when?.kind === "at" ? toDatetimeLocalValue(new Date(when.at)) : "",
    ...(when?.kind === "every" ? everyFields(when.seconds) : { everyCount: "1", everyUnit: "hours" as const }),
    cron: when?.kind === "cron" ? when.cron : DEFAULT_TRIGGER_CRON,
    timezone: when?.kind === "cron" ? when.timezone : defaults.timezone,
    checkEnabled: Boolean(check),
    checkCommand: check?.command.join("\n") ?? "",
    checkCwd: check?.cwd ?? "",
    checkFireOn: check?.fireOn ?? "change",
    checkTimeoutSeconds: String(check?.timeoutSeconds ?? DEFAULT_CHECK_TIMEOUT_SECONDS),
    title: trigger?.title ?? "",
    modelTier: trigger?.modelTier && isModelPresetSlot(trigger.modelTier) ? trigger.modelTier : "",
    playbook: trigger?.playbook ?? "",
    keepChats: trigger?.keepChats?.toString() ?? "",
    maxRuns: trigger?.maxRuns?.toString() ?? "",
    expiresAt: trigger?.expiresAt ? toDatetimeLocalValue(new Date(trigger.expiresAt)) : "",
  };
}

function wholeNumber(value: string, min: number): number | undefined {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) return undefined;
  const parsed = Number(trimmed);
  return Number.isSafeInteger(parsed) && parsed >= min ? parsed : undefined;
}

function futureIso(value: string, now: Date): string | undefined {
  const time = new Date(value).getTime();
  return Number.isFinite(time) && time > now.getTime() ? new Date(time).toISOString() : undefined;
}

function buildTiming(form: TriggerFormState, now: Date): TriggerFormResult<TriggerTimingInput> {
  switch (form.timing) {
    case "once": {
      if (!form.runAt) return { ok: false, error: "Choose when it runs." };
      const runAt = futureIso(form.runAt, now);
      return runAt ? { ok: true, input: { runAt } } : { ok: false, error: "The run time must be in the future." };
    }
    case "every": {
      const count = wholeNumber(form.everyCount, 1);
      if (count === undefined) return { ok: false, error: "The interval must be a whole number of 1 or more." };
      return { ok: true, input: { intervalSeconds: count * (form.everyUnit === "hours" ? 3600 : 60) } };
    }
    case "cron": {
      const cron = form.cron.trim();
      if (!cron) return { ok: false, error: "Enter a cron expression." };
      const timezone = form.timezone.trim();
      return { ok: true, input: { cron, ...(timezone ? { timezone } : {}) } };
    }
  }
}

/** The check the form describes; one-time triggers cannot have one. */
function buildCheck(form: TriggerFormState, existing?: TriggerCheckSpec): TriggerFormResult<TriggerCheckSpec | undefined> {
  if (!form.checkEnabled || form.timing === "once") return { ok: true, input: undefined };
  const command = form.checkCommand.split(/\r?\n/).map((part) => part.trim()).filter(Boolean);
  if (command.length === 0) return { ok: false, error: "Enter the check command." };
  const timeoutSeconds = wholeNumber(form.checkTimeoutSeconds, 1);
  if (timeoutSeconds === undefined) return { ok: false, error: "The check timeout must be a whole number of seconds." };
  const cwd = form.checkCwd.trim();
  return {
    ok: true,
    input: {
      command,
      ...(cwd ? { cwd } : {}),
      timeoutSeconds,
      fireOn: form.checkFireOn,
      // Kept from the trigger being edited; the form has no control for it.
      ...(existing?.fireOnFirstRun && form.checkFireOn === "change" ? { fireOnFirstRun: true } : {}),
    },
  };
}

interface Limits {
  maxRuns?: number;
  expiresAt?: string;
  keepChats?: number;
}

/** `keptExpiresAt`: the edited trigger's untouched end date, which may have passed. */
function buildLimits(form: TriggerFormState, now: Date, keptExpiresAt?: string): TriggerFormResult<Limits> {
  const limits: Limits = {};
  if (form.maxRuns.trim()) {
    const maxRuns = wholeNumber(form.maxRuns, 1);
    if (maxRuns === undefined) return { ok: false, error: "Max runs must be a whole number of 1 or more." };
    limits.maxRuns = maxRuns;
  }
  if (keptExpiresAt) {
    limits.expiresAt = keptExpiresAt;
  } else if (form.expiresAt) {
    const expiresAt = futureIso(form.expiresAt, now);
    if (!expiresAt) return { ok: false, error: "The end date must be in the future." };
    limits.expiresAt = expiresAt;
  }
  if (form.then === "new_chat" && form.keepChats.trim()) {
    const keepChats = wholeNumber(form.keepChats, 0);
    if (keepChats === undefined) return { ok: false, error: "Chats to keep must be a whole number." };
    limits.keepChats = keepChats;
  }
  if (form.then === "new_task") {
    if (limits.maxRuns === undefined && !limits.expiresAt) {
      return { ok: false, error: `Set max runs (up to ${MAX_NEW_TASK_RUNS}) or an end date.` };
    }
    if (limits.maxRuns !== undefined && limits.maxRuns > MAX_NEW_TASK_RUNS) {
      return { ok: false, error: `A trigger that creates tasks can run at most ${MAX_NEW_TASK_RUNS} times.` };
    }
  }
  return { ok: true, input: limits };
}

function checkCommon(form: TriggerFormState): string | undefined {
  if (!form.prompt.trim()) return "Enter a prompt.";
  if (form.then === "new_task" && !form.title.trim()) return "Enter the title of the tasks it creates.";
  return undefined;
}

export function buildTriggerCreate(form: TriggerFormState, taskId: string, now = new Date()): TriggerFormResult<TriggerCreateInput> {
  const commonError = checkCommon(form);
  if (commonError) return { ok: false, error: commonError };
  const timing = buildTiming(form, now);
  if (!timing.ok) return timing;
  const check = buildCheck(form);
  if (!check.ok) return check;
  const limits = buildLimits(form, now);
  if (!limits.ok) return limits;
  const name = form.name.trim();
  return {
    ok: true,
    input: {
      ...(name ? { name } : {}),
      prompt: form.prompt,
      then: form.then,
      taskId,
      ...(form.then === "new_task" ? { title: form.title.trim() } : {}),
      ...(form.modelTier ? { modelTier: form.modelTier } : {}),
      ...(form.playbook ? { playbook: form.playbook } : {}),
      ...timing.input,
      ...(check.input ? { check: check.input } : {}),
      ...limits.input,
    },
  };
}

function sameTiming(input: TriggerTimingInput, existing: TriggerView): boolean {
  const when = existing.when;
  if (input.runAt !== undefined) return when.kind === "at" && Date.parse(when.at) === Date.parse(input.runAt);
  if (input.intervalSeconds !== undefined) return when.kind === "every" && when.seconds === input.intervalSeconds;
  return when.kind === "cron" && when.cron === input.cron && (input.timezone === undefined || when.timezone === input.timezone);
}

function sameCheck(left: TriggerCheckSpec | undefined, right: TriggerCheckSpec | undefined): boolean {
  if (!left || !right) return left === right;
  return left.command.length === right.command.length
    && left.command.every((part, index) => part === right.command[index])
    && (left.cwd ?? "") === (right.cwd ?? "")
    && left.timeoutSeconds === right.timeoutSeconds
    && left.fireOn === right.fireOn
    && Boolean(left.fireOnFirstRun) === Boolean(right.fireOnFirstRun);
}

/** Only what changed: resent timing restarts its countdown, or is refused once past. */
export function buildTriggerUpdate(form: TriggerFormState, existing: TriggerView, now = new Date()): TriggerFormResult<TriggerUpdateInput> {
  const commonError = checkCommon(form);
  if (commonError) return { ok: false, error: commonError };
  const editedRunAt = form.timing !== "once" || existing.when.kind !== "at"
    || form.runAt !== toDatetimeLocalValue(new Date(existing.when.at));
  const timing: TriggerFormResult<TriggerTimingInput> = editedRunAt
    ? buildTiming(form, now)
    : { ok: true, input: { runAt: existing.when.kind === "at" ? existing.when.at : "" } };
  if (!timing.ok) return timing;
  const check = buildCheck(form, existing.check);
  if (!check.ok) return check;
  const expiryEdited = form.expiresAt !== (existing.expiresAt ? toDatetimeLocalValue(new Date(existing.expiresAt)) : "");
  const limits = buildLimits(form, now, expiryEdited ? undefined : existing.expiresAt);
  if (!limits.ok) return limits;

  const input: TriggerUpdateInput = {};
  const name = form.name.trim();
  if (name !== (existing.name ?? "")) input.name = name;
  if (form.prompt !== existing.prompt) input.prompt = form.prompt;
  if (form.then === "new_task" && form.title.trim() !== (existing.title ?? "")) input.title = form.title.trim();
  if (form.modelTier !== (existing.modelTier ?? "")) input.modelTier = form.modelTier || null;
  if (form.playbook !== (existing.playbook ?? "")) input.playbook = form.playbook || null;
  if (form.then === "new_chat" && limits.input.keepChats !== existing.keepChats) input.keepChats = limits.input.keepChats ?? null;
  if (!sameTiming(timing.input, existing)) Object.assign(input, timing.input);
  if (!sameCheck(check.input, existing.check)) input.check = check.input ?? null;
  if (limits.input.maxRuns !== existing.maxRuns) input.maxRuns = limits.input.maxRuns ?? null;
  if (expiryEdited) input.expiresAt = limits.input.expiresAt ?? null;
  return { ok: true, input };
}
