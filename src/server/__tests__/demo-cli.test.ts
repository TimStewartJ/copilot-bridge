import { describe, expect, it } from "vitest";
import { createDemoServerEnv } from "../demo-cli.js";

describe("demo CLI", () => {
  it("builds an isolated demo server environment", () => {
    const env = createDemoServerEnv(
      { PATH: "/usr/bin", EXISTING: "keep-me" },
      {
        dataDir: "/tmp/demo-data",
        docsDir: "/tmp/demo-data/docs",
        copilotHome: "/tmp/demo-data/.copilot",
      },
    );

    expect(env).toMatchObject({
      PATH: "/usr/bin",
      EXISTING: "keep-me",
      BRIDGE_DATA_DIR: "/tmp/demo-data",
      BRIDGE_DOCS_DIR: "/tmp/demo-data/docs",
      COPILOT_HOME: "/tmp/demo-data/.copilot",
      BRIDGE_DEMO_MODE: "true",
      BRIDGE_WEBHOOK_URL: "",
    });
  });
});
