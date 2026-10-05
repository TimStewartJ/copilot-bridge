import { describe, expect, it } from "vitest";
import {
  LARGE_SESSION_LOG_BYTES,
  VERY_LARGE_SESSION_LOG_BYTES,
  describeSessionLogSize,
  formatSessionLogSize,
} from "./session-log-size";

const MB = 1024 * 1024;

describe("formatSessionLogSize", () => {
  it("keeps one decimal only where it carries information", () => {
    expect(formatSessionLogSize(512)).toBe("512 B");
    expect(formatSessionLogSize(300 * 1024)).toBe("300 KB");
    expect(formatSessionLogSize(4.04 * MB)).toBe("4.0 MB");
    expect(formatSessionLogSize(37.7 * MB)).toBe("38 MB");
    expect(formatSessionLogSize(125.2 * MB)).toBe("125 MB");
    expect(formatSessionLogSize(1023.6 * MB)).toBe("1.0 GB");
    expect(formatSessionLogSize(1806.7 * MB)).toBe("1.8 GB");
  });
});

describe("describeSessionLogSize", () => {
  it("draws nothing for an unknown or empty log", () => {
    expect(describeSessionLogSize(undefined)).toBeNull();
    expect(describeSessionLogSize(0)).toBeNull();
  });

  it("leaves an ordinary size unlabelled", () => {
    expect(describeSessionLogSize(LARGE_SESSION_LOG_BYTES - 1)).toEqual({
      level: "normal",
      size: "50 MB",
      label: null,
      hint: null,
    });
  });

  it("names a large log and a very large one at their thresholds", () => {
    expect(describeSessionLogSize(LARGE_SESSION_LOG_BYTES)).toMatchObject({ level: "large", label: "Large" });
    expect(describeSessionLogSize(VERY_LARGE_SESSION_LOG_BYTES - 1)).toMatchObject({ level: "large" });
    const veryLarge = describeSessionLogSize(VERY_LARGE_SESSION_LOG_BYTES);
    expect(veryLarge).toMatchObject({ level: "very-large", label: "Very large", size: "150 MB" });
    expect(veryLarge?.hint).toContain("a second or more");
  });
});
