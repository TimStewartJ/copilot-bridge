import { describe, expect, it } from "vitest";
import { isRecord } from "./is-record.js";

describe("isRecord", () => {
  it("accepts non-null, non-array objects", () => {
    expect(isRecord({ key: "value" })).toBe(true);
    expect(isRecord(Object.create(null))).toBe(true);
    expect(isRecord(new Date())).toBe(true);
  });

  it("rejects arrays, null, primitives, and functions", () => {
    expect(isRecord([])).toBe(false);
    expect(isRecord(Object.assign([], { key: "value" }))).toBe(false);
    expect(isRecord(null)).toBe(false);
    expect(isRecord("value")).toBe(false);
    expect(isRecord(1)).toBe(false);
    expect(isRecord(true)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord(() => undefined)).toBe(false);
  });
});
