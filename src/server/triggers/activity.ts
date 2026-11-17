// Client views of triggers: one per trigger, worker runs from telemetry, and queued chat messages.

import type { DeferCheckpoint } from "../defer-checkpoint.js";
import {
  BACKGROUND_COMMAND_DELIVERY_ID_PREFIX,
  CHAT_MESSAGE_DELIVERY_ID_PREFIX,
  MANAGEMENT_JOB_DELIVERY_ID_PREFIX,
  type DeferredPromptStore,
} from "../deferred-prompt-store.js";
import type { TelemetrySpan, TelemetryStore } from "../telemetry-store.js";
import type { ModelPresetSlot } from "../../shared/model-presets.js";
import type { TriggerCheckOutcome, TriggerCheckSpec } from "./check.js";
import { describeTriggerWhen } from "./timing.js";
import { isTerminalTriggerStatus, type Trigger, type TriggerStatus, type TriggerWhen } from "./types.js";
import type { TriggerThen } from "./service.js";

export type TriggerDeliveryStatus = "pending" | "running" | "completed" | "failed";

export interface TriggerView {
  id: string;
  name?: string;
  prompt: string;
  then: TriggerThen;
  sessionId?: string;
  taskId?: string;
  when: TriggerWhen;
  whenLabel: string;
  check?: TriggerCheckSpec;
  lastCheck?: { outcome: TriggerCheckOutcome; at: string; exitCode?: number; actionPending?: boolean };
  status: TriggerStatus;
  nextRunAt?: string;
  runNow: boolean;
  runCount: number;
  fireCount: number;
  maxRuns?: number;
  expiresAt?: string;
  attempts: number;
  lastError?: string;
  lastRunAt?: string;
  lastFiredAt?: string;
  lastSessionId?: string;
  lastTaskId?: string;
  title?: string;
  modelTier?: ModelPresetSlot;
  playbook?: string;
  keepChats?: number;
  checkpoint?: DeferCheckpoint;
  createdAt: string;
  updatedAt: string;
  canRun: boolean;
  canPause: boolean;
  canResume: boolean;
  canCancel: boolean;
  /** Restart it, or (with failedDelivery) send its last undelivered result again. */
  canReactivate: boolean;
  failedDelivery?: boolean;
}

export interface TriggerWorkerRun {
  id: number;
  triggerId: string;
  action: "continue" | "notify" | "finish" | "return" | "expired" | "error";
  durationMs: number;
  completedAt: string;
  model?: string;
  reasoningEffort?: string;
  contextTier?: string;
  runCount?: number;
  error?: string;
  deliveryId?: string;
  deliveryStatus?: TriggerDeliveryStatus;
  deliveryError?: string;
  usageCaptured?: boolean;
  totalTokens?: number;
  meteredAiCredits?: number;
  estimatedAiCredits?: number;
}

export interface TriggerDeliveryView {
  id: string;
  triggerId: string;
  status: TriggerDeliveryStatus;
  createdAt: string;
  updatedAt: string;
  error?: string;
}

export function toTriggerView(trigger: Trigger, options: { failedDelivery?: boolean } = {}): TriggerView {
  const action = trigger.action;
  const stopped = isTerminalTriggerStatus(trigger.status);
  const lastCheck = trigger.checkPending
    ? { outcome: (trigger.check?.fireOn === "exit_code" ? "fired" : "changed") as TriggerCheckOutcome, at: trigger.checkPending.at, exitCode: trigger.checkPending.exitCode, actionPending: true }
    : trigger.lastCheck
      ? { outcome: trigger.lastCheck.outcome, at: trigger.lastCheck.at, ...(trigger.lastCheck.output ? { exitCode: trigger.lastCheck.output.exitCode } : {}) }
      : undefined;
  return {
    id: trigger.id,
    ...(trigger.name ? { name: trigger.name } : {}),
    prompt: trigger.prompt,
    then: action.kind === "chat" ? action.via : action.kind,
    ...(trigger.sessionId ? { sessionId: trigger.sessionId } : {}),
    ...(trigger.taskId ? { taskId: trigger.taskId } : {}),
    when: trigger.when,
    whenLabel: describeTriggerWhen(trigger.when),
    ...(trigger.check ? { check: trigger.check } : {}),
    ...(lastCheck ? { lastCheck } : {}),
    status: trigger.status,
    // A paused or stopped trigger has no next run.
    ...(trigger.nextRunAt && (trigger.status === "active" || trigger.status === "running") ? { nextRunAt: trigger.nextRunAt } : {}),
    runNow: trigger.runNow,
    runCount: trigger.runCount,
    fireCount: trigger.fireCount,
    ...(trigger.maxRuns !== undefined ? { maxRuns: trigger.maxRuns } : {}),
    ...(trigger.expiresAt ? { expiresAt: trigger.expiresAt } : {}),
    attempts: trigger.attempts,
    ...(trigger.lastError ? { lastError: trigger.lastError } : {}),
    ...(trigger.lastRunAt ? { lastRunAt: trigger.lastRunAt } : {}),
    ...(trigger.lastFiredAt ? { lastFiredAt: trigger.lastFiredAt } : {}),
    ...(trigger.lastSessionId && action.kind !== "chat" ? { lastSessionId: trigger.lastSessionId } : {}),
    ...(trigger.lastTaskId ? { lastTaskId: trigger.lastTaskId } : {}),
    ...(action.kind === "new_task" ? { title: action.title } : {}),
    ...(action.kind !== "chat" && action.modelTier ? { modelTier: action.modelTier } : {}),
    ...(action.kind !== "chat" && action.playbook ? { playbook: action.playbook } : {}),
    ...(action.kind === "new_chat" && action.keepChats !== undefined ? { keepChats: action.keepChats } : {}),
    ...(trigger.checkpoint ? { checkpoint: trigger.checkpoint } : {}),
    createdAt: trigger.createdAt,
    updatedAt: trigger.updatedAt,
    canRun: trigger.status === "active" && !trigger.runNow,
    canPause: trigger.status === "active",
    canResume: trigger.status === "paused",
    canCancel: trigger.status === "active" || trigger.status === "running" || trigger.status === "paused",
    canReactivate: stopped || options.failedDelivery === true,
    ...(options.failedDelivery && !stopped ? { failedDelivery: true } : {}),
  };
}

/** Active first (by next run), then the rest by most recent change. */
export function sortTriggerViews(views: TriggerView[]): TriggerView[] {
  const live = (view: TriggerView) => !isTerminalTriggerStatus(view.status);
  return [...views].sort((left, right) => {
    const difference = Number(!live(left)) - Number(!live(right));
    if (difference !== 0) return difference;
    if (live(left) && live(right)) {
      return Date.parse(left.nextRunAt ?? left.updatedAt) - Date.parse(right.nextRunAt ?? right.updatedAt);
    }
    return Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  });
}

function optionalString(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function optionalNumber(metadata: Record<string, unknown>, key: string): number | undefined {
  const value = metadata[key];
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

const WORKER_ACTIONS = new Set(["continue", "notify", "finish", "return", "expired", "error"]);

/** The trigger a worker span belongs to; older spans carry a prefixed deferId instead. */
function spanTriggerId(metadata: Record<string, unknown>): string | undefined {
  return optionalString(metadata, "triggerId") ?? optionalString(metadata, "deferId")?.replace(/^(once|interval)_/, "");
}

function parseWorkerRun(span: TelemetrySpan): TriggerWorkerRun | undefined {
  const metadata = span.metadata;
  if (!metadata) return undefined;
  const triggerId = spanTriggerId(metadata);
  const action = metadata.action;
  if (!triggerId || typeof action !== "string" || !WORKER_ACTIONS.has(action)) return undefined;
  const runCount = optionalNumber(metadata, "runCount");
  return {
    id: span.id,
    triggerId,
    action: action as TriggerWorkerRun["action"],
    durationMs: span.duration,
    completedAt: span.createdAt,
    ...(optionalString(metadata, "model") ? { model: optionalString(metadata, "model") } : {}),
    ...(optionalString(metadata, "reasoningEffort") ? { reasoningEffort: optionalString(metadata, "reasoningEffort") } : {}),
    ...(optionalString(metadata, "contextTier") ? { contextTier: optionalString(metadata, "contextTier") } : {}),
    ...(runCount !== undefined && Number.isInteger(runCount) && runCount > 0 ? { runCount } : {}),
    ...(optionalString(metadata, "error") ? { error: optionalString(metadata, "error") } : {}),
    ...(optionalString(metadata, "deliveryId") ? { deliveryId: optionalString(metadata, "deliveryId") } : {}),
    ...(typeof metadata.usageCaptured === "boolean" ? { usageCaptured: metadata.usageCaptured } : {}),
    ...(optionalNumber(metadata, "totalTokens") !== undefined ? { totalTokens: optionalNumber(metadata, "totalTokens") } : {}),
    ...(optionalNumber(metadata, "meteredAiCredits") !== undefined ? { meteredAiCredits: optionalNumber(metadata, "meteredAiCredits") } : {}),
    ...(optionalNumber(metadata, "estimatedAiCredits") !== undefined ? { estimatedAiCredits: optionalNumber(metadata, "estimatedAiCredits") } : {}),
  };
}

/** A chat's trigger worker runs, newest first, with whether each message reached the chat. */
export function listTriggerWorkerRuns(
  telemetryStore: TelemetryStore | undefined,
  sessionId: string,
  options: { triggerId?: string; limit?: number; deferredPromptStore?: Pick<DeferredPromptStore, "get"> } = {},
): TriggerWorkerRun[] {
  if (!telemetryStore) return [];
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
  return telemetryStore
    .querySpans({ name: "defer.worker", sessionId, source: "server", limit: options.triggerId ? 500 : limit })
    .map(parseWorkerRun)
    .filter((run): run is TriggerWorkerRun => !!run && (!options.triggerId || run.triggerId === options.triggerId))
    .map((run) => {
      const delivery = run.deliveryId ? options.deferredPromptStore?.get(run.deliveryId) : undefined;
      return delivery?.purpose === "delivery" && delivery.status !== "cancelled"
        ? { ...run, deliveryStatus: delivery.status as TriggerDeliveryStatus, ...(delivery.lastError ? { deliveryError: delivery.lastError } : {}) }
        : run;
    })
    .slice(0, limit);
}

/** The trigger an outbox source id belongs to, or undefined for other senders. */
export function triggerIdFromDeliverySource(sourceId: string | undefined): string | undefined {
  if (!sourceId) return undefined;
  if (
    sourceId.startsWith(MANAGEMENT_JOB_DELIVERY_ID_PREFIX)
    || sourceId.startsWith(CHAT_MESSAGE_DELIVERY_ID_PREFIX)
    || sourceId.startsWith(BACKGROUND_COMMAND_DELIVERY_ID_PREFIX)
  ) {
    return undefined;
  }
  // agent-text-audit: data (outbox source ids the Bridge writes)
  const match = /^(?:trigger:|once_|interval_)(.+)$/.exec(sourceId);
  return match?.[1];
}

/** Messages a chat's triggers queued for it, newest first. */
export function listTriggerDeliveries(
  deferredPromptStore: Pick<DeferredPromptStore, "listDeliveriesForSession"> | undefined,
  sessionId: string,
  options: { triggerId?: string; limit?: number } = {},
): TriggerDeliveryView[] {
  if (!deferredPromptStore) return [];
  const limit = Math.max(1, Math.min(options.limit ?? 100, 500));
  const views: TriggerDeliveryView[] = [];
  for (const item of deferredPromptStore.listDeliveriesForSession(sessionId)) {
    if (item.status === "cancelled") continue;
    const triggerId = triggerIdFromDeliverySource(item.sourceId);
    if (!triggerId || (options.triggerId && triggerId !== options.triggerId)) continue;
    views.push({
      id: item.id,
      triggerId,
      status: item.status as TriggerDeliveryStatus,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      ...(item.lastError ? { error: item.lastError } : {}),
    });
    if (views.length >= limit) break;
  }
  return views;
}
