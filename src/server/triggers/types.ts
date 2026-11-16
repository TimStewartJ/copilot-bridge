// Triggers: the Bridge's one kind of automation. A trigger says when it runs, an optional command
// that decides without a model whether it fires, and what it does when it fires.

import type { DeferCheckpoint } from "../../shared/defer-checkpoint.js";
import type { ModelPresetSlot } from "../../shared/model-presets.js";
import type { TriggerCheckOutcome, TriggerCheckOutput, TriggerCheckResult, TriggerCheckSpec } from "./check.js";

export type TriggerStatus = "active" | "running" | "paused" | "completed" | "cancelled" | "expired" | "failed";

/** Statuses a trigger never leaves by itself. */
export const TERMINAL_TRIGGER_STATUSES = ["completed", "cancelled", "expired", "failed"] as const;
export type TerminalTriggerStatus = (typeof TERMINAL_TRIGGER_STATUSES)[number];

export function isTerminalTriggerStatus(status: TriggerStatus): status is TerminalTriggerStatus {
  return (TERMINAL_TRIGGER_STATUSES as readonly string[]).includes(status);
}

export type TriggerWhen =
  | { kind: "at"; at: string }
  | { kind: "every"; seconds: number }
  | { kind: "cron"; cron: string; timezone: string };

export type TriggerAction =
  /** Wake the chat that owns the trigger: through a temporary worker, or by sending the prompt straight in. */
  | { kind: "chat"; via: "worker" | "message" }
  /** Start a fresh chat in the task that owns the trigger. */
  | { kind: "new_chat"; modelTier?: ModelPresetSlot; playbook?: string; keepChats?: number }
  /** Create a task in the owner's group and start its first chat. */
  | { kind: "new_task"; title: string; modelTier?: ModelPresetSlot; playbook?: string };

export type TriggerActionKind = TriggerAction["kind"];

/** Chat-owned triggers run in the chat lane; task-owned ones start chats or tasks. */
export type TriggerLane = "chat" | "task";

export function triggerLane(action: TriggerAction): TriggerLane {
  return action.kind === "chat" ? "chat" : "task";
}

export interface TriggerLastCheck {
  at: string;
  outcome: TriggerCheckOutcome;
  fingerprint?: string;
  output?: TriggerCheckOutput;
}

/** A firing check result waiting for its action. */
export interface TriggerPendingCheck extends TriggerCheckResult {
  at: string;
  /** The check asked to stop the trigger after this fire (exit code 11). */
  stop?: boolean;
}

export interface Trigger {
  id: string;
  name?: string;
  prompt: string;
  /** Owner when the action wakes a chat. */
  sessionId?: string;
  /** Owner when the action starts a chat or a task. */
  taskId?: string;
  when: TriggerWhen;
  check?: TriggerCheckSpec;
  action: TriggerAction;
  status: TriggerStatus;
  nextRunAt?: string;
  /** Someone asked to run it now: the next pass fires the action without its check. */
  runNow: boolean;
  /** Occurrences, quiet checks included. */
  runCount: number;
  fireCount: number;
  maxRuns?: number;
  expiresAt?: string;
  /** Failed tries in a row. */
  attempts: number;
  claimToken?: string;
  leaseExpiresAt?: string;
  lastError?: string;
  lastRunAt?: string;
  lastFiredAt?: string;
  /** Chat the last fire started. */
  lastSessionId?: string;
  /** Task the last fire created. */
  lastTaskId?: string;
  checkpoint?: DeferCheckpoint;
  lastCheck?: TriggerLastCheck;
  checkPending?: TriggerPendingCheck;
  /** The chat that created it, when one did. */
  createdBySessionId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface TriggerCreate {
  name?: string;
  prompt: string;
  sessionId?: string;
  taskId?: string;
  when: TriggerWhen;
  check?: TriggerCheckSpec;
  action: TriggerAction;
  nextRunAt: string;
  maxRuns?: number;
  expiresAt?: string;
  createdBySessionId?: string;
  /** Migration only: keep the id the row had before triggers. */
  id?: string;
  status?: Extract<TriggerStatus, "active" | "paused">;
}

/** A chat or task a trigger started. */
export interface TriggerRun {
  id: number;
  triggerId: string;
  sessionId: string;
  taskId?: string;
  /** Claim token of the occurrence that started it, so a recovered lease never starts it twice. */
  occurrence?: string;
  recordedAt: string;
}

/** Content-free indicator data for a chat's triggers. */
export interface TriggerSummary {
  count: number;
  runningCount: number;
  nextRunAt: string | null;
}

export const EMPTY_TRIGGER_SUMMARY: TriggerSummary = { count: 0, runningCount: 0, nextRunAt: null };
