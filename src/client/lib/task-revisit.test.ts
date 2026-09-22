import { describe, expect, it } from "vitest";
import { formatRevisit, getRevisitState, toDateTimeInputValue, toDateTimeStorageValue } from "./task-revisit";

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
  it("round-trips local datetime input at minute precision on the host timezone", () => {
    const instant = new Date(2030, 4, 2, 10, 30);
    expect(toDateTimeStorageValue(toDateTimeInputValue(instant.toISOString()))).toBe(instant.toISOString());
    expect(() => toDateTimeStorageValue("invalid")).toThrow("valid revisit date");
  });
});
