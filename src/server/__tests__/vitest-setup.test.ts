import { describe, expect, it } from "vitest";
import { WAIT_FOR_DEFAULT_TIMEOUT_MS, withDefaultTimeout } from "../../test-support/vitest-setup.js";

describe("shared Vitest setup", () => {
  it("gives polling waits a contention-tolerant default budget without overriding explicit ones", () => {
    expect(withDefaultTimeout(undefined)).toEqual({ timeout: WAIT_FOR_DEFAULT_TIMEOUT_MS });
    expect(withDefaultTimeout({ interval: 5 })).toEqual({ interval: 5, timeout: WAIT_FOR_DEFAULT_TIMEOUT_MS });
    expect(withDefaultTimeout({ timeout: 250 })).toEqual({ timeout: 250 });
    expect(withDefaultTimeout(750)).toBe(750);
  });
});
