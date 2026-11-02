// HTTP routes for the calendar: the combined view and the Bridge's own events.

import type { Router } from "express";
import type { AppContext } from "./app-context.js";
import { CalendarNotFoundError, CalendarValidationError, type CalendarStore } from "./calendar-store.js";
import { buildCalendar, CalendarRangeError, type CalendarQuery, type CalendarSources } from "./calendar-view.js";
import { getServerTimezone } from "./schedule-store.js";

type CalendarContext = Pick<AppContext, "checklistStore" | "taskStore" | "scheduleStore" | "helmThinkerStore"> & { calendarStore: CalendarStore };

/** What the calendar reads, gathered once per request. */
export function createCalendarSources(ctx: CalendarContext): CalendarSources {
  const tasks = ctx.taskStore.listTasksWithoutSessions();
  const titles = new Map(tasks.map((task) => [task.id, task.title]));
  return {
    listEvents: (options) => ctx.calendarStore.listEvents(options),
    listDeadlines: (from, to, taskId) => ctx.checklistStore.listChecklistItemsByDeadline(from, to, taskId),
    deadlineSummary: (before, limit, taskId) => ctx.checklistStore.listDeadlineSummary(before, limit, taskId),
    listRevisits: () => tasks
      .filter((task) => task.status === "active" && task.nextTouchAt && Number.isFinite(Date.parse(task.nextTouchAt)))
      .map((task) => ({ id: task.id, title: task.title, nextTouchAt: task.nextTouchAt!, deferred: !!task.deferred })),
    listEnabledSchedules: () => ctx.scheduleStore.getEnabledSchedules(),
    taskTitle: (taskId) => titles.get(taskId),
    helmLookTimes: () => {
      const settings = ctx.helmThinkerStore?.getSettings();
      return settings?.enabled ? settings.times : [];
    },
    serverTimezone: getServerTimezone(),
  };
}

function sendError(res: { status(code: number): { json(body: unknown): void } }, error: unknown): void {
  if (error instanceof CalendarValidationError || error instanceof CalendarRangeError) { res.status(400).json({ error: error.message }); return; }
  if (error instanceof CalendarNotFoundError) { res.status(404).json({ error: error.message }); return; }
  throw error;
}

function one(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function registerCalendarRoutes(router: Router, ctx: CalendarContext): void {
  router.get("/calendar", (req, res) => {
    const query: CalendarQuery = {
      from: one(req.query.from) ?? "",
      to: one(req.query.to) ?? "",
      timezone: one(req.query.timezone) ?? getServerTimezone(),
      ...(one(req.query.taskId) ? { taskId: one(req.query.taskId) } : {}),
    };
    try { res.json(buildCalendar(createCalendarSources(ctx), query)); } catch (error) { sendError(res, error); }
  });
  router.get("/calendar/events/:id", (req, res) => {
    const event = ctx.calendarStore.getEvent(req.params.id);
    if (!event) { res.status(404).json({ error: "Event not found" }); return; }
    res.json({ event });
  });
  router.post("/calendar/events", (req, res) => {
    try {
      // An externalId that already exists updates that event instead of adding one.
      const [saved] = ctx.calendarStore.saveEvents([req.body], "user");
      res.status(saved.result === "created" ? 201 : 200).json({ event: saved.event, result: saved.result });
    } catch (error) { sendError(res, error); }
  });
  router.patch("/calendar/events/:id", (req, res) => {
    try { res.json({ event: ctx.calendarStore.updateEvent(req.params.id, req.body) }); } catch (error) { sendError(res, error); }
  });
  router.delete("/calendar/events/:id", (req, res) => {
    try { ctx.calendarStore.deleteEvent(req.params.id); res.json({ success: true }); } catch (error) { sendError(res, error); }
  });
}
