import { describe, expect, it } from "vitest";
import { DEFAULT_BRIDGE_PORT, resolveBridgePort } from "../port-config.js";

describe("resolveBridgePort", () => {
  it("uses the default port when BRIDGE_PORT is not set", () => {
    expect(resolveBridgePort({})).toBe(DEFAULT_BRIDGE_PORT);
    expect(resolveBridgePort({ BRIDGE_PORT: "   " })).toBe(DEFAULT_BRIDGE_PORT);
  });

  it("uses the configured BRIDGE_PORT", () => {
    expect(resolveBridgePort({ BRIDGE_PORT: "4444" })).toBe(4444);
    expect(resolveBridgePort({ BRIDGE_PORT: " 8080 " })).toBe(8080);
  });

  it("rejects invalid BRIDGE_PORT values", () => {
    for (const value of ["0", "65536", "-1", "3.14", "abc"]) {
      expect(() => resolveBridgePort({ BRIDGE_PORT: value })).toThrow(/BRIDGE_PORT must be an integer/);
    }
  });
});
