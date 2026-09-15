import { CopilotClient } from "@github/copilot-sdk";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BRIDGE_COPILOT_GITHUB_TOKEN_ENV, buildCopilotClientOptions } from "../copilot-client-options.js";
import { makeTestDir } from "./helpers.js";
import { testExecutablePath } from "./test-paths.js";

describe("installed Copilot runtime contract", () => {
  it("starts the pinned Copilot CLI loader", async () => {
    const options = buildCopilotClientOptions({
      ...process.env,
      COPILOT_HOME: makeTestDir("copilot-native-runtime"),
      COPILOT_CLI_PATH: testExecutablePath("missing-copilot-cli"),
      [BRIDGE_COPILOT_GITHUB_TOKEN_ENV]: "",
    });
    expect(options.connection).toEqual(expect.objectContaining({
      kind: "stdio",
      path: expect.stringContaining(join("node_modules", "@github", "copilot", "npm-loader.js")),
    }));
    expect(options.env).not.toHaveProperty("COPILOT_CLI_PATH");

    const client = new CopilotClient({ ...options, useLoggedInUser: false });
    try {
      await client.start();
      await expect(client.ping()).resolves.toBeDefined();
    } finally {
      await client.stop();
    }
  });
});
