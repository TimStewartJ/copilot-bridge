import { describe, expect, it } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDemoServerEnv } from "../demo-cli.js";

describe("demo CLI", () => {
  it("builds an isolated demo server environment", () => {
    const dataDir = join(tmpdir(), "demo-data");
    const docsDir = join(dataDir, "docs");
    const copilotHome = join(dataDir, ".copilot");
    const env = createDemoServerEnv(
      { PATH: "/usr/bin", EXISTING: "keep-me" },
      {
        dataDir,
        docsDir,
        copilotHome,
      },
    );

    expect(env).toMatchObject({
      PATH: "/usr/bin",
      EXISTING: "keep-me",
      BRIDGE_DATA_DIR: dataDir,
      BRIDGE_DOCS_DIR: docsDir,
      COPILOT_HOME: copilotHome,
      BRIDGE_DEMO_MODE: "true",
      BRIDGE_WEBHOOK_URL: "",
    });
  });
});
