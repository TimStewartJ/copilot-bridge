import { existsSync, mkdirSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { isAmbientRuntimeEnvKey, scrubAmbientRuntimeEnv, useRunTempDir } from "../../test-support/hermetic-test-env.js";
import { makeTestDir } from "./helpers.js";

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

  it("gives a run one temp folder, clears those of killed runs, and reuses it for nested loads", () => {
    const parent = makeTestDir("run-temp");
    const abandoned = join(parent, "bridge-vitest-killed");
    const recent = join(parent, "bridge-vitest-running");
    mkdirSync(abandoned);
    mkdirSync(recent);
    const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60_000);
    utimesSync(abandoned, twoDaysAgo, twoDaysAgo);
    const env: NodeJS.ProcessEnv = {};

    const dir = useRunTempDir(env, parent);

    expect(dirname(dir)).toBe(parent);
    expect(basename(dir)).toMatch(/^bridge-vitest-/);
    expect(env).toEqual({ TMPDIR: dir, TEMP: dir, TMP: dir });
    expect(existsSync(abandoned)).toBe(false);
    expect(existsSync(recent)).toBe(true);
    expect(useRunTempDir(env, dir)).toBe(dir);
    // This test itself runs inside its run's folder.
    expect(basename(tmpdir())).toMatch(/^bridge-vitest-/);
  });
});
