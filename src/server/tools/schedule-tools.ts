import { basename, dirname, sep } from "node:path";
import { fileURLToPath } from "node:url";
import * as schedulerModule from "../scheduler.js";
import { enforceScheduleSessionRetention } from "../schedule-session-retention.js";
import {
  findUnknownFields,
  formatUnknownFieldsError,
  normalizeScheduleAutoArchiveKeep,
  normalizeScheduleModel,
} from "../schedule-validation.js";
import { toolFailure } from "../tool-results.js";
import type { AppContext } from "../app-context.js";
import { ensureTask } from "./helpers.js";
import {
  defineBridgeTool,
  registerBridgeToolDefinitions,
  type BridgeToolDefinition,
  type BridgeToolsMcpServer,
} from "../agent-tools-mcp/index.js";

function isPathAtOrUnder(parent: string, candidate: string): boolean {
  const parentWithSeparator = parent.endsWith(sep) ? parent : `${parent}${sep}`;
  return candidate === parent || candidate.startsWith(parentWithSeparator);
}

function isLocalStagingModule(ctx: AppContext): boolean {
  const dataDir = ctx.runtimePaths?.dataDir;
  if (!dataDir) return false;
  const dataFolder = basename(dataDir);
  if (dataFolder !== "data") return false;
  try {
    return isPathAtOrUnder(dirname(dataDir), fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

function getScheduler(ctx: AppContext): typeof schedulerModule {
  if (ctx.scheduler) return ctx.scheduler;
  if (ctx.isStaging) {
    if (!isLocalStagingModule(ctx)) {
      throw new Error("Staging schedules require an isolated scheduler module.");
    }
    schedulerModule.shutdown();
    schedulerModule.initialize(ctx.sessionManager, {
      scheduleStore: ctx.scheduleStore,
      taskStore: ctx.taskStore,
      sessionMetaStore: ctx.sessionMetaStore,
      globalBus: ctx.globalBus,
      deferredPromptStore: ctx.deferredPromptStore,
      deferLoopStore: ctx.deferLoopStore,
    });
    ctx.scheduler = schedulerModule;
  }
  return schedulerModule;
}

async function enforceRetentionForSchedule(ctx: AppContext, schedule: Parameters<typeof enforceScheduleSessionRetention>[0]["schedule"]): Promise<void> {
  try {
    await enforceScheduleSessionRetention({
      schedule,
      sessionMetaStore: ctx.sessionMetaStore,
      sessionManager: ctx.sessionManager,
      globalBus: ctx.globalBus,
      deferredPromptStore: ctx.deferredPromptStore,
      deferLoopStore: ctx.deferLoopStore,
    });
  } catch (err) {
    console.warn(`[schedule-tools] Failed to apply retention for "${schedule.name}" (${schedule.id}):`, err);
  }
}

const SCHEDULE_CREATE_FIELDS = [
  "taskId",
  "name",
  "prompt",
  "type",
  "cron",
  "runAt",
  "timezone",
  "model",
  "maxRuns",
  "expiresAt",
  "autoArchiveKeep",
] as const;
const SCHEDULE_UPDATE_FIELDS = [
  "scheduleId",
  "name",
  "prompt",
  "cron",
  "runAt",
  "timezone",
  "model",
  "enabled",
  "maxRuns",
  "expiresAt",
  "autoArchiveKeep",
] as const;

function rejectUnknownFields(args: unknown, allowedFields: readonly string[]) {
  const unknownFields = findUnknownFields(args, allowedFields);
  return unknownFields.length > 0 ? toolFailure(formatUnknownFieldsError(unknownFields)) : undefined;
}

export interface RegisterScheduleToolsOptions {
  hiddenTools?: ReadonlySet<string>;
}

export function createScheduleToolDefinitions(ctx: AppContext): BridgeToolDefinition[] {
  return [
  defineBridgeTool("schedule_create", {
    description: "Create durable task-level automation that runs on a cron schedule or at a specific time. Each trigger starts a fresh session linked to the task. For same-session follow-up or polling, use defer_create instead.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "The task ID this schedule belongs to" },
        name: { type: "string", description: "Human-readable name (e.g. 'Daily standup prep')" },
        prompt: { type: "string", description: "The message to send when the schedule fires" },
        type: { type: "string", enum: ["cron", "once"], description: "Schedule type: 'cron' for recurring, 'once' for one-shot" },
        cron: { type: "string", description: "Cron expression (e.g. '0 8 * * 1-5' for weekdays at 8am). Required for type=cron. Interpreted in the schedule's timezone (server-local by default)." },
        runAt: { type: "string", description: "ISO timestamp for one-shot runs (e.g. '2026-03-21T18:00:00Z'). Required for type=once. Always interpreted as UTC." },
        timezone: { type: "string", description: "IANA timezone for cron interpretation (e.g. 'America/New_York'). Defaults to server-local timezone if omitted." },
        model: { type: "string", description: "AI model ID for sessions created by this schedule. Omit to use the global Bridge default." },
        maxRuns: { type: "number", description: "Auto-disable after N runs (optional)" },
        expiresAt: { type: "string", description: "ISO timestamp after which the schedule auto-disables (optional)" },
        autoArchiveKeep: { type: "number", description: "Auto-archive older run sessions after keeping the latest N sessions active (optional)" },
      },
      required: ["taskId", "name", "prompt", "type"],
    },
    handler: async (args: any) => {
      const unknownFieldFailure = rejectUnknownFields(args, SCHEDULE_CREATE_FIELDS);
      if (unknownFieldFailure) return unknownFieldFailure;
      if (args.type === "cron" && !args.cron) return toolFailure("cron expression is required for cron schedules");
      if (args.type === "once" && !args.runAt) return toolFailure("runAt is required for one-shot schedules");
      const scheduler = getScheduler(ctx);
      if (args.timezone && !scheduler.isValidTimezone(args.timezone)) return toolFailure(`Invalid timezone: ${args.timezone}`);
      const autoArchiveKeepProvided = Object.prototype.hasOwnProperty.call(args, "autoArchiveKeep");
      const normalizedAutoArchiveKeep = normalizeScheduleAutoArchiveKeep(args.autoArchiveKeep);
      if (!normalizedAutoArchiveKeep.ok) return toolFailure(normalizedAutoArchiveKeep.error);
      const normalizedModel = normalizeScheduleModel(args.model);
      if (!normalizedModel.ok) return toolFailure(normalizedModel.error);
      const task = ensureTask(ctx, args.taskId);
      if (!task.ok) return toolFailure(task.error);

      const schedule = ctx.scheduleStore.createSchedule({
        taskId: args.taskId,
        name: args.name,
        prompt: args.prompt,
        type: args.type,
        cron: args.cron,
        runAt: args.runAt,
        timezone: args.timezone,
        model: normalizedModel.value ?? undefined,
        maxRuns: args.maxRuns,
        expiresAt: args.expiresAt,
        autoArchiveKeep: normalizedAutoArchiveKeep.value ?? undefined,
      });
      if (autoArchiveKeepProvided && schedule.autoArchiveKeep !== undefined) {
        await enforceRetentionForSchedule(ctx, schedule);
      }

      if (schedule.type === "cron") {
        scheduler.registerSchedule(schedule.id);
      } else if (schedule.type === "once" && schedule.runAt) {
        scheduler.armOneShot(schedule.id, schedule.runAt);
      }

      ctx.globalBus.emit({ type: "schedule:changed", taskId: schedule.taskId, scheduleId: schedule.id });
      return { success: true, message: `Schedule "${schedule.name}" created (${schedule.type})`, scheduleId: schedule.id, timezone: schedule.timezone, nextRunAt: schedule.nextRunAt };
    },
  }),
  defineBridgeTool("schedule_update", {
    description: "Update a scheduled session's settings. Only provided fields are changed.",
    parameters: {
      type: "object",
      properties: {
        scheduleId: { type: "string", description: "The schedule ID to update" },
        name: { type: "string", description: "New name" },
        prompt: { type: "string", description: "New prompt text" },
        cron: { type: "string", description: "New cron expression" },
        runAt: { type: "string", description: "New one-shot run time (ISO timestamp)" },
        timezone: { type: "string", description: "IANA timezone for cron interpretation (e.g. 'America/Los_Angeles')" },
        model: { type: ["string", "null"], description: "AI model ID for future schedule runs. Null clears the override and restores the global Bridge default." },
        enabled: { type: "boolean", description: "Enable or disable the schedule" },
        maxRuns: { type: "number", description: "Auto-disable after N runs" },
        expiresAt: { type: "string", description: "ISO timestamp after which the schedule auto-disables" },
        autoArchiveKeep: { type: ["number", "null"], description: "Auto-archive older run sessions after keeping the latest N sessions active. Null disables auto-archive." },
      },
      required: ["scheduleId"],
    },
    handler: async (args: any) => {
      const unknownFieldFailure = rejectUnknownFields(args, SCHEDULE_UPDATE_FIELDS);
      if (unknownFieldFailure) return unknownFieldFailure;
      const { scheduleId, ...updates } = args;
      if (Object.keys(updates).length === 0) return toolFailure("No fields to update");
      const scheduler = getScheduler(ctx);
      if (args.timezone && !scheduler.isValidTimezone(args.timezone)) return toolFailure(`Invalid timezone: ${args.timezone}`);
      const modelProvided = Object.prototype.hasOwnProperty.call(updates, "model");
      if (modelProvided) {
        const normalizedModel = normalizeScheduleModel(updates.model);
        if (!normalizedModel.ok) return toolFailure(normalizedModel.error);
        updates.model = normalizedModel.value;
      }
      const autoArchiveKeepProvided = Object.prototype.hasOwnProperty.call(updates, "autoArchiveKeep");
      if (autoArchiveKeepProvided) {
        const normalizedAutoArchiveKeep = normalizeScheduleAutoArchiveKeep(updates.autoArchiveKeep);
        if (!normalizedAutoArchiveKeep.ok) return toolFailure(normalizedAutoArchiveKeep.error);
        updates.autoArchiveKeep = normalizedAutoArchiveKeep.value;
      }
      const existing = ctx.scheduleStore.getSchedule(scheduleId);
      if (!existing) return toolFailure(`Schedule ${scheduleId} not found`);

      const schedule = ctx.scheduleStore.updateSchedule(scheduleId, updates);
      if (autoArchiveKeepProvided && schedule.autoArchiveKeep !== undefined) {
        await enforceRetentionForSchedule(ctx, schedule);
      }

      if (schedule.type === "cron") {
        if (schedule.enabled) scheduler.registerSchedule(schedule.id);
        else scheduler.unregisterSchedule(schedule.id);
      } else if (schedule.type === "once" && args.runAt && schedule.enabled) {
        scheduler.armOneShot(schedule.id, schedule.runAt!);
      }

      ctx.globalBus.emit({ type: "schedule:changed", taskId: schedule.taskId, scheduleId: schedule.id });
      return { success: true, message: `Schedule "${schedule.name}" updated`, nextRunAt: schedule.nextRunAt };
    },
  }),
  defineBridgeTool("schedule_delete", {
    description: "Delete a scheduled session permanently.",
    parameters: {
      type: "object",
      properties: {
        scheduleId: { type: "string", description: "The schedule ID to delete" },
      },
      required: ["scheduleId"],
    },
    handler: async (args: any) => {
      const schedule = ctx.scheduleStore.getSchedule(args.scheduleId);
      const taskId = schedule?.taskId;
      const scheduler = getScheduler(ctx);
      scheduler.unregisterSchedule(args.scheduleId);
      ctx.scheduleStore.deleteSchedule(args.scheduleId);
      if (taskId) ctx.globalBus.emit({ type: "schedule:changed", taskId, scheduleId: args.scheduleId });
      return { success: true, message: "Schedule deleted" };
    },
  }),
  defineBridgeTool("schedule_list", {
    description: "List all scheduled sessions, optionally filtered by task and/or name.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Filter by task ID (optional)" },
        name: {
          type: "string",
          description: "Filter by schedule name (optional). Case-insensitive substring match.",
        },
      },
    },
    handler: async (args: any) => {
      let schedules = ctx.scheduleStore.listSchedules(args.taskId);
      if (typeof args.name === "string" && args.name.trim() !== "") {
        const needle = args.name.trim().toLowerCase();
        schedules = schedules.filter((s) => s.name.toLowerCase().includes(needle));
      }
      return {
        schedules: schedules.map((s) => ({
          id: s.id,
          taskId: s.taskId,
          name: s.name,
          type: s.type,
          cron: s.cron,
          runAt: s.runAt,
          timezone: s.timezone,
          model: s.model,
          enabled: s.enabled,
          lastRunAt: s.lastRunAt,
          nextRunAt: s.nextRunAt,
          runCount: s.runCount,
          prompt: s.prompt,
          maxRuns: s.maxRuns,
          expiresAt: s.expiresAt,
          autoArchiveKeep: s.autoArchiveKeep,
        })),
      };
    },
  }),
  defineBridgeTool("schedule_trigger", {
    description: "Manually trigger a scheduled session right now, regardless of its cron schedule.",
    parameters: {
      type: "object",
      properties: {
        scheduleId: { type: "string", description: "The schedule ID to trigger" },
      },
      required: ["scheduleId"],
    },
    handler: async (args: any) => {
      const scheduler = getScheduler(ctx);
      const result = await scheduler.triggerSchedule(args.scheduleId);
      return result;
    },
  }),
  ];
}

export function registerScheduleTools(
  server: BridgeToolsMcpServer,
  ctx: AppContext,
  options: RegisterScheduleToolsOptions = {},
): void {
  const definitions = createScheduleToolDefinitions(ctx)
    .filter((tool) => !options.hiddenTools?.has(tool.name));
  registerBridgeToolDefinitions(server, definitions);
}
