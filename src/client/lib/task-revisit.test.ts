import { describe, expect, it } from "vitest";
import { formatRevisit, getRevisitState, isRevisitDue, revisitInDays, toDateTimeInputValue, toDateTimeStorageValue } from "./task-revisit";

describe("task revisit semantics", () => {
  it("distinguishes future, arrived-today and earlier dates without treating them as deadlines", () => {
    const now = new Date(2030, 4, 2, 12);
    expect(getRevisitState(new Date(2030, 4, 2, 13).toISOString(), now)).toBe("upcoming");
    expect(getRevisitState(now.toISOString(), now)).toBe("today");
    expect(getRevisitState(new Date(2030, 4, 2, 10).toISOString(), now)).toBe("today");
    expect(getRevisitState(new Date(2030, 4, 1, 23).toISOString(), now)).toBe("ready");
    expect(getRevisitState(undefined, now)).toBeNull();
    expect(getRevisitState("invalid", now)).toBeNull();
    expect(formatRevisit("2000-01-01T00:00:00Z")).toContain("ready to revisit");
    expect(formatRevisit("2000-01-01T00:00:00Z")).not.toContain("overdue");
  });
  it("calls a date due from the moment it arrives, and postpones to a morning", () => {
    const now = new Date(2030, 4, 2, 23, 30);
    expect(isRevisitDue(now.toISOString(), now)).toBe(true);
    expect(isRevisitDue(new Date(2030, 4, 2, 23, 31).toISOString(), now)).toBe(false);
    expect(isRevisitDue(undefined, now)).toBe(false);
    expect(isRevisitDue("invalid", now)).toBe(false);
    expect(revisitInDays(1, now)).toBe(new Date(2030, 4, 3, 9).toISOString());
    expect(revisitInDays(7, now)).toBe(new Date(2030, 4, 9, 9).toISOString());
    // A month boundary is the calendar's business, not arithmetic on hours.
    expect(revisitInDays(1, new Date(2030, 0, 31, 8))).toBe(new Date(2030, 1, 1, 9).toISOString());
  });
  it("round-trips local datetime input at minute precision on the host timezone", () => {
    const instant = new Date(2030, 4, 2, 10, 30);
    expect(toDateTimeStorageValue(toDateTimeInputValue(instant.toISOString()))).toBe(instant.toISOString());
    expect(() => toDateTimeStorageValue("invalid")).toThrow("valid revisit date");
  });
});
