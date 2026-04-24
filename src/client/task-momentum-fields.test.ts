import { describe, expect, it, vi } from "vitest";
import {
  getFollowUpState,
  getPanelFieldTone,
  toDateTimeInputValue,
  toDateTimeStorageValue,
} from "./components/TaskMomentumFields";

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

describe("getPanelFieldTone", () => {
  const now = new Date("2026-05-01T12:00");

  it("uses warning tone for same-day passed follow-ups", () => {
    expect(getPanelFieldTone("nextTouchAt", "2026-05-01T11:00", now)).toBe("warning");
  });

  it("uses danger tone for prior-day follow-ups", () => {
    expect(getPanelFieldTone("nextTouchAt", "2026-04-30T23:00", now)).toBe("danger");
  });

  it("keeps upcoming follow-ups neutral", () => {
    expect(getPanelFieldTone("nextTouchAt", "2026-05-01T13:00", now)).toBeNull();
  });

  it("keeps non-follow-up fields neutral", () => {
    expect(getPanelFieldTone("nextAction", "Ship preview polish", now)).toBeNull();
  });
});
