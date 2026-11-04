import { describe, expect, it } from "vitest";
import type { CalendarEvent } from "../../shared/calendar.js";
import { buildCalendar, CalendarRangeError, type CalendarSources } from "../calendar-view.js";
import type { ChecklistItem } from "../checklist-store.js";
import type { Schedule } from "../schedule-store.js";

const LA = "America/Los_Angeles";
// Monday 2 November 2026, 08:00 in Los Angeles.
const NOW = new Date("2026-11-02T16:00:00.000Z");

function event(overrides: Partial<CalendarEvent>): CalendarEvent {
  return {
    id: "e1", title: "Event", allDay: false, start: "2026-11-02T17:00:00.000Z", end: "2026-11-02T18:00:00.000Z",
    timezone: LA, createdBy: "user", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function schedule(overrides: Partial<Schedule>): Schedule {
  return {
    id: "s1", taskId: "t1", name: "Digest", prompt: "", type: "cron", cron: "0 9 * * *", timezone: LA, enabled: true,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z", runCount: 0,
    ...overrides,
  };
}

function sources(parts: {
  events?: CalendarEvent[];
  deadlines?: Array<ChecklistItem & { taskTitle?: string }>;
  overdue?: Array<ChecklistItem & { taskTitle?: string }>;
  revisits?: Array<{ id: string; title: string; nextTouchAt: string; deferred: boolean }>;
  schedules?: Schedule[];
  helm?: string[];
} = {}): CalendarSources {
  return {
    listEvents: () => parts.events ?? [],
    listDeadlines: (from, to) => (parts.deadlines ?? []).filter((item) => item.deadline! >= from && item.deadline! <= to),
    deadlineSummary: () => ({ overdue: parts.overdue ?? [], overdueTotal: (parts.overdue ?? []).length, undated: 4 }),
    listRevisits: () => parts.revisits ?? [],
    listEnabledSchedules: () => parts.schedules ?? [],
    taskTitle: () => "A task",
    helmLookTimes: () => parts.helm ?? [],
    serverTimezone: LA,
  };
}

const starts = (calendar: ReturnType<typeof buildCalendar>, kind = "event") =>
  calendar.items.filter((item) => item.kind === kind).map((item) => item.start);

describe("buildCalendar events", () => {
  it.each([
    {
      name: "a weekly event keeps its clock time across the end of daylight saving",
      event: event({ start: "2026-10-25T17:00:00.000Z", end: "2026-10-25T18:00:00.000Z", repeat: { every: "week", interval: 1 } }),
      from: "2026-10-25", to: "2026-11-08", zone: LA,
      expected: ["2026-10-25T17:00:00.000Z", "2026-11-01T18:00:00.000Z", "2026-11-08T18:00:00.000Z"],
    },
    {
      name: "a time inside the spring-forward gap is read with the offset before it",
      event: event({ start: "2027-03-13T10:30:00.000Z", end: "2027-03-13T11:00:00.000Z", repeat: { every: "day", interval: 1 } }),
      from: "2027-03-13", to: "2027-03-15", zone: LA,
      expected: ["2027-03-13T10:30:00.000Z", "2027-03-14T10:30:00.000Z", "2027-03-15T09:30:00.000Z"],
    },
    {
      name: "a half-hour daylight-saving gap",
      event: event({ timezone: "Australia/Lord_Howe", start: "2026-10-02T15:45:00.000Z", end: "2026-10-02T16:15:00.000Z", repeat: { every: "day", interval: 1 } }),
      from: "2026-10-03", to: "2026-10-04", zone: "Australia/Lord_Howe",
      expected: ["2026-10-02T15:45:00.000Z", "2026-10-03T15:45:00.000Z"],
    },
    {
      name: "a monthly event on the 31st skips months without one and does not drift",
      event: event({ allDay: true, start: "2027-01-31", end: "2027-01-31", repeat: { every: "month", interval: 1 } }),
      from: "2027-01-31", to: "2027-03-31", zone: LA,
      expected: ["2027-01-31", "2027-03-31"],
    },
    {
      name: "an old daily series is found without walking from its start",
      event: event({ allDay: true, start: "2020-01-01", end: "2020-01-01", repeat: { every: "day", interval: 1 } }),
      from: "2026-11-02", to: "2026-11-04", zone: LA,
      expected: ["2026-11-02", "2026-11-03", "2026-11-04"],
    },
    {
      name: "a repeat stops after its until date",
      event: event({ start: "2026-11-02T17:00:00.000Z", end: "2026-11-02T18:00:00.000Z", repeat: { every: "day", interval: 2, until: "2026-11-06" } }),
      from: "2026-11-02", to: "2026-11-10", zone: LA,
      expected: ["2026-11-02T17:00:00.000Z", "2026-11-04T17:00:00.000Z", "2026-11-06T17:00:00.000Z"],
    },
  ])("$name", ({ event: series, from, to, zone, expected }) => {
    expect(starts(buildCalendar(sources({ events: [series] }), { from, to, timezone: zone, now: NOW }))).toEqual(expected);
  });

  it("orders all-day and timed items by the viewer's day", () => {
    const calendar = buildCalendar(sources({ events: [
      event({ id: "late", start: "2026-11-19T02:30:00.000Z", end: "2026-11-19T04:00:00.000Z" }),
      event({ id: "day", allDay: true, start: "2026-11-19", end: "2026-11-19" }),
    ] }), { from: "2026-11-18", to: "2026-11-19", timezone: LA, now: NOW });
    expect(calendar.items.map((item) => item.eventId)).toEqual(["late", "day"]);
  });

  it("shows the events and upcoming runs that overlap one Los Angeles day", () => {
    const calendar = buildCalendar(sources({
      events: [
        event({ id: "tokyo", timezone: "Asia/Tokyo", start: "2026-11-01T00:00:00.000Z", end: "2026-11-01T01:00:00.000Z", repeat: { every: "day", interval: 1 } }),
        event({ id: "ended", start: "2026-11-02T06:00:00.000Z", end: "2026-11-02T07:30:00.000Z" }),
        event({ id: "daily", allDay: true, start: "2026-10-31", end: "2026-10-31", repeat: { every: "day", interval: 1 } }),
        event({ id: "overnight", start: "2026-11-02T07:00:00.000Z", end: "2026-11-02T09:00:00.000Z" }),
      ],
      schedules: [schedule({ id: "minute", cron: "* * * * *" }), schedule({ id: "past", cron: "0 7 * * *" })],
    }), { from: "2026-11-02", to: "2026-11-02", timezone: LA, now: NOW });

    expect(calendar.items.map(({ kind, eventId, scheduleId, start }) => [kind, eventId ?? scheduleId, start])).toEqual([
      ["event", "overnight", "2026-11-02T07:00:00.000Z"],
      ["event", "daily", "2026-11-02"],
      ["run", "minute", "2026-11-02T16:00:00.000Z"],
      ["run", "minute", "2026-11-02T16:01:00.000Z"],
      ["run", "minute", "2026-11-02T16:02:00.000Z"],
      ["event", "tokyo", "2026-11-03T00:00:00.000Z"],
    ]);
    expect(calendar.items[1]).toMatchObject({ id: "event:daily:2", eventId: "daily", repeating: true });
    expect(calendar.runCounts).toEqual({ "2026-11-02": 960 });
  });

  it.each([
    [{ from: "2026-11-02", to: "2027-02-01" }],
    [{ from: "2026-11-08", to: "2026-11-02" }],
    [{ from: "Nov 2", to: "2026-11-02" }],
  ])("refuses the window %j", (window) => {
    expect(() => buildCalendar(sources(), { ...window, timezone: LA, now: NOW })).toThrow(CalendarRangeError);
  });
});

describe("buildCalendar derived dates", () => {
  it("places revisits in the viewer's day, not UTC's", () => {
    const revisits = [{ id: "t1", title: "Late", nextTouchAt: "2026-11-02T07:30:00.000Z", deferred: false }];
    expect(starts(buildCalendar(sources({ revisits }), { from: "2026-11-02", to: "2026-11-02", timezone: LA, now: NOW }), "revisit")).toEqual([]);
    expect(starts(buildCalendar(sources({ revisits }), { from: "2026-11-02", to: "2026-11-02", timezone: "UTC", now: NOW }), "revisit")).toHaveLength(1);
  });

  it("lists overlapping events and unexpired runs beside the week’s overdue work", () => {
    const calendar = buildCalendar(sources({
      events: [event({ id: "trip", allDay: true, start: "2026-10-30", end: "2026-11-03" })],
      schedules: [
        schedule({ id: "daily", expiresAt: "2026-11-03T17:30:00.000Z" }),
        schedule({ id: "once", type: "once", cron: undefined, runAt: "2026-11-03T17:00:00.000Z", expiresAt: "2026-11-03T17:00:00.000Z" }),
      ],
      revisits: [{ id: "t1", title: "Check back", nextTouchAt: "2026-10-30T16:00:00.000Z", deferred: false }],
      overdue: [{ id: "c1", taskId: "t2", text: "Pay", done: false, order: 0, createdAt: "", deadline: "2026-10-20" }],
    }), { from: "2026-11-02", to: "2026-11-08", timezone: LA, now: NOW });
    expect(calendar.items.map(({ kind, eventId, scheduleId, start }) => [kind, eventId ?? scheduleId, start])).toEqual([
      ["event", "trip", "2026-10-30"], ["run", "daily", "2026-11-02T17:00:00.000Z"], ["run", "daily", "2026-11-03T17:00:00.000Z"],
    ]);
    expect(calendar.runCounts).toEqual({ "2026-11-02": 1, "2026-11-03": 1 });
    expect(calendar.overdue.map((item) => item.id)).toEqual(["deadline:c1", "revisit:t1"]);
    expect(calendar).toMatchObject({ overdueTotal: 2, undatedChecklistCount: 4, today: "2026-11-02" });
  });

  it.each([
    {
      name: "a run limit counts the runs before the window",
      schedule: schedule({ maxRuns: 5, runCount: 2 }),
      from: "2026-11-04", to: "2026-11-10",
      runs: ["2026-11-04T17:00:00.000Z"], counts: { "2026-11-04": 1 },
    },
    {
      name: "an hourly schedule in another zone is counted on the viewer's days",
      schedule: schedule({ cron: "0 * * * *", timezone: "UTC" }),
      from: "2026-11-03", to: "2026-11-03",
      runs: ["2026-11-03T08:00:00.000Z", "2026-11-03T09:00:00.000Z", "2026-11-03T10:00:00.000Z"], counts: { "2026-11-03": 24 },
    },
  ])("$name", ({ schedule: plan, from, to, runs, counts }) => {
    const calendar = buildCalendar(sources({ schedules: [plan] }), { from, to, timezone: LA, now: NOW });
    expect(starts(calendar, "run")).toEqual(runs);
    expect(calendar.runCounts).toEqual(counts);
  });

  it("counts a dense schedule on the day the clock springs forward", () => {
    const calendar = buildCalendar(sources({ schedules: [schedule({ cron: "* * * * *" })] }),
      { from: "2027-03-14", to: "2027-03-14", timezone: LA, now: new Date("2027-03-13T12:00:00.000Z") });
    expect(calendar.runCounts).toEqual({ "2027-03-14": 1380 });
  });

  it("lists Helm's looks as runs in the server's zone", () => {
    const calendar = buildCalendar(sources({ helm: ["18:00"] }), { from: "2026-11-02", to: "2026-11-02", timezone: "UTC", now: NOW });
    expect(calendar.items.filter((item) => item.kind === "run").map((item) => [item.title, item.start]))
      .toEqual([]);
    const later = buildCalendar(sources({ helm: ["18:00"] }), { from: "2026-11-03", to: "2026-11-03", timezone: "UTC", now: NOW });
    expect(later.items.map((item) => [item.title, item.start])).toEqual([["Helm's look", "2026-11-03T02:00:00.000Z"]]);
  });
});
