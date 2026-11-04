import { describe, expect, it } from "vitest";
import {
  LARGE_SESSION_LOG_BYTES,
  VERY_LARGE_SESSION_LOG_BYTES,
  describeSessionLogSize,
} from "./session-log-size";

describe("describeSessionLogSize", () => {
  it("draws nothing for an unknown or empty log", () => {
    expect(describeSessionLogSize(undefined)).toBeNull();
    expect(describeSessionLogSize(0)).toBeNull();
  });

  it("names a large log and a very large one at their thresholds", () => {
    expect(describeSessionLogSize(LARGE_SESSION_LOG_BYTES - 1)).toMatchObject({ level: "normal", label: null });
    expect(describeSessionLogSize(LARGE_SESSION_LOG_BYTES)).toMatchObject({ level: "large", label: "Large" });
    expect(describeSessionLogSize(VERY_LARGE_SESSION_LOG_BYTES - 1)).toMatchObject({ level: "large" });
    const veryLarge = describeSessionLogSize(VERY_LARGE_SESSION_LOG_BYTES);
    expect(veryLarge).toMatchObject({ level: "very-large", label: "Very large", size: "150 MB" });
    expect(veryLarge?.hint).toContain("Slow to open.");
  });
});
