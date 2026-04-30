import { defineTool } from "@github/copilot-sdk";
import * as schedulerModule from "../scheduler.js";
import type { ScheduleSessionMode } from "../schedule-store.js";
import { toolFailure } from "../tool-results.js";
import type { AppContext } from "../app-context.js";
import { ensureTask } from "./helpers.js";

const SCHEDULE_SESSION_MODES = ["new", "reuse-last"] as const;

function isScheduleSessionMode(value: unknown): value is ScheduleSessionMode {
  return typeof value === "string" && (SCHEDULE_SESSION_MODES as readonly string[]).includes(value);
}

export function createScheduleTools(ctx: AppContext) {
  return [
  defineTool("schedule_create", {
    description: "Create a scheduled session that runs automatically on a cron schedule or at a specific time. The schedule belongs to a task and will create sessions linked to that task when triggered.",
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
        sessionMode: {
          type: "string",
          enum: ["new", "reuse-last"],
          description: "How the schedule chooses its session: 'new' creates a fresh session each run, and 'reuse-last' continues the last session used by this schedule.",
        },
        maxRuns: { type: "number", description: "Auto-disable after N runs (optional)" },
        expiresAt: { type: "string", description: "ISO timestamp after which the schedule auto-disables (optional)" },
      },
      required: ["taskId", "name", "prompt", "type"],
    },
    handler: async (args: any) => {
      if (Object.prototype.hasOwnProperty.call(args, "targetSessionId")) {
        return toolFailure("targetSessionId is no longer supported for schedules; use defer_session for same-session follow-ups");
      }
      if (args.type === "cron" && !args.cron) return toolFailure("cron expression is required for cron schedules");
      if (args.type === "once" && !args.runAt) return toolFailure("runAt is required for one-shot schedules");
      if (args.timezone && !schedulerModule.isValidTimezone(args.timezone)) return toolFailure(`Invalid timezone: ${args.timezone}`);
      if (args.sessionMode !== undefined && !isScheduleSessionMode(args.sessionMode)) {
        return toolFailure(`Invalid sessionMode: ${String(args.sessionMode)}`);
      }
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
        sessionMode: args.sessionMode ?? "new",
        maxRuns: args.maxRuns,
        expiresAt: args.expiresAt,
      });

      if (schedule.type === "cron") {
        schedulerModule.registerSchedule(schedule.id);
      } else if (schedule.type === "once" && schedule.runAt) {
        schedulerModule.armOneShot(schedule.id, schedule.runAt);
      }

      ctx.globalBus.emit({ type: "schedule:changed", taskId: schedule.taskId, scheduleId: schedule.id });
      return { success: true, message: `Schedule "${schedule.name}" created (${schedule.type})`, scheduleId: schedule.id, timezone: schedule.timezone, nextRunAt: schedule.nextRunAt };
    },
  }),
  defineTool("schedule_update", {
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
        enabled: { type: "boolean", description: "Enable or disable the schedule" },
        sessionMode: {
          type: "string",
          enum: ["new", "reuse-last"],
          description: "Change how the schedule chooses its session.",
        },
        maxRuns: { type: "number", description: "Auto-disable after N runs" },
        expiresAt: { type: "string", description: "ISO timestamp after which the schedule auto-disables" },
      },
      required: ["scheduleId"],
    },
    handler: async (args: any) => {
      if (Object.prototype.hasOwnProperty.call(args, "targetSessionId")) {
        return toolFailure("targetSessionId is no longer supported for schedules; use defer_session for same-session follow-ups");
      }
      const { scheduleId, ...updates } = args;
      if (Object.keys(updates).length === 0) return toolFailure("No fields to update");
      if (args.timezone && !schedulerModule.isValidTimezone(args.timezone)) return toolFailure(`Invalid timezone: ${args.timezone}`);
      if (args.sessionMode !== undefined && !isScheduleSessionMode(args.sessionMode)) {
        return toolFailure(`Invalid sessionMode: ${String(args.sessionMode)}`);
      }
      const existing = ctx.scheduleStore.getSchedule(scheduleId);
      if (!existing) return toolFailure(`Schedule ${scheduleId} not found`);

      const nextUpdates = { ...updates };
      if (args.sessionMode !== undefined) {
        nextUpdates.sessionMode = args.sessionMode;
      }

      const schedule = ctx.scheduleStore.updateSchedule(scheduleId, nextUpdates);

      if (schedule.type === "cron") {
        if (schedule.enabled) schedulerModule.registerSchedule(schedule.id);
        else schedulerModule.unregisterSchedule(schedule.id);
      } else if (schedule.type === "once" && args.runAt && schedule.enabled) {
        schedulerModule.armOneShot(schedule.id, schedule.runAt!);
      }

      ctx.globalBus.emit({ type: "schedule:changed", taskId: schedule.taskId, scheduleId: schedule.id });
      return { success: true, message: `Schedule "${schedule.name}" updated`, nextRunAt: schedule.nextRunAt };
    },
  }),
  defineTool("schedule_delete", {
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
      schedulerModule.unregisterSchedule(args.scheduleId);
      ctx.scheduleStore.deleteSchedule(args.scheduleId);
      if (taskId) ctx.globalBus.emit({ type: "schedule:changed", taskId, scheduleId: args.scheduleId });
      return { success: true, message: "Schedule deleted" };
    },
  }),
  defineTool("schedule_list", {
    description: "List all scheduled sessions, optionally filtered by task.",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string", description: "Filter by task ID (optional)" },
      },
    },
    handler: async (args: any) => {
      const schedules = ctx.scheduleStore.listSchedules(args.taskId);
      return {
        schedules: schedules.map((s) => ({
          id: s.id,
          taskId: s.taskId,
          name: s.name,
          type: s.type,
          cron: s.cron,
          runAt: s.runAt,
          timezone: s.timezone,
          enabled: s.enabled,
          sessionMode: s.sessionMode,
          lastRunAt: s.lastRunAt,
          nextRunAt: s.nextRunAt,
          runCount: s.runCount,
          prompt: s.prompt,
          maxRuns: s.maxRuns,
          expiresAt: s.expiresAt,
        })),
      };
    },
  }),
  defineTool("schedule_trigger", {
    description: "Manually trigger a scheduled session right now, regardless of its cron schedule.",
    parameters: {
      type: "object",
      properties: {
        scheduleId: { type: "string", description: "The schedule ID to trigger" },
      },
      required: ["scheduleId"],
    },
    handler: async (args: any) => {
      const result = await schedulerModule.triggerSchedule(args.scheduleId);
      return result;
    },
  }),
  ];
}
