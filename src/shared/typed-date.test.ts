import { describe, expect, it } from "vitest";
import { extractWhen, parseWhen } from "./typed-date.js";

// Monday 2 November 2026, 08:10 in the test machine's own zone; every expectation is local too.
const NOW = new Date(2026, 10, 2, 8, 10);

describe("parseWhen", () => {
  it.each([
    ["today", "2026-11-02", undefined],
    ["tonight", "2026-11-02", "19:00"],
    ["tmrw 9am", "2026-11-03", "09:00"],
    ["tomorrow at 3:30 pm", "2026-11-03", "15:30"],
    ["mon", "2026-11-02", undefined],
    ["next fri", "2026-11-13", undefined],
    ["this weekend", "2026-11-07", undefined],
    ["in 3 days", "2026-11-05", undefined],
    ["in 2 weeks", "2026-11-16", undefined],
    ["in 1 month", "2026-12-02", undefined],
    ["15th november at 6pm", "2026-11-15", "18:00"],
    ["Nov 1", "2027-11-01", undefined],
    ["12/25", "2026-12-25", undefined],
    ["3pm", "2026-11-02", "15:00"],
    ["7am", "2026-11-03", "07:00"],
    ["at 4", "2026-11-02", "16:00"],
    ["fri morning", "2026-11-06", "09:00"],
    ["fri noon", "2026-11-06", "12:00"],
    ["in 2 hours", "2026-11-02", "10:10"],
    ["2026-11-03T09:30", "2026-11-03", "09:30"],
    ["2026-10-01", "2026-10-01", undefined],
  ])("%s", (text, date, time) => {
    const when = parseWhen(text, NOW);
    expect(when?.date).toBe(date);
    expect(when?.time ? `${String(when.time.hour).padStart(2, "0")}:${String(when.time.minute).padStart(2, "0")}` : undefined).toBe(time);
  });

  it.each(["", "soon", "Feb 30", "13pm", "fri fri", "4", "yesterday"])("rejects %j", (text) => {
    expect(parseWhen(text, NOW)).toBeNull();
  });
});

describe("extractWhen", () => {
  it.each([
    ["Call the bank fri 3pm", "Call the bank", "fri 3pm", "2026-11-06"],
    ["Dinner with friends on Nov 15 at 7pm", "Dinner with friends", "on Nov 15 at 7pm", "2026-11-15"],
    ["Renew passport by next week", "Renew passport", "by next week", "2026-11-09"],
  ])("%s", (text, rest, phrase, date) => {
    const found = extractWhen(text, NOW);
    expect(found?.rest).toBe(rest);
    expect(found?.phrase).toBe(phrase);
    expect(found?.when.date).toBe(date);
  });

  it.each(["Friday", "Read chapter 3"])("leaves %j alone", (text) => {
    expect(extractWhen(text, NOW)).toBeNull();
  });
});
