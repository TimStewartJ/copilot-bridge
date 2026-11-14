import { describe, expect, it } from "vitest";
import type { CalendarEvent } from "../../../shared/calendar.js";
import { extractDates, taskAttention, upcomingAbsences, type AttentionTask } from "../attention.js";

const TZ = "America/Los_Angeles";
const NOW = new Date("2026-11-13T20:00:00.000Z");
const TODAY = "2026-11-13";

describe("extractDates", () => {
  it.each([
    ["by Thursday 11/12", ["2026-11-12"]],
    ["due 11/20/26, then 12/1/2026", ["2026-11-20", "2026-12-01"]],
    ["Nov 20 or November 21, 2026, or 22 Nov", ["2026-11-20", "2026-11-21", "2026-11-22"]],
    ["since 2026-11-09 8pm", ["2026-11-09"]],
    // A date without a year is the nearest one: early January is next year.
    ["after 1/3", ["2027-01-03"]],
    ["41/64 done, $1/2 off, see a/b/c, 13/40, 50%", []],
    ["Decide 2 options, Mark 5 items, review 3 separate quotes", []],
  ])("reads %j", (text, dates) => {
    expect(extractDates(text, TODAY)).toEqual(dates);
  });
});

describe("upcomingAbsences", () => {
  const event = (overrides: Partial<CalendarEvent>): CalendarEvent => ({
    id: "e", title: "Trip", allDay: false, start: "2026-11-23T06:55:00.000Z", end: "2026-12-01T14:45:00.000Z", timezone: TZ,
    createdBy: "user", createdAt: "", updatedAt: "", ...overrides,
  });
  it("counts stretches of several days that are not over, and nothing shorter or repeating", () => {
    expect(upcomingAbsences([
      event({ title: "Mission trip" }),
      event({ title: "Retreat", allDay: true, start: "2026-11-27", end: "2026-11-29" }),
      event({ title: "Day retreat", start: "2026-12-05T17:00:00.000Z", end: "2026-12-05T23:00:00.000Z" }),
      event({ title: "Holiday", allDay: true, start: "2026-11-26", end: "2026-11-26" }),
      event({ title: "Weekly", repeat: { every: "week", interval: 1 } }),
      event({ title: "Past", start: "2026-10-01T00:00:00.000Z", end: "2026-10-05T00:00:00.000Z" }),
    ], { now: NOW, timeZone: TZ })).toEqual([
      { title: "Mission trip", start: "2026-11-22", end: "2026-12-01" },
      { title: "Retreat", start: "2026-11-27", end: "2026-11-29" },
    ]);
  });
});

describe("taskAttention", () => {
  const absences = [{ title: "Mission trip", start: "2026-11-22", end: "2026-12-01" }];
  const attention = (task: AttentionTask) => taskAttention(task, { now: NOW, timeZone: TZ, absences });

  it.each<[string, AttentionTask, boolean, string[]]>([
    ["an agent is working on it", { nextAction: "Lock the sheet by 11/14", agentWorking: true }, false, []],
    ["it waits on others until a date to come", { nextAction: "Lock the sheet", waitingOn: "Members by Sunday 11/15" }, false, []],
    ["it is set aside", { nextAction: "Lock the sheet 11/14", deferred: true }, false, []],
    ["it waits on others with no date", { nextAction: "Lock the sheet", waitingOn: "Lee's answer" }, false, []],
    // A date after the wait was set is what it was due by; one on or before it is a record.
    ["its wait records when it was asked", { nextAction: "Follow up", waitingOn: "Reply from the landlord (emailed 11/10)", waitingSince: "2026-11-10T18:00:00.000Z" }, false, []],
    ["its wait was due by a date that passed", { nextAction: "Lock the sheet", waitingOn: "Members by Thursday 11/12", waitingSince: "2026-11-11T05:46:00.000Z" }, true, ["what it was waiting for was due Thu, Nov 12, which has passed"]],
    ["its wait has a date but not when it was set", { nextAction: "Lock the sheet", waitingOn: "Members by Thursday 11/12" }, false, []],
    // Helm's line can make a task Tim's, never take one away from him.
    ["Helm says it is Tim's though its fields wait on someone", { nextAction: "Merge the PR", waitingOn: "Review of the PR", helm: { owner: "tim" } }, true, []],
    ["Helm's pause on Tim's task ended", { helm: { owner: "tim", holdUntil: "2026-11-12" } }, true, ["Helm's pause on it ended Thu, Nov 12"]],
    ["Helm's pause on Tim's task runs on", { helm: { owner: "tim", holdUntil: "2026-11-20" } }, true, []],
    ["Helm calls it an agent's, but nothing works on it", { nextAction: "Send amounts by 11/14", helm: { owner: "agent" } }, true, ["Sat, Nov 14 in the next step is tomorrow"]],
    ["its next step is due tomorrow", { nextAction: "Send amounts by 11/14" }, true, ["Sat, Nov 14 in the next step is tomorrow"]],
    ["Bridge says it needs him", { state: "needs_you", reasons: ["revisit"], nextTouchAt: "2026-11-10T01:00:00.000Z" }, true, ["its revisit date (Mon, Nov 9) has passed"]],
    // Dates in checklist text and notes are mostly history unless they lie ahead; a checklist deadline is a due date.
    ["only history mentions dates", { nextAction: "Lock cards", checklist: [{ text: "Moved from column K on Nov 12" }], notes: "Status as of 2026-11-13" }, true, []],
    ["a checklist deadline passed", { nextAction: "Lock cards", checklist: [{ text: "Pay the fee", deadline: "2026-11-10" }] }, true, ["Tue, Nov 10 in checklist “Pay the fee” has passed"]],
    ["a checklist item must happen before a trip", { nextAction: "Move billing", checklist: [{ text: "Move billing before the Dec 12 charge (ideally before the trip, Nov 21)", deadline: "2026-12-11" }] }, true, ["Sat, Nov 21 in checklist “Move billing before the Dec 12 charge (ideally before the t…” comes before Mission trip (from Sun, Nov 22)"]],
  ])("%s", (_name, task, onTim, reasons) => {
    expect(attention(task)).toMatchObject({ onTim, reasons });
  });
});
