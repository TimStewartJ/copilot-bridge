import { describe, expect, it, vi } from "vitest";
import { getFollowUpState, toDateTimeInputValue, toDateTimeStorageValue } from "./components/TaskMomentumFields";

describe("getFollowUpState", () => {
  const now = new Date("2026-05-01T12:00:00.000Z");

  it("treats future follow-ups as upcoming even later the same day", () => {
    expect(getFollowUpState("2026-05-01T13:00:00.000Z", now)).toBe("upcoming");
  });

  it("treats past-due follow-ups from today as due", () => {
    expect(getFollowUpState("2026-05-01T11:00:00.000Z", now)).toBe("due");
  });

  it("treats prior-day follow-ups as overdue", () => {
    expect(getFollowUpState("2026-04-30T23:00:00.000Z", now)).toBe("overdue");
  });
});

describe("follow-up datetime conversions", () => {
  it("round-trips datetime-local values through ISO storage", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-01T08:00:00.000Z"));

    try {
      const stored = toDateTimeStorageValue("2026-05-02T09:30");
      expect(stored).toBe(new Date("2026-05-02T09:30").toISOString());
      expect(toDateTimeInputValue(stored)).toBe("2026-05-02T09:30");
    } finally {
      vi.useRealTimers();
    }
  });
});
