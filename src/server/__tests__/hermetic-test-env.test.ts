import { describe, expect, it } from "vitest";
import { isAmbientRuntimeEnvKey, scrubAmbientRuntimeEnv } from "../../test-support/hermetic-test-env.js";

describe("hermetic test environment", () => {
  it("removes live Bridge runtime, Copilot session, and credential variables only", () => {
    const env: NodeJS.ProcessEnv = {
      BRIDGE_DATA_DIR: "D:\\copilot-teams-bridge\\data",
      bridge_distribution_mode: "release",
      COPILOT_HOME: "C:\\Users\\someone\\.copilot",
      "COPILOT-FEATURE-AGENTIC-MEMORY": "false",
      GH_TOKEN: "token",
      GITHUB_TOKEN: "token",
      GITHUB_ACTIONS: "true",
      PATH: "C:\\Windows",
      BRIDGEWATER: "kept",
    };

    expect(scrubAmbientRuntimeEnv(env).sort()).toEqual([
      "BRIDGE_DATA_DIR",
      "COPILOT-FEATURE-AGENTIC-MEMORY",
      "COPILOT_HOME",
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "bridge_distribution_mode",
    ]);
    expect(env).toEqual({ GITHUB_ACTIONS: "true", PATH: "C:\\Windows", BRIDGEWATER: "kept" });
  });

  it("starts test workers without inherited Bridge runtime variables", () => {
    const ambientKeys = Object.keys(process.env).filter(isAmbientRuntimeEnvKey);
    // The shared config sets only this guard for tests after the scrub runs.
    expect(ambientKeys).toEqual(["BRIDGE_DISABLE_BACKGROUND_LOG_RETENTION"]);
  });
});
