// Model tools for triggers: one family for every kind of automation.

import type { AppContext } from "../app-context.js";
import { defineBridgeTool, registerBridgeToolDefinitions } from "../agent-tools-mcp/adapter.js";
import type { BridgeToolDefinition, BridgeToolsMcpServer } from "../agent-tools-mcp/server.js";
import { toolFailure } from "../tool-results.js";
import type { ModelPresetSlot } from "../../shared/model-presets.js";
import { TRIGGER_CHECK_EXIT_FIRE, TRIGGER_CHECK_EXIT_FIRE_AND_STOP, TRIGGER_CHECK_MAX_TIMEOUT_SECONDS } from "./check.js";
import { triggerDeliverySourceIds } from "./messages.js";
import { TRIGGER_MAX_NEW_TASK_RUNS, type TriggerResult, type TriggerCreateInput, type TriggerService, type TriggerThen } from "./service.js";
import { describeTriggerWhen, TRIGGER_MIN_CHECKED_INTERVAL_SECONDS, TRIGGER_MIN_UNCHECKED_INTERVAL_SECONDS } from "./timing.js";
import type { Trigger } from "./types.js";

// Agents name tiers as Settings › Models shows them; triggers keep the preset slot.
const TOOL_MODEL_TIERS = { fast: "preset1", standard: "preset2", deep: "preset3" } as const satisfies Record<string, ModelPresetSlot>;

function toolTierName(slot: ModelPresetSlot | undefined): string | undefined {
  return (Object.keys(TOOL_MODEL_TIERS) as Array<keyof typeof TOOL_MODEL_TIERS>).find((name) => TOOL_MODEL_TIERS[name] === slot);
}

function mapTier(args: Record<string, unknown>): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(args, "modelTier") || args.modelTier === null || args.modelTier === "") return undefined;
  const value = args.modelTier;
  if (typeof value !== "string" || !Object.prototype.hasOwnProperty.call(TOOL_MODEL_TIERS, value)) return "modelTier must be fast, standard or deep.";
  args.modelTier = TOOL_MODEL_TIERS[value as keyof typeof TOOL_MODEL_TIERS];
  return undefined;
}

/** What a model sees of a trigger. */
export function formatTriggerForTool(trigger: Trigger, parentDelivery?: { status: string; error?: string }) {
  const action = trigger.action;
  return {
    triggerId: trigger.id,
    ...(trigger.name ? { name: trigger.name } : {}),
    then: action.kind === "chat" ? action.via : action.kind,
    ...(trigger.sessionId ? { sessionId: trigger.sessionId } : {}),
    ...(trigger.taskId ? { taskId: trigger.taskId } : {}),
    when: describeTriggerWhen(trigger.when),
    status: trigger.status,
    ...(trigger.nextRunAt ? { nextRunAt: trigger.nextRunAt } : {}),
    runCount: trigger.runCount,
    fireCount: trigger.fireCount,
    ...(trigger.maxRuns !== undefined ? { maxRuns: trigger.maxRuns } : {}),
    ...(trigger.expiresAt ? { expiresAt: trigger.expiresAt } : {}),
    prompt: trigger.prompt,
    ...(action.kind === "new_task" ? { title: action.title } : {}),
    ...(action.kind !== "chat" && action.modelTier ? { modelTier: toolTierName(action.modelTier) } : {}),
    ...(action.kind !== "chat" && action.playbook ? { playbook: action.playbook } : {}),
    ...(action.kind === "new_chat" && action.keepChats !== undefined ? { keepChats: action.keepChats } : {}),
    ...(trigger.check ? { check: trigger.check } : {}),
    ...(trigger.lastCheck ? { lastCheck: { at: trigger.lastCheck.at, outcome: trigger.lastCheck.outcome, exitCode: trigger.lastCheck.output?.exitCode } } : {}),
    ...(trigger.checkPending ? { checkPending: { at: trigger.checkPending.at, exitCode: trigger.checkPending.exitCode } } : {}),
    ...(trigger.checkpoint ? { checkpoint: trigger.checkpoint } : {}),
    ...(trigger.lastRunAt ? { lastRunAt: trigger.lastRunAt } : {}),
    ...(trigger.lastSessionId && action.kind !== "chat" ? { lastSessionId: trigger.lastSessionId } : {}),
    ...(trigger.lastTaskId ? { lastTaskId: trigger.lastTaskId } : {}),
    ...(trigger.lastError ? { lastError: trigger.lastError } : {}),
    ...(parentDelivery ? { parentDelivery } : {}),
  };
}

function toToolResult(result: TriggerResult, message: (trigger: Trigger) => string) {
  if (!result.ok) return toolFailure(result.error);
  return { success: true, message: message(result.trigger), trigger: formatTriggerForTool(result.trigger) };
}

const CHECK_SCHEMA = {
  type: "object",
  description: `A command the Bridge runs on the trigger's schedule, with no model and no shell, to decide whether it fires. Prefer it whenever the condition is machine-checkable (build status, PR state, a file, an HTTP endpoint read through a CLI): it lets the trigger run often and only use a model when something happened. fireOn "change" (default) fires when the exit code or stdout differ from the last check; the first result is the baseline. fireOn "exit_code" lets the command decide: exit 0 means nothing to do, ${TRIGGER_CHECK_EXIT_FIRE} fires, ${TRIGGER_CHECK_EXIT_FIRE_AND_STOP} fires and then stops the trigger, any other code is a failed check. Whatever fires gets the command's output.`,
  properties: {
    command: { type: "array", items: { type: "string" }, description: "Executable, then its arguments, e.g. [\"gh\", \"pr\", \"checks\", \"123\"]." },
    cwd: { type: "string", description: "Absolute working directory. Defaults to the chat's (or task's) working directory." },
    timeoutSeconds: { type: "number", description: `Seconds the command may run, 1 to ${TRIGGER_CHECK_MAX_TIMEOUT_SECONDS}. Default 60.` },
    fireOn: { type: "string", enum: ["change", "exit_code"], description: "How the check decides to fire. Default change." },
    fireOnFirstRun: { type: "boolean", description: "change checks only: fire on the first result too. Default false." },
  },
  required: ["command"],
} as const;

const TIMING_PROPERTIES = {
  delaySeconds: { type: "number", description: "Run once, this many seconds from now." },
  runAt: { type: "string", description: "Run once at this ISO timestamp." },
  intervalSeconds: { type: "number", description: `Run every N seconds: at least ${TRIGGER_MIN_CHECKED_INTERVAL_SECONDS} with a check, ${TRIGGER_MIN_UNCHECKED_INTERVAL_SECONDS} without.` },
  cron: { type: "string", description: "Run on a cron schedule, e.g. \"0 8 * * 1-5\" for weekdays at 8:00." },
  timezone: { type: "string", description: "IANA timezone for cron. Defaults to the Bridge's." },
} as const;

const ACTION_PROPERTIES = {
  title: { type: "string", description: "new_task only: title of each task it creates." },
  modelTier: { type: "string", enum: ["fast", "standard", "deep"], description: "new_chat and new_task: model tier from Settings › Models the started chat uses. Omit to follow the New chats setting." },
  playbook: { type: "string", description: "new_chat and new_task: playbook the started chat follows, e.g. \"watch\" or \"sweep\" (these also get the previous run's report)." },
  keepChats: { type: "integer", minimum: 0, description: "new_chat only: archive older started chats beyond this many." },
} as const;

type TriggerCheckArgs = {
  command: string[];
  cwd?: string;
  timeoutSeconds?: number;
  fireOn?: "change" | "exit_code";
  fireOnFirstRun?: boolean;
};
type TriggerTimingArgs = { delaySeconds?: number; runAt?: string; intervalSeconds?: number; cron?: string; timezone?: string };
type TriggerActionArgs = { title?: string; modelTier?: "fast" | "standard" | "deep"; playbook?: string; keepChats?: number };
type TriggerCreateArgs = TriggerTimingArgs & TriggerActionArgs & {
  prompt: string;
  name?: string;
  then?: TriggerThen;
  taskId?: string;
  check?: TriggerCheckArgs;
  maxRuns?: number;
  expiresAt?: string;
};
type TriggerListArgs = { taskId?: string; includeInactive?: boolean };
type TriggerUpdateArgs = TriggerTimingArgs & TriggerActionArgs & {
  triggerId: string;
  prompt?: string;
  name?: string;
  check?: TriggerCheckArgs | null;
  maxRuns?: number | null;
  expiresAt?: string | null;
  active?: boolean;
};
type TriggerIdArgs = { triggerId: string };

export interface RegisterTriggerToolsOptions {
  hiddenTools?: ReadonlySet<string>;
}

export function createTriggerToolDefinitions(ctx: AppContext): BridgeToolDefinition[] {
  const service = (): TriggerService => {
    if (!ctx.triggerService) throw new Error("Triggers are unavailable.");
    return ctx.triggerService;
  };
  const callerTaskId = (sessionId: string | undefined) => (sessionId ? ctx.taskStore.findTaskBySessionId(sessionId)?.id : undefined);
  /** A chat manages its own chat triggers and any task trigger, as it could manage schedules. */
  const notOwned = (triggerId: unknown, sessionId: string | undefined) => {
    const trigger = service().get(String(triggerId ?? ""));
    if (!trigger) return toolFailure(`Trigger ${String(triggerId)} not found.`);
    if (trigger.sessionId && sessionId && trigger.sessionId !== sessionId) {
      return toolFailure(`Trigger ${trigger.id} belongs to another chat.`);
    }
    return undefined;
  };

  return [
    defineBridgeTool("trigger_create", {
      description: [
        "Create a trigger: the Bridge's one kind of automation. A trigger has timing (once, every N seconds, or cron), an optional check command that decides with no model whether each run fires, and what it does when it fires (then):",
        "- worker (default from a chat): a temporary worker model runs the prompt as one bounded check and may report back to this chat. For recurring work, say in the prompt when to continue quietly, notify this chat and continue, finish quietly, or return to this chat and stop. Every notification or result starts a turn here that re-reads the whole conversation, so ask to be told only about a change you must act on or one the user asked for. Do not tell the worker to call trigger_cancel, task_complete, sleep or poll.",
        "- message: send the prompt (with the check's output) straight into this chat, no worker. Best with a check that already decides precisely.",
        "- new_chat: start a fresh chat in a task (taskId, defaults to this chat's task) with the prompt. For durable task automation such as a daily review.",
        `- new_task: create a task (title) in the same group as taskId and start its first chat. Needs maxRuns (at most ${TRIGGER_MAX_NEW_TASK_RUNS}) or expiresAt, and waits while the task it made last is still open.`,
        "Use a check whenever the condition is machine-checkable; it runs cheaply and often. Recurring chat triggers stop after 7 days unless maxRuns or expiresAt is set. Do not chain one-time triggers for polling; use intervalSeconds or cron.",
      ].join("\n"),
      parameters: {
        type: "object",
        properties: {
          prompt: { type: "string", description: "What runs when it fires: the worker's bounded check, the message for this chat, or the started chat's first message." },
          name: { type: "string", description: "Short name shown in lists." },
          then: { type: "string", enum: ["worker", "message", "new_chat", "new_task"], description: "What it does when it fires. Default worker." },
          taskId: { type: "string", description: "new_chat and new_task: the task it belongs to. Defaults to this chat's task." },
          ...TIMING_PROPERTIES,
          check: CHECK_SCHEMA,
          maxRuns: { type: "integer", minimum: 1, description: "Stop after this many runs (checks included)." },
          expiresAt: { type: "string", description: "Stop at this ISO timestamp." },
          ...ACTION_PROPERTIES,
        },
        required: ["prompt"],
        additionalProperties: false,
      },
      handler: async (rawArgs: TriggerCreateArgs, invocation) => {
        // mapTier rewrites modelTier from a tier name to a preset slot.
        const args: Record<string, unknown> = { ...rawArgs };
        const tierError = mapTier(args);
        if (tierError) return toolFailure(tierError);
        const sessionId: string | undefined = invocation?.sessionId;
        const ownTaskId = callerTaskId(sessionId);
        const then = args.then ?? "worker";
        const input: TriggerCreateInput = then === "worker" || then === "message"
          ? { ...args, then, sessionId }
          : { ...args, then, taskId: args.taskId ?? ownTaskId };
        if (input.taskId === undefined && (then === "new_chat" || then === "new_task")) {
          return toolFailure("This chat has no task; give taskId.");
        }
        const result = service().create(input, { sessionId, ...(ownTaskId ? { taskId: ownTaskId } : {}) });
        return toToolResult(result, (trigger) => `Trigger ${trigger.id} created: ${describeTriggerWhen(trigger.when)}, next run ${trigger.nextRunAt}.`);
      },
    }),

    defineBridgeTool("trigger_list", {
      description: "List triggers: this chat's, plus those of this chat's task. Give taskId for another task's. Shows timing, status, the check's last result and the worker's private checkpoint. Active ones only unless includeInactive.",
      parameters: {
        type: "object",
        properties: {
          taskId: { type: "string", description: "List this task's triggers instead." },
          includeInactive: { type: "boolean", description: "Also list completed, cancelled, expired and failed triggers." },
        },
        additionalProperties: false,
      },
      handler: async (args: TriggerListArgs, invocation) => {
        const store = ctx.triggerStore;
        if (!store) return toolFailure("Triggers are unavailable.");
        const includeInactive = args?.includeInactive === true;
        const sessionId: string | undefined = invocation?.sessionId;
        const taskId: string | undefined = args?.taskId ?? callerTaskId(sessionId);
        const own = !args?.taskId && sessionId ? store.list({ sessionId, includeInactive }) : [];
        const forTask = taskId ? store.list({ taskId, includeInactive }) : [];
        const deliveries = new Map<string, { status: string; error?: string }>();
        if (sessionId && ctx.deferredPromptStore) {
          for (const delivery of ctx.deferredPromptStore.listDeliveriesForSession(sessionId)) {
            if (!delivery.sourceId || delivery.status === "cancelled" || deliveries.has(delivery.sourceId)) continue;
            deliveries.set(delivery.sourceId, { status: delivery.status, ...(delivery.lastError ? { error: delivery.lastError } : {}) });
          }
        }
        const parentDelivery = (trigger: Trigger) => triggerDeliverySourceIds(trigger.id).map((id) => deliveries.get(id)).find(Boolean);
        return { triggers: [...own, ...forTask].map((trigger) => formatTriggerForTool(trigger, parentDelivery(trigger))) };
      },
    }),

    defineBridgeTool("trigger_update", {
      description: "Change a trigger: its prompt, name, timing, check (null removes it), limits, or new_chat/new_task options. active: false pauses it; active: true resumes a paused one or restarts a cancelled, expired, failed or completed one. A trigger that is running right now cannot be changed until its run ends.",
      parameters: {
        type: "object",
        properties: {
          triggerId: { type: "string", description: "The trigger's id (a once_ or interval_ defer id also works)." },
          prompt: { type: "string" },
          name: { type: "string" },
          ...TIMING_PROPERTIES,
          check: { ...CHECK_SCHEMA, type: ["object", "null"] },
          maxRuns: { type: ["integer", "null"], minimum: 1 },
          expiresAt: { type: ["string", "null"] },
          active: { type: "boolean", description: "false pauses; true resumes or restarts." },
          ...ACTION_PROPERTIES,
        },
        required: ["triggerId"],
        additionalProperties: false,
      },
      handler: async (rawArgs: TriggerUpdateArgs, invocation) => {
        const { triggerId, ...rest } = rawArgs;
        // mapTier rewrites modelTier from a tier name to a preset slot.
        const args: Record<string, unknown> = rest;
        const denied = notOwned(triggerId, invocation?.sessionId);
        if (denied) return denied;
        const tierError = mapTier(args);
        if (tierError) return toolFailure(tierError);
        const result = args.active === true && Object.keys(args).length === 1
          ? service().reactivate(String(triggerId))
          : service().update(String(triggerId), args);
        if (result.ok && "deliveryRetried" in result && result.deliveryRetried) {
          return { success: true, message: `The last result of trigger ${result.trigger.id} was queued for this chat again.`, trigger: formatTriggerForTool(result.trigger) };
        }
        return toToolResult(result, (trigger) => `Trigger ${trigger.id} is ${trigger.status}${trigger.nextRunAt && trigger.status === "active" ? `, next run ${trigger.nextRunAt}` : ""}.`);
      },
    }),

    defineBridgeTool("trigger_run", {
      description: "Run an active trigger now, skipping its check. A cron trigger keeps its next slot; an interval starts counting again.",
      parameters: {
        type: "object",
        properties: { triggerId: { type: "string" } },
        required: ["triggerId"],
        additionalProperties: false,
      },
      handler: async (args: TriggerIdArgs, invocation) => notOwned(args.triggerId, invocation?.sessionId)
        ?? toToolResult(service().runNow(String(args.triggerId)), (trigger) => `Trigger ${trigger.id} will run now.`),
    }),

    defineBridgeTool("trigger_cancel", {
      description: "Stop a trigger. It stays listed as cancelled and can be restarted with trigger_update active: true.",
      parameters: {
        type: "object",
        properties: { triggerId: { type: "string", description: "The trigger's id (a once_ or interval_ defer id also works)." } },
        required: ["triggerId"],
        additionalProperties: false,
      },
      handler: async (args: TriggerIdArgs, invocation) => notOwned(args.triggerId, invocation?.sessionId)
        ?? toToolResult(service().cancel(String(args.triggerId)), (trigger) => `Trigger ${trigger.id} cancelled.`),
    }),

    defineBridgeTool("trigger_delete", {
      description: "Delete a trigger and its run history. Chats and tasks it started stay.",
      parameters: {
        type: "object",
        properties: { triggerId: { type: "string" } },
        required: ["triggerId"],
        additionalProperties: false,
      },
      handler: async (args: TriggerIdArgs, invocation) => notOwned(args.triggerId, invocation?.sessionId)
        ?? toToolResult(service().remove(String(args.triggerId)), (trigger) => `Trigger ${trigger.id} deleted.`),
    }),
  ];
}

export function registerTriggerTools(server: BridgeToolsMcpServer, ctx: AppContext, options: RegisterTriggerToolsOptions = {}): void {
  registerBridgeToolDefinitions(server, createTriggerToolDefinitions(ctx).filter((tool) => !options.hiddenTools?.has(tool.name)));
}
