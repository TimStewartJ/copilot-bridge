import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { resolveRuntimePaths } from "../runtime-paths.js";

describe("runtime paths", () => {
  it("derives isolated defaults when demo mode is enabled without explicit paths", () => {
    const paths = resolveRuntimePaths({ BRIDGE_DEMO_MODE: "true" });

    expect(paths.demoMode).toBe(true);
    expect(paths.dataDir).toMatch(/demo-data$/);
    expect(paths.docsDir).toBe(join(paths.dataDir, "docs"));
    expect(paths.copilotHome).toBe(join(paths.dataDir, ".copilot"));
    expect(paths.workspaceDir).toBe(join(paths.dataDir, "workspace"));
    expect(paths.env.BRIDGE_DATA_DIR).toBe(paths.dataDir);
    expect(paths.env.BRIDGE_DOCS_DIR).toBe(paths.docsDir);
    expect(paths.env.COPILOT_HOME).toBe(paths.copilotHome);
    expect(paths.env.BRIDGE_DEMO_MODE).toBe("true");
  });

  it("keeps existing explicit overrides intact", () => {
    const paths = resolveRuntimePaths({
      BRIDGE_DEMO_MODE: "true",
      BRIDGE_DATA_DIR: "/tmp/demo-data",
      BRIDGE_DOCS_DIR: "/tmp/demo-docs",
      COPILOT_HOME: "/tmp/demo-copilot",
    });

    expect(paths.dataDir).toBe("/tmp/demo-data");
    expect(paths.docsDir).toBe("/tmp/demo-docs");
    expect(paths.copilotHome).toBe("/tmp/demo-copilot");
    expect(paths.workspaceDir).toBe(join(paths.dataDir, "workspace"));
  });
});
