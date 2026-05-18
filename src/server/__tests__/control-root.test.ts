import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BRIDGE_CONTROL_ROOT_ENV, resolveBridgeControlRoot } from "../control-root.js";

describe("resolveBridgeControlRoot", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("uses the fallback root when no control root is configured", () => {
    vi.stubEnv(BRIDGE_CONTROL_ROOT_ENV, undefined);

    expect(resolveBridgeControlRoot("/fallback/root")).toBe(resolve("/fallback/root"));
  });

  it("uses an explicit control root when code runs from another slot", () => {
    vi.stubEnv(BRIDGE_CONTROL_ROOT_ENV, "/control/root");

    expect(resolveBridgeControlRoot("/slot/root")).toBe(resolve("/control/root"));
  });
});
