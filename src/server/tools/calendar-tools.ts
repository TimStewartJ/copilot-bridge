import type { AppContext } from "../app-context.js";
import { CALENDAR_MAX_BATCH } from "../../shared/calendar.js";
import { isRecord } from "../../shared/is-record.js";
import { CalendarNotFoundError, CalendarValidationError } from "../calendar-store.js";
import { createCalendarSources } from "../calendar-router.js";
import { buildCalendar, CalendarRangeError } from "../calendar-view.js";
import { getServerTimezone } from "../schedule-store.js";
import { toolFailure } from "../tool-results.js";
import {
  defineBridgeTool,
  registerBridgeToolDefinitions,
  type BridgeToolDefinition,
  type BridgeToolsMcpServer,
} from "../agent-tools-mcp/index.js";

const EVENT_FIELDS = {
  title: { type: "string", description: "What the event is." },
  allDay: { type: "boolean", description: "True for a whole-day event; start and end are then dates (YYYY-MM-DD, end inclusive)." },
  start: { type: "string", description: "Timed: ISO date-time with offset, e.g. 2026-05-01T15:00:00-07:00. All-day: YYYY-MM-DD." },
  end: { type: "string", description: "Same form as start. Timed events default to one hour; all-day to one day." },
  timezone: { type: "string", description: "IANA zone repeats keep their clock time in. Defaults to the Bridge's zone." },
  repeat: {
    type: ["object", "null"],
    description: "Repeat the event; null stops repeating.",
    properties: {
      every: { type: "string", enum: ["day", "week", "month", "year"] },
      interval: { type: "number", description: "Every how many units. Default 1." },
      until: { type: "string", description: "Last date (YYYY-MM-DD) an occurrence may start." },
    },
    required: ["every"],
  },
  location: { type: ["string", "null"], description: "Where. Optional." },
  notes: { type: ["string", "null"], description: "Details. Optional." },
  taskId: { type: ["string", "null"], description: "Bridge task the event belongs to. Optional." },
  externalId: {
    type: ["string", "null"],
    description: "The event's ID in a calendar it is imported from, any string up to 512 characters. Unique: saving an event with an externalId that already exists updates that event. Optional.",
  },
} as const;

function calendarToolFailure(error: unknown) {
  if (error instanceof CalendarValidationError || error instanceof CalendarNotFoundError || error instanceof CalendarRangeError) {
    return toolFailure(error.message);
  }
  throw error;
}

const withDefaults = (event: unknown) => (isRecord(event) ? { allDay: false, timezone: getServerTimezone(), ...event } : event);

export function createCalendarToolDefinitions(ctx: AppContext): BridgeToolDefinition[] {
  const store = ctx.calendarStore;
  if (!store) return [];
  const calendarCtx = { ...ctx, calendarStore: store };
  return [
    defineBridgeTool("calendar_list", {
      description: "List the Bridge calendar for a date range: the user's events plus checklist deadlines, task revisits and, on request, scheduled agent runs. The Bridge calendar is the user's main calendar.",
      parameters: {
        type: "object",
        properties: {
          from: { type: "string", description: "First date, YYYY-MM-DD." },
          to: { type: "string", description: "Last date, YYYY-MM-DD, inclusive; at most 62 days after from." },
          timezone: { type: "string", description: "IANA zone the dates are in. Defaults to the Bridge's zone." },
          includeRuns: { type: "boolean", description: "Include scheduled agent runs. Default false." },
        },
        required: ["from", "to"],
      },
      handler: async (args: any) => {
        try {
          const calendar = buildCalendar(createCalendarSources(calendarCtx), {
            from: args.from, to: args.to, timezone: args.timezone ?? getServerTimezone(),
          });
          return args.includeRuns ? calendar : { ...calendar, items: calendar.items.filter((item) => item.kind !== "run"), runCounts: undefined };
        } catch (error) {
          return calendarToolFailure(error);
        }
      },
    }),
    defineBridgeTool("calendar_event_create", {
      description: `Add an event to the user's calendar, which is the Bridge calendar, or several at once with events (at most ${CALENDAR_MAX_BATCH} per call, saved all or none). An event whose externalId already exists updates that event in place, keeping its eventId and its task unless taskId is given, so importing the same events again changes nothing. Returns created, updated or unchanged for each event. Events send no alerts; add a reminder as well when the user needs one.`,
      parameters: {
        type: "object",
        properties: {
          ...EVENT_FIELDS,
          events: {
            type: "array",
            maxItems: CALENDAR_MAX_BATCH,
            description: "Several events, each with the fields above. Use instead of the single-event fields.",
            items: { type: "object", properties: EVENT_FIELDS, required: ["title", "start"] },
          },
        },
      },
      handler: async (args: any) => {
        const { events, ...single } = args ?? {};
        try {
          if (events === undefined) {
            const [saved] = store.saveEvents([withDefaults(single)], "agent");
            return { success: true, result: saved.result, event: saved.event };
          }
          if (Object.keys(single).length) return toolFailure("Pass events or one event's fields, not both");
          const saved = store.saveEvents((events as unknown[]).map(withDefaults), "agent");
          const count = (result: string) => saved.filter((entry) => entry.result === result).length;
          return {
            success: true,
            created: count("created"),
            updated: count("updated"),
            unchanged: count("unchanged"),
            results: saved.map(({ result, event }) => ({ eventId: event.id, ...(event.externalId ? { externalId: event.externalId } : {}), result })),
          };
        } catch (error) {
          return calendarToolFailure(error);
        }
      },
    }),
    defineBridgeTool("calendar_event_update", {
      description: "Change a Bridge calendar event. Applies to every repeat of a repeating event. Changing allDay needs a new start and end.",
      parameters: {
        type: "object",
        properties: { eventId: { type: "string", description: "Event ID from calendar_list (eventId)." }, ...EVENT_FIELDS },
        required: ["eventId"],
      },
      handler: async (args: any) => {
        const { eventId, ...updates } = args ?? {};
        try {
          return { success: true, event: store.updateEvent(eventId, updates) };
        } catch (error) {
          return calendarToolFailure(error);
        }
      },
    }),
    defineBridgeTool("calendar_event_delete", {
      description: `Delete a Bridge calendar event, with every repeat, or several with eventIds (at most ${CALENDAR_MAX_BATCH}). Only when the user asks, or to remove imported events (those with an externalId) that their source calendar no longer has. A list reports which IDs were deleted and which were not found.`,
      parameters: {
        type: "object",
        properties: {
          eventId: { type: "string", description: "Event ID from calendar_list (eventId)." },
          eventIds: { type: "array", maxItems: CALENDAR_MAX_BATCH, items: { type: "string" }, description: "Several event IDs. Use instead of eventId." },
        },
      },
      handler: async (args: any) => {
        try {
          if (args?.eventIds !== undefined) {
            if (args.eventId !== undefined) return toolFailure("Pass eventId or eventIds, not both");
            return { success: true, ...store.deleteEvents(args.eventIds) };
          }
          if (typeof args?.eventId !== "string" || !args.eventId) return toolFailure("Pass eventId or eventIds");
          store.deleteEvent(args.eventId);
          return { success: true };
        } catch (error) {
          return calendarToolFailure(error);
        }
      },
    }),
  ];
}

export function registerCalendarTools(
  server: BridgeToolsMcpServer,
  ctx: AppContext,
  options: { hiddenTools?: ReadonlySet<string> } = {},
): void {
  registerBridgeToolDefinitions(
    server,
    createCalendarToolDefinitions(ctx).filter((tool) => !options.hiddenTools?.has(tool.name)),
  );
}
